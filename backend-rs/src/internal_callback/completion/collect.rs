// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `collect_completed_result` and its block-merge helpers
//! (`app/services/chat/trigger/lifecycle.py`).
use brz_mysql::{FromMysqlCol, Json, Mysql, MysqlResult, MysqlRow};
use brz_redis::Redis;
use serde_json::{Map, Value, json};

use super::Completion;
use super::sql;
use crate::internal_callback::session;
use crate::task_store::subtask_column_index;

const TERMINAL_CARD_STATUSES: [&str; 2] = ["populated", "error"];
const NONTERMINAL_CARD_STATUSES: [&str; 2] = ["pending", "partial_ready"];

/// Decode one column of the aliased `subtasks` projection positionally.
fn subtask_column<T: FromMysqlCol>(row: &MysqlRow, column: &str) -> MysqlResult<Option<T>> {
    let index = subtask_column_index(column)
        .ok_or_else(|| brz_mysql::MysqlError::ColumnNotFound(column.to_string()))?;
    row.get_at::<Option<T>>(index)
}

/// `_get_existing_subtask_result`: the stored subtask result, preserving the
/// `subqueryload(Subtask.contexts)` read the ORM issues alongside it.
async fn existing_subtask_result<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    subtask_id: i64,
) -> Option<Value> {
    let mysql = ctx
        .mysql
        .route(crate::task_routing::ByTaskId(subtask_id as u64));
    let row: MysqlRow = mysql
        .fetch_optional(sql::subtask_by_id(ctx.tables), (subtask_id,))
        .await
        .ok()
        .flatten()?;
    // The ORM eager-loads `Subtask.contexts`, so the source issues this read
    // even though the result merge never consumes it.
    let _contexts: Vec<MysqlRow> = mysql
        .fetch_all(sql::contexts_by_subtask(), (subtask_id,))
        .await
        .unwrap_or_default();
    let result: Option<Value> = subtask_column::<Json<Value>>(&row, "result")
        .ok()
        .flatten()
        .map(|json| json.0);
    result.filter(Value::is_object)
}

