//! Exercise production reconciliation scheduling with real HTTP and journal IO.
use super::super::LocalBackendConnectionProfile;
use super::*;
use crate::local::backend::CapabilitySyncRpcHandler;
use axum::{
    extract::Query,
    response::IntoResponse,
    routing::{post, put},
    Json, Router,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
};
use tokio::sync::Notify;

mod digest_tests;
mod journal_tests;
mod runtime_token_tests;
mod scanning_tests;

#[derive(Default)]
struct DigestGate {
    hold_at: AtomicUsize,
    entered: Notify,
    released: Mutex<bool>,
    ready: Condvar,
}

struct HeldDigest(Arc<DigestGate>);

impl Drop for HeldDigest {
    fn drop(&mut self) {
        *self.0.released.lock().unwrap() = true;
        self.0.ready.notify_all();
    }
}

#[derive(Clone, Copy, Debug)]
enum Plan {
    Valid,
    HttpFailure,
    InvalidSnapshot,
    UnexpectedUnchanged,
    FailedApplication,
    HeldHttp,
    HeldTargetHttp,
    HeldApplication,
}

#[derive(Clone, Copy)]
enum RecoveryReply {
    Accepted,
    Unconfirmed,
    Superseded,
    Rejected,
}

#[derive(Clone)]
struct Installer {
    plan: Plan,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    digest: Arc<Mutex<Option<String>>>,
    digest_calls: Arc<AtomicUsize>,
    applications: Arc<AtomicUsize>,
    state_revision: Arc<AtomicUsize>,
    digest_gate: Arc<DigestGate>,
}

impl CapabilitySyncRpcHandler for Installer {
    fn local_plugin_digest(&self) -> Option<String> {
        let call = self.digest_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.digest_gate.hold_at.load(Ordering::SeqCst) == call {
            self.digest_gate.entered.notify_one();
            let mut released = self.digest_gate.released.lock().unwrap();
            while !*released {
                released = self.digest_gate.ready.wait(released).unwrap();
            }
        }
        self.digest.lock().unwrap().clone()
    }

    fn local_plugin_revision(&self) -> Option<String> {
        Some(self.state_revision.load(Ordering::SeqCst).to_string())
    }

    fn handle_sync_capabilities<'a>(
        &'a self,
        payload: Value,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Value> + Send + 'a>> {
        Box::pin(async move {
            self.applications.fetch_add(1, Ordering::SeqCst);
            self.state_revision.fetch_add(1, Ordering::SeqCst);
            if matches!(self.plan, Plan::HeldApplication) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            let success = !matches!(self.plan, Plan::FailedApplication);
            let removed = payload["removed_plugins"]
                .as_array()
                .is_some_and(|items| !items.is_empty());
            let id = payload["plugins"][0]["installed_plugin_id"]
                .as_u64()
                .unwrap_or(8);
            json!({"success":success,"scope":payload["scope"],"plugin_sync":payload["plugin_sync"],"plugins":[{"id":id,"status":if !success {"failed"}else if removed {"removed"}else{"synced"}}]})
        })
    }
}

struct Fixture {
    _temp: tempfile::TempDir,
    controller: LocalBackendConnectionController,
    connection: ConnectionConfig,
    path: PathBuf,
    installer: Installer,
    recovery_entered: Arc<Notify>,
    recovery_release: Arc<Notify>,
    probe_entered: Arc<Notify>,
    plans: Arc<Mutex<Vec<Value>>>,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new(plan: Plan, unconfirmed: bool) -> Self {
        Self::with_recovery(
            plan,
            if unconfirmed {
                RecoveryReply::Unconfirmed
            } else {
                RecoveryReply::Accepted
            },
        )
        .await
    }

