//! Recover one intent independently of foreground snapshot execution.
use super::*;
use std::fs::File;

type RecoveryTask = tokio::task::JoinHandle<Result<(), AppIpcError>>;

pub(super) fn lock_file(path: &Path) -> Result<File, AppIpcError> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| error("plugin_local_journal_unavailable"))?;
    file.try_lock_exclusive()
        .map_err(|_| error("plugin_local_sync_busy"))?;
    Ok(file)
}

pub(super) fn select_pending(pending: &[Value]) -> Option<Value> {
    pending
        .iter()
        .min_by_key(|entry| entry["lastAttemptAt"].as_i64().unwrap_or(0))
        .cloned()
}

pub(super) fn record_submission_result(
    journal: &mut Value,
    operation: &str,
    outcome: &Result<SubmitOutcome, AppIpcError>,
) {
    let Some(entry) = journal["pending"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|entry| entry["operationId"].as_str() == Some(operation))
    else {
        return;
    };
    match outcome {
        Ok(SubmitOutcome::Superseded) => {
            let original = entry.clone();
            if !journal["supersededOperations"].is_array() {
                journal["supersededOperations"] = json!([]);
            }
            journal["supersededOperations"]
                .as_array_mut()
                .unwrap()
                .push(original);
            retire_superseded(journal, operation);
        }
        Ok(SubmitOutcome::Accepted) => {
            entry["accepted"] = json!(true);
            entry["lastErrorCode"] = Value::Null;
        }
        Ok(SubmitOutcome::Rejected { failure, status }) if entry["accepted"] != true => {
            let rejected = json!({"request":entry.clone(),"errorCode":failure.code,"httpStatus":status,"rejectedAt":chrono::Utc::now().timestamp()});
            if !journal["rejectedOperations"].is_array() {
                journal["rejectedOperations"] = json!([]);
            }
            let archive = journal["rejectedOperations"].as_array_mut().unwrap();
            archive.push(rejected);
            if archive.len() > 100 {
                archive.drain(..archive.len() - 100);
            }
            retire_superseded(journal, operation);
        }
        Ok(SubmitOutcome::Rejected { failure, .. }) | Err(failure) => {
            // An uncertain or previously accepted request retains its original
            // ID, order and payload, even when a later response is contradictory.
            entry["lastErrorCode"] = json!(failure.code);
        }
    }
    journal["reconcilePending"] = json!(true);
}

impl LocalBackendConnectionController {
    pub(super) fn schedule_local_recovery(
        &self,
        connection: &ConnectionConfig,
        instance: &str,
        path: &Path,
        journal: &mut Value,
    ) -> Result<Option<RecoveryTask>, AppIpcError> {
        // The caller already owns the ordinary journal lease. Prepare exactly
        // one original request before snapshot HTTP or package application;
        // neither their success nor their network latency gates submission.
        let recovery = lock_file(&path.with_extension("recovery.lock"))?;
        let Some(request) = select_pending(journal["pending"].as_array().unwrap()) else {
            return Ok(None);
        };
        for entry in journal["pending"].as_array_mut().unwrap() {
            if entry["operationId"] == request["operationId"] {
                entry["lastAttemptAt"] = json!(chrono::Utc::now().timestamp_millis());
                entry["lastErrorCode"] = Value::Null;
            }
        }
        persist(path, journal)?;
        let controller = self.clone();
        let connection = connection.clone();
        let instance = instance.to_owned();
        let path = path.to_path_buf();
        Ok(Some(tokio::spawn(async move {
            let _recovery = recovery;
            controller
                .recover_prepared(&connection, &instance, &path, request)
                .await
        })))
    }

    async fn recover_prepared(
        &self,
        connection: &ConnectionConfig,
        instance: &str,
        path: &Path,
        request: Value,
    ) -> Result<(), AppIpcError> {
        {
            let state = self.state.lock().await;
            if state.profile.as_ref().map(|profile| &profile.connection) != Some(connection) {
                return Err(error("plugin_route_profile_mismatch"));
            }
        }

        // Recovery submits intent only. The shared installer applies the current
        // account plan on a subsequent reconciliation, never this captured intent.
        let outcome = submit(connection, instance, &request, &self.base_config.device_id).await;

        let _serial = self.local_sync_lock.lock().await;
        let _file = lock_file(&path.with_extension("lock"))?;
        let mut journal = load_journal(path)?;
        let operation = request["operationId"]
            .as_str()
            .ok_or_else(|| error("plugin_local_journal_invalid"))?;
        record_submission_result(&mut journal, operation, &outcome);
        persist(path, &journal)
    }
}

#[cfg(test)]
mod tests {
    use super::super::super::LocalBackendConnectionProfile;
    use super::*;
    use axum::{extract::Query, response::IntoResponse, routing::post, Json, Router};
    use std::{collections::HashMap, sync::Arc};

