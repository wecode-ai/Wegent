// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn apply_turn_completed_at(blocks: &mut [Value], completed_at: Option<i64>) {
    let Some(completed_at) = completed_at else {
        return;
    };
    let Some(block) = blocks.last_mut().and_then(Value::as_object_mut) else {
        return;
    };
    if block.get("type").and_then(Value::as_str) != Some("tool") {
        block.insert("timestamp".to_owned(), json!(completed_at));
        return;
    }
    let has_completed_at =
        block.get("completedAt").is_some() || block.get("completed_at").is_some();
    let duration_ms = block
        .get("durationMs")
        .or_else(|| block.get("duration_ms"))
        .and_then(Value::as_i64)
        .filter(|duration| *duration >= 0);
    if !has_completed_at && duration_ms.is_none() {
        block.insert("timestamp".to_owned(), json!(completed_at));
        return;
    }
    if !has_completed_at {
        block.insert("completedAt".to_owned(), json!(completed_at));
    }
    if let Some(duration_ms) = duration_ms {
        block.insert(
            "timestamp".to_owned(),
            json!(completed_at.saturating_sub(duration_ms)),
        );
    }
}

pub(super) struct AssistantTurnAccumulation {
    pub(super) blocks: Vec<Value>,
    pub(super) file_changes: Option<Value>,
    assistant_parts: Vec<AssistantTextPart>,
    item_order: Vec<AssistantItemIdentity>,
    memory_citations: Vec<Value>,
}

struct AssistantTextPart {
    id: String,
    content: String,
    created_at: i64,
}

enum AssistantItemIdentity {
    Block(usize),
    Text(usize),
}

impl AssistantTurnAccumulation {
    pub(super) fn new(file_changes: Option<Value>) -> Self {
        Self {
            blocks: Vec::new(),
            file_changes,
            assistant_parts: Vec::new(),
            item_order: Vec::new(),
            memory_citations: Vec::new(),
        }
    }

    pub(super) fn has_non_file_output(&self) -> bool {
        !self.blocks.is_empty()
            || !self.assistant_parts.is_empty()
            || !self.memory_citations.is_empty()
    }

    pub(super) fn assistant_part_count(&self) -> usize {
        self.assistant_parts.len()
    }

    fn has_output(&self) -> bool {
        self.has_non_file_output() || self.file_changes.is_some()
    }

    fn clear_after_emit(&mut self) {
        self.blocks.clear();
        self.file_changes = None;
        self.assistant_parts.clear();
        self.item_order.clear();
        self.memory_citations.clear();
    }

    pub(super) fn record_new_items(
        &mut self,
        previous_block_count: usize,
        previous_part_count: usize,
    ) {
        let started_new_segment =
            self.item_order.is_empty() && (previous_block_count > 0 || previous_part_count > 0);
        let block_start = if started_new_segment {
            0
        } else {
            previous_block_count.min(self.blocks.len())
        };
        self.item_order.extend(
            self.blocks[block_start..]
                .iter()
                .enumerate()
                .filter(|(_, block)| !is_projected_guidance_block(block))
                .map(|(index, _)| AssistantItemIdentity::Block(block_start + index)),
        );

        let part_start = if started_new_segment {
            0
        } else {
            previous_part_count.min(self.assistant_parts.len())
        };
        self.item_order
            .extend((part_start..self.assistant_parts.len()).map(AssistantItemIdentity::Text));
    }

    pub(super) fn runtime_items(&self) -> Vec<Value> {
        self.item_order
            .iter()
            .filter_map(|identity| match identity {
                AssistantItemIdentity::Block(index) => {
                    let block = self.blocks.get(*index)?;
                    let id = string_field(block, "id")?;
                    Some(json!({
                        "id": id,
                        "type": "block",
                        "block": block,
                    }))
                }
                AssistantItemIdentity::Text(index) => {
                    self.assistant_parts.get(*index).map(|part| {
                        json!({
                            "id": part.id,
                            "type": "assistant_text",
                            "content": part.content,
                            "createdAt": part.created_at,
                        })
                    })
                }
            })
            .collect()
    }
}

fn is_projected_guidance_block(block: &Value) -> bool {
    string_field(block, "tool_name")
        .or_else(|| string_field(block, "toolName"))
        .is_some_and(|name| name == "conversation_guidance")
}

pub(super) struct AssistantEmitContext<'a> {
    pub(super) turn_id: &'a str,
    pub(super) subtask_id: &'a str,
    pub(super) created_at: i64,
    pub(super) completed_at: Option<i64>,
    pub(super) status: &'a str,
    pub(super) error: Option<&'a str>,
}

