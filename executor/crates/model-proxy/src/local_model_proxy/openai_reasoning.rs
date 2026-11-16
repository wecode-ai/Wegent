// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Map, Value};

use super::HttpError;

/// Rewrites foreign reasoning history for the official Codex Responses endpoint.
///
/// Third-party Responses providers may persist reasoning text in a non-empty
/// `content` array. The official endpoint accepts only the empty array form,
/// so promote readable text into `summary` and strip provider-bound fields.
pub(super) fn normalize_official_reasoning_history(
    body: Vec<u8>,
) -> Result<(Vec<u8>, usize), HttpError> {
    let mut request = serde_json::from_slice::<Value>(&body).map_err(|error| HttpError {
        status: axum::http::StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let strip_orphan_reasoning_ids = !request
        .get("store")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let Some(items) = request.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok((body, 0));
    };

    let mut changed = 0usize;
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        changed += normalize_reasoning_item(item, strip_orphan_reasoning_ids);
    }
    if changed == 0 {
        return Ok((body, 0));
    }

    let body = serde_json::to_vec(&request).map_err(|error| HttpError {
        status: axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode normalized Responses request: {error}"),
    })?;
    Ok((body, changed))
}

fn normalize_reasoning_item(item: &mut Value, strip_orphan_reasoning_ids: bool) -> usize {
    let Some(object) = item.as_object_mut() else {
        return 0;
    };
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !content.is_empty() {
        let summary = reasoning_summary(&content);
        if !summary.is_empty() && summary_is_empty(object.get("summary")) {
            object.insert("summary".to_owned(), Value::Array(summary));
        }
        object.insert("content".to_owned(), Value::Array(Vec::new()));
        // Text-bearing reasoning identifies an item produced by another
        // provider. Its opaque state cannot be replayed to the official
        // endpoint; clear it while retaining the readable summary above.
        object.remove("encrypted_content");
        if strip_orphan_reasoning_ids {
            object.remove("id");
        }
        return 1;
    }

    let mut changed = false;
    if object.get("encrypted_content").is_some() && !has_usable_encrypted_content(object) {
        object.remove("encrypted_content");
        changed = true;
    }
    if strip_orphan_reasoning_ids
        && object.get("id").is_some()
        && !has_usable_encrypted_content(object)
    {
        object.remove("id");
        changed = true;
    }
    usize::from(changed)
}

fn reasoning_summary(content: &[Value]) -> Vec<Value> {
    content
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("reasoning_text"))
        .filter_map(|part| {
            let text = part.get("text").and_then(Value::as_str)?;
            (!text.is_empty()).then(|| serde_json::json!({ "type": "summary_text", "text": text }))
        })
        .collect()
}

fn summary_is_empty(summary: Option<&Value>) -> bool {
    summary.map_or(true, |value| {
        value.is_null() || value.as_array().is_some_and(Vec::is_empty)
    })
}

fn has_usable_encrypted_content(object: &Map<String, Value>) -> bool {
    object
        .get("encrypted_content")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty() && value.trim() == value)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::normalize_official_reasoning_history;

    #[test]
    fn promotes_foreign_reasoning_text_and_strips_provider_state() {
        let body = serde_json::to_vec(&json!({
            "input": [
                {
                    "type": "reasoning",
                    "id": "rs_foreign",
                    "summary": [],
                    "content": [{"type": "reasoning_text", "text": "why"}],
                    "encrypted_content": "foreign-seal"
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "continue"}]
                }
            ]
        }))
        .unwrap();

        let (body, changed) = normalize_official_reasoning_history(body).unwrap();
        let request = serde_json::from_slice::<serde_json::Value>(&body).unwrap();

        assert_eq!(changed, 1);
        assert_eq!(request["input"][0]["content"], json!([]));
        assert_eq!(request["input"][0]["summary"][0]["text"], "why");
        assert!(request["input"][0].get("id").is_none());
        assert!(request["input"][0].get("encrypted_content").is_none());
        assert_eq!(request["input"][1]["content"][0]["text"], "continue");
    }

    #[test]
    fn preserves_native_encrypted_reasoning_and_returns_original_bytes_when_clean() {
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "reasoning",
                "id": "rs_native",
                "summary": [{"type": "summary_text", "text": "summary"}],
                "content": [],
                "encrypted_content": "native-seal"
            }]
        }))
        .unwrap();

        let (normalized, changed) = normalize_official_reasoning_history(body.clone()).unwrap();

        assert_eq!(changed, 0);
        assert_eq!(normalized, body);
    }

    #[test]
    fn preserves_an_existing_summary_when_clearing_foreign_content() {
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "reasoning",
                "summary": [{"type": "summary_text", "text": "existing"}],
                "content": [{"type": "reasoning_text", "text": "duplicate"}]
            }]
        }))
        .unwrap();

        let (body, changed) = normalize_official_reasoning_history(body).unwrap();
        let request = serde_json::from_slice::<serde_json::Value>(&body).unwrap();

        assert_eq!(changed, 1);
        assert_eq!(request["input"][0]["content"], json!([]));
        assert_eq!(request["input"][0]["summary"][0]["text"], "existing");
        assert_eq!(request["input"][0]["summary"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn preserves_the_item_id_when_the_request_asks_the_server_to_store_it() {
        let body = serde_json::to_vec(&json!({
            "store": true,
            "input": [{
                "type": "reasoning",
                "id": "rs_native",
                "summary": [{"type": "summary_text", "text": "summary"}],
                "content": []
            }]
        }))
        .unwrap();

        let (normalized, changed) = normalize_official_reasoning_history(body.clone()).unwrap();

        assert_eq!(changed, 0);
        assert_eq!(normalized, body);
    }

    #[test]
    fn drops_an_id_that_cannot_be_resolved_by_the_strict_target() {
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "reasoning",
                "id": "rs_orphan",
                "summary": [{"type": "summary_text", "text": "summary"}],
                "content": [],
                "encrypted_content": null
            }]
        }))
        .unwrap();

        let (body, changed) = normalize_official_reasoning_history(body).unwrap();
        let request = serde_json::from_slice::<serde_json::Value>(&body).unwrap();

        assert_eq!(changed, 1);
        assert!(request["input"][0].get("id").is_none());
        assert_eq!(request["input"][0]["summary"][0]["text"], "summary");
    }

    #[test]
    fn removes_invalid_encrypted_state_before_forwarding() {
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "reasoning",
                "id": "rs_foreign",
                "summary": [],
                "content": [],
                "encrypted_content": null
            }]
        }))
        .unwrap();

        let (body, changed) = normalize_official_reasoning_history(body).unwrap();
        let request = serde_json::from_slice::<serde_json::Value>(&body).unwrap();

        assert_eq!(changed, 1);
        assert!(request["input"][0].get("id").is_none());
        assert!(request["input"][0].get("encrypted_content").is_none());
    }
}
