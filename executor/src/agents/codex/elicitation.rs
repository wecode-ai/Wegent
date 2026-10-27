// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::{json_scalar_field, json_string_field, message_params};
use crate::logging::log_executor_event;

pub(super) const FORM_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const URL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn timeout_for(params: &Value) -> Duration {
    configured_timeout(
        params,
        std::env::var("WEGENT_CODEX_MCP_ELICITATION_TIMEOUT_MS")
            .ok()
            .as_deref(),
    )
}

fn configured_timeout(params: &Value, override_ms: Option<&str>) -> Duration {
    // Approval requests share this lifecycle, but keep their own default timeout.
    if matches!(params["mode"].as_str(), Some("url" | "form")) {
        if let Some(ms) = override_ms
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|ms| *ms > 0)
        {
            return Duration::from_millis(ms);
        }
    }
    if params["mode"] == "url" {
        URL_TIMEOUT
    } else {
        FORM_TIMEOUT
    }
}

/// Adds a single deadline before forwarding a request to both UI and response handling.
pub(super) fn prepare(message: &mut Value) {
    if message["method"] != "mcpServer/elicitation/request"
        && !message["method"]
            .as_str()
            .is_some_and(super::is_codex_approval_request_method)
    {
        return;
    }
    let deadline = now_ms().saturating_add(timeout_for(message_params(message)).as_millis() as u64);
    if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
        params
            .entry("expiresAtUnixMs")
            .or_insert_with(|| json!(deadline));
        params
            .entry("interactionStatus")
            .or_insert_with(|| json!("pending"));
    }
    log_event("codex mcp elicitation request received", message);
}

pub(super) fn remaining(message: &Value) -> Duration {
    message_params(message)["expiresAtUnixMs"]
        .as_u64()
        .map(|deadline| Duration::from_millis(deadline.saturating_sub(now_ms())))
        .unwrap_or_else(|| timeout_for(message_params(message)))
}

pub(super) fn log_event(event: &str, message: &Value) {
    let params = message_params(message);
    log_executor_event(
        event,
        &[
            ("request_id", json_scalar_field(message, "id")),
            ("thread_id", json_string_field(params, "threadId")),
            ("turn_id", json_string_field(params, "turnId")),
            ("server_name", json_string_field(params, "serverName")),
            ("mode", json_string_field(params, "mode")),
        ],
    );
}

pub(super) fn settled(message: &Value, status: &str, response: Option<&Value>) -> Value {
    let mut notification = message.clone();
    notification["method"] = json!(if message["method"]
        .as_str()
        .is_some_and(super::is_codex_approval_request_method)
    {
        notification["params"]["approvalMethod"] = message["method"].clone();
        "wegent/approval/settled"
    } else {
        "wegent/mcpElicitation/settled"
    });
    notification["params"]["interactionStatus"] = json!(status);
    notification["params"]["settledAtUnixMs"] = json!(now_ms());
    if let Some(answers) = response.and_then(|response| response.get("answers")) {
        notification["params"]["response"] = json!({
            "requestId": message["id"],
            "interactionScope": message["params"]["turnId"],
            "answers": answers,
        });
    }
    notification
}

pub(super) fn response_status(result: &Value) -> &'static str {
    match result["action"].as_str() {
        Some("accept") => "answered",
        _ => "cancelled",
    }
}

pub(super) fn copy_lifecycle(params: &Value, payload: &mut Value) {
    if let Some(scope) = params.get("turnId") {
        payload["interactionScope"] = scope.clone();
    }
    for key in [
        "expiresAtUnixMs",
        "interactionStatus",
        "settledAtUnixMs",
        "response",
    ] {
        if let Some(value) = params.get(key) {
            payload[key] = value.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_timeout_defaults_and_overrides() {
        let url = json!({"mode": "url"});
        let form = json!({"mode": "form"});
        for invalid in [None, Some(""), Some("0"), Some("-1"), Some("invalid")] {
            assert_eq!(configured_timeout(&url, invalid), Duration::from_secs(600));
            assert_eq!(configured_timeout(&form, invalid), Duration::from_secs(300));
        }
        for params in [url, form] {
            assert_eq!(
                configured_timeout(&params, Some("60000")),
                Duration::from_secs(60)
            );
        }
        assert_eq!(
            configured_timeout(&json!({}), Some("60000")),
            Duration::from_secs(300)
        );
    }
}
