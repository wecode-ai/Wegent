//! Private request state is stored with the existing execution intent.

use brz_mysql::FromMysqlRow;
use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(super) const COLUMNS: &str = "id,executor_owner_user_id,execution_scope,status,COALESCE(observed_state,'') AS observed_state,COALESCE(runtime_device_id,'') AS runtime_device_id,COALESCE(execution_device_id,'') AS execution_device_id,COALESCE(runtime_task_id,'') AS runtime_task_id,execution_payload,updated_at";

#[derive(Clone, Debug, FromMysqlRow)]
pub(super) struct RequestRow {
    pub id: i64,
    pub executor_owner_user_id: i64,
    pub execution_scope: String,
    pub status: String,
    pub observed_state: String,
    pub runtime_device_id: String,
    pub execution_device_id: String,
    pub runtime_task_id: String,
    pub execution_payload: String,
    pub updated_at: Option<NaiveDateTime>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Action {
    pub action: String,
    pub idempotency_key: String,
    pub request_id: Option<String>,
    pub parent_request_id: Option<String>,
    pub message: Option<String>,
    pub client_user_message_id: Option<String>,
}

impl Action {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.idempotency_key.trim().is_empty() || self.idempotency_key.len() > 128 {
            return Err("idempotencyKey must contain 1 to 128 bytes");
        }
        if !matches!(
            self.action.as_str(),
            "new_request" | "followup" | "cancel" | "retry" | "replace" | "prepare_merge"
        ) {
            return Err("Unsupported assistant request action");
        }
        if self.action != "new_request" && self.request_id.as_deref().is_none_or(str::is_empty) {
            return Err("requestId is required for this action");
        }
        if matches!(self.action.as_str(), "new_request" | "followup" | "replace")
            && self
                .message
                .as_deref()
                .is_none_or(|message| message.trim().is_empty())
        {
            return Err("message must not be empty");
        }
        if self
            .request_id
            .iter()
            .chain(self.parent_request_id.iter())
            .any(|id| !valid_id(id))
        {
            return Err("Invalid request identity");
        }
        if self
            .client_user_message_id
            .as_deref()
            .is_some_and(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control))
        {
            return Err("Invalid clientUserMessageId");
        }
        Ok(())
    }

    pub fn fingerprint(&self) -> String {
        digest(&serde_json::to_string(self).expect("action serializes"))
    }
}

pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub(super) fn request_id(project: &str, issue: &str, owner: i64, key: &str) -> String {
    digest(&json!([project, issue, owner, key]).to_string())[..32].to_owned()
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

impl RequestRow {
    pub fn intent(&self) -> Value {
        serde_json::from_str(&self.execution_payload).unwrap_or_else(|_| json!({}))
    }

    pub fn view(&self, position: usize) -> Value {
        let intent = self.intent();
        let request = &intent["assistant_request"];
        let origin = &intent["origin_context"];
        let state = match self.status.as_str() {
            "waiting_runtime" | "claimed" => "queued",
            "cancel_requested" => "cancelling",
            "running" if self.observed_state == "waiting_user" => "waiting_user",
            state => state,
        };
        json!({"requestId":request["requestId"],"parentRequestId":request["parentRequestId"],
            "ownerUserId":self.executor_owner_user_id,
            "deviceId":if self.runtime_device_id.is_empty(){&self.execution_device_id}else{&self.runtime_device_id},
            "runtimeTaskId":self.runtime_task_id,"conversationId":self.runtime_task_id,
            "executionId":self.id.to_string(),"state":state,
            "queuePosition":if state=="queued"{Some(position)}else{None},
            "reasonCode":request["reasonCode"],"message":request["message"],
            "attemptMessage":request["attemptMessage"],"attemptCommandId":request["attemptCommandId"],"attemptClientUserMessageId":request["attemptClientUserMessageId"],
            "commands":request["commands"],"worktree":request["worktree"],
            "assignmentId":origin["assignment_id"],"humanAssignmentId":request["humanAssignmentId"],
            "parentDispatchId":origin["human_assistant_dispatch"],
            "updatedAt":self.updated_at.map(|date|format!("{}Z",date.format("%Y-%m-%dT%H:%M:%S%.f")))})
    }

    pub fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_actions_require_request_identity_and_valid_payloads() {
        let base = json!({"action":"new_request","idempotencyKey":"message-1","message":"Work"});
        let mut action: Action = serde_json::from_value(base.clone()).unwrap();
        assert!(action.validate().is_ok());
        action.action = "followup".into();
        assert!(action.validate().is_err());
        action.request_id = Some("a".repeat(32));
        assert!(action.validate().is_ok());
        let mut foreign = base;
        foreign["ownerUserId"] = json!(8);
        assert!(serde_json::from_value::<Action>(foreign).is_err());
        assert_ne!(
            request_id("7", "i", 1, "key"),
            request_id("7", "i", 2, "key")
        );
        assert_ne!(
            request_id("7", "i", 1, "key"),
            request_id("8", "i", 1, "key")
        );
        assert_eq!(
            request_id("7", "i", 1, "key"),
            request_id("7", "i", 1, "key")
        );
    }
}
