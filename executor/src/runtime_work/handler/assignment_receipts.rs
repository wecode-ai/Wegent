//! Durable acknowledgements are synchronized independently of model execution.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn reconcile_accepted_stand_in_binding(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        if !config["userId"].is_i64()
            || !config["projectId"].is_string()
            || !issue["id"].is_string()
            || !config["id"].is_string()
            || !matches!(config["projectStore"].as_str(), Some("local" | "cloud"))
        {
            return Ok(());
        }
        let task_id = self.stand_in_task_id(config, issue);
        let Some(task) = self.local_task_link(&task_id).filter(|task| {
            !self.store.is_deleted_archived_task_id(&task_id)
                && !self.archived_link_is_deleted(task)
                && super::stand_in::stand_in_origin_matches(
                    config,
                    issue,
                    &task.runtime_handle["origin"],
                )
        }) else {
            return Ok(());
        };
        if !self.stand_in_assignment_is_handled(config, &task.local_task_id, binding) {
            return Ok(());
        }
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let pending = if config["projectStore"] == "local" {
            LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(settings_error)?
                .list_task_bindings(issue_id)
                .map_err(settings_error)?
                .iter()
                .any(|row| {
                    row.task_id == task_id
                        && row.device_id == self.device_id
                        && row.stand_in_pending == Some(true)
                })
        } else {
            let device = self.cloud_device_id()?;
            let existing = self
                .runtime_http(
                    reqwest::Method::GET,
                    &format!("/v1/loop-items/{issue_id}/tasks"),
                    None,
                )
                .await?;
            existing.as_array().into_iter().flatten().any(|row| {
                row["task_id"] == task_id
                    && row["device_id"] == device
                    && row["task_user_id"] == config["userId"]
                    && row["stand_in_pending"] == true
            })
        };
        if pending {
            // Only synchronize an existing reservation; never resurrect an unlinked task.
            self.record_stand_in_issue_wakeup(&task_id, binding);
            self.accept_stand_in_assignment(config, issue, binding)
                .await?;
        }
        Ok(())
    }

    pub(super) async fn accept_stand_in_assignment(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<Value, AppIpcError> {
        let local = config["projectStore"] == "local";
        let backend = if local {
            String::new()
        } else {
            self.verify_runtime_user(config).await?;
            self.backend_connection_snapshot()?
                .ok_or_else(|| {
                    AppIpcError::new("cloud_unavailable", "Cloud connection is unavailable")
                })?
                .backend_url
        };
        let mut binding = binding.clone();
        binding["deviceId"] = json!(if local {
            self.device_id.clone()
        } else {
            self.cloud_device_id()?
        });
        binding["taskId"] = json!(self.stand_in_task_id(config, issue));
        binding["taskTitle"] = issue["title"].clone();
        binding["standInPending"] = json!(self
            .store
            .get_task_summary(binding["taskId"].as_str().unwrap())
            .is_none());
        binding["standInConversationId"] =
            json!(super::stand_in::stand_in_issue_identity(config, issue));
        if !binding["executionContext"].is_object() {
            binding["executionContext"] = json!({});
        }
        binding["executionContext"]["origin"] = self.stand_in_issue_origin(config, issue, &binding);
        let issue_id = issue["id"].as_str().unwrap_or_default();
        if binding["triggerCommentId"].is_string() {
            self.runtime_http(
                reqwest::Method::POST,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                Some(&json!({
                    "deviceId":binding["deviceId"],"taskId":binding["taskId"],"taskTitle":issue["title"],"standInPending":binding["standInPending"],"standInConversationId":binding["standInConversationId"]
                })),
            )
            .await?;
        } else if local {
            LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(settings_error)?
                .bind_task(
                    config["projectId"].as_str().unwrap_or_default(),
                    Some(issue_id),
                    None,
                    serde_json::from_value(binding.clone())
                        .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?,
                    Some(&binding),
                )
                .map_err(settings_error)?;
        } else {
            self.runtime_http(
                reqwest::Method::POST,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                Some(&binding),
            )
            .await?;
        }
        self.store
            .bind_issue_conversation(
                &super::stand_in::stand_in_issue_identity(config, issue),
                binding["taskId"].as_str().unwrap(),
            )
            .map_err(|error| AppIpcError::new("stand_in_settings", error.to_string()))?;
        if binding["triggerCommentId"].is_string()
            || (config["manual"] == true
                && (issue["assignee_user_id"] != config["userId"]
                    || !binding["humanAssignmentId"].is_string()))
        {
            return Ok(binding);
        }
        // Receipt authority still comes from the recipient-owned binding. Model
        // preparation and execution are independent of accepting the assignment.
        if let Err(error) = self
            .record_stand_in_receipt(config, issue, &binding, &backend)
            .await
        {
            log_executor_event(
                "Stand-in receipt persistence failed",
                &[
                    (
                        "task_id",
                        binding["taskId"].as_str().unwrap_or_default().to_owned(),
                    ),
                    ("error", error.message),
                ],
            );
        }
        Ok(binding)
    }

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
        let device_id = match binding["deviceId"].as_str() {
            Some(device) => device.to_owned(),
            None => self.cloud_device_id()?,
        };
        store
            .queue_assignment_receipt(&json!({
                "projectId": project, "issueId": issue_id, "backendUrl": backend_url,
                "assignmentId": super::stand_in::issue_assignment_event_id(binding)?, "userId": config["userId"],
                "deviceId": device_id, "taskId": binding["taskId"],
            }))
            .map_err(settings_error)?;
        self.log_stand_in_decision(config, issue, "receipt_queued", json!({"taskId":binding["taskId"],"issueAssignmentId":super::stand_in::issue_assignment_event_id(binding)?}));
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
        self.flush_assignment_receipts_at(chrono::Utc::now()).await
    }

    async fn flush_assignment_receipts_at(
        &self,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), AppIpcError> {
        let gate = self.task_send_gate("assignment-receipt-sync");
        let _guard = gate.lock().await;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        // Authorization can recover; retain failures for 30 days instead of guessing from 403/404.
        store
            .expire_assignment_receipts(&(now - chrono::Duration::days(30)).to_rfc3339())
            .map_err(settings_error)?;
        for (id, receipt) in store
            .pending_assignment_receipts()
            .map_err(settings_error)?
        {
            if receipt["nextAttemptAt"]
                .as_str()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .is_some_and(|retry_at| retry_at > now)
            {
                continue;
            }
            let Some(connection) = self.backend_connection_snapshot()? else {
                self.log_stand_in_receipt(&receipt, "cloud_unavailable", json!({}));
                continue;
            };
            if receipt["backendUrl"].as_str() != Some(connection.backend_url.as_str()) {
                self.log_stand_in_receipt(&receipt, "backend_changed", json!({}));
                continue;
            }
            // Keep identity verification and the write on the same connection snapshot.
            let identity =
                Self::runtime_request_on(&connection, reqwest::Method::GET, "/users/me", None)
                    .await;
            let verified = match identity {
                Ok(response) if response.status().is_success() => {
                    response.json::<Value>().await.ok()
                }
                _ => None,
            };
            if verified.is_none() {
                self.log_stand_in_receipt(&receipt, "identity_verification_failed", json!({}));
                defer_receipt(&store, &id, &receipt, now)?;
                continue;
            }
            if verified.as_ref().map(|user| &user["id"]) != Some(&receipt["userId"]) {
                self.log_stand_in_receipt(&receipt, "account_changed", json!({}));
                continue;
            }
            let path = format!(
                "/v1/loop-items/{}/assignments/{}/receipt",
                receipt["issueId"].as_str().unwrap_or_default(),
                receipt["assignmentId"].as_str().unwrap_or_default()
            );
            match Self::runtime_request_on(&connection, reqwest::Method::POST, &path, Some(&json!({
                "kind":"stand_in_received", "device_id":receipt["deviceId"], "task_id":receipt["taskId"],
            }))).await {
                Ok(response) if response.status().is_success() || response.status() == reqwest::StatusCode::CONFLICT => {
                    self.log_stand_in_receipt(&receipt, "completed", json!({"status":response.status().as_u16()}));
                    store.complete_assignment_receipt(&id).map_err(settings_error)?;
                }
                Ok(response) => {
                    let status = response.status().as_u16();
                    let failure = receipt_failure_reason(response.json::<Value>().await.ok().as_ref());
                    defer_receipt(&store, &id, &receipt, now)?;
                    self.log_stand_in_receipt(&receipt, "http_failed", json!({"status":status,"failure":failure}));
                }
                Err(error) => {
                    defer_receipt(&store, &id, &receipt, now)?;
                    self.log_stand_in_receipt(&receipt, "request_failed", json!({"errorCode":error.code}));
                }
            }
        }
        Ok(())
    }
}