pub(super) fn push_accumulated_assistant(
    messages: &mut Vec<Value>,
    segment_index: &mut usize,
    context: AssistantEmitContext<'_>,
    assistant: &mut AssistantTurnAccumulation,
    include_file_only: bool,
    options: TranscriptBuildOptions,
) {
    let has_content = if include_file_only {
        assistant.has_output()
    } else {
        assistant.has_non_file_output()
    };
    let is_first_failed_turn =
        include_file_only && context.status == "failed" && *segment_index == 0;
    let should_emit = has_content || is_first_failed_turn;
    if !should_emit {
        return;
    }

    apply_turn_completed_at(&mut assistant.blocks, context.completed_at);
    let stopped_notice = context.status == "cancelled" && *segment_index == 0;
    let message_id = if *segment_index == 0 {
        context.turn_id.to_owned()
    } else {
        format!("{}-{}", context.turn_id, *segment_index)
    };
    let runtime_items = assistant.runtime_items();
    messages.push(synthetic_assistant_message(AssistantMessageDraft {
        message_id: &message_id,
        turn_id: context.turn_id,
        subtask_id: context.subtask_id,
        created_at: context.created_at,
        completed_at: context.completed_at,
        status: context.status,
        error: context.error,
        stopped_notice,
        blocks: &assistant.blocks,
        file_changes: assistant.file_changes.clone(),
        assistant_parts: &assistant.assistant_parts,
        runtime_items: &runtime_items,
        memory_citations: &assistant.memory_citations,
        options,
    }));
    *segment_index += 1;
    assistant.clear_after_emit();
}

fn user_message(
    item: &Value,
    created_at: i64,
    turn_id: &str,
    runtime_status: &str,
) -> Option<Value> {
    let content = extract_text(item).unwrap_or_default();
    let attachments = user_message_image_attachments(item, created_at);
    if content.trim().is_empty() && attachments.is_empty() {
        return None;
    }

    let mut message = json!({
        "id": item_id(item, "user"),
        "role": "user",
        "content": content,
        "status": "done",
        "runtimeStatus": runtime_status,
        "createdAt": item_timestamp(item).unwrap_or(created_at),
        "subtaskId": turn_id,
        "turnId": turn_id,
    });
    if let Some(client_user_message_id) =
        string_field(item, "clientId").or_else(|| string_field(item, "client_id"))
    {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "clientUserMessageId".to_owned(),
                Value::String(client_user_message_id),
            );
        }
    }
    if !attachments.is_empty() {
        if let Some(object) = message.as_object_mut() {
            object.insert("attachments".to_owned(), Value::Array(attachments));
        }
    }
    Some(message)
}

pub(super) fn push_user_message_once(
    messages: &mut Vec<Value>,
    item: &Value,
    created_at: i64,
    turn_id: &str,
    runtime_status: &str,
    seen: &mut HashMap<String, usize>,
) -> bool {
    let Some(message) = user_message(item, created_at, turn_id, runtime_status) else {
        return false;
    };

    let item_id = item_id(item, "user");
    if let Some(message_index) = seen.get(&item_id).copied() {
        if let Some(existing) = messages.get_mut(message_index) {
            merge_missing_user_message_metadata(existing, &message);
        }
        return false;
    }
    seen.insert(item_id, messages.len());
    messages.push(message);
    true
}

