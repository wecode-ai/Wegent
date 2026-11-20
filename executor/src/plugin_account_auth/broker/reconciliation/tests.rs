//! Scheduler events must work without relying on a short audit interval.
use super::*;
use crate::{
    local::backend::{EventHandler, LocalBackendConfig, LocalBackendTransport},
    plugin_account_auth::PluginAuthTransport,
};
use std::{collections::VecDeque, future::Future, pin::Pin};
use tokio::sync::oneshot;

type Reply<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;

#[derive(Clone)]
struct Transport(tokio::sync::mpsc::UnboundedSender<Value>);

impl LocalBackendTransport for Transport {
    fn connect<'a>(&'a self, _: &'a LocalBackendConfig) -> Reply<'a, ()> {
        panic!("The scheduler uses an established transport")
    }
    fn disconnect<'a>(&'a self) -> Reply<'a, ()> {
        panic!("The scheduler does not own connection shutdown")
    }
    fn call<'a>(&'a self, operation: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        assert_eq!(operation, "plugin.auth.automatic");
        self.0.send(payload).unwrap();
        Box::pin(async { Ok(json!({"success":true,"packages":[]})) })
    }
    fn emit<'a>(&'a self, _: &'a str, _: Value) -> Reply<'a, ()> {
        panic!("Reconciliation uses request/reply")
    }
    fn on(&self, _: &str, _: EventHandler) {
        panic!("No Socket subscription")
    }
    fn on_close(&self, _: crate::local::backend::ConnectionClosedHandler) {
        panic!("No Socket subscription")
    }
}

async fn next(received: &mut tokio::sync::mpsc::UnboundedReceiver<Value>) -> Value {
    tokio::time::timeout(Duration::from_secs(2), received.recv())
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn lifecycle_and_inventory_events_run_before_the_long_audit() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    let manifest = home.path().join("capabilities/manifest-v2.json");
    let mut plugins = json!({
        "a":{"installed_plugin_id":42,"managed":true,"enabled":true},
        "b":{"installed_plugin_id":43,"managed":true,"enabled":true},
    });
    std::fs::write(&manifest, json!({"plugins":plugins}).to_string()).unwrap();
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (cancel, cancelled) = watch::channel(false);
    let (events, requested) = tokio::sync::mpsc::channel(16);
    let logins = Arc::new(PendingLogins::default());
    let task = tokio::spawn(run(
        Transport(calls),
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        cancelled,
        requested,
        logins.clone(),
        Duration::from_secs(3600),
    ));
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42, 43])
    );
    events.try_send(ReconciliationRequest::Target(43)).unwrap();
    logins.submit(42, "mail".into());
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42])
    );
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([43])
    );
    plugins["c"] = json!({"installed_plugin_id":44,"managed":true,"enabled":true});
    std::fs::write(&manifest, json!({"plugins":plugins}).to_string()).unwrap();
    crate::services::capability_activation::notify_changed();
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([44])
    );
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(
        received.try_recv().is_err(),
        "Successful events must not restart polling"
    );
    cancel.send_replace(true);
    task.await.unwrap();
}

#[derive(Clone)]
struct GatedDiscovery {
    calls: mpsc::UnboundedSender<Value>,
    gates: Arc<Mutex<VecDeque<oneshot::Receiver<()>>>>,
}

impl super::super::super::PluginAuthTransport for GatedDiscovery {
    fn exchange<'a>(&'a self, operation: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        assert_eq!(operation, "plugin.auth.automatic");
        self.calls.send(payload).unwrap();
        let gate = self.gates.lock().unwrap().pop_front();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.await.unwrap();
            }
            Ok(json!({"success":true,"packages":[]}))
        })
    }
}

#[tokio::test]
async fn login_dispatch_does_not_wait_for_the_active_audit_batch() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    let plugins: serde_json::Map<_, _> = (1..=18)
        .map(|id| {
            (
                format!("plugin-{id}"),
                json!({"installed_plugin_id":id,"managed":true,"enabled":true}),
            )
        })
        .collect();
    std::fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins":plugins}).to_string(),
    )
    .unwrap();
    let (calls, mut received) = mpsc::unbounded_channel();
    let (unblock, blocked) = oneshot::channel();
    let (unblock_login, login_blocked) = oneshot::channel();
    let (cancel, cancelled) = watch::channel(false);
    let (_ordinary, requested) = mpsc::channel(16);
    let logins = Arc::new(PendingLogins::default());
    let task = tokio::spawn(run(
        GatedDiscovery {
            calls,
            gates: Arc::new(Mutex::new(VecDeque::from([blocked, login_blocked]))),
        },
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        cancelled,
        requested,
        logins.clone(),
        Duration::from_secs(3600),
    ));
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!((1..=16).collect::<Vec<_>>())
    );
    logins.submit(17, "mail".into());
    logins.submit(17, "mail".into());
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([17])
    );
    logins.submit(18, "mail".into());
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([18])
    );
    unblock_login.send(()).unwrap();
    unblock.send(()).unwrap();
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([17, 18])
    );
    cancel.send_replace(true);
    task.await.unwrap();
}

#[derive(Clone)]
struct NativeReadinessDiscovery {
    native: LocalAuthContext,
    offline_checks: mpsc::UnboundedSender<()>,
    calls: mpsc::UnboundedSender<Value>,
    fail_once: Arc<AtomicBool>,
}

