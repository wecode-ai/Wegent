// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Raw `subtasks.result` document decoding for the responses output builder.
//!
//! The source reads the persisted result as a dictionary and pulls each field
//! out with Python's own guards (`_extract_text_content`,
//! `_build_items_from_messages_chain`, `_build_items_from_blocks` in
//! `app/services/openapi/output_builder.py`). The row keeps the raw JSON, so
//! SQL NULL, a non-dict document, and an object with an unusable field stay
//! distinguishable, and one mistyped field never erases the others.
use serde_json::Value;

use super::http_error::HttpError;
use super::python_json::python_json_dumps;
use crate::json_compat::{python_str, python_truthy};

/// `result = subtask.result if isinstance(subtask.result, dict) else {}`
/// (`:678`), consumed field by field.
#[derive(Debug, Default)]
pub(super) struct ResultInput {
    /// `str(result.get("value") or "")`'s string branch: strings stay
    /// verbatim and every other non-null value renders as compact JSON.
    pub(super) value: String,
    /// `str(result.get("reasoning_content") or "")`.
    pub(super) reasoning_content: String,
    pub(super) messages_chain: Option<Vec<ChainEntry>>,
    pub(super) blocks: Option<Vec<ToolOrTextBlock>>,
}

impl ResultInput {
    pub(super) fn from_document(document: Option<&Value>) -> Result<Self, HttpError> {
        let Some(Value::Object(map)) = document else {
            return Ok(Self::default());
        };
        Ok(Self {
            value: result_text(map.get("value")),
            reasoning_content: python_text(map.get("reasoning_content")),
            messages_chain: chain_entries(map.get("messages_chain"))?,
            blocks: block_entries(map.get("blocks")),
        })
    }
}

/// The value conversion of the legacy result tail: `None`/JSON null is empty,
/// a string stays verbatim, and anything else renders as compact JSON
/// (including false, 0, [] and {}).
fn result_text(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
    }
}

/// Python `str(value or "")`.
fn python_text(value: Option<&Value>) -> String {
    value
        .filter(|value| python_truthy(value))
        .map(python_str)
        .unwrap_or_default()
}

/// `messages_chain = result.get("messages_chain")`; a non-list value behaves
/// like the absent field and non-object entries are skipped
/// (`if not isinstance(msg, dict): continue`).
fn chain_entries(value: Option<&Value>) -> Result<Option<Vec<ChainEntry>>, HttpError> {
    let Some(Value::Array(items)) = value else {
        return Ok(None);
    };
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        if let Some(entry) = ChainEntry::from_value(item)? {
            entries.push(entry);
        }
    }
    Ok(Some(entries))
}

/// `blocks = result.get("blocks") if isinstance(..., list) else []` plus the
/// per-entry `isinstance(block, dict)` guard.
fn block_entries(value: Option<&Value>) -> Option<Vec<ToolOrTextBlock>> {
    let Value::Array(items) = value? else {
        return None;
    };
    Some(
        items
            .iter()
            .filter_map(ToolOrTextBlock::from_value)
            .collect(),
    )
}

/// One assistant `messages_chain` entry, read field by field. The source skips
/// every other role (`if msg.get("role") != "assistant": continue`) before it
/// looks at any other field, so a non-assistant entry never validates
/// `tool_calls` or `content`.
#[derive(Debug)]
pub(super) struct ChainEntry {
    pub(super) content: MessageContent,
    pub(super) reasoning_content: MessageContent,
    pub(super) tool_calls: Vec<ChainToolCall>,
}

impl ChainEntry {
    fn from_value(value: &Value) -> Result<Option<Self>, HttpError> {
        let Value::Object(map) = value else {
            return Ok(None);
        };
        if map.get("role").and_then(Value::as_str) != Some("assistant") {
            return Ok(None);
        }
        Ok(Some(Self {
            content: MessageContent::from_value(map.get("content")),
            reasoning_content: MessageContent::from_value(map.get("reasoning_content")),
            tool_calls: chain_tool_calls(map.get("tool_calls"))?,
        }))
    }
}

