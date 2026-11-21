//! Independent assignments use the existing Issue inbox and stand-in task lifecycle.
use super::{stand_in::settings_error, *};
use crate::task_runtime::personal_stand_in::{project_role, stand_in_identities};

pub(super) const INDEPENDENT: &str = "independent";

pub(super) fn personal_issue_role(role: &Value, user: i64) -> Option<Value> {
    (role["enabled"] == true
        && role["collaboration"]["enabled"] == true
        && role["collaboration"]["includeIndependentIssues"] == true)
        .then(|| {
            let mut config = project_role(role, user, "", INDEPENDENT);
            config["projectId"] = Value::Null;
            config["enabledAfter"] = role["independentIssuesEnabledAfter"].clone();
            config
        })
        .filter(|config| config["handlingPolicy"]["automatic"] != false)
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn process_personal_issue_assignment(
        &self,
        payload: &Value,
        issue_id: &str,
    ) -> Result<(), AppIpcError> {
        let (Some(user), Some(assignment)) = (
            payload["recipientUserId"].as_i64(),
            payload["assignmentId"].as_str(),
        ) else {
            return Ok(());
        };
        let store = LocalTaskStore::open(self.task_store_path.as_ref()).map_err(settings_error)?;
        let settings = store
            .personal_stand_in(user, &self.device_id)
            .map_err(settings_error)?;
        if !settings["lifecycle"]["status"].is_null() {
            return Ok(());
        }
        let configs: Vec<_> = stand_in_identities(&settings)
            .iter()
            .filter_map(|role| personal_issue_role(role, user))
            .filter(|config| self.stand_in_role_runs_here(config))
            .collect();
        if configs.is_empty() {
            return Ok(());
        }
        let gate = self.task_send_gate(&format!("stand-in-independent-issue:{issue_id}"));
        let _guard = gate.lock().await;
        let issue = match self
            .current_personal_issue(user, issue_id, assignment)
            .await
        {
            Ok(issue) => issue,
            Err(error) if error.code == "source_removed" => return Ok(()),
            Err(error) => return Err(error),
        };
        let configs: Vec<_> = configs
            .into_iter()
            .filter(|config| personal_assignment_after_enable(&issue, config))
            .collect();
        let binding = &issue["human_task_binding"];
        for config in super::personal_stand_in::automatic_assignment_roles(&configs, &issue) {
            match self.execute_stand_in_task(config, &issue, binding).await {
                Err(error)
                    if error.code == "assignment_claimed" || error.code == "source_removed" => {}
                result => result?,
            }
        }
        Ok(())
    }

    pub(super) async fn current_personal_issue(
        &self,
        user: i64,
        issue_id: &str,
        assignment: &str,
    ) -> Result<Value, AppIpcError> {
        if issue_id.is_empty()
            || !issue_id
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
            || assignment.is_empty()
        {
            return Err(AppIpcError::new(
                "source_removed",
                "Invalid independent Issue assignment",
            ));
        }
        self.verify_runtime_user(&json!({"userId":user})).await?;
        let path = format!("/v1/personal-issues/{issue_id}");
        let response = self
            .runtime_request(reqwest::Method::GET, &path, None)
            .await?;
        if matches!(response.status().as_u16(), 403 | 404) {
            return Err(AppIpcError::new(
                "source_removed",
                "Independent Issue is unavailable",
            ));
        }
        let mut issue = Self::read_runtime_response(reqwest::Method::GET, &path, response).await?;
        if issue["id"] != issue_id
            || issue["assignee_id"] != user
            || issue["status"] == "completed"
            || issue["metadata"]["archived"] == true
            || issue["metadata"]["assignment_id"] != assignment
        {
            return Err(AppIpcError::new(
                "source_removed",
                "Independent Issue assignment changed",
            ));
        }
        issue["assignee_user_id"] = json!(user);
        issue["cloud_project_id"] = Value::Null;
        issue["human_task_binding"] =
            json!({"assignmentId":assignment,"humanAssignmentId":assignment});
        Ok(issue)
    }

    pub(super) fn personal_issue_assignment_address(
        &self,
        origin: &Value,
    ) -> Result<Value, AppIpcError> {
        Ok(json!({
            "assignment_id":origin["assignmentId"],
            "device_id":self.cloud_device_id()?,
            "task_id":origin["runtimeTaskId"],
        }))
    }
}

pub(super) fn personal_assignment_after_enable(issue: &Value, config: &Value) -> bool {
    super::stand_in::assignment_after_enable(
        &json!({"created_at":issue["metadata"]["assigned_at"]}),
        config,
    )
}
