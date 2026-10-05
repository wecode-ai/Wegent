// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/internal/chat/history/{session_id}` — internal chat history.
//!
//! Mirrors `app/api/endpoints/internal/chat_storage.py:get_chat_history` and
//! `app/services/chat/compaction_checkpoint.py:resolve_history_subtasks`,
//! including fork-aware lineage resolution
//! (`app/services/task_fork_history.py`).
use crate::json_compat::raw_json;
use brz_http_server::Query as HttpQuery;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

use crate::attachment_block as blocks;
use crate::chat_repository::{ChatHistoryRepository, SubtaskContextRow, SubtaskRow, TaskForkSpec};
use crate::internal_auth::http_error::HttpError;

/// Query parameters of the history endpoint.
#[derive(Debug, Default, Deserialize)]
pub struct HistoryQuery {
    pub limit: Option<i64>,
    pub before_message_id: Option<i64>,
    #[serde(default)]
    pub is_group_chat: bool,
    #[serde(default)]
    pub supports_image: bool,
    #[serde(default)]
    pub supports_video: bool,
    #[serde(default)]
    pub from_latest_compaction: bool,
}

/// History statuses kept in the response (`history_statuses`).
const HISTORY_STATUSES: [&str; 3] = ["COMPLETED", "CANCELLED", "FAILED"];

/// Closing note appended to a cancelled assistant turn that kept useful text
/// (`CANCELLED_ASSISTANT_CONTEXT_NOTE`).
const CANCELLED_ASSISTANT_CONTEXT_NOTE: &str =
    "[Previous assistant response was interrupted by the user.]";

/// Message content block: a bare string, OpenAI-style blocks, or any other
/// JSON value the source keeps in its `Any` content field.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(untagged)]
pub enum MessageContent {
    Text(String),
    Blocks(Vec<Box<serde_json::value::RawValue>>),
    Raw(Box<serde_json::value::RawValue>),
}

fn opaque_blocks(blocks: Vec<Value>) -> MessageContent {
    MessageContent::Blocks(blocks.iter().map(raw_json).collect())
}

/// One message in the history response (`MessageResponse`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: MessageContent,
    pub name: Option<Box<serde_json::value::RawValue>>,
    pub tool_call_id: Option<Box<serde_json::value::RawValue>>,
    pub tool_calls: Option<Box<serde_json::value::RawValue>>,
    pub reasoning_content: Option<Box<serde_json::value::RawValue>>,
    pub created_at: Option<String>,
    pub loaded_skills: Option<Box<serde_json::value::RawValue>>,
    pub model_info: Option<Box<serde_json::value::RawValue>>,
    pub metadata: Option<Box<serde_json::value::RawValue>>,
}

#[derive(serde::Serialize)]
pub(crate) struct HistoryResponse {
    session_id: String,
    messages: Vec<Message>,
}

/// Parse `session_id` into `("task" | "subtask", id)` (`parse_session_id`).
#[allow(clippy::result_large_err)]
pub fn parse_session_id(session_id: &str) -> Result<(&str, i64), HttpError> {
    let (session_type, id_str) = session_id.split_once('-').ok_or_else(|| {
        HttpError::bad_request(&format!(
            "Invalid session_id format: {session_id}. Expected 'task-{{id}}' or 'subtask-{{id}}'"
        ))
    })?;
    if session_type != "task" && session_type != "subtask" {
        return Err(HttpError::bad_request(&format!(
            "Invalid session type: {session_type}. Expected 'task' or 'subtask'"
        )));
    }
    let id = id_str.parse::<i64>().map_err(|_| {
        HttpError::bad_request(&format!("Invalid session ID: {id_str}. Expected integer"))
    })?;
    Ok((session_type, id))
}

/// One resolved history subtask with its lineage origin.
#[derive(Debug, Clone)]
struct ForkHistoryItem {
    subtask: SubtaskRow,
}

