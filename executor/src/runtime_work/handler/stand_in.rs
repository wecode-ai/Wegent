//! Device-owned personal automation. Cloud APIs only synchronize existing Issue work.
use super::*;

fn settings_error(error: crate::task_runtime::TaskRuntimeError) -> AppIpcError {
    let code = if matches!(
        error,
        crate::task_runtime::TaskRuntimeError::VersionConflict
    ) {
        "version_conflict"
    } else {
        "stand_in_settings"
    };
    AppIpcError::new(code, error.to_string())
}

impl RuntimeWorkRpcHandler {
    async fn stand_in_http(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AppIpcError> {
        let connection = self
            .backend_connection_snapshot()?
            .filter(|value| !value.backend_url.is_empty() && !value.auth_token.is_empty())
            .ok_or_else(|| {
                AppIpcError::new(
                    "cloud_unavailable",
                    "Connect this Executor to your cloud account",
                )
            })?;
        let client = crate::agents::backend_url::backend_http_client()
            .map_err(|error| AppIpcError::new("cloud_unavailable", error.to_string()))?;
        let mut request = client
            .request(
                method,
                format!("{}/api{path}", connection.backend_url.trim_end_matches('/')),
            )
            .bearer_auth(&connection.auth_token)
            .timeout(Duration::from_secs(10));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| AppIpcError::new("cloud_unavailable", error.to_string()))?;
        if !response.status().is_success() {
            return Err(AppIpcError::new(
                "cloud_request_failed",
                format!("Issue synchronization returned {}", response.status()),
            ));
        }
        if response.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        response
            .json()
            .await
            .map_err(|error| AppIpcError::new("cloud_response_invalid", error.to_string()))
    }

