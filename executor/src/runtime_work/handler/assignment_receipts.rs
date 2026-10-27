//! Durable acknowledgements are synchronized independently of model execution.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn record_stand_in_receipt(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
        backend_url: &str,
    ) -> Result<(), AppIpcError> {
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        if config["projectStore"] == "local" {
            return store
                .acknowledge_assignment(
                    project,
                    issue_id,
                    binding["humanAssignmentId"].as_str().unwrap_or_default(),
                    config["userId"].as_i64().unwrap_or_default(),
                    true,
                )
                .map_err(settings_error);
        }
        store
            .queue_assignment_receipt(&json!({
                "projectId": project, "issueId": issue_id, "backendUrl": backend_url,
                "assignmentId": binding["assignmentId"], "userId": config["userId"],
                "deviceId": self.device_id, "taskId": binding["taskId"],
            }))
            .map_err(settings_error)?;
        let handler = self.clone();
        tokio::spawn(async move {
            if let Err(error) = handler.flush_assignment_receipts().await {
                log_executor_event(
                    "Assignment receipt synchronization failed",
                    &[("error", error.message)],
                );
            }
        });
        Ok(())
    }

    pub(super) async fn flush_assignment_receipts(&self) -> Result<(), AppIpcError> {
        let gate = self.task_send_gate("assignment-receipt-sync");
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for (id, receipt) in store
            .pending_assignment_receipts()
            .map_err(settings_error)?
        {
            let Some(connection) = self.backend_connection_snapshot()? else {
                continue;
            };
            if receipt["backendUrl"].as_str() != Some(connection.backend_url.as_str()) {
                continue;
            }
            // Keep identity verification and the write on the same connection snapshot.
            let identity =
                Self::stand_in_request_on(&connection, reqwest::Method::GET, "/users/me", None)
                    .await;
            let verified = match identity {
                Ok(response) if response.status().is_success() => {
                    response.json::<Value>().await.ok()
                }
                _ => None,
            };
            if verified.as_ref().map(|user| &user["id"]) != Some(&receipt["userId"]) {
                continue;
            }
            let path = format!(
                "/v1/loop-items/{}/assignments/{}/receipt",
                receipt["issueId"].as_str().unwrap_or_default(),
                receipt["assignmentId"].as_str().unwrap_or_default()
            );
            match Self::stand_in_request_on(&connection, reqwest::Method::POST, &path, Some(&json!({
                "kind":"stand_in_received", "device_id":receipt["deviceId"], "task_id":receipt["taskId"],
            }))).await {
                Ok(response) if response.status().is_success() || response.status() == reqwest::StatusCode::CONFLICT => {
                    store.complete_assignment_receipt(&id).map_err(settings_error)?;
                }
                Ok(response) => log_executor_event("Assignment receipt pending", &[("receipt_id", id), ("status", response.status().to_string())]),
                Err(error) => log_executor_event("Assignment receipt pending", &[("receipt_id", id), ("error", error.message)]),
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use std::sync::atomic::{AtomicU16, AtomicUsize};

    #[tokio::test]
    async fn assignment_receipt_keeps_the_verified_connection_when_settings_change() {
        let root = tempfile::tempdir().unwrap();
        let connection = Arc::new(Mutex::new(None::<ConnectionConfig>));
        let change_connection = connection.clone();
        let writes = Arc::new(AtomicUsize::new(0));
        let count = writes.clone();
        let router = Router::new()
            .route(
                "/api/users/me",
                get(move || {
                    change_connection
                        .lock()
                        .unwrap()
                        .as_mut()
                        .unwrap()
                        .backend_url = "http://127.0.0.1:1".into();
                    async { Json(json!({"id":7})) }
                }),
            )
            .route(
                "/api/v1/loop-items/issue/assignments/one/receipt",
                post(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    async { axum::http::StatusCode::OK }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        *connection.lock().unwrap() = Some(ConnectionConfig {
            backend_url: url.clone(),
            auth_token: "test".into(),
            ..Default::default()
        });
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
        handler.backend_connection = connection;
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store.queue_assignment_receipt(&json!({"assignmentId":"one","issueId":"issue","taskId":"task","userId":7,"deviceId":"mac","backendUrl":url})).unwrap();
        handler.flush_assignment_receipts().await.unwrap();
        assert_eq!(writes.load(Ordering::SeqCst), 1);
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn assignment_receipt_persistence_does_not_wait_for_the_cloud() {
        let root = tempfile::tempdir().unwrap();
        let router = Router::new().route(
            "/api/users/me",
            get(|| async {
                tokio::time::sleep(Duration::from_secs(15)).await;
                Json(json!({"id":7}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url.clone(),
            auth_token: "test".into(),
            ..Default::default()
        })));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        tokio::time::timeout(
            Duration::from_secs(2),
            handler.record_stand_in_receipt(
                &json!({"projectId":"project","projectStore":"cloud","userId":7}),
                &json!({"id":"issue"}),
                &json!({"assignmentId":"one","taskId":"accepted-task"}),
                &url,
            ),
        )
        .await
        .expect("Cloud latency must not block accepted-task receipt persistence")
        .unwrap();
        assert_eq!(store.pending_assignment_receipts().unwrap().len(), 1);
        assert!(handler.local_task_links(true).is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn assignment_receipt_sync_survives_failure_and_restart_without_cross_account_replay() {
        let root = tempfile::tempdir().unwrap();
        let user = Arc::new(AtomicUsize::new(8));
        let status = Arc::new(AtomicU16::new(500));
        let writes = Arc::new(AtomicUsize::new(0));
        let current_user = user.clone();
        let response_status = status.clone();
        let count = writes.clone();
        let router = Router::new()
            .route(
                "/api/users/me",
                get(move || {
                    let id = current_user.load(Ordering::SeqCst);
                    async move { Json(json!({"id": id})) }
                }),
            )
            .route(
                "/api/v1/loop-items/issue/assignments/one/receipt",
                post(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                    let code = response_status.load(Ordering::SeqCst);
                    async move { axum::http::StatusCode::from_u16(code).unwrap() }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let make_handler = || {
            let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
            handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
            handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
            handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
                backend_url: url.clone(),
                auth_token: "test".into(),
                ..Default::default()
            })));
            handler
        };
        let handler = make_handler();
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let receipt = json!({"assignmentId":"one","issueId":"issue","taskId":"task","userId":7,"deviceId":"mac","backendUrl":url});
        store.queue_assignment_receipt(&receipt).unwrap();
        handler.flush_assignment_receipts().await.unwrap();
        assert_eq!(writes.load(Ordering::SeqCst), 0);
        user.store(7, Ordering::SeqCst);
        handler.flush_assignment_receipts().await.unwrap();
        assert_eq!(store.pending_assignment_receipts().unwrap().len(), 1);
        drop(handler);
        let restarted = make_handler();
        status.store(200, Ordering::SeqCst);
        restarted.flush_assignment_receipts().await.unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
        assert!(restarted.local_task_links(true).is_empty());
        store.queue_assignment_receipt(&receipt).unwrap();
        status.store(409, Ordering::SeqCst);
        restarted.flush_assignment_receipts().await.unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
        server.abort();
    }
}
