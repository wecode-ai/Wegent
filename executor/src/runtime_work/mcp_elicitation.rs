// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};

use super::util::now_ms;
use crate::agents::mcp_server_elicitation_request_user_input_params;

pub(super) const SETTLED_METHOD: &str = "wegent/mcpElicitation/settled";

/// The same bounded active-turn item backs live events and transcript recovery.
pub(super) fn item(message: &Value) -> Option<Value> {
    if !matches!(
        message["method"].as_str(),
        Some("mcpServer/elicitation/request" | SETTLED_METHOD)
    ) {
        return None;
    }
    let params = message.get("params")?;
    let mut payload = mcp_server_elicitation_request_user_input_params(params)?;
    let request_id = message.get("id")?;
    let id = match request_id {
        Value::Number(id) => id.to_string(),
        Value::String(id) if !id.is_empty() => id.clone(),
        _ => return None,
    };
    payload["kind"] = json!("request_user_input");
    payload["requestId"] = request_id.clone();
    if payload.get("interactionStatus").is_none() {
        payload["interactionStatus"] = json!("pending");
    }
    Some(json!({
        "id": format!("request-user-input-{id}"),
        "type": "mcpElicitation",
        "renderPayload": payload,
        "createdAt": now_ms(),
    }))
}

pub(super) fn block(item: &Value, terminal: bool) -> Value {
    let mut payload = item["renderPayload"].clone();
    if payload["interactionStatus"] == "pending" {
        let expired = payload["expiresAtUnixMs"]
            .as_i64()
            .is_some_and(|deadline| deadline <= now_ms());
        if terminal || expired {
            payload["interactionStatus"] = json!(if expired { "expired" } else { "cancelled" });
            payload["settledAtUnixMs"] = json!(now_ms());
        }
    }
    json!({
        "id": item["id"], "type": "tool", "tool_name": "request_user_input",
        "status": if payload["interactionStatus"] == "pending" { "pending" } else { "done" },
        "timestamp": item["createdAt"], "render_payload": payload,
    })
}

pub(super) fn merge(existing: &Value, mut incoming: Value) -> Value {
    if existing["renderPayload"]["interactionStatus"] != "pending" {
        return existing.clone();
    }
    incoming["createdAt"] = existing["createdAt"].clone();
    if let Some(deadline) = existing["renderPayload"].get("expiresAtUnixMs") {
        incoming["renderPayload"]["expiresAtUnixMs"] = deadline.clone();
    }
    incoming
}

pub(super) fn settle_pending(item: &mut Value) {
    if item["type"] == "mcpElicitation" && item["renderPayload"]["interactionStatus"] == "pending" {
        item["renderPayload"] = block(item, true)["render_payload"].clone();
    }
}

pub(super) fn accepts_response(item: &Value, response: &Value) -> Option<bool> {
    if item["type"] != "mcpElicitation" {
        return None;
    }
    let key = |value: &Value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    };
    let payload = &item["renderPayload"];
    if key(&payload["requestId"]) != response_id(response).and_then(key) {
        return None;
    }
    Some(
        payload["interactionScope"] == response["interactionScope"]
            && payload["interactionStatus"] == "pending"
            && payload["expiresAtUnixMs"]
                .as_i64()
                .map_or(true, |deadline| deadline > now_ms()),
    )
}

pub(super) fn response_id(response: &Value) -> Option<&Value> {
    response
        .get("requestId")
        .or_else(|| response.get("request_id"))
        .or_else(|| response.get("itemId"))
        .or_else(|| response.get("item_id"))
        .filter(|id| id.is_number() || id.as_str().is_some_and(|id| !id.trim().is_empty()))
}