    pub(super) async fn stand_in_settings(
        &self,
        payload: Value,
        save: bool,
    ) -> Result<Value, AppIpcError> {
        let project = string_field(&payload, "projectId")
            .filter(|id| !id.is_empty())
            .ok_or_else(|| AppIpcError::new("bad_request", "projectId is required"))?;
        let user_id = payload["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let project_store = payload["projectStore"]
            .as_str()
            .filter(|value| matches!(*value, "local" | "cloud"))
            .ok_or_else(|| AppIpcError::new("bad_request", "projectStore is required"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        if !save {
            let mut settings = store
                .stand_in_settings(
                    &project,
                    user_id,
                    payload["standInId"].as_str().unwrap_or("default"),
                )
                .map_err(settings_error)?;
            settings["executionDeviceId"] = json!(self.device_id);
            return Ok(settings);
        }
        let mut settings = payload["settings"].clone();
        if settings["executionDeviceId"].as_str() != Some(self.device_id.as_str()) {
            return Err(AppIpcError::new(
                "wrong_device",
                "Save settings on the selected Executor",
            ));
        }
        settings["projectStore"] = json!(project_store);
        settings["projectId"] = json!(project);
        if settings["enabled"] == true {
            self.stand_in_agent(&settings).await?;
        }
        store
            .save_stand_in_settings(&project, user_id, settings)
            .map_err(settings_error)
    }

    pub(super) fn list_stand_in_settings(&self, payload: Value) -> Result<Value, AppIpcError> {
        let user_id = payload["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let rows = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(settings_error)?
            .enabled_stand_in_settings()
            .map_err(settings_error)?;
        Ok(json!(rows
            .into_iter()
            .filter(|row| row["userId"] == user_id)
            .collect::<Vec<_>>()))
    }

    pub(super) fn start_stand_in_scheduler(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = handler.poll_stand_ins().await {
                    log_executor_event("stand-in polling failed", &[("error", error.message)]);
                }
            }
        });
    }

    async fn poll_stand_ins(&self) -> Result<(), AppIpcError> {
        let settings = LocalTaskStore::open(self.task_store_path.as_ref())
            .map_err(settings_error)?
            .enabled_stand_in_settings()
            .map_err(settings_error)?;
        let mut projects = std::collections::HashMap::<(String, String, i64), Vec<Value>>::new();
        for config in settings {
            if config["executionDeviceId"] != self.device_id {
                continue;
            }
            projects
                .entry((
                    config["projectStore"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    config["projectId"].as_str().unwrap_or_default().to_owned(),
                    config["userId"].as_i64().unwrap_or_default(),
                ))
                .or_default()
                .push(config);
        }
        for configs in projects.values() {
            let config = &configs[0];
            let result = if config["projectStore"] == "local" {
                self.poll_local_stand_in(configs).await
            } else {
                self.poll_cloud_stand_in(configs).await
            };
            if let Err(error) = result {
                log_executor_event(
                    "stand-in project failed",
                    &[
                        ("project_id", config["projectId"].to_string()),
                        ("error", error.message),
                    ],
                );
            }
        }
        Ok(())
    }

    async fn poll_local_stand_in(&self, configs: &[Value]) -> Result<(), AppIpcError> {
        let project = configs[0]["projectId"].as_str().unwrap_or_default();
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        for issue in store.list_tasks(project).map_err(settings_error)? {
            if issue.assignee_user_id != configs[0]["userId"].as_i64()
                || issue.completed_at.is_some()
                || matches!(
                    issue.status.as_deref(),
                    Some("completed" | "cancelled" | "in_review")
                )
            {
                continue;
            }
            let mut issue_value = serde_json::to_value(&issue).unwrap();
            issue_value["tags"] = issue.metadata["tags"].clone();
            let Some(config) = matching_stand_in(configs, &issue_value) else {
                continue;
            };
            let history = issue.metadata["assignment_history"].as_array();
            let Some(assignment) = history.and_then(|rows| rows.last()) else {
                continue;
            };
            if assignment["to_type"] != "user"
                || assignment["to_id"].as_str() != Some(&config["userId"].to_string())
                || !assignment_after_enable(&json!({"created_at":assignment["at"]}), config)
            {
                continue;
            }
            let binding =
                json!({"humanAssignmentId":format!("{}-{}", issue.id, history.unwrap().len())});
            if let Err(error) = self
                .start_local_stand_in(config, &issue_value, &binding)
                .await
            {
                log_executor_event(
                    "stand-in assignment failed",
                    &[("issue_id", issue.id), ("error", error.message)],
                );
            }
        }
        Ok(())
    }

    async fn poll_cloud_stand_in(&self, configs: &[Value]) -> Result<(), AppIpcError> {
        let config = &configs[0];
        let user = self
            .stand_in_http(reqwest::Method::GET, "/users/me", None)
            .await?;
        if config["userId"] != user["id"] {
            return Ok(());
        }
        let Some(project_id) = config["projectId"].as_str() else {
            return Ok(());
        };
        let list = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/cloud-projects/{project_id}/loop-items"),
                None,
            )
            .await?;
        for issue in list["items"].as_array().into_iter().flatten() {
            let Some(config) = matching_stand_in(configs, issue) else {
                continue;
            };
            if let Err(error) = self.start_cloud_stand_in(config, issue).await {
                log_executor_event(
                    "stand-in assignment failed",
                    &[
                        ("issue_id", issue["id"].to_string()),
                        ("error", error.message),
                    ],
                );
            }
        }
        Ok(())
    }

    async fn start_cloud_stand_in(&self, config: &Value, issue: &Value) -> Result<(), AppIpcError> {
        if issue["assignee_user_id"] != config["userId"]
            || issue["completed_at"].is_string()
            || matches!(
                issue["status"].as_str(),
                Some("completed" | "cancelled" | "in_review")
            )
        {
            return Ok(());
        }
        let Some(issue_id) = issue["id"].as_str() else {
            return Ok(());
        };
        let binding = &issue["human_task_binding"];
        let Some(assignment_id) = binding["assignmentId"].as_str() else {
            return Ok(());
        };
        let Some(human_id) = binding["humanAssignmentId"].as_str() else {
            return Ok(());
        };
        let assignments = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/assignments"),
                None,
            )
            .await?;
        if !assignments["items"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| {
                row["id"] == assignment_id
                    && row["status"] == "active"
                    && assignment_after_enable(row, config)
            })
        {
            return Ok(());
        }
        let existing = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                None,
            )
            .await?;
        if existing
            .as_array()
            .into_iter()
            .flatten()
            .any(|row| row["human_assignment_id"] == human_id)
        {
            return Ok(());
        }
        let payload = self.prepare_stand_in_task(config, issue, binding).await?;
        self.create_stand_in_task(config, issue, binding, payload)
            .await
    }

    async fn create_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
        payload: Value,
    ) -> Result<(), AppIpcError> {
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let human_id = binding["humanAssignmentId"].as_str().unwrap_or_default();
        let task_id = format!("stand-in-{human_id}");
        if self.local_task_link(&task_id).is_some() {
            return Ok(());
        }
        let mut binding = binding.clone();
        binding["deviceId"] = json!(self.device_id);
        binding["taskId"] = json!(task_id);
        binding["taskTitle"] = issue["title"].clone();
        let local = config["projectStore"] == "local";
        if local {
            LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(settings_error)?
                .bind_task(
                    project,
                    Some(issue_id),
                    None,
                    serde_json::from_value(binding.clone())
                        .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?,
                    Some(&binding),
                )
                .map_err(settings_error)?;
        } else {
            self.stand_in_http(
                reqwest::Method::POST,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                Some(&binding),
            )
            .await?;
        }
        if let Err(error) = self.create_task(payload).await {
            let cleanup = if local {
                LocalTaskStore::open(self.task_store_path.as_ref())
                    .and_then(|store| store.unbind_task(&self.device_id, &task_id, Some(issue_id)))
                    .map_err(settings_error)
            } else {
                self.stand_in_http(
                    reqwest::Method::DELETE,
                    &format!("/v1/loop-items/{issue_id}/tasks"),
                    Some(&binding),
                )
                .await
                .map(|_| ())
            };
            if let Err(cleanup_error) = cleanup {
                log_executor_event(
                    "stand-in binding rollback failed",
                    &[("task_id", task_id), ("error", cleanup_error.message)],
                );
            }
            return Err(error);
        }
        Ok(())
    }
    async fn start_local_stand_in(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        let task_id = format!(
            "stand-in-{}",
            binding["humanAssignmentId"].as_str().unwrap_or_default()
        );
        if self.local_task_link(&task_id).is_some() {
            return Ok(());
        }
        let payload = self.prepare_stand_in_task(config, issue, binding).await?;
        self.create_stand_in_task(config, issue, binding, payload)
            .await
    }

    async fn stand_in_agent(&self, config: &Value) -> Result<Option<Value>, AppIpcError> {
        let Some(id) = config["agentId"].as_str().filter(|id| !id.is_empty()) else {
            return Ok(None);
        };
        let project = config["projectId"].as_str().unwrap_or_default();
        let rows = if config["projectStore"] == "local" {
            let agents = LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(settings_error)?
                .list_chat_agents(project)
                .map_err(settings_error)?;
            serde_json::to_value(agents)
                .map_err(|error| AppIpcError::new("invalid_agent", error.to_string()))?
        } else {
            self.stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/cloud-projects/{project}/chat-agents"),
                None,
            )
            .await?
        };
        let rows = if config["projectStore"] == "cloud" {
            json!(rows.as_array().into_iter().flatten().map(|row| json!({
                "id":row["id"],"name":row["name"],"runtime":row["runtime"],"status":row["status"],"can_use":row["canUse"],
                "execution_policy":row["executionPolicy"],"model_policy":row["modelPolicy"],"system_prompt":row["systemPrompt"],
                "additional_skills":row["additionalSkills"],"plugins":row["plugins"],"mcp_servers":row["mcpServers"]
            })).collect::<Vec<_>>())
        } else {
            rows
        };
        let agent = rows
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == id && row["status"] == "active" && row["can_use"] != false)
            .ok_or_else(|| {
                AppIpcError::new(
                    "agent_unavailable",
                    "The selected agent is unavailable in this project",
                )
            })?;
        if !matches!(agent["runtime"].as_str(), Some("codex" | "claude_code")) {
            return Err(AppIpcError::new(
                "unsupported_runtime",
                "Choose a Codex or Claude Code agent",
            ));
        }
        if !agent["execution_policy"].is_object() || !agent["model_policy"].is_object() {
            return Err(AppIpcError::new(
                "agent_configuration_required",
                "Configure the agent environment and model before enabling Stand-in",
            ));
        }
        let mut agent = agent.clone();
        if config["projectStore"] == "cloud"
            && agent["execution_policy"]["mode"] == "fixed"
            && agent["execution_policy"]["environment_id"] != self.device_id
        {
            // Cloud policies identify a Device resource; local routing uses its Executor id.
            let devices = self
                .stand_in_http(reqwest::Method::GET, "/devices/online", None)
                .await?;
            let matches = devices["items"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|device| {
                    device["id"].to_string().trim_matches('"')
                        == agent["execution_policy"]["environment_id"]
                            .as_str()
                            .unwrap_or_default()
                        && ["device_id", "app_device_id"]
                            .iter()
                            .any(|key| device[key] == self.device_id)
                });
            if !matches {
                return Err(AppIpcError::new(
                    "agent_device_conflict",
                    "The selected agent requires another device",
                ));
            }
            agent["execution_policy"]["environment_id"] = json!(self.device_id);
        }
        Ok(Some(agent))
    }

    async fn prepare_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<Value, AppIpcError> {
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let human_id = binding["humanAssignmentId"].as_str().unwrap_or_default();
        let task_id = format!("stand-in-{human_id}");
        let protocol = if config["projectStore"] == "local" {
            "local"
        } else {
            "cloud"
        };
        let prompt = format!(
            "[项目空间 Issue] {protocol}://projects/{project}/todos/{issue_id}\n\n{}\n\n{}\n\n{}",
            issue["title"].as_str().unwrap_or_default(),
            issue["description"].as_str().unwrap_or_default(),
            config["prompt"].as_str().unwrap_or_default()
        );
        let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","standInId":config["id"],"projectStore":config["projectStore"],"cloudProjectId":project,"loopItemId":issue_id,"humanAssignmentId":human_id,"assignmentId":binding["assignmentId"],"dispatchId":binding["dispatchId"],"roundId":binding["dispatchRoundId"]});
        let mut payload = json!({"taskId":task_id,"title":issue["title"],"message":prompt,"cloudProjectId":project,"origin":origin});
        if let Some(agent) = self.stand_in_agent(config).await? {
            let catalog = self.runner_catalog().await?;
            apply_stand_in_agent(&mut payload, &agent, &catalog, &self.device_id)?;
            self.materialize_runner_cloud_models(&mut payload).await?;
        } else {
            let mut request = ExecutionRequest {
                prompt: payload["message"].clone(),
                bot: json!([{"name":"Stand-in","shell_type":"Codex"}]),
                new_session: true,
                ..Default::default()
            };
            request.extra.insert("origin".into(), origin);
            payload["executionRequest"] = json!(request);
        }
        // Project agents are direct Wework profiles, not backend Teams.
        payload["executionRequest"]["team_id"] = json!(0);
        payload["executionRequest"]["user_id"] = config["userId"].clone();
        let metadata = if config["projectStore"] == "local" {
            LocalTaskStore::open(self.task_store_path.as_ref())
                .map_err(settings_error)?
                .get_project(project)
                .map_err(settings_error)?
                .metadata
        } else {
            let project = self
                .stand_in_http(
                    reqwest::Method::GET,
                    &format!("/v1/cloud-projects/{project}"),
                    None,
                )
                .await?;
            json!({"execution_environment": project["execution_environment"]})
        };
        crate::task_runtime::apply_project_workspace(
            &mut payload,
            &metadata,
            &self.device_id,
            project,
        )
        .map_err(settings_error)?;
        Ok(payload)
    }
}

