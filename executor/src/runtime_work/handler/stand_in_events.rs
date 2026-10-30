//! Wework forwards received assignment notifications through the existing local RPC.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn handle_stand_in_assignment(
        &self,
        payload: Value,
    ) -> Result<(), AppIpcError> {
        let (Some(project), Some(issue_id), Some(assignment)) = (
            payload["projectId"].as_str(),
            payload["itemId"].as_str(),
            payload["assignmentId"].as_str(),
        ) else {
            self.log_stand_in_decision(&json!({}), &json!({}), "notification_identity_missing", json!({"hasProjectId":payload["projectId"].is_string(),"hasItemId":payload["itemId"].is_string(),"hasAssignmentId":payload["assignmentId"].is_string()}));
            return Ok(());
        };
        let context = json!({"projectId":project,"userId":payload["recipientUserId"]});
        let event_issue = json!({"id":issue_id,"human_task_binding":{"assignmentId":assignment}});
        self.log_stand_in_decision(&context, &event_issue, "notification_received", json!({}));
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let personal = store
            .all_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?;
        let project_configs = self.stand_in_project_configs(&personal, project, "cloud");
        let configs: Vec<Value> = project_configs
            .iter()
            .filter(|config| {
                config["enabled"] == true
                    && config["handlingPolicy"]["automatic"] != false
                    && config["userId"] == payload["recipientUserId"]
            })
            .cloned()
            .collect();
        if configs.is_empty() {
            self.log_stand_in_decision(
                &context,
                &event_issue,
                "no_automatic_project_role",
                json!({"personalSettingsCount":personal.len(),"projectRoles":project_configs.iter().map(|role|json!({"roleId":role["id"],"userId":role["userId"],"enabled":role["enabled"],"automatic":role["handlingPolicy"]["automatic"]})).collect::<Vec<_>>()}),
            );
            return Ok(());
        }
        self.verify_stand_in_user(&configs[0]).await?;
        let issue = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}"),
                None,
            )
            .await?;
        // An event is a hint, never authority to run a stale or reassigned Issue.
        if issue["cloud_project_id"] != project
            || issue["human_task_binding"]["assignmentId"] != assignment
        {
            self.log_stand_in_decision(&context, &issue, "notification_assignment_mismatch", json!({
                "notificationAssignmentId":assignment,"actualProjectId":issue["cloud_project_id"]
            }));
            return Ok(());
        }
        if super::personal_stand_in::matching_personal_roles(&configs, &issue).is_empty() {
            self.log_stand_in_decision(&context, &issue, "no_matching_role_tags", json!({}));
            return Ok(());
        }
        let result = self.start_cloud_stand_in_with_roles(&configs, &issue).await;
        self.log_stand_in_decision(
            &configs[0],
            &issue,
            if result.is_ok() {
                "notification_processed"
            } else {
                "notification_failed"
            },
            json!({"errorCode":result.as_ref().err().map(|error| &error.code)}),
        );
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use std::sync::atomic::AtomicUsize;

    struct Fixture {
        _root: tempfile::TempDir,
        handler: RuntimeWorkRpcHandler,
        server: tokio::task::JoinHandle<()>,
        assignments: Arc<AtomicUsize>,
        bindings: Arc<AtomicUsize>,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    async fn fixture(created_at: &str) -> Fixture {
        let assignments = Arc::new(AtomicUsize::new(0));
        let bindings = Arc::new(AtomicUsize::new(0));
        let assignment_calls = assignments.clone();
        let binding_calls = bindings.clone();
        let created_at = created_at.to_owned();
        let router = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
            .route("/api/v1/loop-items/issue", get(|| async { Json(json!({"id":"issue","cloud_project_id":"project","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}})) }))
            .route("/api/v1/loop-items/issue/assignments", get(move || {
                assignment_calls.fetch_add(1, Ordering::SeqCst);
                let timestamp = created_at.clone();
                async move { Json(json!({"items":[{"id":"assignment","status":"active","created_at":timestamp}]})) }
            }))
            .route("/api/v1/loop-items/issue/tasks", get(move || {
                binding_calls.fetch_add(1, Ordering::SeqCst);
                async { Json(json!([{"human_assignment_id":"human","device_id":"other","task_id":"stand-in-human-default"}])) }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.store = RuntimeWorkStore::new(root.path().join("runtime-index.json"));
        handler.worktrees = WorktreeManager::new(root.path().join("worktrees.json"));
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        })));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        store.save_stand_in_settings("project", 7, json!({"projectStore":"cloud","enabled":true,"prompt":"Review","executionDeviceId":"mac","version":0})).unwrap();
        Fixture {
            _root: root,
            handler,
            server,
            assignments,
            bindings,
        }
    }

    fn notification() -> Value {
        json!({"method":"runtime.stand_in.assignment","payload":{"projectId":"project","itemId":"issue","assignmentId":"assignment","recipientUserId":7}})
    }

    #[tokio::test]
    async fn active_assignment_bound_elsewhere_silently_skips_then_reports_already_handled() {
        let fixture = fixture("2099-01-01T00:00:00Z").await;
        fixture
            .handler
            .handle_runtime_rpc(notification())
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 1);
        assert!(fixture.handler.local_task_links(true).is_empty());

        let error = fixture
            .handler
            .handle_runtime_rpc(json!({
                "method": "runtime.stand_in.run",
                "payload": {
                    "projectId": "project", "issueId": "issue", "userId": 7,
                    "projectStore": "cloud", "standInId": "default"
                }
            }))
            .await
            .unwrap_err();
        assert_eq!(error.code, "assignment_already_handled");
        assert_eq!(
            error.message,
            "This assignment has already been handled or is no longer active"
        );
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 2);
        assert!(fixture.handler.local_task_links(true).is_empty());
    }

    #[tokio::test]
    async fn received_notification_validates_once_and_preserves_existing_binding() {
        let fixture = fixture("2099-01-01T00:00:00Z").await;
        fixture
            .handler
            .handle_runtime_rpc(notification())
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 1);
        assert!(fixture
            .handler
            .local_task_link("stand-in-human-default")
            .is_none());
        // Local discovery cannot issue cloud requests, even with cloud roles enabled.
        for _ in 0..3 {
            assert!(fixture
                .handler
                .local_stand_in_projects()
                .unwrap()
                .is_empty());
        }
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn stale_notifications_and_other_accounts_never_query_assignments() {
        let fixture = fixture("2099-01-01T00:00:00Z").await;
        let mut stale = notification();
        stale["payload"]["assignmentId"] = json!("superseded");
        fixture.handler.handle_runtime_rpc(stale).await.unwrap();
        let mut other_user = notification();
        other_user["payload"]["recipientUserId"] = json!(8);
        fixture
            .handler
            .handle_runtime_rpc(other_user)
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn notification_does_not_bypass_enable_time_or_restart_a_local_task() {
        let fixture = fixture("2020-01-01T00:00:00Z").await;
        fixture
            .handler
            .handle_runtime_rpc(notification())
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 0);
        fixture.handler.upsert_local_task(RuntimeTaskLink {
            local_task_id: "stand-in-human-default".into(),
            status: "failed".into(),
            ..RuntimeTaskLink::default()
        });
        fixture
            .handler
            .handle_runtime_rpc(notification())
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 0);
    }
}
