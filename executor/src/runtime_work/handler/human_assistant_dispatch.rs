//! Assignment-owned dispatch uses the existing Runtime admission and recovery paths.
use super::stand_in::settings_error;
use super::*;

pub(super) fn dispatch<'a>(config: &Value, issue: &'a Value, binding: &Value) -> Option<&'a Value> {
    issue.get("human_assistant_dispatch").filter(|dispatch| {
        dispatch.is_object()
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
        let Some(execution) = issue["human_assistant_dispatch"]["executionId"].as_str() else {
            return;
        };
        let project = config["projectId"].as_str().unwrap_or_default();
        let path = format!("/v1/cloud-projects/{project}/executions/{execution}/dispatch-failed");
        let body =
            json!({"error":error.message.chars().take(2000).collect::<String>(),"note":error.code});
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
