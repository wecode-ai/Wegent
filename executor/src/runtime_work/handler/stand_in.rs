//! Device-owned personal automation. Cloud APIs only synchronize existing Issue work.
use super::stand_in_agent::apply_stand_in_agent;
use super::stand_in_workspace::apply_stand_in_workspace;
use super::*;
use crate::runtime_work::response::local_task_json;

pub(super) fn stand_in_issue_identity(config: &Value, issue: &Value) -> String {
    use sha2::{Digest, Sha256};
    let identity = json!([
        config["userId"],
        config["id"],
        config["projectStore"],
        config["projectId"],
        issue["id"]
    ]);
    format!(
        "stand-in-issue-{:x}",
        Sha256::digest(identity.to_string().as_bytes())
    )
}

pub(super) fn stand_in_issue_receipt_binding(config: &Value, issue: &Value) -> Value {
    if issue["assignee_user_id"] != config["userId"] {
        return json!({});
    }
    if config["projectStore"] == "cloud" {
        return issue
            .get("human_task_binding")
            .filter(|binding| binding.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
    }
    let Some(history) = issue["metadata"]["assignment_history"].as_array() else {
        return json!({});
    };
    json!({"humanAssignmentId":format!("{}-{}", issue["id"].as_str().unwrap_or_default(), history.len())})
}

impl RuntimeWorkRpcHandler {
    /// Notification history follows assignment ownership, including archived work.
    pub(super) fn stand_in_assignment_tasks(&self, payload: Value) -> Result<Value, AppIpcError> {
        let user = payload["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("bad_request", "userId is required"))?;
        let assignments = payload["assignments"]
            .as_array()
            .ok_or_else(|| AppIpcError::new("bad_request", "assignments is required"))?;
        let items: Vec<Value> = self
            .local_task_links(true)
            .into_iter()
            .filter(|task| {
                let origin = &task.runtime_handle["origin"];
                !self.archived_link_is_deleted(task)
                    && origin["initiatedBy"] == "stand_in"
                    && origin["projectStore"] == "cloud"
                    && origin["userId"] == user
                    && assignments.iter().any(|assignment| {
                        ["projectId", "itemId", "humanAssignmentId"]
                            .iter()
                            .all(|key| {
                                assignment[key]
                                    .as_str()
                                    .is_some_and(|value| !value.is_empty())
                            })
                            && assignment["projectId"] == origin["cloudProjectId"]
                            && assignment["itemId"] == origin["loopItemId"]
                            && assignment["humanAssignmentId"] == origin["humanAssignmentId"]
                    })
            })
            .map(local_task_json)
            .collect();
        Ok(json!({"items":items}))
    }
}

/// Map persistence errors to stable settings failures while retaining version-conflict recovery.
pub(super) fn settings_error(error: crate::task_runtime::TaskRuntimeError) -> AppIpcError {
    let code = match &error {
        crate::task_runtime::TaskRuntimeError::VersionConflict => "version_conflict",
        crate::task_runtime::TaskRuntimeError::MemorySuppressed => "memory_suppressed",
        _ => "stand_in_settings",
    };
    AppIpcError::new(code, error.to_string())
}

pub(super) fn issue_assignment_event_id(binding: &Value) -> Result<&str, AppIpcError> {
    // Member work identities belong to the manager's round, not the Issue activity stream.
    let field = if binding["dispatchRoundId"]
        .as_str()
        .is_some_and(|round| round != "direct")
    {
        "issueAssignmentId"
    } else {
        "assignmentId"
    };
    binding[field]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            AppIpcError::new(
                "invalid_assignment",
                "Issue assignment event identity is missing",
            )
        })
}

