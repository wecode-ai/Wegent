// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response construction for the responses API
//! (`_task_to_response_object` + `build_response_output` in
//! `app/api/endpoints/openapi_responses.py` and
//! `app/services/openapi/output_builder.py`).
//!
//! The output items are the source's `ResponseOutputItem` union:
//! `message`, `function_call`, `mcp_call`, `shell_call`, plus the image and
//! video generation calls. A generation block (`type` `image`/`video`)
//! becomes a generation item, whose temporary download URLs are signed from
//! the block's attachment ids.
use serde::Serialize;
use serde_json::Value;

use super::generation_output::{
    ImageGenerationCallItem, VideoGenerationCallItem, build_generation_output_item_from_block,
};
use super::http_error::HttpError;
use super::python_json::python_json_dumps;
use super::responses_repository::TaskRow;
use super::shell_output::{ShellCallItem, ShellInput, build_shell_item, shell_call_status};
use crate::config::AuthConfig;

/// One persisted subtask `result` document
/// (`_build_items_from_messages_chain` / `_build_items_from_blocks` inputs).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ResultInput {
    value: ResultText,
    reasoning_content: Option<String>,
    messages_chain: Option<Vec<Option<ChainEntry>>>,
    blocks: Option<Vec<Option<ToolOrTextBlock>>>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ChainEntry {
    role: Option<String>,
    content: Option<MessageContent>,
    reasoning_content: Option<MessageContent>,
    tool_calls: Option<Vec<Option<ChainToolCall>>>,
}

/// One `messages_chain` tool call: `{"id", "function": {"name",
/// "arguments"}}` with a string-or-object arguments value.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ChainToolCall {
    id: Option<String>,
    function: Option<ChainFunction>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ChainFunction {
    name: Option<String>,
    arguments: Option<ArgumentsText>,
}

/// `function.arguments` arrives either as a pre-serialized JSON string or as
/// the object itself; `_dump_arguments` keeps strings verbatim and renders
/// non-strings with `json.dumps(ensure_ascii=False)`.
#[derive(Debug, Default, Clone)]
struct ArgumentsText(String);

impl<'de> serde::Deserialize<'de> for ArgumentsText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = match Value::deserialize(deserializer)? {
            Value::Null => String::new(),
            Value::String(text) => text,
            other => python_json_dumps(&other),
        };
        Ok(Self(text))
    }
}

/// A persisted `blocks` entry: `tool`, `text`, `thinking`, an `image`/`video`
/// generation block, or an unknown kind that contributes nothing.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub(super) struct ToolOrTextBlock {
    #[serde(rename = "type")]
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
    #[serde(rename = "tool_input")]
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

#[derive(Debug, serde::Deserialize)]
#[serde(untagged)]
enum MessageContent {
    Text(String),
    Blocks(Vec<Option<ContentBlock>>),
}

/// One chain message content block: `text`/`output_text`/`reasoning`
/// blocks carry their payload under `text` (reasoning-only blocks carry it
/// under `reasoning` and contribute nothing, matching the source).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

/// The legacy result.value conversion retains strings verbatim and renders
/// every other non-null value as compact JSON, including false, 0, [] and {}.
#[derive(Debug, Default)]
struct ResultText(String);
impl<'de> serde::Deserialize<'de> for ResultText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = match Value::deserialize(deserializer)? {
            Value::Null => String::new(),
            Value::String(text) => text,
            other => other.to_string(),
        };
        Ok(Self(text))
    }
}

/// `normalize_tool_output`: a JSON-string payload parses (and drops the
/// legacy `pending_user_input` keys on objects); anything else is passed
/// through unchanged. `None` stays JSON null like the source `Optional[Any]`.
pub(crate) fn normalize_tool_output(value: Option<&Value>) -> ToolOutput {
    match value {
        None | Some(Value::Null) => ToolOutput::Null,
        Some(Value::String(text)) => {
            let parsed = serde_json::from_str::<Value>(text).ok();
            match parsed {
                Some(parsed @ Value::Object(_)) => {
                    let mut map = parsed.as_object().expect("object").clone();
                    map.remove("pending_user_input");
                    map.remove("pending_user_input_payload");
                    ToolOutput::Json(Value::Object(map))
                }
                Some(other) => ToolOutput::Json(other),
                None => ToolOutput::Json(Value::String(text.clone())),
            }
        }
        Some(other) => ToolOutput::Json(sanitize_tool_object(other)),
    }
}