pub(crate) fn normalized_user_request_content(content: &str) -> String {
    let request_content = content
        .find(CODEX_REQUEST_MARKER)
        .map(|index| &content[index + CODEX_REQUEST_MARKER.len()..])
        .filter(|request| !request.trim().is_empty())
        .unwrap_or(content);
    let visible_content = strip_leading_application_context(request_content);
    visible_content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn strip_leading_application_context(content: &str) -> &str {
    let trimmed = content.trim_start();
    if !trimmed.starts_with(APPLICATION_CONTEXT_OPEN) {
        return trimmed;
    }
    let Some(close_index) = trimmed.find(APPLICATION_CONTEXT_CLOSE) else {
        return trimmed;
    };
    trimmed[close_index + APPLICATION_CONTEXT_CLOSE.len()..].trim_start()
}

pub(crate) fn merge_missing_user_message_metadata(target: &mut Value, source: &Value) {
    let Some(target) = target.as_object_mut() else {
        return;
    };
    let Some(source) = source.as_object() else {
        return;
    };
    for key in [
        "clientUserMessageId",
        "client_user_message_id",
        "source",
        "runtimeGoalRequest",
        "runtime_goal_request",
    ] {
        if target.get(key).map(Value::is_null).unwrap_or(true) {
            if let Some(value) = source.get(key) {
                target.insert(key.to_owned(), value.clone());
            }
        }
    }

    // Later user-message events and the cached runtime message retain the
    // original UI attachment. Provider transcript attachments may instead
    // point at transient `.model-input` files that are deleted after the turn.
    if source
        .get("attachments")
        .and_then(Value::as_array)
        .is_some_and(|attachments| !attachments.is_empty())
    {
        target.insert("attachments".to_owned(), source["attachments"].clone());
    }
}

pub(super) fn is_internal_turn_abort_message(item: &Value) -> bool {
    extract_text(item)
        .map(|content| content.trim_start().starts_with("<turn_aborted>"))
        .unwrap_or(false)
}

fn user_message_image_attachments(item: &Value, created_at: i64) -> Vec<Value> {
    let mut attachments = mentioned_image_attachments(item, created_at);
    if !attachments.is_empty() {
        return attachments;
    }

    if let Some(content) = item.get("content").and_then(Value::as_array) {
        for part in content {
            match item_type(part).as_str() {
                "localimage" => {
                    if let Some(path) = string_field(part, "path") {
                        push_image_attachment(&mut attachments, &path, created_at);
                    }
                }
                "image" => {
                    if let Some(url) = string_field(part, "url") {
                        push_image_attachment(&mut attachments, &url, created_at);
                    }
                }
                "inputimage" => {
                    if let Some(url) = string_field(part, "image_url") {
                        push_image_attachment(&mut attachments, &url, created_at);
                    }
                }
                _ => {}
            }
        }
    }
    for path in string_array_field(item, "local_images")
        .into_iter()
        .chain(string_array_field(item, "localImages"))
    {
        push_image_attachment(&mut attachments, &path, created_at);
    }
    for url in string_array_field(item, "images") {
        push_image_attachment(&mut attachments, &url, created_at);
    }
    attachments
}

fn mentioned_image_attachments(item: &Value, created_at: i64) -> Vec<Value> {
    let Some(content) = extract_text(item) else {
        return Vec::new();
    };
    let Some(request_marker_index) = content.find(CODEX_REQUEST_MARKER) else {
        return Vec::new();
    };
    let mentioned_files = &content[..request_marker_index];
    if !mentioned_files.contains(CODEX_FILES_MENTIONED_HEADER) {
        return Vec::new();
    }

    let mut attachments = Vec::new();
    for line in mentioned_files.lines() {
        let Some(reference) = line.trim().strip_prefix("## ") else {
            continue;
        };
        let Some((filename, path)) = reference.split_once(": ") else {
            continue;
        };
        let filename = filename.trim();
        let path = path.trim();
        if !is_image_reference(filename) && !is_image_reference(path) {
            continue;
        }
        push_image_attachment(&mut attachments, path, created_at);
    }
    attachments
}

fn is_image_reference(value: &str) -> bool {
    let path = strip_url_query(value).to_ascii_lowercase();
    [".jpeg", ".jpg", ".png", ".gif", ".bmp", ".webp"]
        .iter()
        .any(|extension| path.ends_with(extension))
}

fn push_image_attachment(attachments: &mut Vec<Value>, source: &str, created_at: i64) {
    let source = source.trim();
    if source.is_empty()
        || attachments
            .iter()
            .any(|item| item["local_preview_url"] == source)
    {
        return;
    }
    let index = attachments.len();
    let extension = image_extension(source);
    let mime_type = image_mime_type(source, &extension);
    attachments.push(json!({
        "id": -((index as i64) + 1),
        "filename": image_filename(source, index, &extension),
        "file_size": 0,
        "mime_type": mime_type,
        "status": "ready",
        "file_extension": extension,
        "created_at": created_at,
        "local_preview_url": source,
    }));
}

fn string_array_field(item: &Value, key: &str) -> Vec<String> {
    item.get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn image_filename(source: &str, index: usize, extension: &str) -> String {
    if source.to_ascii_lowercase().starts_with("data:") {
        return format!("image-{}{}", index + 1, extension);
    }

    if let Some(filename) = Path::new(strip_url_query(source))
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
    {
        return filename;
    }

    format!("image-{}{}", index + 1, extension)
}

fn image_extension(source: &str) -> String {
    let lower = source.to_ascii_lowercase();
    if lower.starts_with("data:image/jpeg") || lower.starts_with("data:image/jpg") {
        return ".jpg".to_owned();
    }
    if lower.starts_with("data:image/png") {
        return ".png".to_owned();
    }
    if lower.starts_with("data:image/gif") {
        return ".gif".to_owned();
    }
    if lower.starts_with("data:image/webp") {
        return ".webp".to_owned();
    }
    if lower.starts_with("data:image/bmp") {
        return ".bmp".to_owned();
    }

    let path = strip_url_query(source).to_ascii_lowercase();
    for extension in [".jpeg", ".jpg", ".png", ".gif", ".bmp", ".webp"] {
        if path.ends_with(extension) {
            return extension.to_owned();
        }
    }
    ".png".to_owned()
}

fn image_mime_type(source: &str, extension: &str) -> String {
    if source.to_ascii_lowercase().starts_with("data:image/") {
        return source
            .split_once(':')
            .and_then(|(_, rest)| rest.split_once(';').map(|(mime, _)| mime.to_owned()))
            .unwrap_or_else(|| "image/png".to_owned());
    }
    match extension {
        ".jpg" | ".jpeg" => "image/jpeg",
        ".gif" => "image/gif",
        ".bmp" => "image/bmp",
        ".webp" => "image/webp",
        _ => "image/png",
    }
    .to_owned()
}

fn strip_url_query(source: &str) -> &str {
    source.split(['?', '#']).next().unwrap_or(source)
}

pub(super) fn push_reasoning_block(
    blocks: &mut Vec<Value>,
    item: &Value,
    created_at: i64,
    options: TranscriptBuildOptions,
) {
    if let Some(content) = reasoning_content(item) {
        let mut block = json!({
            "id": item_id(item, "thinking"),
            "type": "thinking",
            "content": content,
            "status": "done",
            "timestamp": created_at,
        });
        if options.truncate_content {
            limit_content_field(&mut block, MAX_TRANSCRIPT_BLOCK_CONTENT_CHARS);
        }
        blocks.push(block);
    }
}

pub(super) fn plan_block(
    item: &Value,
    fallback_timestamp: i64,
    options: TranscriptBuildOptions,
) -> Value {
    let mut block = json!({
        "id": format!("plan-{}", item_id(item, "plan")),
        "type": "plan",
        "process_kind": "plan",
        "content": extract_text(item).unwrap_or_default(),
        "status": "done",
        "timestamp": item_timestamp(item).unwrap_or(fallback_timestamp),
    });
    if options.truncate_content {
        limit_content_field(&mut block, MAX_TRANSCRIPT_BLOCK_CONTENT_CHARS);
    }
    block
}

pub(super) fn collect_assistant_message(
    item: &Value,
    fallback_timestamp: i64,
    fold_commentary: bool,
    interleave_visible_text: bool,
    has_later_process: bool,
    assistant: &mut AssistantTurnAccumulation,
    options: TranscriptBuildOptions,
) {
    if let Some(content) = extract_text(item) {
        if interleave_visible_text {
            assistant.blocks.push(process_text_block(
                item,
                content,
                fallback_timestamp,
                options,
            ));
        } else {
            match assistant_message_phase(item, fold_commentary, has_later_process) {
                AssistantMessagePhase::Process => {
                    assistant.blocks.push(process_text_block(
                        item,
                        content,
                        fallback_timestamp,
                        options,
                    ));
                }
                AssistantMessagePhase::Final => {
                    if !duplicates_completed_plan_block(&content, &assistant.blocks) {
                        assistant.assistant_parts.push(AssistantTextPart {
                            id: item_id(item, "assistant-text"),
                            content,
                            created_at: item_timestamp(item).unwrap_or(fallback_timestamp),
                        });
                    }
                }
            }
        }
    }
    if let Some(memory_citation) = memory_citation(item) {
        assistant.memory_citations.push(memory_citation);
    }
}

fn duplicates_completed_plan_block(content: &str, blocks: &[Value]) -> bool {
    let Some(plan_content) = proposed_plan_content(content) else {
        return false;
    };
    blocks.iter().any(|block| {
        item_type(block) == "plan"
            && string_field(block, "content")
                .is_some_and(|content| content.trim() == plan_content.trim())
    })
}

fn proposed_plan_content(content: &str) -> Option<&str> {
    let trimmed = content.trim();
    let without_open = trimmed.strip_prefix("<proposed_plan>")?.trim_start();
    Some(without_open.strip_suffix("</proposed_plan>")?.trim_end())
}

enum AssistantMessagePhase {
    Final,
    Process,
}

fn assistant_message_phase(
    item: &Value,
    fold_commentary: bool,
    has_later_process: bool,
) -> AssistantMessagePhase {
    match assistant_message_phase_name(item).as_deref() {
        Some("analysis") => AssistantMessagePhase::Process,
        Some("commentary") if fold_commentary => AssistantMessagePhase::Process,
        None if has_later_process => AssistantMessagePhase::Process,
        _ => AssistantMessagePhase::Final,
    }
}

pub(super) fn assistant_message_phase_name(item: &Value) -> Option<String> {
    string_field(item, "phase").map(normalized_phase_or_status)
}

pub(super) fn normalized_phase_or_status(value: String) -> String {
    value.replace(['_', '-'], "").to_ascii_lowercase()
}

fn process_text_block(
    item: &Value,
    content: String,
    fallback_timestamp: i64,
    options: TranscriptBuildOptions,
) -> Value {
    let mut block = json!({
        "id": item_id(item, "text"),
        "type": "text",
        "content": content,
        "status": "done",
        "timestamp": item_timestamp(item).unwrap_or(fallback_timestamp),
    });
    if options.truncate_content {
        limit_content_field(&mut block, MAX_TRANSCRIPT_BLOCK_CONTENT_CHARS);
    }
    block
}

pub(super) fn guidance_block(item: &Value, timestamp: i64) -> Value {
    json!({
        "id": format!("guidance-{}", item_id(item, "user")),
        "type": "tool",
        "tool_use_id": format!("guidance-{}", item_id(item, "user")),
        "tool_name": "conversation_guidance",
        "tool_input": {
            "message": extract_text(item).unwrap_or_default(),
        },
        "tool_output": Value::Null,
        "status": "done",
        "timestamp": timestamp,
    })
}

pub(super) fn file_changes_block(item: &Value, summary: &Value, fallback_timestamp: i64) -> Value {
    json!({
        "id": format!("file-changes-{}", item_id(item, "file-change")),
        "type": "file_changes",
        "file_changes": summary,
        "status": "done",
        "timestamp": item_timestamp(item).unwrap_or(fallback_timestamp),
    })
}

pub(super) fn item_timestamp(item: &Value) -> Option<i64> {
    timestamp_ms_field(item, "timestamp")
        .or_else(|| timestamp_ms_field(item, "createdAt"))
        .or_else(|| timestamp_ms_field(item, "created_at"))
}

pub(super) fn item_completed_at(item: &Value) -> Option<i64> {
    timestamp_ms_field(item, "completedAt").or_else(|| timestamp_ms_field(item, "completed_at"))
}

struct AssistantMessageDraft<'a> {
    message_id: &'a str,
    turn_id: &'a str,
    subtask_id: &'a str,
    created_at: i64,
    completed_at: Option<i64>,
    status: &'a str,
    error: Option<&'a str>,
    stopped_notice: bool,
    blocks: &'a [Value],
    file_changes: Option<Value>,
    assistant_parts: &'a [AssistantTextPart],
    runtime_items: &'a [Value],
    memory_citations: &'a [Value],
    options: TranscriptBuildOptions,
}

fn synthetic_assistant_message(draft: AssistantMessageDraft<'_>) -> Value {
    let mut message = json!({
        "id": format!("assistant-{}", draft.message_id),
        "role": "assistant",
        "content": draft
            .assistant_parts
            .iter()
            .map(|part| part.content.as_str())
            .collect::<Vec<_>>()
            .join("\n\n"),
        "status": draft.status,
        "subtaskId": draft.subtask_id,
        "turnId": draft.turn_id,
        "createdAt": draft.created_at,
        "blocks": draft.blocks,
        "runtimeItems": draft.runtime_items,
    });
    if draft.options.truncate_content {
        limit_content_field(&mut message, MAX_TRANSCRIPT_MESSAGE_CONTENT_CHARS);
    }
    if draft.status != "streaming" {
        if let Some(completed_at) = draft.completed_at {
            if let Some(object) = message.as_object_mut() {
                object.insert("completedAt".to_owned(), json!(completed_at));
            }
        }
    }
    if draft.status == "cancelled" {
        if let Some(object) = message.as_object_mut() {
            object.insert("stoppedNotice".to_owned(), json!(draft.stopped_notice));
        }
    }
    if draft.status == "failed" {
        if let Some(error) = draft.error {
            if let Some(object) = message.as_object_mut() {
                object.insert("error".to_owned(), Value::String(error.to_owned()));
            }
        }
    }
    if draft.status != "streaming" {
        if let Some(file_changes) = draft.file_changes {
            if let Some(object) = message.as_object_mut() {
                object.insert("fileChanges".to_owned(), file_changes);
            }
        }
    }
    if !draft.memory_citations.is_empty() {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "memoryCitations".to_owned(),
                Value::Array(draft.memory_citations.to_vec()),
            );
        }
    }
    message
}