    impl LocalBackendConnectionController {
        async fn recover_pending_once(
            &self,
            connection: &ConnectionConfig,
            instance: &str,
            path: &Path,
        ) -> Result<(), AppIpcError> {
            let worker = {
                let _serial = self.local_sync_lock.lock().await;
                let _file = lock_file(&path.with_extension("lock"))?;
                let mut journal = load_journal(path)?;
                self.schedule_local_recovery(connection, instance, path, &mut journal)?
            };
            match worker {
                Some(worker) => worker.await.map_err(|_| error("recovery_task_failed"))?,
                None => Ok(()),
            }
        }
    }

    fn journal(accepted: bool) -> Value {
        json!({"version":1,"nextIntentOrder":7,"pending":[{"operationId":"request-7","intentOrder":7,"action":"install","targetId":7,"payload":{"releaseId":3},"accepted":accepted}],"receipts":[]})
    }

    #[test]
    fn explicit_supersession_retires_accepted_or_uncertain_original_without_recreating_it() {
        for accepted in [false, true] {
            let mut state = journal(accepted);
            let original = state["pending"][0].clone();
            record_submission_result(&mut state, "request-7", &Ok(SubmitOutcome::Superseded));
            assert_eq!(state["pending"], json!([]));
            assert_eq!(state["supersededOperations"][0], original);
        }
    }