/// Remove the legacy pending-user-input keys from a nested object value.
fn sanitize_tool_object(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sanitized = map.clone();
            sanitized.remove("pending_user_input");
            sanitized.remove("pending_user_input_payload");
            Value::Object(sanitized)
        }
        Value::Array(items) => Value::Array(items.iter().map(sanitize_tool_object).collect()),
        other => other.clone(),
    }
}

/// The serialized `mcp_call.output` value: JSON null, or a sanitized JSON
/// document rendered at the response boundary.
#[derive(Debug)]
pub enum ToolOutput {
    Null,
    Json(Value),
}

impl Serialize for ToolOutput {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Null => serializer.serialize_none(),
            Self::Json(value) => value.serialize(serializer),
        }
    }
}

/// `ResponseError` (`app.schemas.openapi_response`).
#[derive(Debug, Serialize)]
pub struct ResponseError {
    pub code: String,
    pub message: String,
}

/// `OutputTextContent`.
#[derive(Debug, Serialize)]
pub struct OutputTextContent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub text: String,
    pub annotations: [(); 0],
}

/// `OutputMessage`.
#[derive(Debug, Serialize)]
pub struct OutputMessage {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub id: String,
    pub status: &'static str,
    pub role: &'static str,
    pub content: Vec<OutputTextContent>,
}

/// `FunctionCallOutputItem`.
#[derive(Debug, Serialize)]
pub struct FunctionCallItem {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    call_id: String,
    name: String,
    arguments: String,
}

/// `MCPCallOutputItem`.
#[derive(Debug, Serialize)]
pub struct McpCallItem {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    name: String,
    server_label: String,
    arguments: String,
    status: &'static str,
    output: ToolOutput,
}

/// One emitted `ResponseOutputItem`, serialized as an untagged member of
/// the source union. Field order follows each Pydantic model declaration.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum OutputItem {
    Message(OutputMessage),
    FunctionCall(FunctionCallItem),
    McpCall(McpCallItem),
    ShellCall(ShellCallItem),
    ImageGenerationCall(ImageGenerationCallItem),
    VideoGenerationCall(VideoGenerationCallItem),
}

/// `ResponseObject` (`app.schemas.openapi_response.ResponseObject`) with the
/// source field order: `id`, `object`, `created_at`, `status`, `error`,
/// `model`, `output`, `pending_user_input`, `pending_user_input_payload`,
/// `previous_response_id`.
#[derive(Debug, Serialize)]
pub struct ResponseObject {
    pub id: String,
    pub object: &'static str,
    pub created_at: i64,
    pub status: &'static str,
    pub error: Option<ResponseError>,
    pub model: String,
    pub output: Vec<OutputItem>,
    pub pending_user_input: Option<bool>,
    pub pending_user_input_payload: Option<brz_json::RawJson>,
    pub previous_response_id: Option<String>,
}

/// `wegent_status_to_openai_status`
/// (`app.services.openapi.helpers`).
pub fn wegent_status_to_openai_status(wegent_status: &str) -> &'static str {
    match wegent_status {
        "PENDING" => "queued",
        "RUNNING" => "in_progress",
        "COMPLETED" => "completed",
        "FAILED" => "failed",
        "CANCELLED" => "cancelled",
        "CANCELLING" => "in_progress",
        "DELETE" => "failed",
        _ => "incomplete",
    }
}

/// `subtask_status_to_message_status`
/// (`app.services.openapi.helpers`).
fn subtask_status_to_message_status(subtask_status: &str) -> &'static str {
    match subtask_status {
        "PENDING" => "in_progress",
        "RUNNING" => "in_progress",
        "COMPLETED" => "completed",
        "FAILED" => "incomplete",
        "CANCELLED" => "incomplete",
        _ => "incomplete",
    }
}

/// `_build_message_content`: reasoning block first, then text.
fn build_message_content(text: &str, reasoning: &str) -> Vec<OutputTextContent> {
    let mut content = Vec::new();
    if !reasoning.is_empty() {
        content.push(OutputTextContent {
            kind: "reasoning",
            text: reasoning.to_string(),
            annotations: [],
        });
    }
    if !text.is_empty() {
        content.push(OutputTextContent {
            kind: "output_text",
            text: text.to_string(),
            annotations: [],
        });
    }
    content
}

