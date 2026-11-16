//! Notifications wake assignment work; durable intents also recover after reconnection.
use super::stand_in::settings_error;
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) async fn report_assistant_preflight_failure(
        &self,
        config: &Value,
        issue: &Value,
        error: &AppIpcError,
    ) {
        let Some(execution) = issue["human_assistant_dispatch"]["executionId"].as_str() else {
            return;
        };
        let project = config["projectId"].as_str().unwrap_or_default();
        let path = format!("/v1/cloud-projects/{project}/executions/{execution}/dispatch-failed");
        let body =
            json!({"error":error.message.chars().take(2000).collect::<String>(),"note":error.code});
        if let Err(report_error) = self
            .stand_in_http(reqwest::Method::POST, &path, Some(&body))
            .await
        {
            log_executor_event(
                "assistant preflight failure report failed",
                &[
                    ("execution_id", execution.to_owned()),
                    ("error", report_error.message),
                ],
            );
        }
    }

    pub(super) async fn recover_cloud_assistant_dispatches(&self) -> Result<(), AppIpcError> {
        if self.backend_connection_snapshot()?.is_none() {
            return Ok(());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let personal = store
            .declared_personal_stand_ins(&self.device_id)
            .map_err(settings_error)?;
        if !personal.iter().any(|settings| {
            settings["primary"]["enabled"] == true
                && settings["primary"]["collaboration"]["enabled"] == true
        }) {
            return Ok(());
        }
        for config in self.cloud_assistant_recovery_configs(&personal).await? {
            let project = config["projectId"].as_str().unwrap_or_default();
            let user = config["userId"].as_i64().unwrap_or_default();
            let path = format!(
                "/v1/cloud-projects/{project}/loop-items?assignee_type=user&assignee_id={user}"
            );
            let items = match self.stand_in_http(reqwest::Method::GET, &path, None).await {
                Ok(items) => items,
                Err(error) => {
                    log_executor_event(
                        "assistant project recovery failed",
                        &[("project_id", project.to_owned()), ("error", error.message)],
                    );
                    continue;
                }
            };
            for issue in items["items"].as_array().into_iter().flatten() {
                // Recovery only consumes durable intents; enabling a role never backfills history.
                if !issue["human_assistant_dispatch"].is_object()
                    || issue["cloud_project_id"] != project
                    || issue["assignee_user_id"] != user
                {
                    continue;
                }
                if let Err(error) = self
                    .start_cloud_stand_in_with_roles(std::slice::from_ref(&config), issue)
                    .await
                {
                    log_executor_event(
                        "assistant assignment recovery failed",
                        &[
                            ("issue_id", issue["id"].to_string()),
                            ("error", error.message),
                        ],
                    );
                }
            }
        }
        Ok(())
    }

    async fn cloud_assistant_recovery_configs(
        &self,
        personal: &[Value],
    ) -> Result<Vec<Value>, AppIpcError> {
        let connected = self
            .stand_in_http(reqwest::Method::GET, "/users/me", None)
            .await?;
        let personal: Vec<Value> = personal
            .iter()
            .filter(|settings| settings["userId"] == connected["id"])
            .cloned()
            .collect();
        let mut projects = std::collections::BTreeSet::new();
        for settings in &personal {
            let source = &settings["primary"]["collaboration"];
            if source["allProjects"] == true {
                match self
                    .stand_in_http(reqwest::Method::GET, "/v1/cloud-projects", None)
                    .await
                {
                    Ok(visible) => projects.extend(
                        visible["items"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(|project| project["id"].as_str().map(str::to_owned)),
                    ),
                    Err(error) => log_executor_event(
                        "assistant project discovery failed",
                        &[("error", error.message)],
                    ),
                }
            }
            projects.extend(
                source["projects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|project| project["store"] == "cloud")
                    .filter_map(|project| project["id"].as_str().map(str::to_owned)),
            );
        }
        Ok(projects
            .into_iter()
            .flat_map(|project| self.stand_in_project_configs(&personal, &project, "cloud"))
            .filter(|config| {
                config["id"] == "@primary"
                    && config["enabled"] == true
                    && config["handlingPolicy"]["automatic"] != false
            })
            .collect())
    }

    pub(super) async fn handle_stand_in_assignment(
        &self,
        payload: Value,
    ) -> Result<(), AppIpcError> {
        let (Some(project), Some(issue_id), Some(assignment)) = (
            payload["projectId"].as_str(),
            payload["itemId"].as_str(),
            payload["assignmentId"].as_str(),
        ) else {
            return Ok(());
        };
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
            return Ok(());
        }
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let personal = if issue["human_assistant_dispatch"].is_object() {
            store.declared_personal_stand_ins(&self.device_id)
        } else {
            store.all_personal_stand_ins(&self.device_id)
        }
        .map_err(settings_error)?;
        let configs: Vec<Value> = self
            .stand_in_project_configs(&personal, project, "cloud")
            .into_iter()
            .filter(|config| {
                config["enabled"] == true
                    && config["handlingPolicy"]["automatic"] != false
                    && config["userId"] == payload["recipientUserId"]
            })
            .collect();
        if configs.is_empty() {
            return Ok(());
        }
        self.verify_stand_in_user(&configs[0]).await?;
        if super::personal_stand_in::matching_personal_roles(&configs, &issue).is_empty() {
            return Ok(());
        }
        self.start_cloud_stand_in_with_roles(&configs, &issue).await
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
        issue: Arc<Mutex<Value>>,
        issues: Arc<Mutex<Value>>,
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
        let issue = Arc::new(Mutex::new(
            json!({"id":"issue","cloud_project_id":"project","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}}),
        ));
        let current_issue = issue.clone();
        let issues = Arc::new(Mutex::new(json!([])));
        let listed = issues.clone();
        let router = Router::new()
            .route("/api/users/me", get(|| async { Json(json!({"id":7})) }))
            .route("/api/v1/cloud-projects", get(|| async { Json(json!({"items":[{"id":"project"}]})) }))
            .route("/api/v1/cloud-projects/project/loop-items", get(move || {
                let items = listed.lock().unwrap().clone();
                async move { Json(json!({"items":items})) }
            }))
            .route("/api/v1/loop-items/issue", get(move || {
                let issue = current_issue.lock().unwrap().clone();
                async move { Json(issue) }
            }))
            .route("/api/v1/loop-items/issue/assignments", get(move || {
                assignment_calls.fetch_add(1, Ordering::SeqCst);
                let timestamp = created_at.clone();
                async move { Json(json!({"items":[{"id":"assignment","status":"active","created_at":timestamp}]})) }
            }))
            .route("/api/v1/loop-items/issue/tasks", get(move || {
                binding_calls.fetch_add(1, Ordering::SeqCst);
                async { Json(json!([
                    {"human_assignment_id":"human","device_id":"other","task_id":"stand-in-human-default"},
                    {"human_assignment_id":"human","device_id":"other","task_id":"stand-in-human-@primary"}
                ])) }
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
            issue,
            issues,
        }
    }

    fn notification() -> Value {
        json!({"method":"runtime.stand_in.assignment","payload":{"projectId":"project","itemId":"issue","assignmentId":"assignment","recipientUserId":7}})
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

    #[tokio::test]
    async fn durable_notification_does_not_rebind_another_devices_authorization() {
        let fixture = fixture("2099-01-01T00:00:00Z").await;
        let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
        let mut settings = store.personal_stand_in(7, "other").unwrap();
        settings["primary"] = json!({"enabled":true,"prompt":"Private","preferences":"",
            "collaboration":{"enabled":true,"allProjects":true,"projects":[],"excludedProjects":[],"tags":[]}});
        store.save_personal_stand_in(7, "other", settings).unwrap();
        fixture.issue.lock().unwrap()["human_assistant_dispatch"] =
            json!({"dispatchId":"dispatch","dispatchState":"waiting_device"});
        fixture
            .handler
            .handle_runtime_rpc(notification())
            .await
            .unwrap();
        assert_eq!(
            store.personal_stand_in(7, "").unwrap()["executionDeviceId"],
            "other"
        );
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 0);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn recovery_consumes_only_durable_current_assignments_without_notification_or_backfill() {
        let fixture = fixture("2020-01-01T00:00:00Z").await;
        let store = LocalTaskStore::open(fixture.handler.task_store_path.as_ref()).unwrap();
        let mut personal = store.personal_stand_in(7, "mac").unwrap();
        personal["primary"] = json!({"enabled":true,"prompt":"Handle assigned work","preferences":"",
            "collaboration":{"enabled":true,"allProjects":false,"projects":[{"id":"forbidden","store":"cloud"},{"id":"project","store":"cloud"}],"excludedProjects":[],"tags":[]}});
        store.save_personal_stand_in(7, "mac", personal).unwrap();
        let mut issue = json!({"id":"issue","cloud_project_id":"project","assignee_user_id":7,
            "human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
        *fixture.issues.lock().unwrap() = json!([issue.clone()]);
        fixture
            .handler
            .recover_cloud_assistant_dispatches()
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 0);

        issue["human_assistant_dispatch"] = json!({"dispatchState":"waiting_device"});
        let mut batch =
            vec![json!({"id":"history","cloud_project_id":"project","assignee_user_id":7}); 101];
        batch.push(issue.clone());
        *fixture.issues.lock().unwrap() = json!(batch);
        fixture
            .handler
            .recover_cloud_assistant_dispatches()
            .await
            .unwrap();
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 1);
        assert!(fixture.handler.local_task_links(true).is_empty());

        for state in [
            "no_authorized_assistant",
            "cancelled",
            "completed",
            "running",
        ] {
            issue["human_assistant_dispatch"]["dispatchState"] = json!(state);
            *fixture.issues.lock().unwrap() = json!([issue.clone()]);
            fixture
                .handler
                .recover_cloud_assistant_dispatches()
                .await
                .unwrap();
        }
        assert_eq!(fixture.assignments.load(Ordering::SeqCst), 1);
        assert_eq!(fixture.bindings.load(Ordering::SeqCst), 1);
    }
}