/// `_merge_blocks`: merge persisted and in-memory blocks preserving first-seen
/// order, with the terminal-card guard.
pub(crate) fn merge_blocks(existing_blocks: &Value, new_blocks: &Value) -> Vec<Value> {
    let mut merged: Vec<Map<String, Value>> = Vec::new();
    let mut indexes: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for candidate in [existing_blocks, new_blocks] {
        let Value::Array(blocks) = candidate else {
            continue;
        };
        for block in blocks {
            let Value::Object(block) = block else {
                continue;
            };
            let block_id = block
                .get("id")
                .map(|value| match value {
                    Value::String(text) => text.clone(),
                    Value::Null => String::new(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            if !block_id.is_empty()
                && let Some(index) = indexes.get(&block_id).copied()
            {
                let existing = &merged[index];
                let mut updated = existing.clone();
                for (key, value) in block {
                    if !value.is_null() {
                        updated.insert(key.clone(), value.clone());
                    }
                }
                if existing.get("type").and_then(Value::as_str) == Some("card")
                    && existing
                        .get("card_status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| TERMINAL_CARD_STATUSES.contains(&status))
                    && block
                        .get("card_status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| NONTERMINAL_CARD_STATUSES.contains(&status))
                {
                    for key in [
                        "status",
                        "card_status",
                        "card_data",
                        "card_preview_data",
                        "card_error",
                    ] {
                        if let Some(value) = existing.get(key) {
                            updated.insert(key.to_string(), value.clone());
                        }
                    }
                }
                merged[index] = updated;
                continue;
            }
            if !block_id.is_empty() {
                indexes.insert(block_id, merged.len());
            }
            merged.push(block.clone());
        }
    }
    merged.into_iter().map(Value::Object).collect()
}

/// `_is_blank_text_value`.
pub(crate) fn is_blank_text_value(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => true,
        Some(Value::String(text)) => text.trim().is_empty(),
        _ => false,
    }
}

/// `_extract_text_value_from_blocks`.
fn extract_text_value_from_blocks(blocks: Option<&Value>) -> String {
    let Some(Value::Array(blocks)) = blocks else {
        return String::new();
    };
    let mut parts: Vec<&str> = Vec::new();
    for block in blocks {
        let Value::Object(block) = block else {
            continue;
        };
        if !matches!(
            block.get("type").and_then(Value::as_str),
            Some("text" | "output_text")
        ) {
            continue;
        }
        let mut content = block.get("content").and_then(Value::as_str);
        if content.is_none_or(|text| text.trim().is_empty()) {
            content = block.get("text").and_then(Value::as_str);
        }
        if let Some(text) = content.filter(|text| !text.trim().is_empty()) {
            parts.push(text.trim());
        }
    }
    parts.join("\n")
}

/// `_decode_tool_output_payloads`.
fn decode_tool_output_payloads(tool_output: Option<&Value>) -> Vec<Map<String, Value>> {
    let candidates: Vec<&Value> = match tool_output {
        Some(Value::Array(items)) => items.iter().collect(),
        Some(other) => vec![other],
        None => vec![&Value::Null],
    };
    let mut payloads = Vec::new();
    for candidate in candidates {
        let mut value = candidate.clone();
        if let Value::Object(map) = &value
            && let Some(Value::String(text)) = map.get("text")
        {
            value = Value::String(text.clone());
        }
        if let Value::String(text) = &value {
            match serde_json::from_str::<Value>(text) {
                Ok(parsed) => value = parsed,
                Err(_) => continue,
            }
        }
        if let Value::Object(map) = value {
            payloads.push(map);
        }
    }
    payloads
}

/// `_extract_embedded_result_blocks`.
fn extract_embedded_result_blocks(blocks: Option<&Value>) -> Vec<Value> {
    let Some(Value::Array(items)) = blocks else {
        return Vec::new();
    };
    let mut embedded = Vec::new();
    for block in items {
        let Value::Object(block) = block else {
            continue;
        };
        if block.get("type").and_then(Value::as_str) != Some("tool") {
            continue;
        }
        for payload in decode_tool_output_payloads(block.get("tool_output")) {
            let Some(Value::Object(result_data)) = payload.get("result_data") else {
                continue;
            };
            if let Some(result_blocks @ Value::Array(_)) = result_data.get("blocks") {
                embedded = merge_blocks(&Value::Array(embedded), result_blocks);
            }
        }
    }
    embedded
}

/// `collect_completed_result`: the terminal result payload for one subtask.
pub(crate) async fn collect_completed_result<M: Mysql, R: Redis>(
    ctx: &Completion<'_, M, R>,
    subtask_id: i64,
    status: &str,
    result: Option<&Value>,
    error_message: Option<&str>,
    error_code: Option<&str>,
) -> Option<Value> {
    let normalized_status = status.to_uppercase();
    let accumulated_content = session::get_accumulated_content(ctx.redis, subtask_id).await;
    let existing_result = existing_subtask_result(ctx, subtask_id)
        .await
        .unwrap_or_else(|| Value::Object(Map::new()));

    let runtime_result = result.filter(|value| value.is_object());
    let mut runtime = runtime_result
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut termination_reason = runtime
        .get("termination_reason")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if termination_reason.is_none() {
        termination_reason = existing_result
            .get("termination_reason")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
    }
    match &termination_reason {
        Some(reason) => {
            runtime.insert("termination_reason".into(), Value::String(reason.clone()));
        }
        None => {
            runtime.shift_remove("termination_reason");
        }
    }

    let blocks = session::finalize_and_get_blocks(
        ctx.redis,
        subtask_id,
        termination_reason.as_deref(),
        Some(&normalized_status),
    )
    .await;

    let has_payload = !runtime.is_empty()
        || !existing_result.as_object().is_none_or(Map::is_empty)
        || !accumulated_content.is_empty()
        || !blocks.is_empty()
        || normalized_status == "COMPLETED"
        || (normalized_status == "FAILED" && error_code.is_some());
    if !has_payload {
        return None;
    }

    let mut final_result = runtime;
    if let Value::Object(existing) = &existing_result {
        for (key, value) in existing {
            if key == "blocks" {
                let merged =
                    merge_blocks(value, final_result.get("blocks").unwrap_or(&Value::Null));
                if !merged.is_empty() {
                    final_result.insert("blocks".into(), Value::Array(merged));
                }
                continue;
            }
            let current = final_result.get(key);
            if !final_result.contains_key(key)
                || current.is_none_or(Value::is_null)
                || (key == "blocks" && current.is_some_and(|value| !value.is_null()))
            {
                final_result.insert(key.clone(), value.clone());
            }
        }
    }

    if !blocks.is_empty() {
        let merged = merge_blocks(
            final_result.get("blocks").unwrap_or(&Value::Null),
            &Value::Array(blocks.into_iter().map(Value::Object).collect()),
        );
        if !merged.is_empty() {
            final_result.insert("blocks".into(), Value::Array(merged));
        }
    }

    let embedded = extract_embedded_result_blocks(final_result.get("blocks"));
    if !embedded.is_empty() {
        let merged = merge_blocks(
            final_result.get("blocks").unwrap_or(&Value::Null),
            &Value::Array(embedded),
        );
        final_result.insert("blocks".into(), Value::Array(merged));
    }

    if is_blank_text_value(final_result.get("value"))
        && (normalized_status == "COMPLETED" || !accumulated_content.trim().is_empty())
    {
        let text_value = if !accumulated_content.trim().is_empty() {
            accumulated_content.clone()
        } else {
            extract_text_value_from_blocks(final_result.get("blocks"))
        };
        final_result.insert("value".into(), Value::String(text_value));
    }

    if normalized_status == "FAILED"
        && let Some(code) = error_code
    {
        final_result.insert("error_type".into(), Value::String(code.to_string()));
        if let Some(status_code) = extract_http_status_code(error_message.unwrap_or_default()) {
            final_result.insert("error_code".into(), json!(status_code));
        }
    }

    Some(Value::Object(final_result))
}

/// `shared.utils.error_classifier.extract_http_status_code`: the first
/// `4xx`/`5xx` status code carried by the message.
fn extract_http_status_code(message: &str) -> Option<i64> {
    let mut digits = String::new();
    for ch in message.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
            if digits.len() == 3 {
                let code: i64 = digits.parse().ok()?;
                if (400..600).contains(&code) {
                    return Some(code);
                }
                digits.clear();
            }
        } else {
            digits.clear();
        }
    }
    None
}