/// `_task_to_response_object`: convert the task row plus its subtasks into
/// the `ResponseObject`.
///
/// `created_at` mirrors the source `int(created_at.timestamp())`: the task
/// CRD `status.createdAt` is a naive local datetime (`TZ=Asia/Shanghai` in
/// the source deployment), so the timestamp is interpreted as UTC+8.
pub fn task_to_response_object(
    task: &TaskRow,
    model_string: &str,
    subtasks: &[super::responses_repository::SubtaskRow],
    previous_response_id: Option<String>,
    config: &AuthConfig,
) -> Result<ResponseObject, HttpError> {
    // Task status: the CRD `status.status` field, `PENDING` when absent.
    let task_crd = crate::crd::CrdDocument::project_opaque(&task.json.0);
    let status = task_crd.status.as_ref();
    let wegent_status = status
        .and_then(|status| status.status.as_deref())
        .unwrap_or("PENDING");

    // created_at: CRD `status.createdAt` (naive local, +08:00 deployment
    // timezone), falling back to the row's `created_at` column, then to now.
    let created_at_unix = task_created_at_unix(task).unwrap_or_else(unix_now);

    // Output items from the subtasks (assistant role only).
    let output = build_response_output(subtasks, config)?;

    // Error only when the task failed and carries a message.
    let error = if wegent_status == "FAILED" {
        status
            .and_then(|status| status.error_message.as_ref())
            .and_then(brz_json::OpaqueJson::project::<String>)
            .filter(|message| !message.is_empty())
            .map(|message| ResponseError {
                code: "task_failed".to_string(),
                message,
            })
    } else {
        None
    };

    Ok(ResponseObject {
        id: format!("resp_{}", task.id),
        object: "response",
        created_at: created_at_unix,
        status: wegent_status_to_openai_status(wegent_status),
        error,
        model: model_string.to_string(),
        output,
        // `extract_pending_user_input_state` never exposes legacy state.
        pending_user_input: None,
        pending_user_input_payload: None,
        previous_response_id,
    })
}

/// `int(created_at.timestamp())` for the task CRD's `status.createdAt`
/// (naive local datetime in the `TZ=Asia/Shanghai` deployment), falling back
/// to the row `created_at` column (same naive-local convention).
fn task_created_at_unix(task: &TaskRow) -> Option<i64> {
    let task_crd = crate::crd::CrdDocument::project_opaque(&task.json.0);
    if let Some(created_at) = task_crd
        .status
        .as_ref()
        .and_then(|status| status.created_at.as_ref())
        .and_then(brz_json::OpaqueJson::project::<String>)
        && let Some(naive) = parse_naive_datetime(&created_at)
    {
        return Some(naive_and_shanghai_to_unix(&naive));
    }
    task.created_at.as_ref().map(naive_and_shanghai_to_unix)
}

/// Parse the CRD's ISO-ish `createdAt` (`2026-09-05T09:10:52.897612`),
/// keeping microseconds out of the second-truncated conversion.
fn parse_naive_datetime(value: &str) -> Option<chrono::NaiveDateTime> {
    let value = value.trim_end_matches('Z');
    chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").ok()
}

/// Naive local datetime -> Unix seconds under the source deployment timezone
/// (`TZ=Asia/Shanghai`, UTC+8). `datetime.timestamp()` on a naive datetime
/// uses the process local timezone.
fn naive_and_shanghai_to_unix(naive: &chrono::NaiveDateTime) -> i64 {
    use chrono::TimeZone as _;
    chrono::FixedOffset::east_opt(8 * 3600)
        .expect("valid offset")
        .from_local_datetime(naive)
        .single()
        .map(|datetime| datetime.timestamp())
        .unwrap_or_else(|| naive.and_utc().timestamp())
}

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// `build_response_output`: output items for the subtasks in list order.
/// Only ASSISTANT subtasks produce items (`build_output_items_for_subtask`).
pub fn build_response_output(
    subtasks: &[super::responses_repository::SubtaskRow],
    config: &AuthConfig,
) -> Result<Vec<OutputItem>, HttpError> {
    let mut output = Vec::new();
    for subtask in subtasks {
        if subtask.role != "ASSISTANT" {
            continue;
        }
        output.extend(build_output_items_for_subtask(subtask, config)?);
    }
    Ok(output)
}

