use super::*;
use crate::task_runtime::personal_stand_in::{project_role, role_project_matches};

impl RuntimeWorkRpcHandler {
    pub(super) async fn read_assignment_intake(
        &self,
        store: &LocalTaskStore,
        user: i64,
        role: &Value,
        event: &Value,
    ) -> Result<(Value, Value), AppIpcError> {
        let project = super::stand_in_tasks::required(event, "projectId")?;
        let storage = super::stand_in_tasks::required(event, "projectStore")?;
        let id = super::stand_in_tasks::required(event, "issueId")?;
        let config = project_role(role, user, project, storage);
        if !role_project_matches(role, project, storage)
            || config["handlingPolicy"]["automatic"] != true
        {
            return Err(AppIpcError::new(
                "source_removed",
                "Project source is no longer connected or automatic",
            ));
        }
        let (issue, binding) = if storage == "cloud" {
            self.read_cloud_assignment_intake(user, &config, event)
                .await?
        } else if storage == "local" {
            let issue = store.get_task(project, id).map_err(|error| match error {
                crate::task_runtime::TaskRuntimeError::TaskNotFound
                | crate::task_runtime::TaskRuntimeError::ProjectNotFound => {
                    AppIpcError::new("source_removed", "The assigned Issue no longer exists")
                }
                error => super::stand_in::settings_error(error),
            })?;
            let mut issue = serde_json::to_value(issue)
                .map_err(|e| AppIpcError::new("invalid_assignment", e.to_string()))?;
            let history = issue["metadata"]["assignment_history"]
                .as_array()
                .ok_or_else(|| {
                    AppIpcError::new("invalid_assignment", "Missing assignment history")
                })?;
            let assignment = history
                .last()
                .ok_or_else(|| AppIpcError::new("invalid_assignment", "Missing assignment"))?;
            let binding = json!({"humanAssignmentId":format!("{id}-{}",history.len())});
            let expected_user_id = user.to_string();
            if binding["humanAssignmentId"] != event["assignmentId"]
                || assignment["to_type"] != "user"
                || assignment["to_id"].as_str() != Some(expected_user_id.as_str())
                || !super::stand_in::assignment_after_enable(
                    &json!({"created_at":assignment["at"]}),
                    &config,
                )
            {
                return Err(AppIpcError::new("invalid_assignment", "Assignment changed"));
            }
            issue["tags"] = issue["metadata"]["tags"].clone();
            (issue, binding)
        } else {
            return Err(AppIpcError::new(
                "invalid_assignment",
                "Invalid project storage",
            ));
        };
        if issue["assignee_user_id"] != user
            || issue["cloud_project_id"] != project
            || super::personal_stand_in::matching_personal_roles(
                std::slice::from_ref(&config),
                &issue,
            )
            .is_empty()
        {
            return Err(AppIpcError::new(
                "permission_denied",
                "The Issue no longer belongs to this role or user",
            ));
        }
        Ok((issue, binding))
    }

    async fn read_cloud_assignment_intake(
        &self,
        user: i64,
        config: &Value,
        event: &Value,
    ) -> Result<(Value, Value), AppIpcError> {
        self.verify_stand_in_user(&json!({"userId":user})).await?;
        let id = super::stand_in_tasks::required(event, "issueId")?;
        let issue = self
            .stand_in_http(reqwest::Method::GET, &format!("/v1/loop-items/{id}"), None)
            .await?;
        let assignments = self
            .stand_in_http(
                reqwest::Method::GET,
                &format!("/v1/loop-items/{id}/assignments"),
                None,
            )
            .await?;
        let active = assignments["items"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["id"] == event["assignmentId"] && row["status"] == "active");
        if issue["human_task_binding"]["assignmentId"] != event["assignmentId"]
            || !active.is_some_and(|row| super::stand_in::assignment_after_enable(row, config))
        {
            return Err(AppIpcError::new(
                "invalid_assignment",
                "Assignment changed or predates this connection",
            ));
        }
        let binding = issue["human_task_binding"].clone();
        Ok((issue, binding))
    }
}
