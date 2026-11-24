//! A prepared channel submission for the primary DingTalk delegation.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::local::app_ipc::AppIpcError;
use crate::runtime_work::local_connector_auth::{
    prepare_declared_plugin_tool, run_declared_plugin_tool, PreparedPluginTool,
};

use super::{invalid, reply_args, required, validate_reply_text};

pub(crate) struct PreparedDelegatedReply {
    tool: PreparedPluginTool,
    args: Vec<String>,
    binding: ReplyBinding,
}

struct ReplyBinding {
    attempt_id: String,
    conversation_id: String,
    message_id: String,
}

impl ReplyBinding {
    fn from_source(source: &Value, message: &Value) -> Result<Self, AppIpcError> {
        let account_id = channel_id(&source["accountId"])
            .ok_or_else(|| invalid("Missing verified DingTalk account"))?;
        let conversation_id = required(message, "conversationId")?;
        let message_id = required(message, "id")?;
        let same_conversation = match source["kind"].as_str() {
            Some("group") => source["id"] == conversation_id,
            Some("direct") => source["id"] == required(message, "senderId")?,
            _ => false,
        };
        if source["delegated"] != true || !same_conversation {
            return Err(invalid(
                "DingTalk reply does not match the selected conversation",
            ));
        }
        // The provider's account ID binds the native account, organization, and profile.
        let identity = json!([
            "dingtalk-delegation-v1",
            account_id,
            conversation_id,
            message_id
        ]);
        Ok(Self {
            attempt_id: format!("{:x}", Sha256::digest(identity.to_string().as_bytes())),
            conversation_id: conversation_id.to_owned(),
            message_id: message_id.to_owned(),
        })
    }
}

pub(crate) async fn prepare_delegated_reply(
    source: &Value,
    message: &Value,
    text: &str,
) -> Result<PreparedDelegatedReply, AppIpcError> {
    validate_reply_text(text)?;
    let binding = ReplyBinding::from_source(source, message)?;
    let args = reply_args(
        required(source, "profile")?,
        message,
        text,
        &binding.attempt_id,
    )?;
    let tool = prepare_declared_plugin_tool("dingtalk", "dws").await?;
    Ok(PreparedDelegatedReply {
        tool,
        args,
        binding,
    })
}

impl PreparedDelegatedReply {
    pub(crate) fn attempt_id(&self) -> &str {
        &self.binding.attempt_id
    }

    /// Call immediately after the existing durable delegation claim succeeds.
    pub(crate) async fn submit(self) -> Value {
        let response = self.tool.run(&self.args).await;
        submission_outcome(&self.binding, response)
    }
}

fn submission_outcome(binding: &ReplyBinding, response: Result<Value, AppIpcError>) -> Value {
    let mut outcome = json!({
        "attemptId":binding.attempt_id,
        "status":"unknown",
        "reasonCode":"channel_result_unconfirmed"
    });
    match response {
        Ok(response) if response["success"] == true => {
            if let Some(task) = channel_id(&response["result"]["openTaskId"]) {
                outcome["channelTaskId"] = json!(task);
            }
            apply_receipt(binding, &mut outcome, &response);
        }
        Err(error) => {
            // These errors prove the send was not started or its authority was refused.
            if matches!(
                error.code.as_str(),
                "connection_cli_unavailable"
                    | "connector_auth_required"
                    | "dingtalk_permissions_required"
            ) {
                outcome["status"] = json!("failed");
            }
            outcome["reasonCode"] = json!(error.code);
        }
        Ok(_) => {}
    }
    outcome
}

/// Query the recorded channel task after the caller verifies the current account.
pub(crate) async fn verify_delegated_reply(
    source: &Value,
    message: &Value,
    result: &Value,
) -> Result<Value, AppIpcError> {
    let binding = ReplyBinding::from_source(source, message)?;
    let task =
        channel_id(&result["channelTaskId"]).ok_or_else(|| invalid("Missing channel task"))?;
    if result["attemptId"] != binding.attempt_id || result["status"] != "unknown" {
        return Err(invalid(
            "DingTalk verification does not match the recorded attempt",
        ));
    }
    let args = [
        "chat",
        "message",
        "query-send-status",
        "--open-task-id",
        task,
        "--profile",
        required(source, "profile")?,
        "--format",
        "json",
    ]
    .map(str::to_owned);
    let response = run_declared_plugin_tool("dingtalk", "dws", &args).await?;
    let mut outcome = json!({
        "status":"unknown",
        "attemptId":binding.attempt_id,
        "channelTaskId":task
    });
    apply_receipt(&binding, &mut outcome, &response);
    Ok(outcome)
}

