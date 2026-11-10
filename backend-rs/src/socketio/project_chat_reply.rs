// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Reply context stays in its authorized project and Issue conversation.
use super::project_chat_events::ack_error;
use super::{project_chat_mentions, project_chat_messages::load_message_by_message_id};
use crate::state::AppState;
use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct ReplyContext {
    pub reply_to: Option<String>,
    pub root: Option<String>,
    pub preview: Option<String>,
    pub recipient: Option<Value>,
}

fn stand_in_recipient(sender: &str, name: &str, metadata: &Value) -> Option<Value> {
    if sender != "agent" {
        return None;
    }
    let identity = metadata.get("stand_in")?.as_object()?;
    let user = identity.get("user_id")?.as_i64()?;
    let role = identity.get("role_id")?.as_str()?;
    Some(json!({"user_id":user,"role_id":role,"name":name}))
}

pub(super) async fn resolve_reply(
    state: &AppState,
    project: &str,
    task: Option<&str>,
    reply_to: Option<&str>,
) -> Result<ReplyContext, Value> {
    let Some(reply_to) = reply_to else {
        return Ok(ReplyContext::default());
    };
    let Some(target) = load_message_by_message_id(state, project, reply_to).await? else {
        return Err(ack_error(
            "SCOPE_NOT_FOUND",
            "reply target message not found",
        ));
    };
    if target.task_id != task.unwrap_or_default() {
        return Err(ack_error(
            "INVALID_MESSAGE",
            "reply target belongs to a different task thread",
        ));
    }
    Ok(ReplyContext {
        reply_to: Some(reply_to.to_string()),
        root: Some(if target.thread_root_message_id.is_empty() {
            target.message_id.clone()
        } else {
            target.thread_root_message_id.clone()
        }),
        preview: Some(project_chat_mentions::preview(&target.content)),
        recipient: stand_in_recipient(&target.sender_type, &target.sender_name, &target.metadata()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_agent_identity_supplies_a_reply_recipient() {
        let metadata = json!({"stand_in":{"user_id":7,"role_id":"review"}});
        assert_eq!(
            stand_in_recipient("agent", "Reviewer", &metadata),
            Some(json!({"user_id":7,"role_id":"review","name":"Reviewer"}))
        );
        assert!(stand_in_recipient("user", "Forged", &metadata).is_none());
        assert!(stand_in_recipient("agent", "Ordinary bot", &json!({})).is_none());
        assert!(
            stand_in_recipient(
                "agent",
                "Invalid",
                &json!({"stand_in":{"user_id":"7","role_id":"review"}})
            )
            .is_none()
        );
    }
}
