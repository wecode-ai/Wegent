// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/internal/chat/history/{session_id}/subtasks/{subtask_id}` — one
//! page of a subtask's rendered transcript for AI history backtracking.
//!
//! Mirrors `app/api/endpoints/internal/chat_storage.py:read_history_subtask`
//! and the shared service it calls
//! (`app/services/chat/subtask_history.py:read_subtask_record`), on the
//! deployment's sharded subtask store:
//! 1. `parse_session_id` — `task-<id>` only; any other type is 400
//!    `Only task-based sessions are supported`.
//! 2. `task_store.get_by_id` — 404 `Task not found` when the task is missing.
//! 3. `subtask_store.get_by_id(subtask_id, owner_user_id=task.user_id)`:
//!    `_owner_matches_subtask_id` reads the shard row, guards the owner
//!    against that row's task (`_owner_matches_task_id`), then `_get_shard_
//!    subtask_by_id` reads the full row and `_attach_contexts` batches its
//!    `subtask_contexts`. A missing row, a row from another task, or a
//!    `DELETE`d row is 404 `Subtask not found in this session`.
//! 4. `_rendered_units` — the as-streamed `result.blocks` ground truth, with
//!    the `messages_chain` and `result.value` fallbacks.
//! 5. `_parse_cursor` then the compound-cursor page loop, which splits inside
//!    a single over-budget unit so a giant tool output stays reachable.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_history::parse_session_id;
use crate::chat_repository::ChatHistoryRepository;
use crate::internal_auth::http_error::HttpError;
use crate::json_compat::{python_json_value_no_ascii, python_str, python_truthy};
use crate::state::AppState;
use crate::task_store::subtask_column_index;

/// `DEFAULT_READ_MAX_CHARS` (source `app/services/chat/subtask_history.py`).
pub const DEFAULT_READ_MAX_CHARS: i64 = 14_000;

/// `SubtaskStatus.DELETE` — a deleted subtask is unreadable through a session.
const DELETED_STATUS: &str = "DELETE";

/// `SubtaskRole.USER`.
const USER_ROLE: &str = "USER";

/// Query parameters. FastAPI defaults `cursor` to `"0:0"` and `max_chars` to
/// `0`, which the service replaces with [`DEFAULT_READ_MAX_CHARS`].
#[derive(Debug, Default, Deserialize)]
pub struct SubtaskRecordQuery {
    pub cursor: Option<String>,
    pub max_chars: Option<i64>,
}

/// `SubtaskRecordResponse`.
#[derive(Debug, Serialize)]
pub struct SubtaskRecordResponse {
    pub id: i64,
    pub role: String,
    pub status: String,
    pub content: String,
    pub cursor: String,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_units: i64,
}

/// `read_subtask_record`'s result, before the response envelope.
#[derive(Debug, PartialEq, Eq)]
pub struct SubtaskRecord {
    pub id: i64,
    pub role: String,
    pub status: String,
    pub content: String,
    pub cursor: String,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub total_units: i64,
}

impl From<SubtaskRecord> for SubtaskRecordResponse {
    fn from(record: SubtaskRecord) -> Self {
        Self {
            id: record.id,
            role: record.role,
            status: record.status,
            content: record.content,
            cursor: record.cursor,
            next_cursor: record.next_cursor,
            has_more: record.has_more,
            total_units: record.total_units,
        }
    }
}

/// The subtask columns `_rendered_units` and the page loop read.
#[derive(Debug, Clone)]
pub struct RenderingRow {
    pub id: i64,
    pub role: String,
    pub status: String,
    pub prompt: Option<String>,
    pub result: Option<Value>,
}

impl RenderingRow {
    /// `result if isinstance(subtask.result, dict) else {}`.
    fn result_object(&self) -> Option<&serde_json::Map<String, Value>> {
        self.result.as_ref().and_then(Value::as_object)
    }
}

/// Decode one column of the labeled subtask projection by mapper position, so
/// the caller never needs the resolved physical table name.
fn decode_column<T: brz_mysql::FromMysqlCol>(
    row: &brz_mysql::MysqlRow,
    column: &str,
) -> Result<T, HttpError> {
    let index = subtask_column_index(column).ok_or_else(|| {
        HttpError::internal(brz_mysql::MysqlError::ColumnNotFound(column.to_string()))
    })?;
    row.get_at(index).map_err(HttpError::internal)
}

/// GET /api/internal/chat/history/:session_id/subtasks/:subtask_id.
#[brz_http_server::get("/api/internal/chat/history/:session_id/subtasks/:subtask_id")]
async fn read_history_subtask(
    #[inject(state)] state: &AppState,
    session_id: &str,
    subtask_id: &str,
    #[auth] _service: crate::internal_auth::InternalService,
    query: brz_http_server::Query<SubtaskRecordQuery>,
) -> Result<SubtaskRecordResponse, crate::http_compat::FastApiError> {
    read_history_subtask_value(state, session_id, subtask_id, &query)
        .await
        .map_err(crate::http_compat::FastApiError::from)
}

