// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;

use super::HttpError;

pub(super) fn codex_forked_from_thread_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-codex-turn-metadata")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| serde_json::from_str::<Value>(value).ok())
        .and_then(|metadata| {
            metadata
                .get("forked_from_thread_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
        })
}

pub(super) fn prepare_fork_request(
    body: Vec<u8>,
    is_fork: bool,
) -> Result<(Vec<u8>, usize), HttpError> {
    if !is_fork {
        return Ok((body, 0));
    }
    let mut request = serde_json::from_slice::<Value>(&body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let Some(items) = request.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok((body, 0));
    };
    let removed = items
        .iter_mut()
        .filter(|item| is_opaque_encrypted_history_item(item))
        .map(remove_encrypted_content)
        .sum();
    if removed == 0 {
        return Ok((body, 0));
    }
    let body = serde_json::to_vec(&request).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode fork request: {error}"),
    })?;
    Ok((body, removed))
}

fn is_opaque_encrypted_history_item(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some(
            "reasoning"
                | "compaction"
                | "compaction_summary"
                | "context_compaction"
                | "agent_message"
        )
    )
}

fn remove_encrypted_content(value: &mut Value) -> usize {
    match value {
        Value::Object(object) => {
            let removed = usize::from(object.remove("encrypted_content").is_some());
            removed
                + object
                    .values_mut()
                    .map(remove_encrypted_content)
                    .sum::<usize>()
        }
        Value::Array(items) => items.iter_mut().map(remove_encrypted_content).sum(),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use serde_json::{json, Value};

    use super::{codex_forked_from_thread_id, prepare_fork_request};

    #[test]
    fn reads_fork_lineage_from_codex_turn_metadata() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-codex-turn-metadata",
            HeaderValue::from_static(
                "{\"thread_id\":\"thread-child\",\"forked_from_thread_id\":\"thread-parent\"}",
            ),
        );

        assert_eq!(
            codex_forked_from_thread_id(&headers).as_deref(),
            Some("thread-parent")
        );
    }

    #[test]
    fn strips_only_opaque_encrypted_history_from_fork_requests() {
        let body = serde_json::to_vec(&json!({
            "model": "gpt-5.6-terra",
            "input": [
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "kept summary"}],
                    "encrypted_content": "stale-reasoning",
                    "details": {
                        "encrypted_content": "nested-stale-reasoning"
                    }
                },
                {
                    "type": "compaction",
                    "encrypted_content": "stale-compaction"
                },
                {
                    "type": "compaction_summary",
                    "encrypted_content": "stale-compaction-summary"
                },
                {
                    "type": "context_compaction",
                    "encrypted_content": "stale-context-compaction"
                },
                {
                    "type": "agent_message",
                    "encrypted_content": "stale-agent-message"
                },
                {
                    "type": "function_call_output",
                    "output": [{
                        "type": "encrypted_content",
                        "encrypted_content": "tool-owned-content"
                    }]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "continue"}]
                }
            ]
        }))
        .expect("request body");

        let (prepared, removed) =
            prepare_fork_request(body, true).expect("fork request should prepare");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(removed, 6);
        assert_eq!(prepared["input"][0]["summary"][0]["text"], "kept summary");
        assert!(prepared["input"][0].get("encrypted_content").is_none());
        assert!(prepared["input"][0]["details"]
            .get("encrypted_content")
            .is_none());
        let input = prepared["input"].as_array().expect("prepared input array");
        for item in &input[1..5] {
            assert!(item.get("encrypted_content").is_none());
        }
        assert_eq!(
            prepared["input"][5]["output"][0]["encrypted_content"],
            "tool-owned-content"
        );
        assert_eq!(prepared["input"][6]["content"][0]["text"], "continue");
    }

    #[test]
    fn preserves_encrypted_history_for_non_fork_requests() {
        let body = serde_json::to_vec(&json!({
            "model": "gpt-5.6-terra",
            "input": [{
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "active-thread-state"
            }]
        }))
        .expect("request body");

        let (prepared, removed) =
            prepare_fork_request(body.clone(), false).expect("request should prepare");

        assert_eq!(removed, 0);
        assert_eq!(prepared, body);
    }
}