fn matching_stand_in<'a>(configs: &'a [Value], issue: &Value) -> Option<&'a Value> {
    let mut tagged = Vec::new();
    let mut defaults = Vec::new();
    for config in configs {
        let tags = config["tags"].as_array();
        if tags.map_or(true, |tags| tags.is_empty()) {
            defaults.push(config);
        } else if tags.unwrap().iter().any(|tag| {
            issue["tags"]
                .as_array()
                .is_some_and(|tags| tags.contains(tag))
        }) {
            tagged.push(config);
        }
    }
    let matches = if tagged.is_empty() { defaults } else { tagged };
    if matches.len() > 1 {
        log_executor_event(
            "stand-in tag conflict",
            &[("issue_id", issue["id"].to_string())],
        );
        return None;
    }
    matches.first().copied()
}

fn apply_stand_in_agent(
    payload: &mut Value,
    agent: &Value,
    catalog: &Value,
    device: &str,
) -> Result<(), AppIpcError> {
    let runtime = agent["runtime"].as_str().unwrap_or("codex");
    let default_model = catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|model| model["runtime"] == runtime && model["is_default"] == true)
        .cloned()
        .unwrap_or(Value::Null);
    payload["runtime"] = json!(runtime);
    payload["runnerPolicy"] = json!({"runtime":runtime,"execution_policy":agent["execution_policy"],"model_policy":agent["model_policy"]});
    payload["runnerSelection"] =
        json!({"execution_policy":{"mode":"fixed","environment_id":device},"model":default_model});
    payload["projectInstructions"] = agent["system_prompt"].clone();
    payload["additionalSkills"] = agent["additional_skills"].clone();
    payload["projectPlugins"] = agent["plugins"].clone();
    payload["bot"] = json!([{"id":agent["id"],"name":agent["name"],"shell_type":if runtime == "claude_code" {"ClaudeCode"} else {"Codex"},"mcp_servers":agent["mcp_servers"]}]);
    crate::task_runtime::runner_routing::resolve_pending(payload, Some(catalog), device)
        .map_err(settings_error)
}