/// `for tool_call in msg.get("tool_calls") or []`: a falsy value yields no
/// calls, an array keeps its object elements, and a truthy value Python
/// cannot iterate raises (`TypeError`) instead of being skipped.
fn chain_tool_calls(value: Option<&Value>) -> Result<Vec<ChainToolCall>, HttpError> {
    let Some(value) = value.filter(|value| python_truthy(value)) else {
        return Ok(Vec::new());
    };
    let Value::Array(items) = value else {
        // Objects and strings iterate to non-dict members and contribute
        // nothing; numbers and booleans are not iterable.
        return match value {
            Value::Object(_) | Value::String(_) => Ok(Vec::new()),
            _ => Err(malformed_result()),
        };
    };
    let mut calls = Vec::with_capacity(items.len());
    for item in items {
        if let Some(call) = ChainToolCall::from_value(item)? {
            calls.push(call);
        }
    }
    Ok(calls)
}

/// The endpoint's unhandled-exception mapping for a document the source
/// raises on (`app/core/exceptions.py:119`).
fn malformed_result() -> HttpError {
    HttpError::internal("Internal server error")
}

/// One `messages_chain` tool call: `{"id", "function": {"name",
/// "arguments"}}` read the way `_build_tool_item_from_tool_call` does.
#[derive(Debug)]
pub(super) struct ChainToolCall {
    pub(super) id: String,
    pub(super) function: Option<ChainFunction>,
}

impl ChainToolCall {
    fn from_value(value: &Value) -> Result<Option<Self>, HttpError> {
        let Value::Object(map) = value else {
            return Ok(None);
        };
        let function = match map.get("function") {
            Some(value) if python_truthy(value) => match value {
                Value::Object(fields) => Some(ChainFunction {
                    name: python_text(fields.get("name")),
                    arguments: dump_arguments(fields.get("arguments")),
                }),
                // `tool_call.get("function") or {}` then `.get(...)`: a truthy
                // non-object has no `.get` and raises in the source.
                _ => return Err(malformed_result()),
            },
            _ => None,
        };
        Ok(Some(Self {
            id: python_text(map.get("id")),
            function,
        }))
    }
}

#[derive(Debug)]
pub(super) struct ChainFunction {
    pub(super) name: String,
    pub(super) arguments: String,
}