/// `build_output_items_for_subtask`: `result.output_items` passthrough,
/// then `messages_chain`, then `blocks`, then the plain value/reasoning
/// fallback.
pub fn build_output_items_for_subtask(
    subtask: &super::responses_repository::SubtaskRow,
    config: &AuthConfig,
) -> Result<Vec<OutputItem>, HttpError> {
    let result = subtask
        .result
        .as_ref()
        .and_then(|result| result.0.value.as_ref());
    let Some(result) = result else {
        return Ok(Vec::new());
    };
    let message_status = subtask_status_to_message_status(&subtask.status);

    if let Some(items) = build_items_from_messages_chain(subtask, result, message_status) {
        return Ok(items);
    }
    if let Some(items) = build_items_from_blocks(subtask, result, message_status, config)? {
        return Ok(items);
    }

    // Plain `value`/`reasoning_content` result (`build_output_items_for_subtask`
    // tail): one message with the bare subtask id.
    let text = result.value.0.as_str();
    let reasoning = result.reasoning_content.as_deref().unwrap_or("");
    if text.is_empty() && reasoning.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![OutputItem::Message(OutputMessage {
        kind: "message",
        id: format!("msg_{}", subtask.id),
        status: message_status,
        role: "assistant",
        content: build_message_content(text, reasoning),
    })])
}

/// `_build_items_from_messages_chain`: for each assistant entry, the tool
/// calls first (matched to `blocks` tool entries for the protocol and
/// output), then one message for the entry's extracted text/reasoning.
/// Returns `None` when the chain is absent/empty; an empty-but-present
/// chain that produced nothing falls through to the blocks path via the
/// `value`/`reasoning_content` final message.
fn build_items_from_messages_chain(
    subtask: &super::responses_repository::SubtaskRow,
    result: &ResultInput,
    message_status: &'static str,
) -> Option<Vec<OutputItem>> {
    let chain = result
        .messages_chain
        .as_ref()
        .filter(|chain| !chain.is_empty())?;
    let blocks = result.blocks.as_deref().unwrap_or_default();

    let mut items: Vec<OutputItem> = Vec::new();
    let mut built_message = false;
    for entry in chain.iter().filter_map(|entry| entry.as_ref()) {
        if entry.role.as_deref() != Some("assistant") {
            continue;
        }
        for tool_call in entry.tool_calls.iter().flatten().filter_map(|c| c.as_ref()) {
            let call_id = tool_call.id.as_deref().unwrap_or("");
            let function = tool_call.function.as_ref();
            let tool_name = function
                .and_then(|function| function.name.as_deref())
                .unwrap_or("");
            let arguments = function
                .and_then(|function| function.arguments.as_ref())
                .map(|arguments| arguments.0.as_str())
                .unwrap_or("");
            let block = find_tool_block_for_tool_call(call_id, tool_name, blocks);
            items.push(build_tool_item_from_tool_call(
                call_id, tool_name, arguments, block,
            ));
        }
        let text = extract_text_content(entry.content.as_ref());
        let reasoning = extract_text_content(entry.reasoning_content.as_ref());
        if text.is_empty() && reasoning.is_empty() {
            continue;
        }
        built_message = true;
        items.push(OutputItem::Message(OutputMessage {
            kind: "message",
            id: format!("msg_{}_{}", subtask.id, items.len()),
            status: message_status,
            role: "assistant",
            content: build_message_content(&text, &reasoning),
        }));
    }

    if !built_message {
        // Chain final fallback: `value`/`reasoning_content` with the bare id.
        // When neither is present the chain produced only tool items (or
        // nothing); the caller falls through to the blocks path (`if items:`
        // in `build_output_items_for_subtask`), so tool-only chains do not
        // short-circuit.
        let final_text = result.value.0.as_str();
        let final_reasoning = result.reasoning_content.as_deref().unwrap_or("");
        if !final_text.is_empty() || !final_reasoning.is_empty() {
            items.push(OutputItem::Message(OutputMessage {
                kind: "message",
                id: format!("msg_{}", subtask.id),
                status: message_status,
                role: "assistant",
                content: build_message_content(final_text, final_reasoning),
            }));
        }
    }
    (!items.is_empty()).then_some(items)
}

/// `_index_tool_blocks` + `_find_tool_block_for_tool_call`: match by
/// `tool_use_id`/`id`, else the single same-name mcp-protocol block.
fn find_tool_block_for_tool_call<'a>(
    call_id: &str,
    tool_name: &str,
    blocks: &'a [Option<ToolOrTextBlock>],
) -> Option<&'a ToolOrTextBlock> {
    let tool_blocks = || {
        blocks
            .iter()
            .filter_map(|block| block.as_ref())
            .filter(|block| block.kind.as_deref() == Some("tool"))
    };
    if !call_id.is_empty()
        && let Some(matched) = tool_blocks().find(|block| {
            let block_id = block.tool_use_id.as_deref().or(block.id.as_deref());
            block_id == Some(call_id)
        })
    {
        return Some(matched);
    }
    if tool_name.is_empty() {
        return None;
    }
    let mut candidates = tool_blocks().filter(|block| {
        block.tool_name.as_deref() == Some(tool_name)
            && matches!(
                block.tool_protocol.as_deref(),
                Some("mcp") | Some("mcp_call")
            )
    });
    let candidate = candidates.next()?;
    candidates.next().is_none().then_some(candidate)
}