impl PluginAuthTransport for NativeReadinessDiscovery {
    fn available(&self, registered: bool) -> bool {
        let ready = self.native.available(registered);
        if !ready {
            self.offline_checks.send(()).unwrap();
        }
        ready
    }

    fn exchange<'a>(&'a self, operation: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        assert_eq!(operation, "plugin.auth.automatic");
        self.calls.send(payload).unwrap();
        let failed = self.fail_once.swap(false, Ordering::SeqCst);
        Box::pin(async move {
            if failed {
                Err("discovery temporarily unavailable".into())
            } else {
                Ok(json!({"success":true,"packages":[]}))
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn native_renewal_wakes_offline_logins_without_skipping_discovery_backoff() {
    use crate::config::device::ConnectionConfig;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    std::fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins":{
            "a":{"installed_plugin_id":42,"managed":true,"enabled":true},
            "b":{"installed_plugin_id":43,"managed":true,"enabled":true}
        }})
        .to_string(),
    )
    .unwrap();
    let base = "http://127.0.0.1:1";
    let account_claims = URL_SAFE_NO_PAD.encode(r#"{"user_id":1,"sub":"same-user"}"#);
    let old = format!("test.{account_claims}.old");
    let renewed = format!("test.{account_claims}.renewed");
    let connection = Arc::new(Mutex::new(Some(ConnectionConfig {
        backend_url: base.into(),
        auth_token: old.clone(),
        ..Default::default()
    })));
    let logins = Arc::new(PendingLogins::default());
    let native = LocalAuthContext::new(connection.clone()).with_pending_logins(logins.clone());
    let native_claims = URL_SAFE_NO_PAD.encode(
        r#"{"user_id":1,"sub":"same-user","thumbprint":"device","token_use":"plugin_native","scope":"plugin_native"}"#,
    );
    let configure = |revision, token: &str| {
        native
            .configure(json!({"configuration_revision":revision,"session":{
                "backend_url":base,"account_token":token,
                "native_token":format!("test.{native_claims}.test"),
                "expires_at":chrono::Utc::now().timestamp()+600
            }}))
            .unwrap();
    };
    configure(1, &old);

    let (offline_checks, mut checked) = mpsc::unbounded_channel();
    let (calls, mut received) = mpsc::unbounded_channel();
    let (cancel, cancelled) = watch::channel(false);
    let task = tokio::spawn({
        let logins = logins.clone();
        let home = home.path().to_owned();
        let transport = NativeReadinessDiscovery {
            native: native.clone(),
            offline_checks,
            calls,
            fail_once: Arc::new(AtomicBool::new(true)),
        };
        async move { run_logins(transport, &home, &AtomicBool::new(false), cancelled, logins).await }
    });
    logins.submit(43, "mail".into());
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([43])
    );
    let retry_due = logins
        .next_ready()
        .expect("discovery backoff remains scheduled");

    connection.lock().unwrap().as_mut().unwrap().auth_token = renewed.clone();
    logins.submit(42, "mail".into());
    for _ in 0..2 {
        tokio::time::timeout(Duration::from_secs(2), checked.recv())
            .await
            .expect("scheduler must notice the unavailable Native session")
            .unwrap();
    }
    let revision = logins.revision();
    configure(2, &renewed);
    assert_eq!(logins.revision(), revision);
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42])
    );
    assert_eq!(logins.next_ready(), Some(retry_due));
    tokio::time::advance(retry_due - tokio::time::Instant::now()).await;
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([43])
    );
    cancel.send_replace(true);
    task.await.unwrap();
}

#[derive(Clone)]
struct FailedDiscovery {
    calls: tokio::sync::mpsc::UnboundedSender<Value>,
    first: Arc<AtomicBool>,
}

impl super::super::super::PluginAuthTransport for FailedDiscovery {
    fn exchange<'a>(&'a self, _: &'a str, payload: Value, _: Duration) -> Reply<'a, Value> {
        self.calls.send(payload).unwrap();
        let fail = self.first.swap(false, Ordering::SeqCst);
        Box::pin(async move {
            if fail {
                Err("discovery unavailable".into())
            } else {
                Ok(json!({"success":true,"packages":[]}))
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn successful_partial_events_preserve_a_failed_full_cycle_retry() {
    let home = tempfile::tempdir().unwrap();
    std::fs::create_dir(home.path().join("capabilities")).unwrap();
    std::fs::write(
        home.path().join("capabilities/manifest-v2.json"),
        json!({"plugins":{
            "a":{"installed_plugin_id":42,"managed":true,"enabled":true},
            "b":{"installed_plugin_id":43,"managed":true,"enabled":true}
        }})
        .to_string(),
    )
    .unwrap();
    let (calls, mut received) = tokio::sync::mpsc::unbounded_channel();
    let (cancel, cancelled) = watch::channel(false);
    let (events, requested) = tokio::sync::mpsc::channel(16);
    let task = tokio::spawn(run(
        FailedDiscovery {
            calls,
            first: Arc::new(AtomicBool::new(true)),
        },
        home.path().to_owned(),
        Arc::new(AtomicBool::new(true)),
        cancelled,
        requested,
        Arc::default(),
        Duration::from_secs(3600),
    ));
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42, 43])
    );
    events
        .send(ReconciliationRequest::Target(43))
        .await
        .unwrap();
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([43])
    );
    tokio::time::advance(Duration::from_secs(31)).await;
    assert_eq!(
        next(&mut received).await["installed_plugin_ids"],
        json!([42, 43])
    );
    cancel.send_replace(true);
    task.await.unwrap();
}