/// Handler body exposed for focused tests.
pub async fn read_history_subtask_value(
    app: &AppState,
    session_id: &str,
    subtask_id: &str,
    query: &SubtaskRecordQuery,
) -> Result<SubtaskRecordResponse, HttpError> {
    let (session_type, task_id) = parse_session_id(session_id)?;
    if session_type != "task" {
        return Err(HttpError::bad_request(
            "Only task-based sessions are supported",
        ));
    }
    // FastAPI's path parameter is `int`, so a non-integer id is a 422, not a
    // 500; the router-level parse mirrors that before the handler runs.
    let subtask_id = subtask_id
        .parse::<i64>()
        .map_err(|_| HttpError::bad_request("Invalid subtask_id"))?;

    let repository = ChatHistoryRepository::new(&app.mysql, &*app.task_store);
    // `task_store.get_by_id` renders the full task projection with no owner
    // filter; only `user_id` is consumed here.
    let task = repository
        .get_task_by_id(task_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(|| HttpError::not_found("Task not found"))?;

    // `subtask_store.get_by_id(subtask_id, owner_user_id=task.user_id)`.
    let Some(shard_row) = app
        .task_store
        .get_subtask_ref(subtask_id)
        .await
        .map_err(HttpError::internal)?
    else {
        return Err(HttpError::not_found("Subtask not found in this session"));
    };
    let owner_task_id: i64 = decode_column(&shard_row, "task_id")?;
    let owned = app
        .task_store
        .task_owner_matches(owner_task_id, i64::from(task.user_id))
        .await
        .map_err(HttpError::internal)?;
    if !owned {
        return Err(HttpError::not_found("Subtask not found in this session"));
    }
    let Some(row) = app
        .task_store
        .get_subtask(subtask_id)
        .await
        .map_err(HttpError::internal)?
    else {
        return Err(HttpError::not_found("Subtask not found in this session"));
    };
    // `subqueryload(Subtask.contexts)`: the batch context read runs whenever
    // the row exists. The rendering consumes none of its rows.
    let _contexts = repository
        .list_contexts_by_subtask_ids(&[subtask_id])
        .await
        .map_err(HttpError::internal)?;

    let row_task_id: i64 = decode_column(&row, "task_id")?;
    let status: String = decode_column(&row, "status")?;
    // Session scoping and the DELETE exclusion both answer 404.
    if row_task_id != task_id || status == DELETED_STATUS {
        return Err(HttpError::not_found("Subtask not found in this session"));
    }

    let rendering = RenderingRow {
        id: subtask_id,
        role: decode_column(&row, "role")?,
        status,
        prompt: decode_column(&row, "prompt")?,
        result: decode_column::<Option<brz_mysql::Json<Value>>>(&row, "result")?.map(|json| json.0),
    };
    Ok(read_subtask_record(
        &rendering,
        query.cursor.as_deref().unwrap_or("0:0"),
        query.max_chars.unwrap_or(0),
    )
    .into())
}

/// `read_subtask_record` for one loaded row: render, parse the compound
/// cursor, then page with the within-unit split fallback.
pub fn read_subtask_record(subtask: &RenderingRow, cursor: &str, max_chars: i64) -> SubtaskRecord {
    let units = rendered_units(subtask);
    let total = units.len() as i64;
    let max_chars = if max_chars <= 0 {
        DEFAULT_READ_MAX_CHARS
    } else {
        max_chars
    };
    let (unit_idx, char_off) = parse_cursor(cursor, total);

    let mut parts: Vec<String> = Vec::new();
    let mut budget = max_chars;
    let mut index = unit_idx;
    let mut offset = char_off;
    let mut next_cursor: Option<String> = None;

    while index < total {
        let unit = units[index as usize].as_str();
        let piece = char_slice_from(unit, offset);
        let piece_len = char_len(piece);
        if piece_len > budget {
            if parts.is_empty() {
                // A single unit alone overflows the page — split within it so a
                // giant tool output stays fully reachable (never lost).
                parts.push(truncate_chars(piece, budget));
                let new_off = offset + budget;
                next_cursor = Some(if new_off >= char_len(unit) {
                    format!("{}:0", index + 1)
                } else {
                    format!("{index}:{new_off}")
                });
            } else {
                // Page already has content: stop on this whole-unit boundary.
                next_cursor = Some(format!("{index}:{offset}"));
            }
            break;
        }
        parts.push(piece.to_string());
        budget -= piece_len;
        index += 1;
        offset = 0;
    }

    SubtaskRecord {
        id: subtask.id,
        role: subtask.role.to_lowercase(),
        status: subtask.status.clone(),
        content: parts.join("\n\n"),
        cursor: format!("{unit_idx}:{char_off}"),
        has_more: next_cursor.is_some(),
        next_cursor,
        total_units: total,
    }
}

/// `_parse_cursor`: `<unit_idx>:<char_off>` into clamped non-negative ints.
fn parse_cursor(cursor: &str, total: i64) -> (i64, i64) {
    let mut unit_idx = 0_i64;
    let mut char_off = 0_i64;
    if let Some((head, tail)) = cursor.split_once(':') {
        if is_digits(head) {
            unit_idx = head.parse::<i64>().unwrap_or(i64::MAX);
        }
        if is_digits(tail) {
            char_off = tail.parse::<i64>().unwrap_or(i64::MAX);
        }
    }
    (unit_idx.clamp(0, total), char_off.max(0))
}

/// `str.isdigit()` for the digit runs Python's `int()` accepts here.
fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// Python indexes strings by Unicode scalar, so `units[i][off:]` and the
/// budget comparison (`len(...)`) count chars, not bytes.
fn char_len(text: &str) -> i64 {
    text.chars().count() as i64
}

/// `text[off:]` for a non-negative char offset.
fn char_slice_from(text: &str, offset: i64) -> &str {
    if offset <= 0 {
        return text;
    }
    match text.char_indices().nth(offset as usize) {
        Some((byte_index, _)) => &text[byte_index..],
        None => "",
    }
}

/// `text[:count]` for a non-negative char count.
fn truncate_chars(text: &str, count: i64) -> String {
    text.chars().take(count.max(0) as usize).collect()
}

/// `_rendered_units`: ordered, non-empty rendered unit strings.
///
/// `blocks` is the as-streamed ground truth (never compaction-lossy);
/// `messages_chain` / `value` are the legacy/simple-turn fallbacks.
pub fn rendered_units(subtask: &RenderingRow) -> Vec<String> {
    if subtask.role == USER_ROLE {
        return subtask
            .prompt
            .clone()
            .filter(|prompt| !prompt.is_empty())
            .into_iter()
            .collect();
    }
    let Some(result) = subtask.result_object() else {
        return Vec::new();
    };
    let rendered: Vec<String> = match result.get("blocks").and_then(Value::as_array) {
        Some(blocks) if !blocks.is_empty() => blocks
            .iter()
            .filter_map(|block| block.as_object().map(render_block))
            .collect(),
        _ => match result.get("messages_chain").and_then(Value::as_array) {
            Some(chain) if !chain.is_empty() => chain
                .iter()
                .filter_map(|message| message.as_object().map(render_message))
                .collect(),
            _ => match result.get("value") {
                Some(Value::String(text)) if !text.is_empty() => vec![text.clone()],
                _ => Vec::new(),
            },
        },
    };
    rendered
        .into_iter()
        .filter(|unit| !unit.is_empty())
        .collect()
}

/// `_render_block`: one stored block into a readable transcript fragment.
fn render_block(block: &serde_json::Map<String, Value>) -> String {
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "text" => block_content(block),
        "tool" => {
            let name = block
                .get("display_name")
                .filter(|value| python_truthy(value))
                .or_else(|| block.get("tool_name").filter(|value| python_truthy(value)))
                .map(python_str)
                .unwrap_or_else(|| "tool".to_string());
            let tool_input = block
                .get("tool_input")
                .filter(|value| python_truthy(value))
                .cloned()
                .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
            let mut lines = vec![format!(
                "[tool: {name}] input={}",
                python_json_value_no_ascii(&tool_input)
            )];
            if let Some(output) = block
                .get("tool_output")
                .filter(|value| python_truthy(value))
            {
                lines.push(format!("output: {}", python_str(output)));
            }
            lines.join("\n")
        }
        "guidance" | "subagent" => block_content(block),
        _ => python_json_value_no_ascii(&Value::Object(block.clone())),
    }
}

/// `str(block.get("content") or "")`.
fn block_content(block: &serde_json::Map<String, Value>) -> String {
    block
        .get("content")
        .filter(|value| python_truthy(value))
        .map(python_str)
        .unwrap_or_default()
}

/// `_render_message`: one `messages_chain` entry (legacy-turn fallback).
fn render_message(message: &serde_json::Map<String, Value>) -> String {
    let role = message
        .get("role")
        .map(python_str)
        .unwrap_or_else(|| "assistant".to_string());
    let content = message.get("content").cloned().unwrap_or(Value::Null);
    let mut text = match content {
        Value::String(text) => text,
        other => python_json_value_no_ascii(&other),
    };
    if let Some(tool_calls) = message
        .get("tool_calls")
        .filter(|value| python_truthy(value))
    {
        text = format!(
            "{text}\n[tool_calls: {}]",
            python_json_value_no_ascii(tool_calls)
        );
    }
    format!("{role}: {text}")
}

#[cfg(test)]
#[path = "chat_subtask_record_tests.rs"]
mod tests;