/// `_build_tool_item_from_tool_call`.
fn build_tool_item_from_tool_call(
    call_id: &str,
    tool_name: &str,
    arguments: &str,
    block: Option<&ToolOrTextBlock>,
) -> OutputItem {
    match normalize_tool_protocol(tool_name, block) {
        ToolProtocol::Shell => {
            let parsed = ShellInput::from_arguments(arguments);
            build_shell_item(call_id, tool_name, &parsed, shell_call_status(block))
        }
        ToolProtocol::Mcp => OutputItem::McpCall(McpCallItem {
            kind: "mcp_call",
            id: nonempty_or(call_id, &format!("mcp_{tool_name}")),
            name: tool_name.to_string(),
            server_label: server_label_of(block),
            arguments: arguments.to_string(),
            status: shell_call_status(block),
            output: normalize_tool_output(block.and_then(|block| block.tool_output.as_ref())),
        }),
        ToolProtocol::Function => {
            let fallback_id = format!("fc_{tool_name}");
            let id = nonempty_or(call_id, &fallback_id);
            OutputItem::FunctionCall(FunctionCallItem {
                kind: "function_call",
                id: id.clone(),
                call_id: id,
                name: tool_name.to_string(),
                arguments: arguments.to_string(),
            })
        }
    }
}

/// `_build_items_from_blocks`: tool blocks become tool items, generation
/// (`image`/`video`) blocks become generation items, text and thinking blocks
/// become messages, then the final `value`/`reasoning` message when no text or
/// media was emitted.
fn build_items_from_blocks(
    subtask: &super::responses_repository::SubtaskRow,
    result: &ResultInput,
    message_status: &'static str,
    config: &AuthConfig,
) -> Result<Option<Vec<OutputItem>>, HttpError> {
    let Some(blocks) = result.blocks.as_ref() else {
        return Ok(None);
    };
    if blocks.is_empty() {
        return Ok(None);
    }

    // `generation_default_status`: the item default when the block carries no
    // status of its own.
    let generation_default_status = if matches!(message_status, "in_progress" | "completed") {
        message_status
    } else {
        "failed"
    };

    let mut items: Vec<OutputItem> = Vec::new();
    let mut emitted_text = false;
    let mut emitted_reasoning = false;
    let mut emitted_media = false;
    for block in blocks.iter().filter_map(|block| block.as_ref()) {
        if block.kind.as_deref() == Some("tool") {
            let tool_use_id = block
                .tool_use_id
                .as_deref()
                .or(block.id.as_deref())
                .unwrap_or("");
            let tool_name = block.tool_name.as_deref().unwrap_or("");
            // `_dump_arguments(tool_input)`: the block's own input
            // document, `json.dumps`-rendered with its stored field
            // order and unknown keys retained.
            let arguments = block
                .tool_input_json
                .as_ref()
                .map(python_json_dumps)
                .unwrap_or_default();
            match normalize_tool_protocol(tool_name, Some(block)) {
                ToolProtocol::Shell => {
                    let input = ShellInput::from_tool_input(block);
                    let item = build_shell_item(
                        tool_use_id,
                        tool_name,
                        &input,
                        shell_call_status(Some(block)),
                    );
                    items.push(item);
                }
                ToolProtocol::Mcp => {
                    items.push(OutputItem::McpCall(McpCallItem {
                        kind: "mcp_call",
                        id: nonempty_or(tool_use_id, &format!("mcp_{tool_name}")),
                        name: tool_name.to_string(),
                        server_label: block.server_label.clone().unwrap_or_default(),
                        arguments,
                        status: shell_call_status(Some(block)),
                        output: normalize_tool_output(block.tool_output.as_ref()),
                    }));
                }
                ToolProtocol::Function => {
                    let fallback_id = format!("fc_{tool_name}");
                    let id = nonempty_or(tool_use_id, &fallback_id);
                    items.push(OutputItem::FunctionCall(FunctionCallItem {
                        kind: "function_call",
                        id: id.clone(),
                        call_id: id,
                        name: tool_name.to_string(),
                        arguments,
                    }));
                }
            }
            continue;
        }
        if let Some(item) =
            build_generation_output_item_from_block(block, generation_default_status, config)?
        {
            emitted_media = true;
            items.push(item);
            continue;
        }
        match block.kind.as_deref() {
            Some("text") => {
                if let Some(content) = block.content.as_deref().filter(|c| !c.is_empty()) {
                    emitted_text = true;
                    let index = items.len();
                    items.push(text_message(subtask, message_status, index, content, ""));
                }
            }
            Some("thinking") => {
                if let Some(content) = block.content.as_deref().filter(|c| !c.is_empty()) {
                    emitted_reasoning = true;
                    let index = items.len();
                    items.push(text_message(subtask, message_status, index, "", content));
                }
            }
            _ => {}
        }
    }

    let final_text = if emitted_text || emitted_media {
        String::new()
    } else {
        result.value.0.clone()
    };
    let final_reasoning = result.reasoning_content.clone().unwrap_or_default();
    if !final_text.is_empty() || (!final_reasoning.is_empty() && !emitted_reasoning) {
        let reasoning = if emitted_reasoning {
            ""
        } else {
            final_reasoning.as_str()
        };
        items.push(OutputItem::Message(OutputMessage {
            kind: "message",
            id: format!("msg_{}", subtask.id),
            status: message_status,
            role: "assistant",
            content: build_message_content(&final_text, reasoning),
        }));
    }
    Ok(Some(items))
}

