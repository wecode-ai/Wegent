//! DingTalk replies retain their existing approval and source-message binding.
use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub(crate) async fn reply(
    source: &Value,
    message: &Value,
    work: &str,
    text: &str,
    mentions: &Value,
) -> Result<Value, AppIpcError> {
    let args = reply_arguments(source, message, work, text, mentions)?;
    super::local_connector_auth::run_declared_plugin_tool("dingtalk", "dws", &args).await
}

fn reply_arguments(
    source: &Value,
    message: &Value,
    work: &str,
    text: &str,
    mentions: &Value,
) -> Result<Vec<String>, AppIpcError> {
    if text.trim().is_empty() || text.len() > 20000 {
        return Err(AppIpcError::new(
            "bad_request",
            "Reply text is required and must fit the message size limit",
        ));
    }
    let mention_ids = mention_ids(source, mentions)?;
    let identity = if mention_ids.is_empty() {
        json!([work, message["id"], text])
    } else {
        json!([work, message["id"], text, mention_ids])
    };
    let uuid = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    let mut args = [
        "chat",
        "message",
        "reply",
        "--conversation-id",
        required(message, "conversationId")?,
        "--ref-msg-id",
        required(message, "id")?,
        "--ref-sender",
        required(message, "senderId")?,
        "--text",
        text,
        "--ai-tag=true",
        "--uuid",
        &uuid,
        "--profile",
        required(source, "profile")?,
        "--format",
        "json",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    if !mention_ids.is_empty() {
        args.extend(["--at-open-dingtalk-ids".into(), mention_ids.join(",")]);
    }
    Ok(args)
}

fn mention_ids(source: &Value, mentions: &Value) -> Result<Vec<String>, AppIpcError> {
    if mentions.is_null() {
        return Ok(Vec::new());
    }
    let ids = mentions
        .as_array()
        .filter(|ids| ids.len() <= 30)
        .ok_or_else(|| invalid("Supply at most thirty mentionOpenDingTalkIds"))?;
    if !ids.is_empty() && source["kind"] != "group" {
        return Err(invalid("DingTalk mentions require a group conversation"));
    }
    let mut result = Vec::new();
    for id in ids {
        let id = id
            .as_str()
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 256
                    && !id.chars().any(|c| {
                        c.is_whitespace() || c.is_control() || matches!(c, ',' | '<' | '>' | '@')
                    })
            })
            .ok_or_else(|| {
                invalid("Supply real openDingTalkIds from contact lookup or source messages")
            })?;
        result.push(id.to_owned());
    }
    result.sort();
    result.dedup();
    Ok(result)
}

fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, AppIpcError> {
    value[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| invalid(&format!("Missing DingTalk {key}")))
}

fn invalid(message: &str) -> AppIpcError {
    AppIpcError::new("dingtalk_response_invalid", message)
}

pub(crate) fn runtime_work_summaries(user: i64, role: Option<&str>) -> Vec<Value> {
    super::store::RuntimeWorkStore::from_env()
        .list_task_summaries(false)
        .into_iter()
        .filter(|task| {
            let origin = &task.runtime_handle["origin"];
            origin["initiatedBy"] == "stand_in"
                && origin["userId"] == user
                && role.map_or(true, |role| origin["standInId"] == role)
        })
        .map(super::response::local_task_json)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(mentions: Value) -> Vec<String> {
        reply_arguments(
            &json!({"kind":"group","profile":"account"}),
            &json!({"id":"message","conversationId":"chat","senderId":"sender"}),
            "work",
            "Please investigate",
            &mentions,
        )
        .unwrap()
    }

    fn flag<'a>(args: &'a [String], key: &str) -> &'a str {
        &args[args.iter().position(|value| value == key).unwrap() + 1]
    }

    #[test]
    fn replies_forward_structured_mentions_and_preserve_source_and_ai_label() {
        let mentioned = args(json!(["person-b", "person-a", "person-a"]));
        assert_eq!(
            flag(&mentioned, "--at-open-dingtalk-ids"),
            "person-a,person-b"
        );
        assert_eq!(flag(&mentioned, "--conversation-id"), "chat");
        assert_eq!(flag(&mentioned, "--ref-msg-id"), "message");
        assert_eq!(flag(&mentioned, "--ref-sender"), "sender");
        assert_eq!(flag(&mentioned, "--profile"), "account");
        assert!(mentioned.contains(&"--ai-tag=true".into()));
        assert_eq!(mentioned, args(json!(["person-a", "person-b"])));
        assert_ne!(
            flag(&mentioned, "--uuid"),
            flag(&args(Value::Null), "--uuid")
        );
    }

    #[test]
    fn replies_without_mentions_keep_the_existing_idempotency_key() {
        let plain = args(Value::Null);
        assert_eq!(plain, args(json!([])));
        assert!(!plain.contains(&"--at-open-dingtalk-ids".into()));
        assert_eq!(
            flag(&plain, "--uuid"),
            format!(
                "{:x}",
                Sha256::digest(
                    json!(["work", "message", "Please investigate"])
                        .to_string()
                        .as_bytes()
                )
            )
        );
    }

    #[test]
    fn malformed_mentions_and_direct_chat_mentions_fail_before_sending() {
        for input in [
            json!("person"),
            json!([null]),
            json!([""]),
            json!(["a,b"]),
            json!(["@Name"]),
            json!(["<@person>"]),
            json!(["a\nb"]),
            json!(["a b"]),
            json!(vec!["person"; 31]),
        ] {
            assert!(mention_ids(&json!({"kind":"group"}), &input).is_err());
        }
        assert!(mention_ids(&json!({"kind":"direct"}), &json!(["person"])).is_err());
    }
}
