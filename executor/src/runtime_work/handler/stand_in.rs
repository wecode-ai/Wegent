//! Device-owned personal automation. Cloud APIs only synchronize existing Issue work.
use super::stand_in_agent::apply_stand_in_agent;
use super::stand_in_workspace::apply_stand_in_workspace;
use super::*;
use crate::agents::normalize_reasoning_effort_alias;
use crate::runtime_work::response::local_task_json;

pub(super) fn personal_task_claimed(issue: &Value) -> bool {
    let marker = issue
        .get("personal_task_assignment_at")
        .filter(|value| value.is_string())
        .or_else(|| issue["metadata"].get("personal_task_assignment_at"));
    let history = issue
        .get("assignment_history")
        .filter(|value| value.is_array())
        .unwrap_or(&issue["metadata"]["assignment_history"]);
    marker.is_some_and(|marker| {
        marker.is_string()
            && history
                .as_array()
                .and_then(|rows| rows.last())
                .is_some_and(|assignment| assignment["at"] == *marker)
    })
}

pub(super) fn stand_in_origin_matches(config: &Value, issue: &Value, origin: &Value) -> bool {
    origin["initiatedBy"] == "stand_in"
        && origin["type"] == "issue_dispatch"
        && origin["loopItemId"] == issue["id"]
        && origin["standInId"] == config["id"]
        && origin["userId"] == config["userId"]
        && origin["projectStore"] == config["projectStore"]
        && origin["cloudProjectId"] == config["projectId"]
}

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
                "This assignment has already been handled or is no longer active",
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
            return self
                .reconcile_accepted_stand_in_binding(
                    config,
                    issue,
                    &stand_in_issue_receipt_binding(config, issue),
                )
                .await;
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
            if config["enabled"] != true || config["handlingPolicy"]["automatic"] == false {
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
            if personal_task_claimed(&issue_value) {
                continue;
            }
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
                    self.stand_in_issue_runs_here(config, &issue_value)
                        && assignment_after_enable(&json!({"created_at":assignment["at"]}), config)
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
            for config in
                super::personal_stand_in::automatic_assignment_roles(&eligible, &issue_value)
            {
                let task_id = self.stand_in_task_id(config, &issue_value);
                if self.stand_in_assignment_is_handled(config, &task_id, &binding)
                    && !bindings
                        .iter()
                        .any(|row| row.task_id == task_id && row.stand_in_pending == Some(true))
                {
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
        if personal_task_claimed(issue) {
            return Ok(());
        }
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
        let eligible_configs: Vec<Value> = matching
            .into_iter()
            .filter(|config| assignment_after_enable(assignment, config))
            .cloned()
            .collect();
        let eligible =
            super::personal_stand_in::automatic_assignment_roles(&eligible_configs, issue);
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
        if eligible.iter().any(|role| {
            existing
                .as_array()
                .into_iter()
                .flatten()
                .any(|row| self.assignment_handled_by_another_role(role, issue, binding, row))
        }) {
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
        // Persist the eligible role, which may differ from the original intake hint.
        let intents = self.queue_stand_in_dispatches(std::slice::from_ref(config), issue)?;
        // Same-device reservations are not proof that a local task was accepted.
        let result = self.execute_stand_in_task(config, issue, binding).await;
        self.settle_stand_in_dispatches(&intents, result.as_ref().err());
        result
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
        if config["manual"] != true {
            let store =
                LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
            let bindings = store
                .list_task_bindings(issue["id"].as_str().unwrap_or_default())
                .map_err(settings_error)?;
            if bindings.iter().any(|row| {
                self.assignment_handled_by_another_role(
                    config,
                    issue,
                    binding,
                    &serde_json::to_value(row).unwrap(),
                )
            }) {
                return Ok(());
            }
        }
        self.execute_stand_in_task(config, issue, binding).await
    }

    /// Prepare an independent stand-in profile using only its own explicit model selection.
    pub(super) async fn prepare_stand_in_execution(
        &self,
        payload: Value,
        config: &Value,
    ) -> Result<Value, AppIpcError> {
        let agent = {
            let has_reasoning = super::creation::normalized_model_options(&config["modelOptions"])
                .get("reasoning")
                .is_some_and(Value::is_string);
            (config["model"].is_object() || has_reasoning).then(|| json!({
                "id":"stand-in", "name":"Stand-in", "runtime":config["model"]["runtime"].as_str().unwrap_or("codex"),
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
        let mut options = config
            .get("modelOptions")
            .map(super::creation::normalized_model_options)
            .unwrap_or_default();
        // Provider identity comes from runner routing, never from saved user options.
        options.remove("runnerModelProvider");
        if let Some(effort) = options
            .get_mut("reasoning")
            .filter(|value| value.is_string())
        {
            *effort = json!(normalize_reasoning_effort_alias(effort.as_str().unwrap()));
        }
        if let Some(agent) = agent {
            let catalog = self.runner_catalog().await?;
            apply_stand_in_agent(
                &mut payload,
                &agent,
                &catalog,
                &self.device_id,
                config.get("model").filter(|model| model.is_object()),
            )?;
            if let Some(effort) = options.get("reasoning").and_then(Value::as_str) {
                let selected = &payload["runnerRouting"]["model"];
                let model = catalog["models"].as_array().and_then(|models| {
                    models.iter().find(|model| {
                        ["runtime", "provider", "model_id"]
                            .iter()
                            .all(|key| model.get(key) == selected.get(key))
                    })
                });
                let is_default = model
                    .and_then(|model| model["default_reasoning_effort"].as_str())
                    .is_some_and(|value| normalize_reasoning_effort_alias(value) == effort);
                let supported =
                    model.and_then(|model| model["supported_reasoning_efforts"].as_array());
                if !is_default
                    && supported.is_some_and(|efforts| {
                        !efforts.iter().any(|value| {
                            value.as_str().is_some_and(|value| {
                                normalize_reasoning_effort_alias(value) == effort
                            })
                        })
                    })
                {
                    return Err(AppIpcError::new(
                        "model_reasoning_unavailable",
                        "The selected model does not support the saved reasoning effort; update the stand-in model settings",
                    ));
                }
            }
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
        if !options.is_empty() {
            let target = payload
                .as_object_mut()
                .unwrap()
                .entry("modelOptions")
                .or_insert_with(|| json!({}));
            target.as_object_mut().unwrap().extend(options);
        }
        if let Some(effort) = payload["modelOptions"]
            .get_mut("reasoning")
            .filter(|value| value.is_string())
        {
            *effort = json!(normalize_reasoning_effort_alias(effort.as_str().unwrap()));
        }
        if payload["modelId"].is_string() {
            payload["modelSelection"] = json!({"modelName":payload["modelId"],"modelType":payload["modelType"],"options":payload["modelOptions"]});
        }
        let mut request = execution_request(&payload)
            .ok_or_else(|| AppIpcError::new("bad_request", "Invalid stand-in execution request"))?;
        super::creation::apply_creation_options(&mut request, &payload)?;
        payload["executionRequest"] = json!(request);
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