impl RuntimeWorkRpcHandler {
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
        settings["id"] = json!(settings["id"].as_str().unwrap_or("default").to_owned());
        if settings["executionDeviceId"].as_str() != Some(self.device_id.as_str()) {
            return Err(AppIpcError::new(
                "wrong_device",
                "Save settings on the selected Executor",
            ));
        }
        settings["projectStore"] = json!(project_store);
        settings["projectId"] = json!(project);
        settings["userId"] = json!(user_id);
        let gate = self.task_send_gate(&format!("stand-in-processing:{user_id}"));
        let _guard = gate.lock().await;
        let previous = store
            .personal_stand_in(user_id, &self.device_id)
            .map_err(settings_error)?;
        if settings.get("connections").is_none() {
            if let Some(role) = previous["roles"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|role| role["id"] == settings["id"])
            {
                if role["connections"].is_array() {
                    settings["connections"] = role["connections"].clone();
                }
            }
        }
        let mut prepared = json!({"roles":[settings]});
        self.preflight_git_connections(&prepared, &previous).await?;
        self.prepare_connection_boundaries(&mut prepared, &previous)
            .await?;
        let settings = prepared["roles"][0].clone();
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
        let kind = if local { "local" } else { "cloud" };
        let selected = if payload["standInId"].is_string() {
            None
        } else {
            self.stand_in_project_configs(
                &[store
                    .personal_stand_in(user, &self.device_id)
                    .map_err(settings_error)?],
                &project,
                kind,
            )
            .into_iter()
            .next()
        };
        let mut config = store
            .stand_in_settings(
                &project,
                user,
                payload["standInId"]
                    .as_str()
                    .or_else(|| selected.as_ref().and_then(|role| role["id"].as_str()))
                    .unwrap_or("default"),
            )
            .map_err(settings_error)?;
        config["projectId"] = json!(project);
        config["projectStore"] = payload["projectStore"].clone();
        config["userId"] = json!(user);
        config["executionDeviceId"] = json!(self.device_id);
        config["manual"] = json!(true);
        if !local {
            self.verify_runtime_user(&config).await?;
        }
        let gate = self.task_send_gate(&format!("stand-in-issue:{project}:{issue_id}"));
        let _guard = gate.lock().await;
        let issue = if local {
            serde_json::to_value(
                store
                    .get_task(&project, &issue_id)
                    .map_err(settings_error)?,
            )
            .unwrap()
        } else {
            self.runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}"),
                None,
            )
            .await?
        };
        if issue["cloud_project_id"] != project {
            return Err(AppIpcError::new(
                "permission_denied",
                "Issue does not belong to this project",
            ));
        }
        self.log_stand_in_decision(
            &config,
            &issue,
            "manual_role_selected",
            json!({
                "requestedRoleId":payload["standInId"],"enabled":config["enabled"]
            }),
        );
        if local {
            self.start_manual_stand_in_attempt(&config, &issue).await?;
        } else {
            self.start_cloud_stand_in_with_roles(std::slice::from_ref(&config), &issue)
                .await?;
        }
        let task_id = self.stand_in_task_id(&config, &issue);
        let task = self
            .local_task_link(&task_id)
            .filter(|task| !self.archived_link_is_deleted(task));
        if task.as_ref().is_some_and(|task| task.status == "failed") {
            return Err(AppIpcError::new(
                "stand_in_start_failed",
                "The Stand-in task failed; open its Runtime task to recover",
            ));
        }
        if task.is_none() {
            self.log_stand_in_decision(
                &config,
                &issue,
                "manual_task_missing",
                json!({"expectedTaskId":task_id}),
            );
            return Err(AppIpcError::new(
                "assignment_already_handled",
                "This conversation was already handled or removed",
            ));
        }
        Ok(json!({"deviceId":self.device_id,"taskId":task_id}))
    }

    pub(super) async fn start_manual_stand_in_attempt(
        &self,
        config: &Value,
        issue: &Value,
    ) -> Result<(), AppIpcError> {
        let task_id = self.stand_in_task_id(config, issue);
        if config["recoveringDispatch"] == true
            && (self.local_task_link(&task_id).is_some()
                || self.store.is_deleted_archived_task_id(&task_id))
        {
            return Ok(());
        }
        if config["projectStore"] != "local" {
            let issue_id = issue["id"].as_str().unwrap_or_default();
            let existing = self
                .runtime_http(
                    reqwest::Method::GET,
                    &format!("/v1/loop-items/{issue_id}/tasks"),
                    None,
                )
                .await?;
            if !self.use_stand_in_issue_reservation(config, issue, &existing)? {
                return Err(AppIpcError::new(
                    "wrong_device",
                    "Open the existing Issue conversation on its owning device",
                ));
            }
        }
        let task_id = self.stand_in_task_id(config, issue);
        if self.local_task_link(&task_id).is_some_and(|task| {
            !self.archived_link_is_deleted(&task)
                && !matches!(task.status.as_str(), "failed" | "archived")
        }) {
            return Ok(());
        }
        self.execute_stand_in_task(
            config,
            issue,
            &stand_in_issue_receipt_binding(config, issue),
        )
        .await
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
        let receipt_handler = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                receipt_handler.flush_stand_in_task_results().await;
                if let Err(error) = receipt_handler
                    .flush_stand_in_proposal_continuations()
                    .await
                {
                    log_executor_event(
                        "stand-in proposal continuation failed",
                        &[("code", error.code)],
                    );
                }
                if let Err(error) = receipt_handler.flush_assignment_receipts().await {
                    log_executor_event(
                        "Assignment receipt synchronization failed",
                        &[("error", error.message)],
                    );
                }
            }
        });
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
        let handler = self.clone();
        runtime.spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                // Cloud outages must not delay local assignment polling or receipts.
                if let Err(error) = handler.collect_stand_in_issue_events().await {
                    log_executor_event(
                        "Stand-in Issue event collection failed",
                        &[("code", error.code)],
                    );
                }
                if let Err(error) = handler.flush_stand_in_dispatches().await {
                    log_executor_event(
                        "Stand-in dispatch reconciliation failed",
                        &[("code", error.code)],
                    );
                }
            }
        });
    }

    async fn poll_local_stand_ins(&self) -> Result<(), AppIpcError> {
        let settings = self.local_stand_in_projects()?;
        let mut projects = std::collections::HashMap::<(String, String, i64), Vec<Value>>::new();
        for config in settings {
            if config["executionDeviceId"] != self.device_id
                || config["enabled"] != true
                || config["handlingPolicy"]["automatic"] == false
            {
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
            let bindings = store
                .list_task_bindings(&issue.id)
                .map_err(settings_error)?;
            let previous = format!(
                "stand-in-{}",
                binding["humanAssignmentId"].as_str().unwrap()
            );
            if bindings.iter().any(|row| row.task_id == previous) {
                continue;
            }
            for config in super::personal_stand_in::matching_personal_roles(&eligible, &issue_value)
            {
                let task_id = self.stand_in_task_id(config, &issue_value);
                if self.stand_in_assignment_is_handled(config, &task_id, &binding) {
                    continue;
                }
                if let Err(error) = self
                    .start_local_stand_in(config, &issue_value, &binding)
                    .await
                {
                    log_executor_event(
                        "stand-in assignment failed",
                        &[
                            ("issue_id", issue.id.clone()),
                            ("role_id", config["id"].to_string()),
                            ("error", error.message),
                        ],
                    );
                }
            }
        }
        Ok(())
    }

    pub(super) async fn start_cloud_stand_in_with_roles(
        &self,
        configs: &[Value],
        issue: &Value,
    ) -> Result<(), AppIpcError> {
        let intents = self.queue_stand_in_dispatches(configs, issue)?;
        let result = if configs
            .first()
            .is_some_and(|config| config["manual"] == true)
        {
            let mut result = Ok(());
            for config in configs {
                if let Err(error) = self.start_manual_stand_in_attempt(config, issue).await {
                    result = Err(error);
                }
            }
            result
        } else {
            self.start_cloud_assignment_attempt(configs, issue).await
        };
        self.settle_stand_in_dispatches(&intents, result.as_ref().err());
        result
    }

    pub(super) async fn start_cloud_assignment_attempt(
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
        let _guard = gate.lock().await;
        if issue["assignee_user_id"] != config["userId"] {
            self.log_stand_in_decision(
                config,
                issue,
                "assignee_mismatch",
                json!({"actualAssigneeUserId":issue["assignee_user_id"]}),
            );
            return Ok(());
        }
        let Some(issue_id) = issue["id"].as_str() else {
            self.log_stand_in_decision(config, issue, "issue_id_missing", json!({}));
            return Ok(());
        };
        let binding = &issue["human_task_binding"];
        if binding["assignmentId"].as_str().is_none() {
            self.log_stand_in_decision(config, issue, "assignment_identity_missing", json!({}));
            return Ok(());
        }
        if binding["humanAssignmentId"].as_str().is_none() {
            self.log_stand_in_decision(
                config,
                issue,
                "human_assignment_identity_missing",
                json!({}),
            );
            return Ok(());
        }
        let matching = super::personal_stand_in::matching_personal_roles(configs, issue);
        if matching.is_empty() {
            self.log_stand_in_decision(config, issue, "no_matching_role_tags", json!({}));
            return Ok(());
        }
        if matching.iter().all(|role| {
            self.stand_in_assignment_is_handled(role, &self.stand_in_task_id(role, issue), binding)
        }) {
            self.log_stand_in_decision(config, issue, "local_tasks_already_exist", json!({}));
            return Ok(());
        }
        let assignments = self
            .runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/assignments"),
                None,
            )
            .await?;
        let event_id = issue_assignment_event_id(binding)?;
        let Some(assignment) = assignments["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == event_id && row["status"] == "active")
        else {
            let active: Vec<Value> = assignments["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| json!({"id":row["id"],"status":row["status"]}))
                .collect();
            self.log_stand_in_decision(
                config,
                issue,
                "active_assignment_not_found",
                json!({"assignments":active}),
            );
            return Ok(());
        };
        let eligible: Vec<&Value> = matching
            .into_iter()
            .filter(|config| assignment_after_enable(assignment, config))
            .collect();
        if eligible.is_empty() {
            self.log_stand_in_decision(config, issue, "assignment_before_role_enabled", json!({
                "assignedAt":assignment["created_at"],
                "roleEnableTimes":configs.iter().map(|role|json!({"id":role["id"],"enabledAfter":role["enabledAfter"]})).collect::<Vec<_>>()
            }));
            return Ok(());
        }
        let existing = self
            .runtime_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{issue_id}/tasks"),
                None,
            )
            .await?;
        let previous = format!(
            "stand-in-{}",
            binding["humanAssignmentId"].as_str().unwrap()
        );
        if existing.as_array().into_iter().flatten().any(|row| {
            row["human_assignment_id"] == binding["humanAssignmentId"] && row["task_id"] == previous
        }) {
            self.log_stand_in_decision(
                config,
                issue,
                "legacy_assignment_binding_exists",
                json!({"taskId":previous}),
            );
            return Ok(());
        }
        self.dispatch_cloud_stand_in_roles(&eligible, issue, binding, &existing)
            .await
    }

    pub(super) async fn dispatch_cloud_stand_in_roles(
        &self,
        configs: &[&Value],
        issue: &Value,
        binding: &Value,
        existing: &Value,
    ) -> Result<(), AppIpcError> {
        let mut failure = None;
        for config in configs {
            let result = self
                .dispatch_cloud_stand_in_role(config, issue, binding, existing)
                .await;
            if let Err(error) = result {
                log_executor_event(
                    "stand-in assignment failed",
                    &[
                        (
                            "issue_id",
                            issue["id"].as_str().unwrap_or_default().to_owned(),
                        ),
                        ("role_id", config["id"].to_string()),
                        ("error", error.message.clone()),
                    ],
                );
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn dispatch_cloud_stand_in_role(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
        existing: &Value,
    ) -> Result<(), AppIpcError> {
        if !self.use_stand_in_issue_reservation(config, issue, existing)? {
            return Ok(());
        }
        // Same-device reservations are not proof that a local task was accepted.
        self.execute_stand_in_task(config, issue, binding).await
    }

    pub(super) fn use_stand_in_issue_reservation(
        &self,
        config: &Value,
        issue: &Value,
        existing: &Value,
    ) -> Result<bool, AppIpcError> {
        let task_id = self.stand_in_task_id(config, issue);
        let rows: Vec<_> = existing
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| {
                !row["task_user_id"]
                    .as_i64()
                    .is_some_and(|owner| Some(owner) != config["userId"].as_i64())
            })
            .collect();
        let identity = stand_in_issue_identity(config, issue);
        let bound = rows
            .iter()
            .copied()
            .find(|row| row["stand_in_conversation_id"] == identity)
            .or_else(|| rows.iter().copied().find(|row| row["task_id"] == task_id))
            .or_else(|| {
                rows.iter().copied().find(|row| {
                    row["human_assignment_id"]
                        .as_str()
                        .is_some_and(|assignment| {
                            row["task_id"]
                                == format!(
                                    "stand-in-{assignment}-{}",
                                    config["id"].as_str().unwrap_or_default()
                                )
                        })
                })
            });
        if bound.is_some_and(|row| row["device_id"] != self.device_id) {
            let row = bound.unwrap();
            self.log_stand_in_decision(
                config,
                issue,
                "role_assignment_binding_exists",
                json!({
                    "taskId":task_id,"bindingDeviceId":row["device_id"],
                    "localTaskExists":self.local_task_link(&task_id).is_some()
                }),
            );
            return Ok(false);
        }
        if self.local_task_link(&task_id).is_none() {
            if let Some(reserved) = bound.and_then(|row| row["task_id"].as_str()) {
                self.store
                    .bind_issue_conversation(&stand_in_issue_identity(config, issue), reserved)
                    .map_err(|error| AppIpcError::new("stand_in_settings", error.to_string()))?;
            }
        }
        Ok(true)
    }

    pub(super) async fn start_local_stand_in(
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
        self.execute_stand_in_task(config, issue, binding).await
    }

    pub(super) fn stand_in_task_id(&self, config: &Value, issue: &Value) -> String {
        let identity = stand_in_issue_identity(config, issue);
        if let Some(task) = self.store.issue_conversation(&identity) {
            return task;
        }
        // Keep the oldest existing conversation, including pre-upgrade assignment sessions.
        if let Some(task) = self
            .local_task_links(true)
            .into_iter()
            .filter(|task| {
                let origin = &task.runtime_handle["origin"];
                origin["initiatedBy"] == "stand_in"
                    && origin["type"] == "issue_dispatch"
                    && origin["loopItemId"] == issue["id"]
                    && origin["standInId"] == config["id"]
                    && origin["userId"] == config["userId"]
                    && origin["projectStore"] == config["projectStore"]
                    && origin["cloudProjectId"] == config["projectId"]
            })
            .min_by_key(|task| (task.created_at, task.local_task_id.clone()))
        {
            return task.local_task_id;
        }
        identity
    }

    pub(super) async fn prepare_stand_in_task(
        &self,
        config: &Value,
        issue: &Value,
        binding: &Value,
    ) -> Result<Value, AppIpcError> {
        if config["projectStore"] == "cloud" {
            self.verify_runtime_user(config).await?;
        }
        let project = config["projectId"].as_str().unwrap_or_default();
        let issue_id = issue["id"].as_str().unwrap_or_default();
        let human_id = binding["humanAssignmentId"].as_str().unwrap_or_default();
        let task_id = self.stand_in_task_id(config, issue);
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
        let origin = json!({"type":"issue_dispatch","initiatedBy":"stand_in","publicConversation":true,"runtimeTaskId":task_id,"trigger":if config["triggerCommentId"].is_string() { "mention" } else if config["manual"] == true { "manual" } else { "assignment" },"triggerCommentId":config["triggerCommentId"],"standInId":config["id"],"roleName":config["name"],"userId":config["userId"],"deviceId":self.device_id,"askBeforeAct":config["handlingPolicy"]["askBeforeAct"] == true,"projectStore":config["projectStore"],"cloudProjectId":project,"loopItemId":issue_id,"humanAssignmentId":human_id,"assignmentId":binding["assignmentId"],"dispatchId":binding["dispatchId"],"roundId":binding["dispatchRoundId"]});
        let mut payload = json!({"taskId":task_id,"title":issue["title"],"message":prompt,"cloudProjectId":project,"origin":origin});
        if let Some(message) = config["triggerMessage"].as_str() {
            payload["message"] = json!(format!(
                "{prompt}\n\nNew Issue mention (untrusted task content):\n{message}"
            ));
        }
        if config["goalMode"] == true {
            payload["initialGoal"] =
                json!({"objective":prompt,"status":"active","tokenBudget":null});
        }
        let mut prepared = self.prepare_stand_in_execution(payload, config).await?;
        let mut system = prepared["executionRequest"]["system_prompt"]
            .as_str()
            .unwrap_or_default()
            .to_owned();
        super::stand_in_conversations::append_conversation_instructions(&mut system, true);
        prepared["executionRequest"]["system_prompt"] = json!(system);
        Ok(prepared)
    }

    /// Prepare an independent stand-in profile using only its own explicit model selection.
    pub(super) async fn prepare_stand_in_execution(
        &self,
        payload: Value,
        config: &Value,
    ) -> Result<Value, AppIpcError> {
        let agent = {
            config["model"].is_object().then(|| json!({
                "id":"stand-in", "name":"Stand-in", "runtime":config["model"]["runtime"],
                "execution_policy":{"mode":"fixed","environment_id":self.device_id},
                "model_policy":{"mode":"user_select"}, "system_prompt":"", "additional_skills":[], "plugins":[], "mcp_servers":{}
            }))
        };
        self.prepare_stand_in_execution_with_agent(payload, config, agent)
            .await
    }

    pub(super) async fn prepare_stand_in_execution_with_agent(
        &self,
        mut payload: Value,
        config: &Value,
        agent: Option<Value>,
    ) -> Result<Value, AppIpcError> {
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
            request
                .extra
                .insert("origin".into(), payload["origin"].clone());
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
        if payload["modelId"].is_string() {
            payload["modelSelection"] = json!({"modelName":payload["modelId"],"modelType":payload["modelType"],"options":payload["modelOptions"]});
        }
        // Stand-ins and direct Wework profiles do not execute as Backend Teams.
        payload["executionRequest"]["team_id"] = json!(0);
        payload["executionRequest"]["user_id"] = config["userId"].clone();
        if matches!(
            payload["origin"]["type"].as_str(),
            Some("connection_work" | "dingtalk_work" | "stand_in_schedule")
        ) {
            if let Some(user) = config["userId"].as_i64() {
                payload["executionRequest"]["standInReportTo"] = json!({
                    "userId":user,"taskId":super::stand_in_conversations::conversation_task_id(user,None)
                });
            }
        }
        if config["handlingPolicy"]["askBeforeAct"] == true {
            if payload["runtime"] == "claude_code" {
                return Err(AppIpcError::new(
                    "confirmation_runtime_unsupported",
                    "Choose Codex for execution-before-confirmation controls",
                ));
            }
            payload["executionRequest"]["runtime_permission_profile"] = json!(":read-only");
        }
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

pub(super) fn assignment_after_enable(assignment: &Value, config: &Value) -> bool {
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
