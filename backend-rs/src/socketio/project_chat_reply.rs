//! Resolve persisted reply scope and stand-in identity before recipient validation.
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::{SendRequest, ack_error};
use crate::socketio::project_chat_mentions::{self, Mention};
use crate::socketio::project_chat_messages::load_message_by_message_id;
use crate::state::AppState;

#[derive(Default)]
pub(super) struct Context {
    pub(super) reply_to: Option<String>,
    pub(super) root: Option<String>,
    pub(super) preview: Option<String>,
    recipient: Option<Recipient>,
}

#[derive(Serialize)]
struct Recipient {
    user_id: i64,
    role_id: String,
    name: String,
}

impl Context {
    pub(super) fn apply_stand_in(
        &self,
        mentions: &mut Vec<Mention>,
        metadata: &mut Map<String, Value>,
    ) {
        if !mentions.is_empty() {
            return;
        }
        if let Some(recipient) = &self.recipient {
            mentions.push(Mention::user(recipient.user_id, recipient.name.clone()));
            metadata.insert("stand_in_reply_to".into(), json!(recipient));
        }
    }
}

fn stand_in_recipient(sender: &str, name: &str, metadata: &Value) -> Option<Recipient> {
    if sender != "agent" {
        return None;
    }
    let identity = metadata.get("stand_in")?;
    Some(Recipient {
        user_id: identity.get("user_id")?.as_i64()?,
        role_id: identity.get("role_id")?.as_str()?.to_owned(),
        name: name.to_owned(),
    })
}

pub(super) async fn resolve(state: &AppState, request: &SendRequest) -> Result<Context, Value> {
    let Some(reply_to) = request.reply_to_message_id.as_deref() else {
        return Ok(Context::default());
    };
    let Some(target) = load_message_by_message_id(state, &request.project_id, reply_to).await?
    else {
        return Err(ack_error(
            "SCOPE_NOT_FOUND",
            "reply target message not found",
        ));
    };
    if target.task_id != request.task_id.as_deref().unwrap_or_default() {
        return Err(ack_error(
            "INVALID_MESSAGE",
            "reply target belongs to a different task thread",
        ));
    }
    let root = if target.thread_root_message_id.is_empty() {
        target.message_id.clone()
    } else {
        target.thread_root_message_id.clone()
    };
    Ok(Context {
        reply_to: Some(reply_to.to_owned()),
        root: Some(root),
        preview: Some(project_chat_mentions::preview(&target.content)),
        recipient: stand_in_recipient(&target.sender_type, &target.sender_name, &target.metadata()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply() -> Context {
        Context {
            recipient: stand_in_recipient(
                "agent",
                "Reviewer",
                &json!({"stand_in":{"user_id":7,"role_id":"review"}}),
            ),
            ..Context::default()
        }
    }

    #[test]
    fn persisted_stand_in_identity_becomes_a_validated_mention_target() {
        let mut mentions = Vec::new();
        let mut metadata = Map::new();
        reply().apply_stand_in(&mut mentions, &mut metadata);
        assert_eq!(
            json!(mentions),
            json!([{"type":"user","id":"7","label":"Reviewer"}])
        );
        assert_eq!(
            metadata["stand_in_reply_to"],
            json!({"user_id":7,"role_id":"review","name":"Reviewer"})
        );
    }

    #[test]
    fn explicit_mentions_keep_their_original_targets() {
        let mut mentions = vec![Mention::user(8, "Selected user".to_owned())];
        let mut metadata = Map::new();
        reply().apply_stand_in(&mut mentions, &mut metadata);
        assert_eq!(
            json!(mentions),
            json!([{"type":"user","id":"8","label":"Selected user"}])
        );
        assert!(metadata.is_empty());
    }

    #[test]
    fn ordinary_or_malformed_messages_do_not_supply_a_stand_in_identity() {
        let identity = json!({"stand_in":{"user_id":7,"role_id":"review"}});
        assert!(stand_in_recipient("user", "Actor", &identity).is_none());
        for metadata in [
            json!({}),
            json!({"stand_in":{"user_id":"7","role_id":"review"}}),
            json!({"stand_in":{"user_id":7}}),
        ] {
            assert!(stand_in_recipient("agent", "Reviewer", &metadata).is_none());
        }
    }
}