/// One `message` output item with the `msg_{id}_{index}` id
/// (`append_message`'s `len(output)` index in the blocks path).
fn text_message(
    subtask: &super::responses_repository::SubtaskRow,
    message_status: &'static str,
    index: usize,
    text: &str,
    reasoning: &str,
) -> OutputItem {
    OutputItem::Message(OutputMessage {
        kind: "message",
        id: format!("msg_{}_{}", subtask.id, index),
        status: message_status,
        role: "assistant",
        content: build_message_content(text, reasoning),
    })
}

/// `SHELL_TOOL_NAMES` and the block protocol normalization.
enum ToolProtocol {
    Shell,
    Mcp,
    Function,
}

/// `_normalize_tool_protocol`: the block's `tool_protocol` wins when it
/// names mcp or shell; otherwise the (block) tool name `exec`/`command_tool`
/// selects shell; everything else is a function call.
fn normalize_tool_protocol(tool_name: &str, block: Option<&ToolOrTextBlock>) -> ToolProtocol {
    if let Some(block) = block
        && let Some(protocol) = block
            .tool_protocol
            .as_deref()
            .map(str::trim)
            .map(str::to_lowercase)
    {
        if matches!(protocol.as_str(), "mcp" | "mcp_call") {
            return ToolProtocol::Mcp;
        }
        if protocol == "shell_call" {
            return ToolProtocol::Shell;
        }
    }
    let candidate = match block {
        Some(block) => {
            let block_name = block.tool_name.as_deref().unwrap_or("");
            if tool_name.is_empty() {
                block_name
            } else {
                tool_name
            }
        }
        None => tool_name,
    };
    if matches!(
        candidate.trim().to_lowercase().as_str(),
        "exec" | "command_tool"
    ) {
        return ToolProtocol::Shell;
    }
    ToolProtocol::Function
}

/// `str((block or {}).get("server_label") or "")`.
fn server_label_of(block: Option<&ToolOrTextBlock>) -> String {
    block
        .and_then(|block| block.server_label.as_deref())
        .unwrap_or("")
        .to_string()
}

pub(super) fn nonempty_or(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

/// `_extract_text_content`: string passthrough, or the `text` fields of
/// `text`/`output_text`/`reasoning`-typed content blocks joined with `\n`.
/// (A `reasoning`-typed block carries its text under `reasoning`, not
/// `text`, so it contributes nothing — matching the source extraction.)
fn extract_text_content(value: Option<&MessageContent>) -> String {
    match value {
        Some(MessageContent::Text(text)) => text.clone(),
        Some(MessageContent::Blocks(blocks)) => blocks
            .iter()
            .filter_map(|block| block.as_ref())
            .filter(|block| {
                matches!(
                    block.kind.as_deref(),
                    Some("text" | "output_text" | "reasoning")
                )
            })
            .filter_map(|block| block.text.as_deref())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        None => String::new(),
    }
}
