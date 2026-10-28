//! Assignment decisions contain identities and state, never Issue content or credentials.
use super::*;

impl RuntimeWorkRpcHandler {
    pub(super) fn log_stand_in_decision(
        &self,
        config: &Value,
        issue: &Value,
        reason: &str,
        details: Value,
    ) {
        log_executor_event(
            "stand-in assignment decision",
            &[
                ("device_id", self.device_id.clone()),
                ("project_id", config["projectId"].to_string()),
                ("issue_id", issue["id"].to_string()),
                ("user_id", config["userId"].to_string()),
                ("role_id", config["id"].to_string()),
                ("manual", (config["manual"] == true).to_string()),
                ("project_store", config["projectStore"].to_string()),
                (
                    "issue_assignment_id",
                    issue["human_task_binding"]["issueAssignmentId"].to_string(),
                ),
                (
                    "dispatch_round_id",
                    issue["human_task_binding"]["dispatchRoundId"].to_string(),
                ),
                ("reason", reason.to_owned()),
                (
                    "assignment_id",
                    issue["human_task_binding"]["assignmentId"].to_string(),
                ),
                (
                    "human_assignment_id",
                    issue["human_task_binding"]["humanAssignmentId"].to_string(),
                ),
                ("details", details.to_string()),
            ],
        );
    }
}

impl RuntimeWorkRpcHandler {
    pub(super) fn log_stand_in_receipt(&self, receipt: &Value, reason: &str, details: Value) {
        log_executor_event(
            "stand-in assignment receipt",
            &[
                ("device_id", self.device_id.clone()),
                ("project_id", receipt["projectId"].to_string()),
                ("issue_id", receipt["issueId"].to_string()),
                ("assignment_id", receipt["assignmentId"].to_string()),
                ("user_id", receipt["userId"].to_string()),
                ("task_id", receipt["taskId"].to_string()),
                ("retry_count", receipt["retryCount"].to_string()),
                ("reason", reason.to_owned()),
                ("details", details.to_string()),
            ],
        );
    }
}