/// `_dump_arguments(value or "")`: strings stay verbatim, a falsy value is
/// empty, and everything else renders with `json.dumps(ensure_ascii=False)`.
fn dump_arguments(value: Option<&Value>) -> String {
    match value.filter(|value| python_truthy(value)) {
        None => String::new(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => python_json_dumps(other),
    }
}

/// A persisted `blocks` entry: `tool`, `text`, `thinking`, an `image`/`video`
/// generation block, or an unknown kind that contributes nothing.
#[derive(Debug, Default)]
pub(super) struct ToolOrTextBlock {
    pub(super) kind: Option<String>,
    pub(super) id: Option<String>,
    pub(super) status: Option<String>,
    pub(super) content: Option<String>,
    pub(super) tool_use_id: Option<String>,
    pub(super) tool_name: Option<String>,
    pub(super) tool_protocol: Option<String>,
    pub(super) server_label: Option<String>,
    /// The raw `tool_input` document, kept verbatim for the blocks path's
    /// `_dump_arguments` rendering (unknown keys and field order retained).
    pub(super) tool_input_json: Option<Value>,
    pub(super) tool_output: Option<Value>,
    /// Generation-block fields (`type` `image`/`video`), read verbatim so the
    /// output item preserves the block's own number forms.
    pub(super) is_placeholder: Option<bool>,
    pub(super) video_url: Option<Value>,
    pub(super) video_attachment_id: Option<Value>,
    pub(super) video_duration: Option<Value>,
    pub(super) video_progress: Option<Value>,
    pub(super) video_thumbnail: Option<Value>,
    pub(super) image_urls: Option<Vec<Value>>,
    pub(super) image_download_urls: Option<Vec<Value>>,
    pub(super) image_attachment_ids: Option<Vec<Value>>,
    pub(super) image_count: Option<Value>,
    pub(super) image_size: Option<Value>,
    pub(super) image_download_url_expires_in_seconds: Option<Value>,
}

impl ToolOrTextBlock {
    /// Read one `blocks` entry field by field: the source only uses a field it
    /// can read (`isinstance` guards at every use), so a mistyped field is
    /// ignored instead of erasing the rest of the block.
    fn from_value(value: &Value) -> Option<Self> {
        let Value::Object(map) = value else {
            return None;
        };
        let text = |key: &str| map.get(key).and_then(Value::as_str).map(str::to_owned);
        let raw = |key: &str| map.get(key).cloned();
        let list = |key: &str| map.get(key).and_then(Value::as_array).cloned();
        Some(Self {
            kind: text("type"),
            id: text("id"),
            status: text("status"),
            content: text("content"),
            tool_use_id: text("tool_use_id"),
            tool_name: text("tool_name"),
            tool_protocol: text("tool_protocol"),
            server_label: text("server_label"),
            tool_input_json: raw("tool_input"),
            tool_output: raw("tool_output"),
            is_placeholder: map.get("is_placeholder").and_then(Value::as_bool),
            video_url: raw("video_url"),
            video_attachment_id: raw("video_attachment_id"),
            video_duration: raw("video_duration"),
            video_progress: raw("video_progress"),
            video_thumbnail: raw("video_thumbnail"),
            image_urls: list("image_urls"),
            image_download_urls: list("image_download_urls"),
            image_attachment_ids: list("image_attachment_ids"),
            image_count: raw("image_count"),
            image_size: raw("image_size"),
            image_download_url_expires_in_seconds: raw("image_download_url_expires_in_seconds"),
        })
    }
}

/// One chain message content value. `_extract_text_content`
/// (`openapi/output_builder.py:170-185`) accepts a bare string, and for a list
/// contributes only object entries typed `text`/`output_text`/`reasoning`
/// whose `text` is a non-empty string; every other entry is skipped. Recorded
/// chains mix an empty string, a reasoning-only block (value under
/// `reasoning`), and the final text, so the list is read as a value instead of
/// being decoded as a typed enum.
#[derive(Debug)]
pub(super) enum MessageContent {
    Text(String),
    Blocks(Vec<ContentBlock>),
}

impl MessageContent {
    fn from_value(value: Option<&Value>) -> Self {
        match value {
            Some(Value::String(text)) => Self::Text(text.clone()),
            Some(Value::Array(items)) => {
                Self::Blocks(items.iter().filter_map(ContentBlock::from_value).collect())
            }
            _ => Self::Blocks(Vec::new()),
        }
    }
}

/// One chain content block: only object entries whose `type` and `text` are
/// strings participate (`isinstance(block, dict)` / `isinstance(text, str)`);
/// a reasoning-only block keeps its value under `reasoning` and contributes
/// nothing to the extracted text.
#[derive(Debug)]
pub(super) struct ContentBlock {
    kind: String,
    text: String,
}

impl ContentBlock {
    fn from_value(value: &Value) -> Option<Self> {
        let Value::Object(map) = value else {
            return None;
        };
        Some(Self {
            kind: map.get("type").and_then(Value::as_str)?.to_owned(),
            text: map.get("text").and_then(Value::as_str)?.to_owned(),
        })
    }
}

/// `_extract_text_content`: string passthrough, or the `text` fields of
/// `text`/`output_text`/`reasoning`-typed content blocks joined with `\n`.
/// (A `reasoning`-typed block carries its text under `reasoning`, not
/// `text`, so it contributes nothing — matching the source extraction.)
pub(super) fn extract_text_content(value: &MessageContent) -> String {
    match value {
        MessageContent::Text(text) => text.clone(),
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter(|block| matches!(block.kind.as_str(), "text" | "output_text" | "reasoning"))
            .map(|block| block.text.as_str())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    }
}
