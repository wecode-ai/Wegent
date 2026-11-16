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
                ("project_id", diagnostic_identity(&config["projectId"])),
                ("issue_id", diagnostic_identity(&issue["id"])),
                ("user_id", diagnostic_identity(&config["userId"])),
                ("role_id", diagnostic_identity(&config["id"])),
                ("manual", (config["manual"] == true).to_string()),
                (
                    "project_store",
                    diagnostic_identity(&config["projectStore"]),
                ),
                (
                    "issue_assignment_id",
                    diagnostic_identity(&issue["human_task_binding"]["issueAssignmentId"]),
                ),
                (
                    "dispatch_round_id",
                    diagnostic_identity(&issue["human_task_binding"]["dispatchRoundId"]),
                ),
                ("reason", reason.to_owned()),
                (
                    "assignment_id",
                    diagnostic_identity(&issue["human_task_binding"]["assignmentId"]),
                ),
                (
                    "human_assignment_id",
                    diagnostic_identity(&issue["human_task_binding"]["humanAssignmentId"]),
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
                ("project_id", diagnostic_identity(&receipt["projectId"])),
                ("issue_id", diagnostic_identity(&receipt["issueId"])),
                (
                    "assignment_id",
                    diagnostic_identity(&receipt["assignmentId"]),
                ),
                ("user_id", diagnostic_identity(&receipt["userId"])),
                ("task_id", diagnostic_identity(&receipt["taskId"])),
                ("retry_count", diagnostic_identity(&receipt["retryCount"])),
                ("reason", reason.to_owned()),
                ("details", details.to_string()),
            ],
        );
    }
}

fn diagnostic_identity(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
