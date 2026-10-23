//! Typed DingTalk operations reuse the installed plugin and its device-owned credentials.
use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::OnceLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

pub(crate) async fn search(payload: &Value) -> Result<Value, AppIpcError> {
    let profile = active_profile().await?;
    let kind = payload["kind"]
        .as_str()
        .filter(|kind| matches!(*kind, "group" | "direct"))
        .ok_or_else(|| AppIpcError::new("bad_request", "Connection kind is required"))?;
    let query = payload["query"]
        .as_str()
        .filter(|query| !query.trim().is_empty() && query.len() <= 256)
        .ok_or_else(|| AppIpcError::new("bad_request", "A search query is required"))?;
    let mut args: Vec<String> = if kind == "group" {
        vec!["chat", "search"]
    } else {
        vec!["contact", "user", "search"]
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    args.extend([
        "--query".into(),
        query.into(),
        "--profile".into(),
        profile.clone(),
    ]);
    if kind == "group" {
        if let Some(cursor) = payload["cursor"]
            .as_str()
            .filter(|cursor| !cursor.is_empty() && cursor.len() <= 2048)
        {
            args.extend(["--cursor".into(), cursor.into()]);
        }
    }
    let value = super::local_connector_auth::dingtalk_command(&args).await?;
    let rows = value
        .pointer(if kind == "group" {
            "/result/groups"
        } else {
            "/result"
        })
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppIpcError::new(
                "dingtalk_response_invalid",
                "DingTalk search returned an unknown response structure",
            )
        })?;
    let items: Vec<Value> = rows
        .iter()
        .filter_map(|row| {
            let id = if kind == "group" {
                row["openConversationId"].as_str()
            } else {
                row["openDingTalkId"].as_str()
            }?;
            let name = row[if kind == "group" { "title" } else { "name" }].as_str()?;
            Some(json!({"id":id,"name":name,"kind":kind,"profile":profile}))
        })
        .collect();
    if !rows.is_empty() && items.len() != rows.len() {
        return Err(AppIpcError::new(
            "dingtalk_response_invalid",
            "DingTalk search results are missing identity fields",
        ));
    }
    Ok(
        json!({"items":items,"hasMore":value["result"]["hasMore"],"nextCursor":value["result"]["nextCursor"]}),
    )
}

pub(crate) async fn active_profile() -> Result<String, AppIpcError> {
    let value =
        super::local_connector_auth::dingtalk_command(&["profile".into(), "list".into()]).await?;
    value["currentProfile"]
        .as_str()
        .filter(|profile| !profile.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            AppIpcError::new(
                "connector_auth_required",
                "pluginKey=dingtalk connectorSlug=dingtalk",
            )
        })
}