    async fn with_recovery(plan: Plan, reply: RecoveryReply) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_url = format!("http://{}", listener.local_addr().unwrap());
        let connection = ConnectionConfig {
            backend_url: backend_url.clone(),
            socket_url: backend_url,
            auth_token: "test-token".into(),
            ..Default::default()
        };
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let recovery_entered = Arc::new(Notify::new());
        let recovery_release = Arc::new(Notify::new());
        let probe_entered = Arc::new(Notify::new());
        let plans = Arc::new(Mutex::new(Vec::new()));
        let removals = Arc::new(Mutex::new(HashMap::<String, bool>::new()));
        let accept_intent = {
            let removals = removals.clone();
            move |method: axum::http::Method, Query(query): Query<HashMap<String, String>>| {
                let removals = removals.clone();
                async move {
                    removals.lock().unwrap().insert(
                        query["operation_id"].clone(),
                        method == axum::http::Method::DELETE,
                    );
                    let mut response = Json(json!({})).into_response();
                    for (name, value) in [
                        ("X-Plugin-Delivery-Mode", "local_pull_v1"),
                        ("X-Plugin-Operation-Id", query["operation_id"].as_str()),
                        (
                            "X-Plugin-Intent-Order",
                            query["local_intent_order"].as_str(),
                        ),
                    ] {
                        response.headers_mut().insert(name, value.parse().unwrap());
                    }
                    response
                }
            }
        };
        let router = Router::new()
            .route("/api/plugins/marketplace/8/install", post(accept_intent.clone()))
            .route("/api/plugins/installed/8", put(accept_intent.clone()).delete(accept_intent.clone()))
            .route("/api/plugins/builtin/example/ensure-installed", post(accept_intent))
            .route("/api/plugins/local-sync", post({
                let entered = entered.clone();
                let release = release.clone();
                let probe_entered = probe_entered.clone();
                let plans = plans.clone();
                let removals = removals.clone();
                move |Json(body): Json<Value>| {
                    let entered = entered.clone();
                    let release = release.clone();
                    let probe_entered = probe_entered.clone();
                    let plans = plans.clone();
                    let removals = removals.clone();
                    async move {
                        if body["probeOnly"] == true {
                            probe_entered.notify_one();
                            return Json(json!({"enabled":true,"protocolVersion":1,"contractRevision":3,"accountId":1})).into_response();
                        }
                        plans.lock().unwrap().push(body.clone());
                        if matches!(plan, Plan::HeldHttp) || (matches!(plan, Plan::HeldTargetHttp) && body["installedPluginId"] == 8) {
                            entered.notify_one();
                            release.notified().await;
                        }
                        if matches!(plan, Plan::HttpFailure) {
                            return (axum::http::StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail":"snapshot unavailable"}))).into_response();
                        }
                        if matches!(plan, Plan::InvalidSnapshot) {
                            return Json(json!({"protocolVersion":1,"generation":0})).into_response();
                        }
                        if matches!(plan, Plan::UnexpectedUnchanged) {
                            return Json(json!({"protocolVersion":1,"revision":"a".repeat(64),"unchanged":true})).into_response();
                        }
                        let targeted = body["targeted"] == true;
                        if !targeted && body["knownRevision"] == "a".repeat(64) && body["actualRevision"] == body["knownRevision"] && body["recoveryPending"] != true {
                            return Json(json!({"protocolVersion":1,"revision":"a".repeat(64),"unchanged":true})).into_response();
                        }
                        let operation = body["operationId"].as_str();
                        let removed = operation.is_some_and(|id| removals.lock().unwrap().get(id) == Some(&true));
                        let installed_id = body["installedPluginId"].as_u64().unwrap_or(8);
                        Json(json!({"protocolVersion":1,"revision":"a".repeat(64),"generation":1,"operation":operation.map(|id|json!({"operationId":id,"state":"intent_saved","installedPluginId":8})),"payload":{"mode":"merge","scope":if targeted {"plugin_delta"}else{"plugins"},"plugins":if removed {json!([])}else{json!([{"installed_plugin_id":installed_id}])},"removed_plugins":if removed {json!([{"installed_plugin_id":installed_id}])}else{json!([])},"plugin_sync":{"version":2,"generation":1,"complete":!targeted}}})).into_response()
                    }
                }
            }))
            .route("/api/plugins/marketplace/7/install", post({
                let entered = recovery_entered.clone();
                let release = recovery_release.clone();
                move |Query(query): Query<HashMap<String,String>>| {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        assert_eq!(query["operation_id"], "original");
                        assert_eq!(query["local_intent_order"], "7");
                        assert_eq!(query["release_id"], "3");
                        entered.notify_one();
                        release.notified().await;
                        let (status, body, state) = match reply {
                            RecoveryReply::Accepted | RecoveryReply::Unconfirmed => (axum::http::StatusCode::OK, json!({}), None),
                            RecoveryReply::Superseded => (axum::http::StatusCode::CONFLICT, json!({"detail":"INTENT_SUPERSEDED"}), Some("superseded")),
                            RecoveryReply::Rejected => (axum::http::StatusCode::NOT_FOUND, json!({"detail":"Marketplace plugin not found"}), Some("rejected")),
                        };
                        let mut response = (status, Json(body)).into_response();
                        if !matches!(reply, RecoveryReply::Unconfirmed) {
                            for (name,value) in [("X-Plugin-Delivery-Mode","local_pull_v1"),("X-Plugin-Operation-Id","original"),("X-Plugin-Intent-Order","7")] {
                                response.headers_mut().insert(name,value.parse().unwrap());
                            }
                        }
                        if let Some(state) = state {
                            response.headers_mut().insert("X-Plugin-Operation-State", state.parse().unwrap());
                        }
                        response
                    }
                }
            }));
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let controller =
            LocalBackendConnectionController::start(crate::config::device::DeviceConfig::default())
                .await;
        controller.state.lock().await.profile = Some(LocalBackendConnectionProfile {
            connection: connection.clone(),
            registration_device_type: None,
        });
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.json");
        persist(&path,&json!({"version":1,"nextIntentOrder":7,"pending":[{"operationId":"original","intentOrder":7,"action":"install","targetId":7,"payload":{"releaseId":3},"accepted":false}],"receipts":[]})).unwrap();
        let installer = Installer {
            plan,
            entered,
            release,
            digest: Arc::new(Mutex::new(Some("actual".into()))),
            digest_calls: Arc::new(AtomicUsize::new(0)),
            applications: Arc::new(AtomicUsize::new(0)),
            state_revision: Arc::new(AtomicUsize::new(0)),
            digest_gate: Arc::new(DigestGate::default()),
        };
        controller.state.lock().await.plugin_sync = Some(Arc::new(installer.clone()));
        Self {
            _temp: temp,
            controller,
            connection,
            path,
            installer,
            recovery_entered,
            recovery_release,
            probe_entered,
            plans,
            server,
        }
    }

    async fn sync(&self, params: Value) -> Result<Value, AppIpcError> {
        let mut lease = Some(
            self.controller
                .acquire_local_sync_lease(&self.connection, &self.path)
                .await?,
        );
        self.controller
            .apply_local_plugin_sync(
                params,
                LocalSyncSession {
                    connection: &self.connection,
                    handler: Arc::new(self.installer.clone()),
                    capabilities: &json!({"enabled":true}),
                    instance: "native",
                    path: &self.path,
                },
                load_journal(&self.path)?,
                &mut lease,
            )
            .await
    }

    async fn wait_for_merge(&self, unconfirmed: bool) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let state = load_journal(&self.path).unwrap();
                if (unconfirmed
                    && state["pending"][0]["lastErrorCode"]
                        == "plugin_local_acceptance_unconfirmed")
                    || (!unconfirmed && state["pending"][0]["accepted"] == true)
                {
                    return state;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("The prepared recovery did not merge its result")
    }
}

