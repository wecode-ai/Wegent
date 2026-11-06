//! Durable execution facts. Queue maintenance never invents Runtime completion.

use brz_mysql::FromMysqlRow;
use chrono::NaiveDateTime;
use serde_json::{Value, json};

pub(super) const COLUMNS: &str = "id,COALESCE(loop_item_id,'') AS loop_item_id,COALESCE(cloud_project_id,'') AS cloud_project_id,COALESCE(executor_owner_user_id,0) AS executor_owner_user_id,COALESCE(assigner_user_id,0) AS assigner_user_id,COALESCE(agent_id,'') AS agent_id,COALESCE(team_id,0) AS team_id,COALESCE(automation_run_id,'') AS automation_run_id,COALESCE(execution_environment,'') AS execution_environment,COALESCE(execution_device_id,'') AS execution_device_id,COALESCE(runtime_device_id,'') AS runtime_device_id,COALESCE(runtime_task_id,'') AS runtime_task_id,COALESCE(status,'') AS status,COALESCE(approval_status,'') AS approval_status,COALESCE(execution_payload,'') AS execution_payload,COALESCE(error_message,'') AS error_message,COALESCE(execution_note,'') AS execution_note,COALESCE(version,0) AS version,lease_expires_at,start_requested_at,started_at,completed_at";

#[derive(Clone, Debug, FromMysqlRow)]
pub(super) struct Execution {
    pub id: i64,
    pub loop_item_id: String,
    pub cloud_project_id: String,
    pub executor_owner_user_id: i64,
    pub assigner_user_id: i64,
    pub agent_id: String,
    pub team_id: i64,
    pub automation_run_id: String,
    pub execution_environment: String,
    pub execution_device_id: String,
    pub runtime_device_id: String,
    pub runtime_task_id: String,
    pub status: String,
    pub approval_status: String,
    pub execution_payload: String,
    pub error_message: String,
    pub execution_note: String,
    pub version: i64,
    pub start_requested_at: Option<NaiveDateTime>,
    pub completed_at: Option<NaiveDateTime>,
}

impl Execution {
    pub fn intent(&self) -> Value {
        serde_json::from_str::<Value>(&self.execution_payload)
            .ok()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    }

    pub fn selection(&self) -> Value {
        let intent = self.intent();
        if intent["runtime_selection"].is_object() {
            intent["runtime_selection"].clone()
        } else {
            intent
        }
    }

    pub fn context(&self) -> Value {
        self.intent()
            .get("origin_context")
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}))
    }

    pub fn assignment_pending(&self) -> bool {
        self.selection()["assignment_request"].is_object()
    }
    pub fn routed(&self) -> bool {
        self.selection()["runner_routing"].is_object()
    }
    pub fn terminal(&self) -> bool {
        terminal(&self.status)
    }

    pub fn conversation_id(&self) -> String {
        if self.selection()["executor_kind"] == "collaboration_group_dispatch" {
            format!("{}-manager-initial", self.runtime_task_id)
        } else {
            self.runtime_task_id.clone()
        }
    }

    pub fn can_cancel_without_runtime(&self) -> bool {
        matches!(
            self.status.as_str(),
            "waiting_runtime" | "pending_approval" | "queued"
        ) || (self.status == "claimed" && unset(self.start_requested_at))
    }
}

pub(super) fn unset(value: Option<NaiveDateTime>) -> bool {
    value.is_none_or(|value| value.and_utc().timestamp() <= 1)
}

pub(super) fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_undelivered_claims_can_release_capacity_without_runtime_truth() {
        for (status, start, expected) in [
            ("queued", None, true),
            ("claimed", None, true),
            ("claimed", Some(chrono::Utc::now().naive_utc()), false),
            ("running", None, false),
            ("cancel_requested", None, false),
        ] {
            let row = execution(status, start);
            assert_eq!(row.can_cancel_without_runtime(), expected, "{status}");
        }
    }

    #[test]
    fn v1_and_v2_selection_preserve_pending_admission_and_manager_identity() {
        let mut row = execution("queued", None);
        row.execution_payload = json!({"assignment_request":{"environment":"cloud"}}).to_string();
        assert!(row.assignment_pending());
        row.execution_payload=json!({"schema_version":2,"runtime_selection":{"executor_kind":"collaboration_group_dispatch"}}).to_string();
        row.runtime_task_id = "codex-queue-1".into();
        assert_eq!(row.conversation_id(), "codex-queue-1-manager-initial");
        row.execution_payload = "malformed".into();
        assert_eq!(row.selection(), json!({}));
    }

    fn execution(status: &str, start_requested_at: Option<NaiveDateTime>) -> Execution {
        Execution {
            id: 1,
            loop_item_id: "P-1".into(),
            cloud_project_id: "2".into(),
            executor_owner_user_id: 7,
            assigner_user_id: 8,
            agent_id: "a".into(),
            team_id: 0,
            automation_run_id: String::new(),
            execution_environment: "cloud".into(),
            execution_device_id: String::new(),
            runtime_device_id: String::new(),
            runtime_task_id: String::new(),
            status: status.into(),
            approval_status: String::new(),
            execution_payload: String::new(),
            error_message: String::new(),
            execution_note: String::new(),
            version: 1,
            start_requested_at,
            completed_at: None,
        }
    }
}