fn assignment_after_enable(assignment: &Value, config: &Value) -> bool {
    let parse = |value: &Value| {
        value
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
    };
    match (
        parse(&assignment["created_at"]),
        parse(&config["enabledAfter"]),
    ) {
        (Some(assigned), Some(enabled)) => assigned >= enabled,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn tag_rules_prefer_a_specific_stand_in_and_never_choose_an_ambiguous_match() {
        let configs = vec![
            json!({"id":"default","tags":[]}),
            json!({"id":"review","tags":["review","security"]}),
            json!({"id":"docs","tags":["docs"]}),
        ];
        assert_eq!(
            matching_stand_in(&configs, &json!({"tags":["review"]})).unwrap()["id"],
            "review"
        );
        assert_eq!(
            matching_stand_in(&configs, &json!({"tags":["other"]})).unwrap()["id"],
            "default"
        );
        assert!(matching_stand_in(&configs, &json!({"tags":["review","docs"]})).is_none());
        assert!(matching_stand_in(&configs[1..], &json!({"tags":["other"]})).is_none());
    }

    #[test]
    fn selected_agent_uses_existing_runner_compiler_and_keeps_capabilities() {
        let model = json!({"runtime":"codex","provider":"native","model_id":"model"});
        let agent = json!({"id":"reviewer","name":"Reviewer","runtime":"codex","execution_policy":{"mode":"fixed","environment_id":"mac"},"model_policy":{"mode":"fixed","model":model},"system_prompt":"Review carefully","additional_skills":["review"],"plugins":[{"id":"plugin"}],"mcp_servers":{"tools":{}}});
        let catalog = json!({"runtimes":["codex"],"models":[{"runtime":"codex","provider":"native","model_id":"model","local_model_id":"model","is_default":true}]});
        let mut payload = json!({"taskId":"task","message":"Handle this task","origin":{"initiatedBy":"stand_in"}});
        apply_stand_in_agent(&mut payload, &agent, &catalog, "mac").unwrap();
        assert_eq!(
            payload["executionRequest"]["system_prompt"],
            "Review carefully"
        );
        assert_eq!(payload["executionRequest"]["bot"][0]["id"], "reviewer");
        assert_eq!(
            payload["executionRequest"]["preload_skills"],
            json!(["review"])
        );
        assert_eq!(
            payload["executionRequest"]["model_config"]["model_id"],
            "model"
        );
        assert!(apply_stand_in_agent(&mut json!({}), &agent, &catalog, "another-device").is_err());
    }

    #[test]
    fn historical_and_invalid_assignments_never_trigger() {
        let settings = json!({"enabledAfter":"2026-10-20T12:00:00Z"});
        assert!(!assignment_after_enable(
            &json!({"created_at":"2026-10-20T11:59:59Z"}),
            &settings
        ));
        assert!(assignment_after_enable(
            &json!({"created_at":"2026-10-20T12:00:01Z"}),
            &settings
        ));
        assert!(assignment_after_enable(
            &json!({"created_at":"2026-10-20T20:00:01+08:00"}),
            &settings
        ));
        assert!(!assignment_after_enable(
            &json!({"created_at":"2026-10-20T20:00:01"}),
            &settings
        ));
        assert!(!assignment_after_enable(
            &json!({"created_at":"invalid"}),
            &settings
        ));
    }

    #[tokio::test]
    async fn existing_manual_binding_prevents_another_device_from_creating_a_task() {
        let bindings = Arc::new(AtomicUsize::new(0));
        let calls = bindings.clone();
        let router = Router::new()
            .route("/api/v1/loop-items/issue/assignments", get(|| async { Json(json!({"items":[{"id":"assignment","status":"active","created_at":"2026-10-20T12:00:01Z"}]})) }))
            .route("/api/v1/loop-items/issue/tasks", get(move || {
                calls.fetch_add(1, Ordering::SeqCst);
                async { Json(json!([{"human_assignment_id":"human","device_id":"other"}])) }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        handler.backend_connection = Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: url,
            auth_token: "test".into(),
            ..Default::default()
        })));
        let config =
            json!({"projectId":"project","userId":7,"enabledAfter":"2026-10-20T12:00:00Z"});
        let issue = json!({"id":"issue","assignee_user_id":7,"human_task_binding":{"humanAssignmentId":"human","assignmentId":"assignment"}});
        handler.start_cloud_stand_in(&config, &issue).await.unwrap();
        assert_eq!(bindings.load(Ordering::SeqCst), 1);
        assert!(handler.local_task_link("stand-in-human").is_none());
        server.abort();
    }

    #[tokio::test]
    async fn rejected_local_creation_rolls_back_the_issue_binding() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let store = LocalTaskStore::open(handler.task_store_path.as_ref()).unwrap();
        let project = store
            .create_project(serde_json::from_value(json!({"name":"Stand-in"})).unwrap())
            .unwrap();
        let issue = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({"title":"Issue"})).unwrap(),
            )
            .unwrap();
        let error = handler
            .create_stand_in_task(
                &json!({"projectId":project.id,"projectStore":"local"}),
                &serde_json::to_value(&issue).unwrap(),
                &json!({"humanAssignmentId":"human"}),
                json!({"schemaVersion":99}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "unsupported_schema_version");
        assert!(store
            .find_user_task_binding("mac", "stand-in-human")
            .is_err());
        assert!(handler.local_task_link("stand-in-human").is_none());
    }

    #[tokio::test]
    async fn rejected_cloud_creation_rolls_back_the_issue_binding() {
        let bindings = Arc::new(AtomicUsize::new(0));
        let created = bindings.clone();
        let removed = bindings.clone();
        let router = Router::new().route(
            "/api/v1/loop-items/issue/tasks",
            axum::routing::post(move || {
                created.fetch_add(1, Ordering::SeqCst);
                async { Json(json!({"id":1})) }
            })
            .delete(move || {
                removed.fetch_sub(1, Ordering::SeqCst);
                async { axum::http::StatusCode::NO_CONTENT }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async { axum::serve(listener, router).await.unwrap() });
        let handler = RuntimeWorkRpcHandler {
            backend_connection: Arc::new(Mutex::new(Some(ConnectionConfig {
                backend_url: url,
                auth_token: "test".into(),
                ..Default::default()
            }))),
            ..RuntimeWorkRpcHandler::new("mac", "unused")
        };
        let error = handler
            .create_stand_in_task(
                &json!({"projectId":"project","projectStore":"cloud"}),
                &json!({"id":"issue","title":"Issue"}),
                &json!({"humanAssignmentId":"human"}),
                json!({"schemaVersion":99}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "unsupported_schema_version");
        assert_eq!(bindings.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn executor_rejects_settings_for_a_different_device() {
        let root = tempfile::tempdir().unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("mac", "unused");
        handler.task_store_path = Arc::new(root.path().join("tasks.sqlite"));
        let error = handler.stand_in_settings(json!({"projectId":"project","userId":7,"projectStore":"local","settings":{"executionDeviceId":"cloud"}}), true).await.unwrap_err();
        assert_eq!(error.code, "wrong_device");
    }
}
