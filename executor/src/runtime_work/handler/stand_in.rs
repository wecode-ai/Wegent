//! Device-owned personal automation. Cloud APIs only synchronize existing Issue work.
use super::stand_in_agent::apply_stand_in_agent;
use super::stand_in_workspace::apply_stand_in_workspace;
use super::*;

pub(super) fn settings_error(error: crate::task_runtime::TaskRuntimeError) -> AppIpcError {
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
    pub(super) async fn stand_in_http(
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

    pub(super) async fn verify_stand_in_user(&self, config: &Value) -> Result<(), AppIpcError> {
        let user = self
            .stand_in_http(reqwest::Method::GET, "/users/me", None)
            .await?;
        if user["id"] != config["userId"] {
            return Err(AppIpcError::new(
                "permission_denied",
                "Stand-in can only handle the connected user's assignments",
            ));
        }
        Ok(())
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
            settings["projectStore"] = json!(project_store);
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
        settings["userId"] = json!(user_id);
        store
            .save_stand_in_settings(&project, user_id, settings)
            .map_err(settings_error)
    }

    pub(super) async fn run_stand_in(&self, payload: Value) -> Result<Value, AppIpcError> {
        let project = string_field(&payload, "projectId")
            .ok_or_else(|| AppIpcError::new("bad_request", "projectId is required"))?;
        let issue_id = string_field(&payload, "issueId")
            .ok_or_else(|| AppIpcError::new("bad_request", "issueId is required"))?;
        let user = payload["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let local = match payload["projectStore"].as_str() {
            Some("local") => true,
            Some("cloud") => false,
            _ => return Err(AppIpcError::new("bad_request", "projectStore is required")),
        };
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let mut config = store
            .stand_in_settings(
                &project,
                user,
                payload["standInId"].as_str().unwrap_or("default"),
            )
            .map_err(settings_error)?;
        config["projectId"] = json!(project);
        config["projectStore"] = payload["projectStore"].clone();
        config["userId"] = json!(user);
        config["executionDeviceId"] = json!(self.device_id);
        config["manual"] = json!(true);
        if !local {
            self.verify_stand_in_user(&config).await?;
        }
        let gate = self.task_send_gate(&format!("stand-in-issue:{project}:{issue_id}"));
        let _guard = gate.lock().await;
        let mut issue = if local {
            serde_json::to_value(
                store
                    .get_task(&project, &issue_id)
                    .map_err(settings_error)?,
            )
            .unwrap()
        } else {
            self.stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}"),
                None,
            )
            .await?
        };
        let personal = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        let configs: Vec<Value> = personal["roles"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, role)| {
                crate::task_runtime::personal_stand_in::role_project_matches(
                    role,
                    &project,
                    if local { "local" } else { "cloud" },
                )
            })
            .map(|(order, role)| {
                let mut value = crate::task_runtime::personal_stand_in::project_role(
                    role,
                    user,
                    &project,
                    if local { "local" } else { "cloud" },
                    personal["autoSelect"] == true,
                );
                value["roleOrder"] = json!(order);
                value["personalVersion"] = personal["version"].clone();
                value
            })
            .collect();
        if payload["standInId"].is_null() {
            let mut issue_for_selection = issue.clone();
            if local {
                issue_for_selection["tags"] = issue["metadata"]["tags"].clone();
            }
            config = if let Some(selected) = self
                .select_personal_role(&configs, &issue_for_selection)
                .await?
            {
                selected
            } else {
                crate::task_runtime::personal_stand_in::project_role(
                    &personal["roles"][0],
                    user,
                    &project,
                    if local { "local" } else { "cloud" },
                    false,
                )
            };
            config["executionDeviceId"] = json!(self.device_id);
            config["manual"] = json!(true);
        }
        if issue["cloud_project_id"] == project
            && issue["assignee_user_id"].is_null()
            && issue["assignee_agent_id"].is_null()
            && issue["assignee_group_id"].is_null()
            && issue["assignee_team_id"].is_null()
        {
            issue = if local {
                serde_json::to_value(
                    store
                        .update_task(
                            &project,
                            &issue_id,
                            serde_json::from_value(
                                json!({"version":issue["version"],"assignee_user_id":user}),
                            )
                            .map_err(|error| AppIpcError::new("bad_request", error.to_string()))?,
                        )
                        .map_err(settings_error)?,
                )
                .unwrap()
            } else {
                self.stand_in_http(reqwest::Method::POST, &format!("/v1/cloud-projects/{project}/loop-items/{issue_id}/assign"), Some(&json!({"version":issue["version"],"assigneeType":"user","assigneeId":user.to_string(),"notifyAssignee":false}))).await?
            };
        }
        if issue["cloud_project_id"] != project || issue["assignee_user_id"] != user {
            return Err(AppIpcError::new(
                "invalid_assignment",
                "Choose an Issue assigned to yourself in this project",
            ));
        }
        let human_id = if local {
            let history = issue["metadata"]["assignment_history"]
                .as_array()
                .ok_or_else(|| {
                    AppIpcError::new("invalid_assignment", "Issue assignment is unavailable")
                })?;
            let assignment = history.last().ok_or_else(|| {
                AppIpcError::new("invalid_assignment", "Issue assignment is unavailable")
            })?;
            if assignment["to_type"] != "user"
                || assignment["to_id"].as_str() != Some(&user.to_string())
            {
                return Err(AppIpcError::new(
                    "invalid_assignment",
                    "Issue is no longer assigned to yourself",
                ));
            }
            let human = format!("{issue_id}-{}", history.len());
            self.start_local_stand_in(&config, &issue, &json!({"humanAssignmentId":human}))
                .await?;
            human
        } else {
            let human = issue["human_task_binding"]["humanAssignmentId"]
                .as_str()
                .ok_or_else(|| {
                    AppIpcError::new("invalid_assignment", "Issue assignment is unavailable")
                })?
                .to_owned();
            self.start_cloud_stand_in(&config, &issue).await?;
            human
        };
        let task_id = format!("stand-in-{human_id}");
        let task = self.local_task_link(&task_id);
        if task.as_ref().is_some_and(|task| task.status == "failed") {
            return Err(AppIpcError::new(
                "stand_in_start_failed",
                "The Stand-in task failed; open its Runtime task to recover",
            ));
        }
        if task.is_none() {
            return Err(AppIpcError::new(
                "assignment_already_handled",
                "This assignment has already been handled or is no longer active",
            ));
        }
        Ok(json!({"deviceId":self.device_id,"taskId":task_id}))
    }

    pub(super) async fn list_stand_in_settings(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let user_id = payload["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let rows = self.personal_stand_in_projects().await?;
        Ok(json!({"items": rows
            .into_iter()
            .filter(|row| row["userId"] == user_id && (payload["includeDisabled"] == true || row["enabled"] == true))
            .collect::<Vec<_>>() }))
    }

    pub(super) fn start_local_stand_in_scheduler(&self) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let handler = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = handler.poll_local_stand_ins().await {
                    log_executor_event("stand-in polling failed", &[("error", error.message)]);
                }
            }
        });
    }

    async fn poll_local_stand_ins(&self) -> Result<(), AppIpcError> {
        let settings = self.local_stand_in_projects()?;
        let mut projects = std::collections::HashMap::<(String, String, i64), Vec<Value>>::new();
        for config in settings {
            if config["executionDeviceId"] != self.device_id || config["enabled"] != true {
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
            let result = self.poll_local_stand_in(configs).await;
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
            if issue.assignee_user_id != configs[0]["userId"].as_i64() {
                continue;
            }
            let mut issue_value = serde_json::to_value(&issue).unwrap();
            issue_value["tags"] = issue.metadata["tags"].clone();
            let history = issue.metadata["assignment_history"].as_array();
            let Some(assignment) = history.and_then(|rows| rows.last()) else {
                continue;
            };
            if assignment["to_type"] != "user"
                || assignment["to_id"].as_str() != Some(&configs[0]["userId"].to_string())
            {
                continue;
            }
            let eligible: Vec<Value> = configs
                .iter()
                .filter(|config| {
                    assignment_after_enable(&json!({"created_at":assignment["at"]}), config)
                })
                .cloned()
                .collect();
            if eligible.is_empty() {
                continue;
            }
            let binding =
                json!({"humanAssignmentId":format!("{}-{}", issue.id, history.unwrap().len())});
            let task_id = format!(
                "stand-in-{}",
                binding["humanAssignmentId"].as_str().unwrap()
            );
            if self.local_task_link(&task_id).is_some()
                || store
                    .list_task_bindings(&issue.id)
                    .map_err(settings_error)?
                    .iter()
                    .any(|binding| binding.task_id == task_id)
            {
                continue;
            }
            let Some(config) = self
                .select_polled_personal_role(&eligible, &issue_value)
                .await
            else {
                continue;
            };
            if let Err(error) = self
                .start_local_stand_in(&config, &issue_value, &binding)
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

    async fn start_cloud_stand_in(&self, config: &Value, issue: &Value) -> Result<(), AppIpcError> {
        self.start_cloud_stand_in_with_roles(std::slice::from_ref(config), issue)
            .await
    }

    pub(super) async fn start_cloud_stand_in_with_roles(
        &self,
        configs: &[Value],
        issue: &Value,
    ) -> Result<(), AppIpcError> {
        let config = &configs[0];
        let gate = self.task_send_gate(&format!(
            "stand-in-issue:{}:{}",
            config["projectId"].as_str().unwrap_or_default(),
            issue["id"].as_str().unwrap_or_default()
        ));
        let _guard = if config["manual"] == true {
            None
        } else {
            Some(gate.lock().await)
        };
        if issue["assignee_user_id"] != config["userId"] {
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
        if config["manual"] != true
            && self
                .local_task_link(&format!("stand-in-{human_id}"))
                .is_some()
        {
            return Ok(());
        }
        let assignments = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/assignments"),
                None,
            )
            .await?;
        let Some(assignment) = assignments["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == assignment_id && row["status"] == "active")
        else {
            return Ok(());
        };
        let eligible: Vec<Value> = configs
            .iter()
            .filter(|config| {
                config["manual"] == true || assignment_after_enable(assignment, config)
            })
            .cloned()
            .collect();
        if eligible.is_empty() {
            return Ok(());
        }
        let existing = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                None,
            )
            .await?;
        if let Some(row) = existing
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["human_assignment_id"] == human_id)
        {
            let task_id = format!("stand-in-{human_id}");
            if config["manual"] == true
                && row["device_id"] == self.device_id
                && row["task_id"] == task_id
                && self
                    .local_task_link(&task_id)
                    .is_some_and(|task| task.status == "failed")
            {
                let payload = self.prepare_stand_in_task(config, issue, binding).await?;
                self.dispatch_stand_in_task(payload, true).await?;
            }
            return Ok(());
        }
        let selected = if config["manual"] == true {
            config.clone()
        } else {
            let Some(selected) = self.select_personal_role(&eligible, issue).await? else {
                return Ok(());
            };
            selected
        };
        let config = &selected;
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
        if config["projectStore"] == "cloud" {
            self.verify_stand_in_user(config).await?;
        }
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let human_id = binding["humanAssignmentId"].as_str().unwrap_or_default();
        let task_id = format!("stand-in-{human_id}");
        let gate = self.task_send_gate(&format!("stand-in-start:{task_id}"));
        let _guard = gate.lock().await;
        let existing = self.local_task_link(&task_id);
        let retry = existing
            .as_ref()
            .is_some_and(|task| config["manual"] == true && task.status == "failed");
        if existing.is_some() && !retry {
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
        let result = self.dispatch_stand_in_task(payload, retry).await;
        if let Err(error) = result {
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
    async fn dispatch_stand_in_task(
        &self,
        payload: Value,
        retry: bool,
    ) -> Result<Value, AppIpcError> {
        let result = if retry {
            self.send_message(payload).await
        } else {
            self.create_task(payload).await
        };
        result.and_then(|result| {
            if result["success"] == false || result["accepted"] == false {
                Err(AppIpcError::new(
                    "stand_in_start_failed",
                    result["error"]
                        .as_str()
                        .unwrap_or("Stand-in execution was not accepted"),
                ))
            } else {
                Ok(result)
            }
        })
    }

    async fn start_local_stand_in(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<(), AppIpcError> {
        let gate = self.task_send_gate(&format!(
            "stand-in-issue:{}:{}",
            config["projectId"].as_str().unwrap_or_default(),
            issue["id"].as_str().unwrap_or_default()
        ));
        let _guard = if config["manual"] == true {
            None
        } else {
            Some(gate.lock().await)
        };
        let task_id = format!(
            "stand-in-{}",
            binding["humanAssignmentId"].as_str().unwrap_or_default()
        );
        if self
            .local_task_link(&task_id)
            .is_some_and(|task| config["manual"] != true || task.status != "failed")
        {
            return Ok(());
        }
        let payload = self.prepare_stand_in_task(config, issue, binding).await?;
        self.create_stand_in_task(config, issue, binding, payload)
            .await
    }

    async fn prepare_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<Value, AppIpcError> {
        if config["projectStore"] == "cloud" {
            self.verify_stand_in_user(config).await?;
        }
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
        let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","trigger":if config["manual"] == true { "manual" } else { "assignment" },"standInId":config["id"],"roleName":config["name"],"selectionMode":config["selectionMode"],"selectionReason":config["selectionReason"],"projectStore":config["projectStore"],"cloudProjectId":project,"loopItemId":issue_id,"humanAssignmentId":human_id,"assignmentId":binding["assignmentId"],"dispatchId":binding["dispatchId"],"roundId":binding["dispatchRoundId"]});
        let mut payload = json!({"taskId":task_id,"title":issue["title"],"message":prompt,"cloudProjectId":project,"origin":origin});
        if config["goalMode"] == true {
            payload["initialGoal"] =
                json!({"objective":prompt,"status":"active","tokenBudget":null});
        }
        let agent = self.stand_in_agent(config).await?.or_else(|| {
            config["model"].is_object().then(|| json!({
                "id":"stand-in", "name":"Stand-in", "runtime":config["model"]["runtime"],
                "execution_policy":{"mode":"fixed","environment_id":self.device_id},
                "model_policy":{"mode":"user_select"}, "system_prompt":"", "additional_skills":[], "plugins":[], "mcp_servers":{}
            }))
        });
        if let Some(agent) = agent {
            let catalog = self.runner_catalog().await?;
            apply_stand_in_agent(
                &mut payload,
                &agent,
                &catalog,
                &self.device_id,
                config.get("model").filter(|model| model.is_object()),
            )?;
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
        if let Some(options) = config["modelOptions"].as_object() {
            let target = payload
                .as_object_mut()
                .unwrap()
                .entry("modelOptions")
                .or_insert_with(|| json!({}));
            target.as_object_mut().unwrap().extend(options.clone());
        }
        // Project agents are direct Wework profiles, not backend Teams.
        payload["executionRequest"]["team_id"] = json!(0);
        payload["executionRequest"]["user_id"] = config["userId"].clone();
        if config
            .get("workspace")
            .is_some_and(|workspace| !workspace.is_null())
        {
            apply_stand_in_workspace(&mut payload, config)?;
            return Ok(payload);
        }
        payload["executionRequest"]["standaloneChatWorkspace"] = json!(true);
        Ok(payload)
    }
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
        (Some(assigned), Some(enabled)) if config["projectStore"] == "cloud" => {
            // MySQL assignment records have second precision; compare the same precision.
            assigned.timestamp() >= enabled.timestamp()
        }
        (Some(assigned), Some(enabled)) => assigned >= enabled,
        _ => false,
    }
}

#[cfg(test)]
#[path = "stand_in_tests.rs"]
mod tests;