pub(crate) async fn source_page(
    source: &Value,
    state: &Value,
) -> Result<(Vec<Value>, Value), AppIpcError> {
    let profile = required(source, "profile")?;
    let id = required(source, "id")?;
    let self_id = own_identity(profile).await?;
    let start = state["after"]
        .as_str()
        .unwrap_or(required(source, "enabledAfter")?);
    let until = state["until"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let cursor = state["cursor"].as_str().unwrap_or("0");
    let mut args = if source["kind"] == "group" {
        vec!["chat", "message", "list-mentions", "--group", id]
    } else {
        vec!["chat", "message", "search-advanced", "--sender-ids", id]
    }
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    args.extend([
        "--start".into(),
        start.into(),
        "--end".into(),
        until.clone(),
        "--limit".into(),
        "100".into(),
        "--cursor".into(),
        cursor.into(),
        "--profile".into(),
        profile.into(),
    ]);
    let response = super::local_connector_auth::dingtalk_command(&args).await?;
    let messages = normalize_source_page(source, &response, &self_id)?;
    let has_more = response["result"]["hasMore"]
        .as_bool()
        .ok_or_else(|| invalid("Missing message pagination state"))?;
    let next = if has_more {
        let next = required(&response["result"], "nextCursor")?;
        if next == cursor {
            return Err(invalid("Message pagination cursor did not advance"));
        }
        json!({"after":start,"until":until,"cursor":next})
    } else {
        json!({"after":until,"cursor":"0"})
    };
    Ok((messages, next))
}

pub(crate) fn normalize_source_page(
    source: &Value,
    response: &Value,
    own_id: &str,
) -> Result<Vec<Value>, AppIpcError> {
    let conversations = response["result"]["conversationMessagesList"]
        .as_array()
        .ok_or_else(|| invalid("Missing conversation messages"))?;
    let mut result = Vec::new();
    for conversation in conversations {
        let direct = conversation["singleChat"]
            .as_bool()
            .ok_or_else(|| invalid("Missing conversation kind"))?;
        if direct != (source["kind"] == "direct") {
            continue;
        }
        let conversation_id = required(conversation, "openConversationId")?;
        if !direct && conversation["openConversationId"] != source["id"] {
            continue;
        }
        for message in conversation["messages"]
            .as_array()
            .ok_or_else(|| invalid("Missing messages"))?
        {
            let sender = required(message, "senderOpenDingTalkId")?;
            if sender == own_id || (direct && message["senderOpenDingTalkId"] != source["id"]) {
                continue;
            }
            let text = required(message, "content")?;
            let id = required(message, "openMessageId")?;
            let at = required(message, "createTime")?;
            result.push(json!({"id":id,"text":text,"senderId":sender,"senderName":message["sender"],"at":at,"conversationId":conversation_id,"quotedMessageId":message["quotedMessage"]["openMessageId"],"topicId":message["openConvThreadId"]}));
        }
    }
    Ok(result)
}

#[cfg(test)]
mod source_tests {
    use super::*;

    fn conversation(id: &str, direct: bool, sender: &str) -> Value {
        json!({"openConversationId":id,"singleChat":direct,"messages":[{"senderOpenDingTalkId":sender,"content":"Review this","openMessageId":format!("{id}:{sender}"),"createTime":"2026-10-23 12:00:00"}]})
    }

    #[test]
    fn intake_never_broadens_group_or_direct_scopes_and_excludes_self() {
        let response = json!({"result":{"conversationMessagesList":[conversation("selected",false,"alice"),conversation("other",false,"alice"),conversation("selected",false,"me"),conversation("dm-a",true,"alice"),conversation("dm-b",true,"bob"),conversation("self",true,"me")]}});
        let group =
            normalize_source_page(&json!({"kind":"group","id":"selected"}), &response, "me")
                .unwrap();
        assert_eq!(group.len(), 1);
        assert_eq!(group[0]["conversationId"], "selected");
        let direct =
            normalize_source_page(&json!({"kind":"direct","id":"alice"}), &response, "me").unwrap();
        assert_eq!(direct.len(), 1);
        assert_eq!(direct[0]["conversationId"], "dm-a");
    }

    #[test]
    fn invalid_provider_responses_fail_explicitly_without_advancing_intake() {
        assert!(normalize_source_page(
            &json!({"kind":"group","id":"selected"}),
            &json!({"success":false}),
            "me"
        )
        .is_err());
        let malformed = json!({"result":{"conversationMessagesList":[{"openConversationId":"selected","singleChat":false,"messages":[{"senderOpenDingTalkId":"alice"}]}]}});
        assert!(
            normalize_source_page(&json!({"kind":"group","id":"selected"}), &malformed, "me")
                .is_err()
        );
    }
}

async fn own_identity(profile: &str) -> Result<String, AppIpcError> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, String)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((_, id)) = cache
        .lock()
        .await
        .get(profile)
        .filter(|(at, _)| at.elapsed() < Duration::from_secs(60))
        .cloned()
    {
        return Ok(id);
    }
    let profiles =
        super::local_connector_auth::dingtalk_command(&["profile".into(), "list".into()]).await?;
    let account = profiles["profiles"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["profile"] == profile))
        .ok_or_else(|| {
            AppIpcError::new(
                "connector_auth_required",
                "pluginKey=dingtalk connectorSlug=dingtalk",
            )
        })?;
    let users = super::local_connector_auth::dingtalk_command(&[
        "contact".into(),
        "user".into(),
        "search".into(),
        "--query".into(),
        required(account, "userName")?.into(),
        "--profile".into(),
        profile.into(),
    ])
    .await?;
    let user = users["result"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["userId"] == account["userId"]))
        .ok_or_else(|| invalid("Cannot resolve the connected DingTalk user's identity"))?;
    let id = required(user, "openDingTalkId")?.to_owned();
    cache
        .lock()
        .await
        .insert(profile.into(), (Instant::now(), id.clone()));
    Ok(id)
}

pub(crate) async fn reply(
    source: &Value,
    message: &Value,
    work: &str,
    text: &str,
) -> Result<Value, AppIpcError> {
    if text.trim().is_empty() || text.len() > 20000 {
        return Err(AppIpcError::new(
            "bad_request",
            "Reply text is required and must fit the message size limit",
        ));
    }
    let uuid = format!(
        "{:x}",
        Sha256::digest(json!([work, message["id"], text]).to_string().as_bytes())
    );
    let args = [
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
        "--uuid",
        &uuid,
        "--profile",
        required(source, "profile")?,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    super::local_connector_auth::dingtalk_command(&args).await
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