fn apply_receipt(binding: &ReplyBinding, outcome: &mut Value, response: &Value) {
    let result = &response["result"];
    let Some(receipt) = channel_id(&result["openMessageId"]) else {
        return;
    };
    if response["success"] != true
        || receipt == binding.message_id
        || outcome["channelTaskId"] == receipt
        || (!result["openConversationId"].is_null()
            && result["openConversationId"] != binding.conversation_id)
        || (!result["openTaskId"].is_null() && result["openTaskId"] != outcome["channelTaskId"])
    {
        return;
    }
    outcome["status"] = json!("sent");
    outcome["receiptId"] = json!(receipt);
    outcome["reasonCode"] = Value::Null;
}

fn channel_id(value: &Value) -> Option<&str> {
    value.as_str().filter(|id| {
        !id.is_empty()
            && id.len() <= 512
            && !id.starts_with('-')
            && !id.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message() -> Value {
        json!({"id":"incoming","conversationId":"room","senderId":"peer"})
    }

    fn source() -> Value {
        json!({"delegated":true,"kind":"direct","id":"peer","accountId":"account","profile":"org:native-user"})
    }

    #[test]
    fn attempt_is_bound_to_account_and_original_message() {
        let mut source = source();
        let mut message = message();
        let initial = ReplyBinding::from_source(&source, &message)
            .unwrap()
            .attempt_id;
        message["workId"] = json!("another-work");
        message["text"] = json!("an edited draft");
        assert_eq!(
            ReplyBinding::from_source(&source, &message)
                .unwrap()
                .attempt_id,
            initial
        );
        source["accountId"] = json!("another-account");
        assert_ne!(
            ReplyBinding::from_source(&source, &message)
                .unwrap()
                .attempt_id,
            initial
        );
        message["senderId"] = json!("unselected-peer");
        assert!(ReplyBinding::from_source(&source, &message).is_err());
    }

    #[test]
    fn submission_requires_delivery_evidence_and_keeps_timeouts_unknown() {
        let binding = ReplyBinding::from_source(&source(), &message()).unwrap();
        for (response, status) in [
            (Ok(json!({"success":true})), "unknown"),
            (
                Ok(json!({"success":true,"result":{"openTaskId":"task"}})),
                "unknown",
            ),
            (
                Err(AppIpcError::new("connection_cli_timeout", "Timed out")),
                "unknown",
            ),
            (
                Err(AppIpcError::new(
                    "connection_cli_unavailable",
                    "Could not start",
                )),
                "failed",
            ),
            (
                Ok(json!({"success":true,"result":{"openMessageId":"incoming"}})),
                "unknown",
            ),
            (
                Ok(
                    json!({"success":true,"result":{"openMessageId":"outbound","openConversationId":"other"}}),
                ),
                "unknown",
            ),
            (
                Ok(
                    json!({"success":true,"result":{"openMessageId":"outbound","openConversationId":"room"}}),
                ),
                "sent",
            ),
        ] {
            let outcome = submission_outcome(&binding, response);
            assert_eq!(outcome["status"], status);
            if status == "sent" {
                assert_eq!(outcome["receiptId"], "outbound");
            } else {
                assert!(outcome["receiptId"].is_null());
            }
        }
        let accepted = submission_outcome(
            &binding,
            Ok(json!({"success":true,"result":{"openTaskId":"task"}})),
        );
        assert_eq!(accepted["channelTaskId"], "task");
        assert!(accepted["receiptId"].is_null());
    }

    #[test]
    fn status_receipt_must_belong_to_the_recorded_task() {
        let binding = ReplyBinding::from_source(&source(), &message()).unwrap();
        let mut outcome = json!({"status":"unknown","channelTaskId":"requested"});
        apply_receipt(
            &binding,
            &mut outcome,
            &json!({
                "success":true,"result":{"openTaskId":"unrelated","openMessageId":"sent"}
            }),
        );
        assert_eq!(outcome["status"], "unknown");
        apply_receipt(
            &binding,
            &mut outcome,
            &json!({
                "success":true,"result":{"openTaskId":"requested","openMessageId":"sent"}
            }),
        );
        assert_eq!(outcome["status"], "sent");
        assert_eq!(outcome["receiptId"], "sent");
    }
}
