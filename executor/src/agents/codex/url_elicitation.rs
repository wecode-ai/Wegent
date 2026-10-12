use super::{
    is_mcp_tool_call_approval, mcp_server_elicitation_request_user_input_params,
    mcp_server_elicitation_response, mcp_server_tool_call_approval_response, message_params,
    InteractionAnswerRouter,
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

pub(super) async fn shared_response(
    message: &Value,
    answers: Option<Arc<InteractionAnswerRouter>>,
    key: String,
    auto_approve: bool,
) -> Result<Option<Value>, String> {
    let params = message_params(message);
    if auto_approve && is_mcp_tool_call_approval(params) {
        return mcp_server_tool_call_approval_response(message).map(Some);
    }
    // Never await an answer for a request the UI cannot display.
    if mcp_server_elicitation_request_user_input_params(params).is_none() {
        return mcp_server_elicitation_response(message, None).map(Some);
    }
    let Some(router) = answers else {
        return mcp_server_elicitation_response(message, None).map(Some);
    };
    let response = if params.get("mode").and_then(Value::as_str) == Some("url") {
        match tokio::time::timeout(Duration::from_secs(600), router.receive(key.clone())).await {
            Ok(result) => result?,
            Err(_) => {
                router.expire(&key).await;
                return Ok(Some(json!({"action": "cancel"})));
            }
        }
    } else {
        router.receive(key).await?
    };
    let Some(response) = response else {
        return Ok(None);
    };
    mcp_server_elicitation_response(message, Some(&response)).map(Some)
}

pub(super) fn request_params(params: &Value) -> Option<Value> {
    let address = params.get("url")?.as_str()?;
    let url = url::Url::parse(address).ok()?;
    let is_loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (url.scheme() != "https" && !(url.scheme() == "http" && is_loopback))
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let elicitation_id = params.get("elicitationId")?.as_str()?;
    if elicitation_id.trim().is_empty() {
        return None;
    }
    Some(json!({
        "itemId": "mcp_server_elicitation",
        "interactionKind": "mcp_url",
        "mode": "url",
        "url": address,
        "elicitationId": elicitation_id,
        "serverName": params.get("serverName"),
        "message": params.get("message"),
        "questions": [],
    }))
}

pub(super) fn response_result(response: &Value) -> Value {
    let action = response
        .pointer("/answers/__mcp_url/answers/0")
        .and_then(Value::as_str);
    // Consent to opening the browser is not proof of successful authorization.
    json!({"action": match action {
        Some("accept") => "accept",
        Some("decline") => "decline",
        _ => "cancel",
    }})
}
