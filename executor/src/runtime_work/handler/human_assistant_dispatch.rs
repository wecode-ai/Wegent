//! Assignment-owned dispatch uses the existing Runtime admission and recovery paths.
use super::stand_in::settings_error;
use super::*;

pub(super) fn dispatch<'a>(config: &Value, issue: &'a Value, binding: &Value) -> Option<&'a Value> {
    issue
        .get("direct_human_assignment_receipt")
        .filter(|dispatch| {
            dispatch.is_object()
                && dispatch["projectId"] == config["projectId"]
                && dispatch["issueId"] == issue["id"]
                && dispatch["ownerUserId"] == config["userId"]
                && dispatch["humanAssignmentId"] == binding["humanAssignmentId"]
                && dispatch["dispatchId"].is_string()
                && dispatch["executionId"].is_string()
                && config["id"] == "@primary"
                && config["manual"] != true
                && !config["triggerCommentId"].is_string()
                && !binding["triggerCommentId"].is_string()
                && binding["humanAssignmentId"].is_string()
                && binding["assignmentId"].is_string()
                && binding["humanAssignmentId"] == issue["human_task_binding"]["humanAssignmentId"]
                && binding["assignmentId"] == issue["human_task_binding"]["assignmentId"]
        })
}

#[cfg(test)]
#[path = "human_assistant_dispatch_tests.rs"]
mod tests;

impl RuntimeWorkRpcHandler {
    pub(super) async fn validate_private_issue_owner_binding(
        &self,
        origin: &Value,
        issue: &Value,
        task: &str,
    ) -> Result<(), AppIpcError> {
        let denied = || {
            AppIpcError::new(
                "permission_denied",
                "Private Issue conversation ownership is unavailable",
            )
        };
        if origin["projectStore"] != "cloud"
            || issue["cloud_project_id"] != origin["cloudProjectId"]
            || issue["id"] != origin["loopItemId"]
            || issue["permissions"]["execute"] != true
            || origin["runtimeTaskId"] != task
            || !origin["userId"].is_i64()
        {
            return Err(denied());
        }
        let device = self.cloud_device_id()?;
        let rows = self
            .runtime_http(
                reqwest::Method::GET,
                &format!(
                    "/v1/loop-items/{}/tasks",
                    issue["id"].as_str().ok_or_else(denied)?
                ),
                None,
            )
            .await?;
        if !rows.as_array().into_iter().flatten().any(|row| {
            row["task_id"] == task
                && row["task_user_id"] == origin["userId"]
                && (row["device_id"] == self.device_id || row["device_id"] == device)
        }) {
            return Err(denied());
        }
        Ok(())
    }

    pub(super) async fn admit_private_issue_followup(
        &self,
        request: &mut ExecutionRequest,
        link: &RuntimeTaskLink,
    ) -> Result<(), AppIpcError> {
        let origin = &link.runtime_handle["origin"];
        if origin["assistantRequestId"].is_string() {
            return self
                .validate_current_assistant_request(origin)
                .await
                .map_err(|error| AppIpcError::new("permission_denied", error));
        }
        if !origin["humanAssistantDispatchId"].is_string()
            || !super::super::util::is_private_discussion(request)
            || (link.status == "failed" && runtime_session_id_from_link(link).is_none())
        {
            return Ok(());
        }
        let user = origin["userId"]
            .as_i64()
            .ok_or_else(|| AppIpcError::new("permission_denied", "Missing Issue owner"))?;
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let issue = self.read_stand_in_issue(&store, user, origin).await?;
        let receipt = &issue["direct_human_assignment_receipt"];
        if receipt["dispatchId"] == origin["humanAssistantDispatchId"]
            && receipt["executionId"] == origin["executionId"]
            && matches!(
                receipt["state"].as_str(),
                Some("queued" | "waiting_device" | "running" | "waiting_user" | "cancelling")
            )
        {
            return Ok(());
        }
        self.validate_private_issue_owner_binding(origin, &issue, &link.local_task_id)
            .await?;
        let mut manual = origin.clone();
        let fields = manual.as_object_mut().unwrap();
        fields.remove("humanAssistantDispatchId");
        fields.remove("executionId");
        manual["manual"] = json!(true);
        manual["trigger"] = json!("manual");
        manual["publicConversation"] = json!(true);
        manual["privateOwnerFollowup"] = json!(true);
        request.extra.insert("origin".into(), manual.clone());
        self.store.update_task(&link.local_task_id, |task| {
            task.runtime_handle["origin"] = manual.clone();
            task.runtime_handle["executionRequest"]["origin"] = manual;
        });
        Ok(())
    }