fn receipt_failure_reason(body: Option<&Value>) -> &'static str {
    // Never copy arbitrary server bodies, Issue content or credentials into logs.
    match body.and_then(|body| body["detail"].as_str()) {
        Some("A recipient-owned task binding is required") => "personal_binding_required",
        Some("Only the recipient can acknowledge an assignment") => "recipient_mismatch",
        Some("Assignment is no longer active") => "assignment_inactive",
        _ => "unknown",
    }
}

fn defer_receipt(
    store: &LocalTaskStore,
    id: &str,
    receipt: &Value,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), AppIpcError> {
    let attempts = receipt["retryCount"]
        .as_u64()
        .unwrap_or_default()
        .min(u32::MAX as u64) as u32;
    let delay = (5i64 * (1i64 << attempts.min(10))).min(3600);
    store
        .defer_assignment_receipt(
            id,
            attempts.saturating_add(1),
            &(now + chrono::Duration::seconds(delay)).to_rfc3339(),
        )
        .map_err(settings_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::{get, post},
        Json, Router,
    };
    use std::sync::atomic::{AtomicU16, AtomicUsize};

    #[test]
    fn receipt_failure_diagnostics_never_log_arbitrary_response_content() {
        assert_eq!(
            receipt_failure_reason(Some(
                &json!({"detail":"A recipient-owned task binding is required"})
            )),
            "personal_binding_required"
        );
        assert_eq!(
            receipt_failure_reason(Some(
                &json!({"detail":"Only the recipient can acknowledge an assignment"})
            )),
            "recipient_mismatch"
        );
        assert_eq!(
            receipt_failure_reason(Some(&json!({"detail":"secret or Issue content"}))),
            "unknown"
        );
        assert_eq!(receipt_failure_reason(None), "unknown");
    }

    #[tokio::test]
    async fn manual_stand_in_work_receipts_only_acknowledge_the_current_recipient() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Manual receipts"})).unwrap())
            .unwrap();
        let config = json!({"id":"review","projectId":project.id,"projectStore":"local","userId":7,"manual":true});
        for assignee in [Value::Null, json!(8), json!(7)] {
            let issue = store
                .create_task(
                    &project.id,
                    serde_json::from_value(json!({"title":"Review","assignee_user_id":assignee}))
                        .unwrap(),
                )
                .unwrap();
            let value = serde_json::to_value(&issue).unwrap();
            let binding = super::super::stand_in::stand_in_issue_receipt_binding(&config, &value);
            handler
                .accept_stand_in_assignment(&config, &value, &binding)
                .await
                .unwrap();
            assert_eq!(store.list_task_bindings(&issue.id).unwrap().len(), 1);
            assert_eq!(
                store
                    .get_task(&project.id, &issue.id)
                    .unwrap()
                    .assignee_user_id,
                issue.assignee_user_id
            );
            let receipts = store.assignment_receipts(&project.id, &issue.id).unwrap();
            assert_eq!(
                receipts
                    .iter()
                    .any(|row| row["stand_in_received_at"].is_string()),
                assignee == 7
            );
            assert!(receipts.iter().all(|row| row["human_read_at"].is_null()));
        }
    }

    #[tokio::test]
    async fn cloud_background_intake_binds_and_acknowledges_without_starting_execution() {
        let root = tempfile::tempdir().unwrap();
        let received_binding = Arc::new(Mutex::new(Value::Null));
        let binding_output = received_binding.clone();
        let router = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
            .route(
                "/api/v1/loop-items/issue/tasks",
                post(move |Json(body): Json<Value>| {
                    *binding_output.lock().unwrap() = body;
                    async { Json(json!({"id":"binding"})) }
                }),
            )
            .route(
                "/api/v1/loop-items/issue/assignments/event/receipt",
                post(|| async { Json(json!({"acknowledged":true})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        })));
        handler.execute_stand_in_task(
            &json!({"id":"review","projectId":"project","projectStore":"cloud","userId":7,"handlingPolicy":{"immediate":false}}),
            &json!({"id":"issue","title":"Review"}),
            &json!({"humanAssignmentId":"human","assignmentId":"event","dispatchRoundId":"direct"}),
        ).await.unwrap();
        handler.flush_assignment_receipts().await.unwrap();
        let binding = received_binding.lock().unwrap().clone();
        assert_eq!(binding["deviceId"], "mac");
        assert_eq!(binding["assignmentId"], "event");
        assert_eq!(
            binding["taskId"],
            "stand-in-issue-abf6e07390e1647c67dad92c7f6306dadc4b461f0830e780536856cf500b2db6"
        );
        assert_eq!(binding["standInConversationId"], binding["taskId"]);
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
        assert_eq!(store.stand_in_events(7).unwrap().len(), 1);
        assert!(handler.local_task_links(true).is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn accepted_local_assignment_keeps_its_receipt_when_execution_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Receipts"})).unwrap())
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Review","assignee_user_id":7})).unwrap(),
            )
            .unwrap();
        let assignment = format!("{}-1", issue.id);
        let result = handler
            .create_stand_in_task(
                &json!({"id":"review","projectId":project.id,"projectStore":"local","userId":7}),
                &serde_json::to_value(&issue).unwrap(),
                &json!({"humanAssignmentId":assignment}),
                json!({"schemaVersion":99}),
            )
            .await
            .unwrap_err();
        assert_eq!(result.code, "unsupported_schema_version");
        let receipt = store.assignment_receipts(&project.id, &issue.id).unwrap();
        assert!(receipt[0]["stand_in_received_at"].is_string());
        assert!(receipt[0]["human_read_at"].is_null());
        assert!(handler.local_task_links(true).is_empty());
        let reservations = store.list_task_bindings(&issue.id).unwrap();
        assert_eq!(reservations.len(), 1);
        assert_eq!(reservations[0].device_id, "mac");
        assert_eq!(
            reservations[0].human_assignment_id.as_deref(),
            Some(assignment.as_str())
        );
        assert_eq!(
            reservations[0].task_id,
            super::super::stand_in::stand_in_issue_identity(
                &json!({"id":"review","projectId":project.id,"projectStore":"local","userId":7}),
                &serde_json::to_value(&issue).unwrap(),
            )
        );
    }

    #[tokio::test]
    async fn assignment_receipt_retention_is_bounded_without_dropping_recent_authorization_failures(
    ) {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store
            .queue_assignment_receipt(&json!({"assignmentId":"one","issueId":"issue","userId":7}))
            .unwrap();
        handler.flush_assignment_receipts().await.unwrap();
        assert_eq!(store.pending_assignment_receipts().unwrap().len(), 1);
        handler
            .flush_assignment_receipts_at(chrono::Utc::now() + chrono::Duration::days(31))
            .await
            .unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
    }

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
    async fn round_receipt_acknowledges_the_issue_event_not_the_manager_work_id() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        handler.record_stand_in_receipt(
            &json!({"projectId":"project","projectStore":"cloud","userId":7}),
            &json!({"id":"issue"}),
            &json!({"assignmentId":"member-work","dispatchRoundId":"round-1","issueAssignmentId":"issue-event","taskId":"accepted-task"}),
            "https://backend.invalid",
        ).await.unwrap();
        let receipts = store.pending_assignment_receipts().unwrap();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].1["assignmentId"], "issue-event");
        assert_eq!(receipts[0].1["taskId"], "accepted-task");
    }

    #[tokio::test]
    async fn assignment_receipt_sync_survives_failure_and_restart_without_cross_account_replay() {
        for status in [403, 404, 500] {
            verify_retry_after_restart(status).await;
        }
    }

    async fn verify_retry_after_restart(failure_status: u16) {
        let root = tempfile::tempdir().unwrap();
        let user = Arc::new(AtomicUsize::new(8));
        let status = Arc::new(AtomicU16::new(failure_status));
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
        assert_eq!(
            writes.load(Ordering::SeqCst),
            1,
            "Restart must retain the backoff"
        );
        assert_eq!(store.pending_assignment_receipts().unwrap().len(), 1);
        restarted
            .flush_assignment_receipts_at(chrono::Utc::now() + chrono::Duration::seconds(6))
            .await
            .unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
        assert!(restarted.local_task_links(true).is_empty());
        store.queue_assignment_receipt(&receipt).unwrap();
        status.store(409, Ordering::SeqCst);
        restarted.flush_assignment_receipts().await.unwrap();
        assert!(store.pending_assignment_receipts().unwrap().is_empty());
        server.abort();
    }
}