#[tokio::test]
async fn read_only_probes_do_not_wait_for_the_foreground_execution_lease() {
    let fixture = Fixture::new(Plan::Valid, true).await;
    let _serial = fixture.controller.local_sync_lock.lock().await;
    let probe = fixture.controller.local_plugin_sync_at(json!({
        "backend_url":fixture.connection.backend_url,"auth_token":fixture.connection.auth_token,"probeOnly":true
    }),fixture._temp.path());
    let result = tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .expect("Capability negotiation waited for an unrelated full application")
        .unwrap();
    assert_eq!(result["enabled"], true);
    assert!(load_journal(&fixture.path).unwrap()["pending"][0]["lastAttemptAt"].is_null());
}

#[tokio::test]
async fn queued_execution_rechecks_the_account_after_waiting_for_the_lease() {
    let fixture = Arc::new(Fixture::new(Plan::Valid, true).await);
    let serial = fixture.controller.local_sync_lock.lock().await;
    let request = tokio::spawn({
        let fixture = fixture.clone();
        async move {
            fixture.controller.local_plugin_sync_at(json!({
            "backend_url":fixture.connection.backend_url,"auth_token":fixture.connection.auth_token,"action":"install","targetId":7
        }),fixture._temp.path()).await
        }
    });
    tokio::time::timeout(Duration::from_secs(3), fixture.probe_entered.notified())
        .await
        .unwrap();
    fixture
        .controller
        .state
        .lock()
        .await
        .profile
        .as_mut()
        .unwrap()
        .connection
        .auth_token = "another-account-token".into();
    drop(serial);
    let result = tokio::time::timeout(Duration::from_secs(3), request)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err().code, "plugin_route_profile_mismatch");
    let scope = format!(
        "{:x}",
        Sha256::digest(format!("{}:1", fixture.connection.backend_url).as_bytes())
    );
    assert!(!fixture._temp.path().join(format!("{scope}.json")).exists());
}