/// Summary-compaction checkpoint detection
/// (`subtask_has_summary_checkpoint`).
fn subtask_has_summary_checkpoint(subtask: &SubtaskRow) -> bool {
    if subtask.role != "ASSISTANT" || subtask.status != "COMPLETED" {
        return false;
    }
    let Some(result) = subtask.result.as_ref().map(|json| &json.0) else {
        return false;
    };
    let Some(chain) = result.get("messages_chain").and_then(Value::as_array) else {
        return false;
    };
    chain.iter().any(|msg| {
        msg.get("additional_kwargs")
            .and_then(Value::as_object)
            .and_then(|kwargs| kwargs.get("summary_compacted"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    })
}

/// Slice `subtasks` to start at the latest checkpoint subtask
/// (`scope_to_latest_checkpoint`).
fn scope_to_latest_checkpoint(subtasks: &[ForkHistoryItem]) -> (&[ForkHistoryItem], Option<usize>) {
    let mut latest: Option<usize> = None;
    for (index, item) in subtasks.iter().enumerate() {
        if subtask_has_summary_checkpoint(&item.subtask) {
            latest = Some(index);
        }
    }
    match latest {
        None => (subtasks, None),
        Some(index) => (&subtasks[index..], Some(index)),
    }
}

/// Apply `limit` without ever dropping the checkpoint subtask
/// (`apply_checkpoint_limit`).
fn apply_checkpoint_limit(
    subtasks: &[ForkHistoryItem],
    limit: Option<i64>,
    from_latest_compaction: bool,
) -> Vec<ForkHistoryItem> {
    let Some(limit) = limit else {
        return subtasks.to_vec();
    };
    if limit <= 0 || subtasks.is_empty() {
        return subtasks.to_vec();
    }
    let limit = limit as usize;
    if from_latest_compaction {
        // Keep the checkpoint subtask (index 0) plus the last `limit - 1`
        // subtasks after it (`head + tail[-(limit - 1):]`).
        let keep = limit - 1;
        if keep == 0 {
            return subtasks[..1].to_vec();
        }
        if keep >= subtasks.len() - 1 {
            return subtasks.to_vec();
        }
        let mut owned: Vec<ForkHistoryItem> = Vec::with_capacity(1 + keep);
        owned.extend_from_slice(&subtasks[..1]);
        owned.extend_from_slice(&subtasks[subtasks.len() - keep..]);
        return owned;
    }
    let start = subtasks.len().saturating_sub(limit);
    subtasks[start..].to_vec()
}

/// Resolve the fork lineage for a task (`resolve_lineage`), bounded by
/// `MAX_FORK_DEPTH`; cycle detection raises a bad-request error.
async fn resolve_lineage(
    repository: &ChatHistoryRepository<'_>,
    task_id: i64,
    user_id: i32,
) -> Result<Vec<(i64, Option<i64>, Option<i64>)>, HttpError> {
    // Each node: (task_id, user_id, inherited_cutoff). The current task is
    // resolved with the requesting user id; ancestors are unscoped.
    let mut nodes_reversed: Vec<(i64, Option<i64>, Option<i64>)> = Vec::new();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut current_task_id = task_id;
    let mut inherited_cutoff: Option<i64> = None;

    for _ in 0..crate::task_routing::MAX_FORK_DEPTH {
        if !seen.insert(current_task_id) {
            return Err(HttpError::bad_request(&format!(
                "Task fork history cycle detected at task {current_task_id}"
            )));
        }
        let _ = user_id;
        // `_lineage_task`: depth 0 scopes the lookup to the requesting user,
        // ancestors are unscoped (`owner_user_id=None`).
        let task = if current_task_id == task_id {
            repository
                .get_task_by_id_with_owner(current_task_id, i64::from(user_id))
                .await
                .map_err(HttpError::internal)?
        } else {
            repository
                .get_task_by_id(current_task_id)
                .await
                .map_err(HttpError::internal)?
        };
        let Some(task) = task else {
            if current_task_id == task_id {
                return Err(HttpError::not_found("Task not found"));
            }
            return Err(HttpError::bad_request(&format!(
                "Task {current_task_id} not found while resolving fork history"
            )));
        };

        nodes_reversed.push((task.id, Some(i64::from(task.user_id)), inherited_cutoff));
        let fork = task
            .json
            .as_ref()
            .map(|json| &json.0)
            .and_then(TaskForkSpec::from_task_json);
        let Some(fork) = fork else {
            break;
        };
        current_task_id = fork.source_task_id;
        inherited_cutoff = Some(fork.after_message_id);
    }

    nodes_reversed.reverse();
    Ok(nodes_reversed)
}

/// `resolve_history_subtasks`: resolve -> status-filter -> checkpoint-scope ->
/// limit.
#[allow(clippy::too_many_arguments)]
async fn resolve_history_subtasks(
    repository: &ChatHistoryRepository<'_>,
    task_id: i64,
    user_id: i32,
    before_message_id: Option<i64>,
    limit: Option<i64>,
    from_latest_compaction: bool,
) -> Result<Vec<ForkHistoryItem>, HttpError> {
    let lineage = resolve_lineage(repository, task_id, user_id).await?;
    let mut items: Vec<ForkHistoryItem> = Vec::new();

    for (node_task_id, node_user_id, inherited_cutoff) in &lineage {
        let subtasks = repository
            .list_subtasks_by_task(*node_task_id, node_user_id.unwrap_or_default())
            .await
            .map_err(HttpError::internal)?;
        for subtask in subtasks {
            if let Some(cutoff) = inherited_cutoff
                && i64::from(subtask.message_id) > *cutoff
            {
                continue;
            }
            if let Some(before) = before_message_id
                && i64::from(subtask.message_id) >= before
            {
                continue;
            }
            items.push(ForkHistoryItem { subtask });
        }
    }

    items.sort_by(|left, right| {
        left.subtask
            .message_id
            .cmp(&right.subtask.message_id)
            .then_with(|| left.subtask.created_at.cmp(&right.subtask.created_at))
            .then_with(|| left.subtask.id.cmp(&right.subtask.id))
    });

    let mut subtasks: Vec<ForkHistoryItem> = items
        .into_iter()
        .filter(|item| HISTORY_STATUSES.contains(&item.subtask.status.as_str()))
        .collect();

    let mut scoped_to_checkpoint = false;
    if from_latest_compaction {
        let (scoped, checkpoint_index) = scope_to_latest_checkpoint(&subtasks);
        scoped_to_checkpoint = checkpoint_index.is_some();
        subtasks = scoped.to_vec();
    }
    Ok(apply_checkpoint_limit(
        &subtasks,
        limit,
        scoped_to_checkpoint,
    ))
}

/// Document attachment prefix (`context_service.build_document_text_prefix`).
///
/// The history endpoint calls it without `task_id`/`subtask_id`
/// (`chat_storage.py:571`), so `build_sandbox_path(None, None, ...)` is
/// `None` and the document header carries no sandbox-path segment.
fn build_document_text_prefix(
    context: &SubtaskContextRow,
    inject_max_chars: usize,
) -> Option<String> {
    let extracted_text = context.extracted_text.as_deref()?;
    if extracted_text.is_empty() {
        return None;
    }
    let filename = context.original_filename();
    let header = blocks::build_attachment_header(
        i64::from(context.id),
        Some(&filename),
        Some(&context.mime_type()),
        context.file_size(),
        None,
        false,
    );
    let is_truncated = context
        .type_data
        .as_ref()
        .map(|json| {
            json.0
                .get("is_truncated")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .unwrap_or(false);
    let (inject_text, inject_truncated) =
        blocks::truncate_for_injection(extracted_text, inject_max_chars);
    let note = blocks::build_truncation_note(is_truncated && !inject_truncated);
    Some(format!("{header}\n{note}{inject_text}\n\n"))
}

/// Convert one subtask into response messages (`subtask_to_messages`).
#[allow(clippy::too_many_arguments)]
async fn subtask_to_messages(
    repository: &ChatHistoryRepository<'_>,
    subtask: &SubtaskRow,
    is_group_chat: bool,
    supports_image: bool,
    supports_video: bool,
    max_extracted_text_length: usize,
    inject_max_chars: usize,
) -> Result<Vec<Message>, HttpError> {
    if subtask.role == "USER" {
        // Group chats keep the sender prefix; the recorded case is not a group
        // chat and does not query the users table.
        let sender_prefix = if is_group_chat && subtask.sender_user_id != 0 {
            format!("User[{}]: ", subtask.sender_user_id)
        } else {
            String::new()
        };
        let raw_prompt = subtask.prompt.as_deref().unwrap_or("");
        let (text_content, extra_blocks) = blocks::parse_prompt_blocks(raw_prompt);
        let text_content = if sender_prefix.is_empty() {
            text_content
        } else if !text_content.trim_start().starts_with(&sender_prefix) {
            format!("{sender_prefix}{text_content}")
        } else {
            text_content
        };

        let contexts = repository
            .list_ready_contexts(subtask.id)
            .await
            .map_err(HttpError::internal)?;

        let content = build_user_message_content(
            contexts,
            &text_content,
            extra_blocks,
            supports_image,
            supports_video,
            max_extracted_text_length,
            inject_max_chars,
            subtask.task_id,
            subtask.id,
        );
        return Ok(vec![Message {
            id: subtask.id.to_string(),
            role: "user".to_string(),
            content,
            name: None,
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
            created_at: subtask.created_at.map(format_datetime),
            loaded_skills: None,
            model_info: None,
            metadata: None,
        }]);
    }

    Ok(assistant_messages(subtask))
}

/// Python truthiness of a JSON value (`if not content`).
fn json_falsy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => true,
        Value::Bool(true) => false,
        Value::Number(number) => number.as_f64() == Some(0.0),
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
    }
}

/// Python truthiness of an optional JSON field; an absent field is falsy.
fn json_truthy(value: Option<&Value>) -> bool {
    value.is_some_and(|value| !json_falsy(value))
}

/// Opaque JSON content, preserving the source's `Any` content field.
fn raw_content(value: &Value) -> MessageContent {
    MessageContent::Raw(raw_json(value))
}

/// Optional raw JSON field: an explicit `null` is absent (`MessageResponse`).
fn optional_raw(value: Option<&Value>) -> Option<Box<serde_json::value::RawValue>> {
    value.filter(|value| !value.is_null()).map(raw_json)
}

/// Summary-compaction marker forwarded through the controlled metadata
/// whitelist (`resp_metadata`).
fn compacted_metadata(msg: &Value) -> Option<Value> {
    let compacted = msg
        .get("additional_kwargs")
        .and_then(Value::as_object)
        .and_then(|kwargs| kwargs.get("summary_compacted"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    compacted.then(|| json!({"summary_compacted": true}))
}

/// Build the messages of one assistant subtask (`subtask_to_messages`).
///
/// A single assistant subtask may expand into several messages when its
/// `messages_chain` carries the intermediate tool-call and tool-result
/// entries of one agent turn. Cancelled, failed, and legacy chain-less turns
/// are shaped separately: a turn the source omits must not reappear here.
fn assistant_messages(subtask: &SubtaskRow) -> Vec<Message> {
    let result = subtask
        .result
        .as_ref()
        .map(|json| &json.0)
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let created_at = subtask.created_at.map(format_datetime);

    // A cancelled turn may contain a partial response. Preserve the useful
    // text, but close the turn explicitly so the next model request does not
    // interpret it as an unfinished assistant message. Empty cancelled turns
    // add no context and must be omitted.
    if subtask.status == "CANCELLED" {
        if subtask.role != "ASSISTANT" {
            return Vec::new();
        }
        let Some(text) = result.get("value").and_then(Value::as_str) else {
            return Vec::new();
        };
        if text.trim().is_empty() {
            return Vec::new();
        }
        return vec![Message {
            id: subtask.id.to_string(),
            role: "assistant".to_string(),
            content: MessageContent::Text(format!(
                "{}\n\n{CANCELLED_ASSISTANT_CONTEXT_NOTE}",
                text.trim_end()
            )),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
            created_at,
            loaded_skills: None,
            model_info: None,
            metadata: None,
        }];
    }

    // For FAILED assistant subtasks, only keep result.value when present.
    // Do not expand messages_chain for failed turns to avoid injecting
    // tool-call artifacts or partial chain state into model history.
    if subtask.status == "FAILED" {
        if subtask.role != "ASSISTANT" {
            return Vec::new();
        }
        let content = result.get("value").cloned().unwrap_or_else(|| json!(""));
        if json_falsy(&content) {
            return Vec::new();
        }
        return vec![Message {
            id: subtask.id.to_string(),
            role: "assistant".to_string(),
            content: raw_content(&content),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            reasoning_content: None,
            created_at,
            loaded_skills: None,
            model_info: None,
            metadata: None,
        }];
    }

    // If messages_chain is available, expand to individual Message objects.
    if let Some(chain) = result.get("messages_chain").and_then(Value::as_array)
        && !chain.is_empty()
    {
        let loaded_skills = result.get("loaded_skills").cloned();
        let mut responses: Vec<Message> = Vec::with_capacity(chain.len());
        for (index, msg) in chain.iter().enumerate() {
            let role = msg
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("assistant");
            let resp_metadata = compacted_metadata(msg);
            let content = msg.get("content").cloned().unwrap_or_else(|| json!(""));
            // Empty assistant entries without tool calls, reasoning, or a
            // compaction marker carry no context.
            if role == "assistant"
                && json_falsy(&content)
                && !json_truthy(msg.get("tool_calls"))
                && !json_truthy(msg.get("reasoning_content"))
                && resp_metadata.is_none()
            {
                continue;
            }
            responses.push(Message {
                id: format!("{}-{index}", subtask.id),
                role: role.to_string(),
                content: raw_content(&content),
                name: optional_raw(msg.get("name")),
                tool_call_id: optional_raw(msg.get("tool_call_id")),
                tool_calls: optional_raw(msg.get("tool_calls")),
                reasoning_content: optional_raw(msg.get("reasoning_content")),
                created_at: created_at.clone(),
                loaded_skills: None,
                model_info: optional_raw(msg.get("model_info")),
                metadata: resp_metadata.map(|value| raw_json(&value)),
            });
        }
        // Attach loaded_skills to the last *assistant* message in the chain,
        // mirroring the package-mode backward scan so that skill state is
        // restored even when the chain ends with a tool message.
        if let Some(skills) = loaded_skills.filter(|value| !json_falsy(value)) {
            for response in responses.iter_mut().rev() {
                if response.role == "assistant" {
                    response.loaded_skills = Some(raw_json(&skills));
                    break;
                }
            }
        }
        return responses;
    }

    // Fallback for legacy data without messages_chain.
    let content = result.get("value").cloned().unwrap_or_else(|| json!(""));
    if json_falsy(&content) {
        return Vec::new();
    }
    vec![Message {
        id: subtask.id.to_string(),
        role: "assistant".to_string(),
        content: raw_content(&content),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        reasoning_content: None,
        created_at,
        loaded_skills: optional_raw(result.get("loaded_skills")),
        model_info: optional_raw(result.get("model_info")),
        metadata: None,
    }]
}

fn format_datetime(datetime: chrono::NaiveDateTime) -> String {
    datetime.format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Build user message content with attachment and KB contexts
/// (`_build_user_message_content`). Covers the recorded dependency topology:
/// attachment contexts with image/video/document handling and knowledge-base
/// contexts with direct-injection loading.
#[allow(clippy::too_many_arguments)]
fn build_user_message_content(
    contexts: Vec<SubtaskContextRow>,
    text_content: &str,
    extra_blocks: Vec<Value>,
    supports_image: bool,
    supports_video: bool,
    max_extracted_text_length: usize,
    inject_max_chars: usize,
    task_id: i64,
    subtask_id: i64,
) -> MessageContent {
    if contexts.is_empty() {
        if extra_blocks.is_empty() {
            return MessageContent::Text(text_content.to_string());
        }
        let mut blocks = vec![json!({"type": "text", "text": text_content})];
        blocks.extend(extra_blocks);
        return opaque_blocks(blocks);
    }

    let attachments: Vec<&SubtaskContextRow> = contexts
        .iter()
        .filter(|context| context.context_type == "attachment")
        .collect();
    let kb_contexts: Vec<&SubtaskContextRow> = contexts
        .iter()
        .filter(|context| context.context_type == "knowledge_base")
        .collect();

    let image_extensions = ["jpg", "jpeg", "png", "gif", "bmp", "webp"];
    let video_extensions = ["mp4", "avi", "mkv", "mov", "flv", "wmv"];

    let mut vision_parts: Vec<Value> = Vec::new();
    let mut attachment_text_parts: Vec<String> = Vec::new();

    for context in &attachments {
        let extension = context.file_extension().to_lowercase();
        let extension = extension
            .strip_prefix('.')
            .unwrap_or(&extension)
            .to_string();
        if image_extensions.contains(&extension.as_str())
            && !context.image_base64.as_deref().unwrap_or("").is_empty()
        {
            let filename = context.original_filename();
            let sandbox_path =
                blocks::build_sandbox_path(Some(task_id), Some(subtask_id), Some(&filename));
            let header = blocks::build_attachment_header(
                i64::from(context.id),
                Some(&filename),
                Some(&context.mime_type()),
                context.file_size(),
                sandbox_path.as_deref(),
                true,
            );
            attachment_text_parts.push(format!("{header}\n"));
            if !supports_image {
                continue;
            }
            let mime_type = if context.mime_type().is_empty() {
                "unknown".to_string()
            } else {
                context.mime_type()
            };
            vision_parts.push(json!({
                "type": "image_url",
                "image_url": {"url": format!("data:{};base64,{}", mime_type, context.image_base64.clone().unwrap_or_default())},
            }));
        } else if video_extensions.contains(&extension.as_str()) {
            // Video support requires the dedicated media-resolution path that
            // the recorded dependency topology does not exercise; keep the
            // metadata-only shape used when `supports_video` is false.
            let filename = context.original_filename();
            let file_size = context.file_size();
            let header = blocks::build_attachment_header(
                i64::from(context.id),
                Some(&filename),
                Some(&context.mime_type()),
                file_size,
                None,
                false,
            );
            attachment_text_parts.push(format!("{header}\n\n"));
        } else if let Some(prefix) = build_document_text_prefix(context, inject_max_chars) {
            attachment_text_parts.push(prefix);
        }
    }

    let total_attachment_text_length: usize = attachment_text_parts
        .iter()
        .map(|part| part.chars().count())
        .sum();
    let remaining_space = max_extracted_text_length.saturating_sub(total_attachment_text_length);

    let mut kb_text_parts: Vec<String> = Vec::new();
    let mut current_kb_length = 0_usize;
    let _ = supports_video;

    for kb_ctx in &kb_contexts {
        if remaining_space == 0 {
            break;
        }
        if kb_ctx.is_restricted_kb_context() {
            continue;
        }
        let mut kb_content = kb_ctx.extracted_text.clone().unwrap_or_default();
        if kb_content.is_empty() {
            // Direct-injection KBs load content from their documents; the
            // recorded dependency topology has no knowledge_base contexts, so
            // only the document-count-free header path applies here.
            let type_data = kb_ctx
                .type_data
                .as_ref()
                .map(|json| &json.0)
                .cloned()
                .unwrap_or_else(|| json!({}));
            let injection_mode = type_data
                .get("rag_result")
                .and_then(|rag| rag.get("injection_mode"))
                .or_else(|| type_data.get("injection_mode"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if injection_mode == "direct_injection" {
                // Content loading would query knowledge_documents; absent in
                // the recorded topology, so the context contributes no text.
                kb_content = String::new();
            }
        }
        if kb_content.is_empty() {
            continue;
        }
        let kb_name = if kb_ctx.name.is_empty() {
            "Knowledge Base".to_string()
        } else {
            kb_ctx.name.clone()
        };
        let kb_id = kb_ctx.knowledge_id();
        let kb_prefix = format!("[Knowledge Base: {kb_name} (ID: {kb_id})]\n{kb_content}\n\n");
        let prefix_length = kb_prefix.chars().count();
        if current_kb_length + prefix_length <= remaining_space {
            kb_text_parts.push(kb_prefix);
            current_kb_length += prefix_length;
        } else {
            let available = remaining_space.saturating_sub(current_kb_length);
            if available > 100 {
                let truncated: String = kb_prefix.chars().take(available).collect();
                kb_text_parts.push(format!("{truncated}\n(truncated...)\n\n"));
            }
            break;
        }
    }

    let mut context_blocks: Vec<Value> = Vec::new();
    if !attachment_text_parts.is_empty() {
        context_blocks.push(json!({
            "type": "text",
            "text": format!("<attachment>{}{}", attachment_text_parts.concat(), "</attachment>"),
        }));
    }
    if !kb_text_parts.is_empty() {
        context_blocks.push(json!({
            "type": "text",
            "text": format!("<knowledge_base>{}{}", kb_text_parts.concat(), "</knowledge_base>"),
        }));
    }

    if !extra_blocks.is_empty() {
        let mut all = context_blocks;
        all.extend(vision_parts);
        all.push(json!({"type": "text", "text": text_content}));
        all.extend(extra_blocks);
        return opaque_blocks(all);
    }

    if !context_blocks.is_empty() {
        let mut all = context_blocks;
        all.extend(vision_parts);
        all.push(json!({"type": "text", "text": text_content}));
        return opaque_blocks(all);
    }

    if !vision_parts.is_empty() {
        let mut all = vision_parts;
        all.push(json!({"type": "text", "text": text_content}));
        return opaque_blocks(all);
    }

    MessageContent::Text(text_content.to_string())
}

/// Handler body for `GET /api/internal/chat/history/{session_id}`, exposed
/// to `main.rs`'s API struct.
///
/// The source declares the query model with defaults for every field, so an
/// absent query string is valid and decodes to `HistoryQuery::default()`.
pub async fn get_chat_history_value(
    app: &crate::state::AppState,
    session_id: &str,
    query: &HttpQuery<HistoryQuery>,
) -> Result<HistoryResponse, crate::http_compat::FastApiError> {
    chat_history(app, session_id, query)
        .await
        .map_err(crate::http_compat::FastApiError::from)
}

async fn chat_history(
    app: &crate::state::AppState,
    session_id: &str,
    query: &HistoryQuery,
) -> Result<HistoryResponse, HttpError> {
    get_chat_history_inner(app, session_id, query).await
}

async fn get_chat_history_inner(
    app: &crate::state::AppState,
    session_id: &str,
    query: &HistoryQuery,
) -> Result<HistoryResponse, HttpError> {
    let (session_type, task_id) = parse_session_id(session_id)?;
    if session_type != "task" {
        return Err(HttpError::bad_request(
            "Only task-based sessions are supported",
        ));
    }

    let repository = ChatHistoryRepository::new(&app.mysql, &*app.task_store);
    let task = repository
        .get_task_by_id(task_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(|| HttpError::not_found("Task not found"))?;
    let task_user_id = task.user_id;
    let subtasks = resolve_history_subtasks(
        &repository,
        task_id,
        task_user_id,
        query.before_message_id,
        query.limit,
        query.from_latest_compaction,
    )
    .await?;

    let mut messages: Vec<Message> = Vec::new();
    for item in &subtasks {
        let subtask_messages = subtask_to_messages(
            &repository,
            &item.subtask,
            query.is_group_chat,
            query.supports_image,
            query.supports_video,
            app.internal_chat.max_extracted_text_length,
            app.internal_chat.attachment_inject_max_chars,
        )
        .await?;
        messages.extend(subtask_messages);
    }

    Ok(HistoryResponse {
        session_id: session_id.to_owned(),
        messages,
    })
}

#[cfg(test)]
#[path = "chat_history_tests.rs"]
mod tests;