    #[test]
    fn uncertain_results_keep_the_original_request_across_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.json");
        for code in [
            "plugin_local_http_unavailable",
            "plugin_local_acceptance_unconfirmed",
            "plugin_local_intent_failed",
            "INTENT_SUPERSEDED",
        ] {
            let mut state = journal(false);
            let request = state["pending"][0].clone();
            record_submission_result(&mut state, "request-7", &Err(error(code)));
            persist(&path, &state).unwrap();
            let recovered = load_journal(&path).unwrap();
            for field in [
                "operationId",
                "intentOrder",
                "action",
                "targetId",
                "payload",
                "accepted",
            ] {
                assert_eq!(
                    recovered["pending"][0][field], request[field],
                    "{code}: {field}"
                );
            }
            assert!(recovered["rejectedOperations"].is_null());
        }
    }

    #[test]
    fn acknowledged_rejection_archives_only_unaccepted_work() {
        for accepted in [false, true] {
            let mut state = journal(accepted);
            state["pending"].as_array_mut().unwrap().push(json!({"operationId":"other-plugin","action":"update","targetId":8,"intentOrder":8}));
            let rejection = Ok(SubmitOutcome::Rejected {
                failure: error("Marketplace plugin not found"),
                status: 404,
            });
            record_submission_result(&mut state, "request-7", &rejection);
            assert_eq!(
                state["pending"].as_array().unwrap().len(),
                if accepted { 2 } else { 1 }
            );
            if !accepted {
                assert_eq!(
                    state["rejectedOperations"][0]["request"]["operationId"],
                    "request-7"
                );
                assert_eq!(state["rejectedOperations"][0]["httpStatus"], 404);
                assert_eq!(state["pending"][0]["operationId"], "other-plugin");
            }
        }
    }

    #[tokio::test]
    async fn recovery_network_wait_holds_neither_foreground_lock_and_merges_newer_journal_writes() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "test-token".into(),
            ..ConnectionConfig::default()
        };
        let router = Router::new().route(
            "/api/plugins/marketplace/7/install",
            post({
                let entered = entered.clone();
                let release = release.clone();
                move || {
                    let entered = entered.clone();
                    let release = release.clone();
                    async move {
                        entered.notify_one();
                        release.notified().await;
                        let mut response = axum::http::StatusCode::OK.into_response();
                        for (name, value) in [
                            ("X-Plugin-Delivery-Mode", "local_pull_v1"),
                            ("X-Plugin-Operation-Id", "request-7"),
                            ("X-Plugin-Intent-Order", "7"),
                        ] {
                            response.headers_mut().insert(name, value.parse().unwrap());
                        }
                        response
                    }
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.json");
        persist(&path, &journal(false)).unwrap();
        let controller =
            LocalBackendConnectionController::start(crate::config::device::DeviceConfig::default())
                .await;
        controller.state.lock().await.profile = Some(LocalBackendConnectionProfile {
            connection: connection.clone(),
            registration_device_type: None,
        });
        let worker = tokio::spawn({
            let controller = controller.clone();
            let connection = connection.clone();
            let path = path.clone();
            async move {
                controller
                    .recover_pending_once(&connection, "native", &path)
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(3), entered.notified())
            .await
            .unwrap();
        assert_eq!(
            controller
                .recover_pending_once(&connection, "native", &path)
                .await
                .unwrap_err()
                .code,
            "plugin_local_sync_busy"
        );
        {
            let _serial = controller
                .local_sync_lock
                .try_lock()
                .expect("recovery blocked the foreground coordinator");
            let _file = lock_file(&path.with_extension("lock"))
                .expect("recovery held the ordinary journal lease");
            let mut state = load_journal(&path).unwrap();
            state["pending"].as_array_mut().unwrap().push(
                json!({"operationId":"foreground","intentOrder":8,"action":"install","targetId":8}),
            );
            persist(&path, &state).unwrap();
        }
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(3), worker)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let state = load_journal(&path).unwrap();
        assert_eq!(state["pending"][0]["accepted"], true);
        assert_eq!(state["pending"][0]["operationId"], "request-7");
        assert_eq!(state["pending"][1]["operationId"], "foreground");
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn a_real_request_timeout_retains_the_original_pending_operation() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "test-token".into(),
            ..ConnectionConfig::default()
        };
        let (entered, received) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut bytes = [0_u8; 4096];
            assert!(stream.read(&mut bytes).await.unwrap() > 0);
            entered.send(()).unwrap();
            std::future::pending::<()>().await;
            drop(stream);
        });
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("journal.json");
        persist(&path, &journal(false)).unwrap();
        let controller =
            LocalBackendConnectionController::start(crate::config::device::DeviceConfig::default())
                .await;
        controller.state.lock().await.profile = Some(LocalBackendConnectionProfile {
            connection: connection.clone(),
            registration_device_type: None,
        });
        let worker = tokio::spawn({
            let path = path.clone();
            async move {
                controller
                    .recover_pending_once(&connection, "native", &path)
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(3), received)
            .await
            .unwrap()
            .unwrap();
        // Exercise reqwest's real request deadline without waiting 30 wall seconds.
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(31)).await;
        worker.await.unwrap().unwrap();
        tokio::time::resume();
        let state = load_journal(&path).unwrap();
        assert_eq!(state["pending"][0]["operationId"], "request-7");
        assert_eq!(state["pending"][0]["intentOrder"], 7);
        assert_eq!(state["pending"][0]["payload"], json!({"releaseId":3}));
        assert_eq!(state["pending"][0]["accepted"], false);
        assert_eq!(
            state["pending"][0]["lastErrorCode"],
            "plugin_local_http_unavailable"
        );
        assert!(state["rejectedOperations"].is_null());
        server.abort();
        let _ = server.await;
    }

    #[tokio::test]
    async fn error_status_alone_is_not_proof_of_nonacceptance() {
        async fn respond(
            Query(params): Query<HashMap<String, String>>,
        ) -> axum::response::Response {
            let operation = &params["operation_id"];
            let (status, detail) = match operation.as_str() {
                "marked404" | "plain404" | "wrong-id" => (404, "Marketplace plugin not found"),
                "timeout" => (408, "Timeout"),
                "retry429" => (429, "Throttled"),
                "server500" => (500, "Unavailable"),
                "conflict" => (409, "IDEMPOTENCY_CONFLICT"),
                _ => (409, "INTENT_SUPERSEDED"),
            };
            let mut response = (
                axum::http::StatusCode::from_u16(status).unwrap(),
                Json(json!({"detail":detail})),
            )
                .into_response();
            if operation != "plain404" {
                for (name, value) in [
                    ("X-Plugin-Delivery-Mode", "local_pull_v1"),
                    ("X-Plugin-Intent-Order", "7"),
                    ("X-Plugin-Operation-State", "rejected"),
                ] {
                    response.headers_mut().insert(name, value.parse().unwrap());
                }
                response.headers_mut().insert(
                    "X-Plugin-Operation-Id",
                    if operation == "wrong-id" {
                        "another".parse().unwrap()
                    } else {
                        operation.parse().unwrap()
                    },
                );
            }
            response
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let connection = ConnectionConfig {
            backend_url: format!("http://{}", listener.local_addr().unwrap()),
            auth_token: "test-token".into(),
            ..ConnectionConfig::default()
        };
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route("/api/plugins/marketplace/7/install", post(respond)),
            )
            .await
            .unwrap();
        });
        for (operation, definitive) in [
            ("marked404", true),
            ("superseded", true),
            ("plain404", false),
            ("wrong-id", false),
            ("timeout", false),
            ("retry429", false),
            ("server500", false),
            ("conflict", false),
        ] {
            let request =
                json!({"action":"install","targetId":7,"operationId":operation,"intentOrder":7});
            let outcome = submit(&connection, "native", &request, "").await;
            assert_eq!(
                matches!(outcome, Ok(SubmitOutcome::Rejected { .. })),
                definitive,
                "{operation}"
            );
        }
        server.abort();
        let _ = server.await;
    }
}