#[tokio::test]
async fn failed_or_invalid_full_reconciliation_still_recovers_the_original_request() {
    for plan in [
        Plan::HttpFailure,
        Plan::InvalidSnapshot,
        Plan::FailedApplication,
    ] {
        for unconfirmed in [false, true] {
            let fixture = Fixture::new(plan, unconfirmed).await;
            let failure = fixture.sync(json!({"full":true})).await.unwrap_err();
            assert_eq!(
                failure.code,
                match plan {
                    Plan::HttpFailure => "snapshot unavailable",
                    Plan::InvalidSnapshot => "plugin_local_invalid_response",
                    _ => "plugin_local_apply_failed",
                }
            );
            tokio::time::timeout(Duration::from_secs(3), fixture.recovery_entered.notified())
                .await
                .unwrap();
            fixture.recovery_release.notify_one();
            let state = fixture.wait_for_merge(unconfirmed).await;
            let original = &state["pending"][0];
            assert_eq!(original["operationId"], "original");
            assert_eq!(original["intentOrder"], 7);
            assert_eq!(original["action"], "install");
            assert_eq!(original["targetId"], 7);
            assert_eq!(original["payload"], json!({"releaseId":3}));
            assert_eq!(original["accepted"], !unconfirmed);
            assert!(state["rejectedOperations"].is_null());
        }
    }
}

#[tokio::test]
async fn recovery_submits_while_full_snapshot_http_or_application_is_held() {
    for plan in [Plan::HeldHttp, Plan::HeldApplication] {
        let fixture = Arc::new(Fixture::new(plan, true).await);
        let foreground = tokio::spawn({
            let fixture = fixture.clone();
            async move { fixture.sync(json!({"full":true})).await }
        });
        tokio::time::timeout(Duration::from_secs(3), fixture.installer.entered.notified())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), fixture.recovery_entered.notified())
            .await
            .unwrap();
        assert!(!foreground.is_finished());
        fixture.installer.release.notify_one();
        assert_eq!(foreground.await.unwrap().unwrap()["localCompleted"], true);
        // The unresolved recovery HTTP response did not block full completion.
        fixture.recovery_release.notify_one();
        let state = fixture.wait_for_merge(true).await;
        assert_eq!(state["pending"][0]["operationId"], "original");
        assert_eq!(state["pending"][0]["intentOrder"], 7);
    }
}

#[tokio::test]
async fn a_targeted_update_does_not_replay_unrelated_pending_work() {
    let fixture = Fixture::new(Plan::Valid, true).await;
    // Per-plugin execution must preserve the foreground target priority.
    let result = fixture.sync(json!({"installedPluginId":8})).await;
    assert!(result.is_ok());
    let state = load_journal(&fixture.path).unwrap();
    assert!(state["pending"][0]["lastAttemptAt"].is_null());
    assert_eq!(state["pending"][0]["operationId"], "original");
}

#[tokio::test]
async fn targeted_http_wait_does_not_hold_another_plugins_journal() {
    let fixture = Arc::new(Fixture::new(Plan::HeldTargetHttp, true).await);
    let slow = tokio::spawn({
        let fixture = fixture.clone();
        async move { fixture.sync(json!({"installedPluginId":8})).await }
    });
    tokio::time::timeout(Duration::from_secs(3), fixture.installer.entered.notified())
        .await
        .unwrap();
    let fast = tokio::time::timeout(
        Duration::from_secs(3),
        fixture.sync(json!({"installedPluginId":9})),
    )
    .await
    .expect("An unrelated plugin waited for the slow HTTP request")
    .unwrap();
    assert_eq!(fast["localCompleted"], true);
    assert!(!slow.is_finished());
    assert_eq!(
        load_journal(&fixture.path).unwrap()["pending"][0]["operationId"],
        "original"
    );
    fixture.installer.release.notify_one();
    assert_eq!(slow.await.unwrap().unwrap()["localCompleted"], true);
}

#[tokio::test]
async fn foreground_scope_is_released_on_cancellation_and_full_sync_defers() {
    let fixture = Fixture::new(Plan::Valid, true).await;
    let foreground = scanning::ForegroundOperation::begin(
        fixture.controller.local_sync_foreground.clone(),
        &fixture.path,
    );
    assert_eq!(
        fixture.sync(json!({"full":true})).await.unwrap_err().code,
        "plugin_local_sync_busy"
    );
    drop(foreground);
    assert!(!fixture
        .controller
        .has_foreground_plugin_operation(&fixture.path));
    assert!(fixture.sync(json!({"installedPluginId":9})).await.is_ok());
}
