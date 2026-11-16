// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashSet;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::HttpError;

/// Rewrites foreign reasoning history for the official Codex Responses endpoint.
///
/// Third-party Responses providers may persist reasoning text in a non-empty
/// `content` array. The official endpoint accepts only the empty array form,
/// so promote readable text into `summary` and strip provider-bound fields.
pub(super) fn normalize_official_reasoning_history(
    body: Vec<u8>,
    known_foreign_keys: &HashSet<String>,
    model_switched: bool,
) -> Result<(Vec<u8>, usize, HashSet<String>), HttpError> {
    let mut request = serde_json::from_slice::<Value>(&body).map_err(|error| HttpError {
        status: axum::http::StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let strip_orphan_reasoning_ids = !request
        .get("store")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut changed = 0usize;
    let mut normalized_reasoning_items = 0usize;
    let mut new_foreign_keys = HashSet::new();
    let previous_response_key = request
        .get("previous_response_id")
        .and_then(Value::as_str)
        .map(foreign_previous_response_key);
    if model_switched
        || previous_response_key
            .as_ref()
            .is_some_and(|key| known_foreign_keys.contains(key))
    {
        let removed = request
            .as_object_mut()
            .is_some_and(|object| object.remove("previous_response_id").is_some());
        changed += usize::from(removed);
        if let Some(key) = previous_response_key {
            new_foreign_keys.insert(key);
        }
    }
    if let Some(items) = request.get_mut("input").and_then(Value::as_array_mut) {
        let original = std::mem::take(items);
        let mut retained = Vec::with_capacity(original.len());
        for mut item in original {
            let encrypted_state = super::request_identity::has_encrypted_model_state(&item);
            if item.get("type").and_then(Value::as_str) == Some("reasoning") {
                let key = history_item_key(&item);
                let known_foreign = known_foreign_keys.contains(&key);
                let content_has_text = item
                    .get("content")
                    .and_then(Value::as_array)
                    .is_some_and(|content| !content.is_empty());
                if known_foreign || content_has_text || (model_switched && encrypted_state) {
                    normalized_reasoning_items += sanitize_foreign_reasoning_item(&mut item);
                    new_foreign_keys.insert(key);
                    changed += 1;
                } else {
                    let item_changed =
                        normalize_reasoning_item(&mut item, strip_orphan_reasoning_ids);
                    normalized_reasoning_items += item_changed;
                    changed += item_changed;
                }
                retained.push(item);
            } else if encrypted_state {
                let key = history_item_key(&item);
                let known_foreign = known_foreign_keys.contains(&key);
                if known_foreign || model_switched {
                    new_foreign_keys.insert(key);
                    changed += 1;
                } else {
                    retained.push(item);
                }
            } else {
                retained.push(item);
            }
        }
        *items = retained;
    }
    if changed == 0 {
        return Ok((body, 0, new_foreign_keys));
    }

    let body = serde_json::to_vec(&request).map_err(|error| HttpError {
        status: axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode normalized Responses request: {error}"),
    })?;
    Ok((body, normalized_reasoning_items, new_foreign_keys))
}

fn sanitize_foreign_reasoning_item(item: &mut Value) -> usize {
    let Some(object) = item.as_object_mut() else {
        return 0;
    };
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let summary = reasoning_summary(&content);
    if !summary.is_empty() && summary_is_empty(object.get("summary")) {
        object.insert("summary".to_owned(), Value::Array(summary));
    }
    object.insert("content".to_owned(), Value::Array(Vec::new()));
    object.remove("encrypted_content");
    object.remove("id");
    1
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

fn history_item_key(item: &Value) -> String {
    if let Some(id) = item
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return format!("id:{id}");
    }
    let mut normalized = item.clone();
    if let Some(object) = normalized.as_object_mut() {
        object.remove("encrypted_content");
        object.remove("status");
    }
    let bytes = serde_json::to_vec(&normalized).unwrap_or_default();
    format!("hash:{:x}", Sha256::digest(bytes))
}

fn foreign_previous_response_key(response_id: &str) -> String {
    format!("previous_response_id:{response_id}")
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

        let (body, changed, _) =
            normalize_official_reasoning_history(body, &Default::default(), false).unwrap();
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

        let (normalized, changed, _) =
            normalize_official_reasoning_history(body.clone(), &Default::default(), false).unwrap();

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

        let (body, changed, _) =
            normalize_official_reasoning_history(body, &Default::default(), false).unwrap();
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

        let (normalized, changed, _) =
            normalize_official_reasoning_history(body.clone(), &Default::default(), false).unwrap();

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

        let (body, changed, _) =
            normalize_official_reasoning_history(body, &Default::default(), false).unwrap();
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

        let (body, changed, _) =
            normalize_official_reasoning_history(body, &Default::default(), false).unwrap();
        let request = serde_json::from_slice::<serde_json::Value>(&body).unwrap();

        assert_eq!(changed, 1);
        assert!(request["input"][0].get("id").is_none());
        assert!(request["input"][0].get("encrypted_content").is_none());
    }
}