    pub(super) fn validate_human_assistant_grant(
        &self,
        settings: &Value,
        origin: &Value,
        issue: &Value,
    ) -> Result<(), String> {
        let configs = self.stand_in_project_configs(
            std::slice::from_ref(settings),
            origin["cloudProjectId"].as_str().unwrap_or_default(),
            origin["projectStore"].as_str().unwrap_or_default(),
        );
        let authorized = origin["standInId"] == "@primary"
            && super::personal_stand_in::matching_personal_roles(&configs, issue)
                .iter()
                .any(|role| {
                    role["id"] == "@primary"
                        && role["enabled"] == true
                        && self.stand_in_role_runs_here(role)
                        && role["handlingPolicy"]["automatic"] != false
                });
        authorized
            .then_some(())
            .ok_or_else(|| "Default assistant authorization is unavailable".into())
    }

    pub(super) async fn report_assistant_preflight_failure(
        &self,
        config: &Value,
        issue: &Value,
        error: &AppIpcError,
    ) {
        let Some(execution) = issue["direct_human_assignment_receipt"]["executionId"].as_str()
        else {
            return;
        };
        self.report_assistant_execution_failure(config, execution, error)
            .await;
    }

    pub(super) async fn report_assistant_execution_failure(
        &self,
        config: &Value,
        execution: &str,
        error: &AppIpcError,
    ) {
        let project = config["projectId"].as_str().unwrap_or_default();
        let path = format!("/v1/cloud-projects/{project}/executions/{execution}/dispatch-failed");
        let message = crate::agents::redact_diagnostic_text(&error.message);
        let body =
            json!({"error":message.chars().take(2000).collect::<String>(),"note":error.code});
        if let Err(report_error) = self
            .runtime_http(reqwest::Method::POST, &path, Some(&body))
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
            settings["lifecycle"]["status"].is_null()
                && settings["primary"]["enabled"] == true
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
            let items = match self.runtime_http(reqwest::Method::GET, &path, None).await {
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
                if let Err(error) = self.recover_issue_assistant_requests(&config, issue).await {
                    log_executor_event(
                        "Assistant request discovery failed",
                        &[
                            ("issue_id", issue["id"].to_string()),
                            ("code", error.code),
                            ("error", error.message),
                        ],
                    );
                }
                // Recovery only consumes durable intents; enabling a role never backfills history.
                if !issue["direct_human_assignment_receipt"].is_object()
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
            .runtime_http(reqwest::Method::GET, "/users/me", None)
            .await?;
        let personal: Vec<Value> = personal
            .iter()
            .filter(|settings| {
                settings["userId"] == connected["id"] && settings["lifecycle"]["status"].is_null()
            })
            .cloned()
            .collect();
        let mut projects = std::collections::BTreeSet::new();
        for settings in &personal {
            let source = &settings["primary"]["collaboration"];
            if source["allProjects"] == true {
                match self
                    .runtime_http(reqwest::Method::GET, "/v1/cloud-projects", None)
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
                    && self.stand_in_role_runs_here(config)
                    && config["enabled"] == true
                    && config["handlingPolicy"]["automatic"] != false
            })
            .collect())
    }
}
