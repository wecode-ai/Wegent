//! DingTalk replies retain their existing approval and source-message binding.
use crate::local::app_ipc::AppIpcError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
    super::local_connector_auth::run_plugin_tool("dingtalk", "dingtalk", &args).await
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
