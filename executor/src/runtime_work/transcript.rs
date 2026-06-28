// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::path::Path;

use serde_json::{json, Map, Value};

use super::util::{
    bool_field, extract_text, integer_field, item_id, item_type, normalize_workspace_path, now_ms,
    raw_string_field, reasoning_content, string_field, timestamp_ms_field,
};

pub(crate) fn transcript_messages(thread: &Value, device_id: &str) -> Vec<Value> {
    let mut messages = Vec::new();
    let workspace_path = string_field(thread, "cwd").unwrap_or_default();
    for turn in thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let created_at = turn_started_at(turn);
        let completed_at = turn_completed_at(turn, created_at);
        let turn_file_changes = file_changes(turn);
        let turn_id = item_id(turn, "turn");
        let subtask_id = turn_subtask_id(turn, &turn_id);
        let turn_cancelled = turn_interrupted(turn);
        let fold_commentary = turn_should_fold_commentary(turn);
        let mut assistant_segment_index = 0;
        let mut assistant = AssistantTurnAccumulation::new(turn_file_changes.clone());
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            match item_type(item).as_str() {
                "usermessage" => {
                    if is_internal_turn_abort_message(item) {
                        continue;
                    }
                    let is_guidance =
                        assistant_segment_index > 0 || assistant.has_non_file_output();
                    push_accumulated_assistant(
                        &mut messages,
                        &mut assistant_segment_index,
                        AssistantEmitContext {
                            turn_id: &turn_id,
                            subtask_id,
                            created_at,
                            completed_at,
                            status: if turn_cancelled { "cancelled" } else { "done" },
                        },
                        &mut assistant,
                        false,
                    );
                    push_user_message(&mut messages, item, created_at);
                    if is_guidance {
                        assistant.blocks.push(guidance_block(
                            item,
                            item_timestamp(item).unwrap_or(created_at),
                        ));
                    }
                }
                "reasoning" => push_reasoning_block(&mut assistant.blocks, item, created_at),
                "commandexecution" => assistant.blocks.push(command_block(item, created_at)),
                "functioncall" | "customtoolcall" | "dynamictoolcall" | "mcptoolcall"
                | "mcpcall" | "toolsearchcall" | "websearchcall" | "websearch"
                | "imagegeneration" | "imageview" | "sleep" | "localshellcall" | "shellcall" => {
                    assistant.blocks.push(tool_block(item, created_at))
                }
                "functioncalloutput" | "customtoolcalloutput" | "toolsearchoutput" => {
                    merge_tool_output(&mut assistant.blocks, item, created_at);
                }
                "filechange" => {
                    if let Some(summary) = file_changes_from_file_change_item(
                        item,
                        &turn_id,
                        device_id,
                        &workspace_path,
                    ) {
                        if fold_commentary {
                            assistant
                                .blocks
                                .push(file_changes_block(item, &summary, created_at));
                        }
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), summary);
                    }
                }
                "patchapplyend" => {
                    if let Some(summary) = file_changes_from_patch_apply_end(
                        item,
                        &turn_id,
                        device_id,
                        &workspace_path,
                    ) {
                        if fold_commentary {
                            assistant
                                .blocks
                                .push(file_changes_block(item, &summary, created_at));
                        }
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), summary);
                    }
                }
                "contextcompaction" => {
                    assistant.context_events.push(context_event(
                        item,
                        created_at,
                        "context_compaction",
                        "done",
                    ));
                }
                "agentmessage" => {
                    collect_assistant_message(
                        item,
                        created_at,
                        fold_commentary,
                        turn_cancelled && fold_commentary,
                        &mut assistant.blocks,
                        &mut assistant.assistant_parts,
                        &mut assistant.memory_citations,
                    );
                    if let Some(file_changes) = file_changes(item) {
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), file_changes);
                    }
                }
                "message" => match string_field(item, "role")
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "user" => {
                        if is_internal_turn_abort_message(item) {
                            continue;
                        }
                        let is_guidance =
                            assistant_segment_index > 0 || assistant.has_non_file_output();
                        push_accumulated_assistant(
                            &mut messages,
                            &mut assistant_segment_index,
                            AssistantEmitContext {
                                turn_id: &turn_id,
                                subtask_id,
                                created_at,
                                completed_at,
                                status: if turn_cancelled { "cancelled" } else { "done" },
                            },
                            &mut assistant,
                            false,
                        );
                        push_user_message(&mut messages, item, created_at);
                        if is_guidance {
                            assistant.blocks.push(guidance_block(
                                item,
                                item_timestamp(item).unwrap_or(created_at),
                            ));
                        }
                    }
                    "assistant" => {
                        collect_assistant_message(
                            item,
                            created_at,
                            fold_commentary,
                            turn_cancelled && fold_commentary,
                            &mut assistant.blocks,
                            &mut assistant.assistant_parts,
                            &mut assistant.memory_citations,
                        );
                        if let Some(file_changes) = file_changes(item) {
                            assistant.file_changes =
                                merge_file_changes(assistant.file_changes.take(), file_changes);
                        }
                    }
                    _ => {}
                },
                "agentmessageevent" => {
                    collect_assistant_message(
                        item,
                        created_at,
                        fold_commentary,
                        turn_cancelled && fold_commentary,
                        &mut assistant.blocks,
                        &mut assistant.assistant_parts,
                        &mut assistant.memory_citations,
                    );
                    if let Some(file_changes) = file_changes(item) {
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), file_changes);
                    }
                }
                _ => {}
            }
        }
        push_accumulated_assistant(
            &mut messages,
            &mut assistant_segment_index,
            AssistantEmitContext {
                turn_id: &turn_id,
                subtask_id,
                created_at,
                completed_at,
                status: if turn_cancelled { "cancelled" } else { "done" },
            },
            &mut assistant,
            true,
        );
    }
    messages
}

pub(crate) fn tool_block_from_notification(params: &Value, status: &str) -> Option<Value> {
    let item = params.get("item").unwrap_or(params);
    let item_type = item_type(item);
    if !is_tool_item_type(&item_type) {
        return None;
    }
    let mut block = tool_block(item, now_ms());
    if let Some(object) = block.as_object_mut() {
        object.insert("status".to_owned(), Value::String(status.to_owned()));
    }
    Some(block)
}

pub(crate) fn tool_update_from_notification(params: &Value) -> Option<(String, Value)> {
    let item = params.get("item").unwrap_or(params);
    let item_type = item_type(item);
    if !is_tool_item_type(&item_type) && !is_tool_output_item_type(&item_type) {
        return None;
    }
    Some((
        tool_call_id(item),
        json!({
            "status": tool_status(item),
            "tool_output": tool_output(item),
        }),
    ))
}

fn turn_started_at(turn: &Value) -> i64 {
    timestamp_ms_field(turn, "startedAt")
        .or_else(|| timestamp_ms_field(turn, "started_at"))
        .or_else(|| timestamp_ms_field(turn, "createdAt"))
        .or_else(|| timestamp_ms_field(turn, "created_at"))
        .unwrap_or_else(now_ms)
}

fn turn_completed_at(turn: &Value, started_at: i64) -> Option<i64> {
    timestamp_ms_field(turn, "completedAt")
        .or_else(|| timestamp_ms_field(turn, "completed_at"))
        .or_else(|| timestamp_ms_field(turn, "endedAt"))
        .or_else(|| timestamp_ms_field(turn, "ended_at"))
        .or_else(|| timestamp_ms_field(turn, "stoppedAt"))
        .or_else(|| timestamp_ms_field(turn, "stopped_at"))
        .or_else(|| timestamp_ms_field(turn, "cancelledAt"))
        .or_else(|| timestamp_ms_field(turn, "cancelled_at"))
        .or_else(|| timestamp_ms_field(turn, "interruptedAt"))
        .or_else(|| timestamp_ms_field(turn, "interrupted_at"))
        .or_else(|| timestamp_ms_field(turn, "updatedAt"))
        .or_else(|| timestamp_ms_field(turn, "updated_at"))
        .or_else(|| {
            integer_field(turn, "durationMs")
                .or_else(|| integer_field(turn, "duration_ms"))
                .map(|duration| started_at.saturating_add(duration))
        })
        .filter(|completed_at| *completed_at >= started_at)
}

fn turn_subtask_id(turn: &Value, turn_id: &str) -> i64 {
    integer_field(turn, "subtaskId")
        .or_else(|| integer_field(turn, "subtask_id"))
        .filter(|value| *value != 0)
        .unwrap_or_else(|| synthetic_turn_subtask_id(turn_id))
}

fn turn_should_fold_commentary(turn: &Value) -> bool {
    if turn_has_final_assistant_message(turn) || turn_running(turn) {
        return true;
    }
    // Interrupted turns with process output should keep commentary inside the
    // collapsible process area. If commentary is the only assistant output,
    // surface it directly like Codex app does.
    turn_interrupted(turn) && turn_has_substantive_process(turn)
}

fn turn_has_substantive_process(turn: &Value) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| {
            let item_type = item_type(item);
            is_substantive_process_item_type(&item_type)
                || (item_type == "message"
                    && !string_field(item, "role")
                        .unwrap_or_default()
                        .eq_ignore_ascii_case("user")
                    && !is_agent_message(item))
        })
}

fn is_agent_message(item: &Value) -> bool {
    matches!(
        item_type(item).as_str(),
        "agentmessage" | "agentmessageevent"
    )
}

fn is_substantive_process_item_type(item_type: &str) -> bool {
    is_tool_item_type(item_type)
        || is_tool_output_item_type(item_type)
        || matches!(
            item_type,
            "reasoning" | "filechange" | "patchapplyend" | "contextcompaction"
        )
}

fn turn_interrupted(turn: &Value) -> bool {
    turn_status(turn).is_some_and(|status| {
        matches!(
            status.as_str(),
            "interrupted" | "cancelled" | "canceled" | "aborted"
        )
    })
}

fn turn_running(turn: &Value) -> bool {
    turn_status(turn).is_some_and(|status| {
        matches!(
            status.as_str(),
            "running" | "inprogress" | "active" | "busy" | "pending"
        )
    })
}

fn turn_status(turn: &Value) -> Option<String> {
    string_field(turn, "status").map(normalized_phase_or_status)
}

fn turn_has_final_assistant_message(turn: &Value) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(is_final_assistant_message)
}

fn is_final_assistant_message(item: &Value) -> bool {
    match item_type(item).as_str() {
        "agentmessage" | "agentmessageevent" => assistant_message_phase_name(item)
            .map(|phase| !matches!(phase.as_str(), "analysis" | "commentary"))
            .unwrap_or(true),
        "message" => {
            let is_assistant = string_field(item, "role")
                .unwrap_or_default()
                .eq_ignore_ascii_case("assistant");
            is_assistant
                && assistant_message_phase_name(item)
                    .map(|phase| !matches!(phase.as_str(), "analysis" | "commentary"))
                    .unwrap_or(true)
        }
        _ => false,
    }
}

fn synthetic_turn_subtask_id(turn_id: &str) -> i64 {
    let mut hash = 2_166_136_261_u32;
    for byte in turn_id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    let value = i64::from(hash & 0x7fff_ffff);
    -value.max(1)
}

fn apply_turn_completed_at(blocks: &mut [Value], completed_at: Option<i64>) {
    let Some(completed_at) = completed_at else {
        return;
    };
    let Some(block) = blocks.last_mut().and_then(Value::as_object_mut) else {
        return;
    };
    block.insert("timestamp".to_owned(), json!(completed_at));
}

struct AssistantTurnAccumulation {
    blocks: Vec<Value>,
    file_changes: Option<Value>,
    context_events: Vec<Value>,
    assistant_parts: Vec<String>,
    memory_citations: Vec<Value>,
}

impl AssistantTurnAccumulation {
    fn new(file_changes: Option<Value>) -> Self {
        Self {
            blocks: Vec::new(),
            file_changes,
            context_events: Vec::new(),
            assistant_parts: Vec::new(),
            memory_citations: Vec::new(),
        }
    }

    fn has_non_file_output(&self) -> bool {
        !self.blocks.is_empty()
            || !self.context_events.is_empty()
            || !self.assistant_parts.is_empty()
            || !self.memory_citations.is_empty()
    }

    fn has_output(&self) -> bool {
        self.has_non_file_output() || self.file_changes.is_some()
    }

    fn clear_after_emit(&mut self) {
        self.blocks.clear();
        self.file_changes = None;
        self.context_events.clear();
        self.assistant_parts.clear();
        self.memory_citations.clear();
    }
}

struct AssistantEmitContext<'a> {
    turn_id: &'a str,
    subtask_id: i64,
    created_at: i64,
    completed_at: Option<i64>,
    status: &'a str,
}

fn push_accumulated_assistant(
    messages: &mut Vec<Value>,
    segment_index: &mut usize,
    context: AssistantEmitContext<'_>,
    assistant: &mut AssistantTurnAccumulation,
    include_file_only: bool,
) {
    let should_emit = if include_file_only {
        assistant.has_output()
    } else {
        assistant.has_non_file_output()
    };
    if !should_emit {
        return;
    }

    apply_turn_completed_at(&mut assistant.blocks, context.completed_at);
    let stopped_notice = context.status == "cancelled" && *segment_index == 0;
    let synthetic_turn_id = if *segment_index == 0 {
        context.turn_id.to_owned()
    } else {
        format!("{}-{}", context.turn_id, *segment_index)
    };
    messages.push(synthetic_assistant_message(AssistantMessageDraft {
        turn_id: &synthetic_turn_id,
        subtask_id: context.subtask_id,
        created_at: context.created_at,
        completed_at: context.completed_at,
        status: context.status,
        stopped_notice,
        blocks: &assistant.blocks,
        file_changes: assistant.file_changes.clone(),
        context_events: &assistant.context_events,
        assistant_parts: &assistant.assistant_parts,
        memory_citations: &assistant.memory_citations,
    }));
    *segment_index += 1;
    assistant.clear_after_emit();
}

fn push_user_message(messages: &mut Vec<Value>, item: &Value, created_at: i64) {
    let content = extract_text(item).unwrap_or_default();
    let attachments = user_message_image_attachments(item, created_at);
    if content.trim().is_empty() && attachments.is_empty() {
        return;
    }

    let mut message = json!({
        "id": item_id(item, "user"),
        "role": "user",
        "content": content,
        "status": "done",
        "createdAt": item_timestamp(item).unwrap_or(created_at),
    });
    if !attachments.is_empty() {
        if let Some(object) = message.as_object_mut() {
            object.insert("attachments".to_owned(), Value::Array(attachments));
        }
    }
    messages.push(message);
}

fn is_internal_turn_abort_message(item: &Value) -> bool {
    extract_text(item)
        .map(|content| content.trim_start().starts_with("<turn_aborted>"))
        .unwrap_or(false)
}

fn user_message_image_attachments(item: &Value, created_at: i64) -> Vec<Value> {
    let mut attachments = Vec::new();
    if let Some(content) = item.get("content").and_then(Value::as_array) {
        for part in content {
            match item_type(part).as_str() {
                "localimage" => {
                    if let Some(path) = string_field(part, "path") {
                        push_image_attachment(&mut attachments, &path, true, created_at);
                    }
                }
                "image" => {
                    if let Some(url) = string_field(part, "url") {
                        push_image_attachment(&mut attachments, &url, false, created_at);
                    }
                }
                "inputimage" => {
                    if let Some(url) = string_field(part, "image_url") {
                        push_image_attachment(&mut attachments, &url, false, created_at);
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
        push_image_attachment(&mut attachments, &path, true, created_at);
    }
    for url in string_array_field(item, "images") {
        push_image_attachment(&mut attachments, &url, false, created_at);
    }
    attachments
}

fn push_image_attachment(attachments: &mut Vec<Value>, source: &str, local: bool, created_at: i64) {
    if source.trim().is_empty()
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
        "local_preview_url": if local { source } else { source.trim() },
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

fn push_reasoning_block(blocks: &mut Vec<Value>, item: &Value, created_at: i64) {
    if let Some(content) = reasoning_content(item) {
        blocks.push(json!({
            "id": item_id(item, "thinking"),
            "type": "thinking",
            "content": content,
            "status": "done",
            "timestamp": created_at,
        }));
    }
}

fn collect_assistant_message(
    item: &Value,
    fallback_timestamp: i64,
    fold_commentary: bool,
    interleave_visible_text: bool,
    blocks: &mut Vec<Value>,
    assistant_parts: &mut Vec<String>,
    memory_citations: &mut Vec<Value>,
) {
    if let Some(content) = extract_text(item) {
        if interleave_visible_text {
            blocks.push(process_text_block(item, content, fallback_timestamp));
        } else {
            match assistant_message_phase(item, fold_commentary) {
                AssistantMessagePhase::Process => {
                    blocks.push(process_text_block(item, content, fallback_timestamp));
                }
                AssistantMessagePhase::Final => {
                    assistant_parts.push(content);
                }
            }
        }
    }
    if let Some(memory_citation) = memory_citation(item) {
        memory_citations.push(memory_citation);
    }
}

enum AssistantMessagePhase {
    Final,
    Process,
}

fn assistant_message_phase(item: &Value, fold_commentary: bool) -> AssistantMessagePhase {
    match assistant_message_phase_name(item).as_deref() {
        Some("analysis") => AssistantMessagePhase::Process,
        Some("commentary") if fold_commentary => AssistantMessagePhase::Process,
        _ => AssistantMessagePhase::Final,
    }
}

fn assistant_message_phase_name(item: &Value) -> Option<String> {
    string_field(item, "phase").map(normalized_phase_or_status)
}

fn normalized_phase_or_status(value: String) -> String {
    value.replace(['_', '-'], "").to_ascii_lowercase()
}

fn process_text_block(item: &Value, content: String, fallback_timestamp: i64) -> Value {
    json!({
        "id": item_id(item, "text"),
        "type": "text",
        "content": content,
        "status": "done",
        "timestamp": item_timestamp(item).unwrap_or(fallback_timestamp),
    })
}

fn guidance_block(item: &Value, timestamp: i64) -> Value {
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

fn file_changes_block(item: &Value, summary: &Value, fallback_timestamp: i64) -> Value {
    json!({
        "id": format!("file-changes-{}", item_id(item, "file-change")),
        "type": "file_changes",
        "file_changes": summary,
        "status": "done",
        "timestamp": item_timestamp(item).unwrap_or(fallback_timestamp),
    })
}

fn item_timestamp(item: &Value) -> Option<i64> {
    timestamp_ms_field(item, "timestamp")
        .or_else(|| timestamp_ms_field(item, "createdAt"))
        .or_else(|| timestamp_ms_field(item, "created_at"))
}

struct AssistantMessageDraft<'a> {
    turn_id: &'a str,
    subtask_id: i64,
    created_at: i64,
    completed_at: Option<i64>,
    status: &'a str,
    stopped_notice: bool,
    blocks: &'a [Value],
    file_changes: Option<Value>,
    context_events: &'a [Value],
    assistant_parts: &'a [String],
    memory_citations: &'a [Value],
}

fn synthetic_assistant_message(draft: AssistantMessageDraft<'_>) -> Value {
    let mut message = json!({
        "id": format!("assistant-{}", draft.turn_id),
        "role": "assistant",
        "content": draft.assistant_parts.join("\n\n"),
        "status": draft.status,
        "subtaskId": draft.subtask_id,
        "subtask_id": draft.subtask_id,
        "createdAt": draft.created_at,
        "blocks": draft.blocks,
    });
    if let Some(completed_at) = draft.completed_at {
        if let Some(object) = message.as_object_mut() {
            object.insert("completedAt".to_owned(), json!(completed_at));
        }
    }
    if draft.status == "cancelled" {
        if let Some(object) = message.as_object_mut() {
            object.insert("stoppedNotice".to_owned(), json!(draft.stopped_notice));
        }
    }
    if let Some(file_changes) = draft.file_changes {
        if let Some(object) = message.as_object_mut() {
            object.insert("fileChanges".to_owned(), file_changes);
        }
    }
    if !draft.context_events.is_empty() {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "contextEvents".to_owned(),
                Value::Array(draft.context_events.to_vec()),
            );
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

fn command_block(item: &Value, timestamp: i64) -> Value {
    json!({
        "id": item_id(item, "tool"),
        "type": "tool",
        "tool_use_id": item_id(item, "tool"),
        "tool_name": "bash",
        "tool_input": command_input(item),
        "tool_output": command_output(item),
        "status": tool_status(item),
        "timestamp": timestamp,
    })
}

fn tool_block(item: &Value, timestamp: i64) -> Value {
    if matches!(
        item_type(item).as_str(),
        "commandexecution" | "shellcall" | "localshellcall"
    ) {
        return command_block(item, timestamp);
    }
    json!({
        "id": tool_call_id(item),
        "type": "tool",
        "tool_use_id": tool_call_id(item),
        "tool_name": tool_name(item),
        "tool_input": tool_input(item),
        "tool_output": tool_output(item),
        "status": tool_status(item),
        "timestamp": timestamp,
    })
}

fn merge_tool_output(blocks: &mut Vec<Value>, item: &Value, timestamp: i64) {
    let call_id = tool_call_id(item);
    if let Some(block) = blocks.iter_mut().rev().find(|block| {
        block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|value| value == call_id)
    }) {
        if let Some(object) = block.as_object_mut() {
            object.insert("tool_output".to_owned(), tool_output(item));
            object.insert("status".to_owned(), Value::String(tool_status(item)));
        }
        return;
    }
    blocks.push(json!({
        "id": call_id,
        "type": "tool",
        "tool_use_id": tool_call_id(item),
        "tool_name": tool_name(item),
        "tool_output": tool_output(item),
        "status": tool_status(item),
        "timestamp": timestamp,
    }));
}

fn command_input(item: &Value) -> Value {
    json!({
        "command": string_field(item, "command")
            .or_else(|| command_from_local_shell_action(item))
            .unwrap_or_default(),
        "cwd": string_field(item, "cwd").unwrap_or_default(),
    })
}

fn command_output(item: &Value) -> String {
    raw_string_field(item, "aggregatedOutput")
        .or_else(|| raw_string_field(item, "aggregated_output"))
        .or_else(|| raw_string_field(item, "output"))
        .unwrap_or_default()
}

fn command_from_local_shell_action(item: &Value) -> Option<String> {
    item.get("action").and_then(|action| {
        string_field(action, "command")
            .or_else(|| string_field(action, "cmd"))
            .or_else(|| string_field(action, "commandLine"))
    })
}

fn is_tool_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandexecution"
            | "shellcall"
            | "localshellcall"
            | "functioncall"
            | "customtoolcall"
            | "dynamictoolcall"
            | "mcptoolcall"
            | "mcpcall"
            | "toolsearchcall"
            | "websearchcall"
            | "websearch"
            | "imagegeneration"
            | "imageview"
            | "sleep"
    )
}

fn is_tool_output_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "functioncalloutput" | "customtoolcalloutput" | "toolsearchoutput"
    )
}

fn tool_call_id(item: &Value) -> String {
    string_field(item, "call_id")
        .or_else(|| string_field(item, "callId"))
        .or_else(|| string_field(item, "id"))
        .unwrap_or_else(|| format!("tool-{}", now_ms()))
}

fn tool_name(item: &Value) -> String {
    match item_type(item).as_str() {
        "functioncall" | "functioncalloutput" => string_field(item, "name")
            .or_else(|| string_field(item, "tool"))
            .unwrap_or_else(|| "function_call".to_owned()),
        "customtoolcall" | "customtoolcalloutput" => string_field(item, "name")
            .or_else(|| string_field(item, "tool"))
            .unwrap_or_else(|| "custom_tool".to_owned()),
        "dynamictoolcall" => {
            string_field(item, "tool").unwrap_or_else(|| "dynamic_tool".to_owned())
        }
        "mcptoolcall" | "mcpcall" => {
            let server = string_field(item, "server");
            let tool = string_field(item, "tool")
                .or_else(|| string_field(item, "name"))
                .unwrap_or_else(|| "mcp_tool".to_owned());
            server
                .map(|server| format!("{server}.{tool}"))
                .unwrap_or(tool)
        }
        "toolsearchcall" | "toolsearchoutput" => "tool_search".to_owned(),
        "websearch" | "websearchcall" => "web_search".to_owned(),
        "imagegeneration" => "image_generation".to_owned(),
        "imageview" => "view_image".to_owned(),
        "sleep" => "sleep".to_owned(),
        _ => "tool".to_owned(),
    }
}

fn tool_input(item: &Value) -> Value {
    match item_type(item).as_str() {
        "functioncall" => parse_json_object_string(item, "arguments").unwrap_or_else(
            || json!({"arguments": raw_string_field(item, "arguments").unwrap_or_default()}),
        ),
        "customtoolcall" => json!({"input": raw_string_field(item, "input").unwrap_or_default()}),
        "dynamictoolcall" | "toolsearchcall" => {
            item.get("arguments").cloned().unwrap_or(Value::Null)
        }
        "mcptoolcall" | "mcpcall" => item
            .get("arguments")
            .or_else(|| item.get("input"))
            .cloned()
            .unwrap_or(Value::Null),
        "websearch" => json!({"query": string_field(item, "query").unwrap_or_default()}),
        "websearchcall" => item
            .get("action")
            .cloned()
            .unwrap_or_else(|| json!({"query": string_field(item, "query").unwrap_or_default()})),
        "imageview" => json!({"path": string_field(item, "path").unwrap_or_default()}),
        "sleep" => {
            json!({"duration_ms": item.get("durationMs").or_else(|| item.get("duration_ms")).cloned().unwrap_or(Value::Null)})
        }
        "imagegeneration" => {
            json!({"revised_prompt": string_field(item, "revisedPrompt").or_else(|| string_field(item, "revised_prompt")).unwrap_or_default()})
        }
        _ => Value::Object(Map::new()),
    }
}

fn parse_json_object_string(item: &Value, key: &str) -> Option<Value> {
    let text = raw_string_field(item, key)?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

fn tool_output(item: &Value) -> Value {
    match item_type(item).as_str() {
        "commandexecution" | "shellcall" | "localshellcall" => Value::String(command_output(item)),
        "functioncalloutput" | "customtoolcalloutput" => output_payload_text(item)
            .map(Value::String)
            .unwrap_or_else(|| item.get("output").cloned().unwrap_or(Value::Null)),
        "toolsearchoutput" => item.get("results").cloned().unwrap_or_else(|| {
            output_payload_text(item)
                .map(Value::String)
                .unwrap_or(Value::Null)
        }),
        "dynamictoolcall" => item
            .get("contentItems")
            .or_else(|| item.get("content_items"))
            .map(output_content_items_text)
            .map(Value::String)
            .unwrap_or_else(|| item.get("result").cloned().unwrap_or(Value::Null)),
        "mcptoolcall" | "mcpcall" => item
            .get("error")
            .and_then(|error| string_field(error, "message"))
            .map(Value::String)
            .or_else(|| item.get("result").cloned())
            .unwrap_or(Value::Null),
        "imagegeneration" => string_field(item, "savedPath")
            .or_else(|| string_field(item, "saved_path"))
            .or_else(|| raw_string_field(item, "result"))
            .map(Value::String)
            .unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn output_payload_text(item: &Value) -> Option<String> {
    let output = item.get("output")?;
    output
        .as_str()
        .map(str::to_owned)
        .or_else(|| Some(output_content_items_text(output)).filter(|value| !value.is_empty()))
}

fn output_content_items_text(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.as_str().map(str::to_owned).or_else(|| {
                part.get("text")
                    .or_else(|| part.get("content"))
                    .or_else(|| part.get("inputText"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool_status(item: &Value) -> String {
    let status = string_field(item, "status").unwrap_or_else(|| "completed".to_owned());
    if status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("failure")
        || status.eq_ignore_ascii_case("error")
        || bool_field(item, "success").is_some_and(|success| !success)
        || item.get("error").is_some()
    {
        "error".to_owned()
    } else if status.eq_ignore_ascii_case("completed")
        || status.eq_ignore_ascii_case("complete")
        || status.eq_ignore_ascii_case("done")
        || status.eq_ignore_ascii_case("succeeded")
        || bool_field(item, "success").is_some_and(|success| success)
    {
        "done".to_owned()
    } else {
        "pending".to_owned()
    }
}

fn file_changes(value: &Value) -> Option<Value> {
    value
        .get("fileChanges")
        .or_else(|| value.get("file_changes"))
        .filter(|value| value.is_object())
        .cloned()
}

fn merge_file_changes(existing: Option<Value>, next: Value) -> Option<Value> {
    let Some(mut current) = existing else {
        return Some(next);
    };
    let Some(current_object) = current.as_object_mut() else {
        return Some(next);
    };
    let Some(next_object) = next.as_object() else {
        return Some(current);
    };

    let mut files = current_object
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for next_file in next_object
        .get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(next_path) = string_field(next_file, "path") else {
            continue;
        };
        if let Some(existing_index) = files
            .iter()
            .position(|file| string_field(file, "path").is_some_and(|path| path == next_path))
        {
            files[existing_index] = merge_file_change(files.get(existing_index), next_file);
        } else {
            files.push(next_file.clone());
        }
    }
    if files.is_empty() {
        return Some(current);
    }

    for key in [
        "status",
        "device_id",
        "workspace_path",
        "reverted_at",
        "revertible",
    ] {
        if let Some(value) = next_object.get(key) {
            current_object.insert(key.to_owned(), value.clone());
        }
    }

    let additions = files
        .iter()
        .filter_map(|file| file.get("additions").and_then(Value::as_i64))
        .sum::<i64>();
    let deletions = files
        .iter()
        .filter_map(|file| file.get("deletions").and_then(Value::as_i64))
        .sum::<i64>();
    current_object.insert("file_count".to_owned(), json!(files.len()));
    current_object.insert("additions".to_owned(), json!(additions));
    current_object.insert("deletions".to_owned(), json!(deletions));
    current_object.insert("files".to_owned(), Value::Array(files));

    let combined_diff = [
        current_object.get("diff").and_then(Value::as_str),
        next_object.get("diff").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .filter(|diff| !diff.trim().is_empty())
    .collect::<Vec<_>>()
    .join("\n");
    if combined_diff.is_empty() {
        current_object.remove("diff");
    } else {
        current_object.insert("diff".to_owned(), Value::String(combined_diff));
    }

    Some(current)
}

fn merge_file_change(existing: Option<&Value>, next: &Value) -> Value {
    let Some(existing) = existing else {
        return next.clone();
    };
    let Some(existing_object) = existing.as_object() else {
        return next.clone();
    };
    let Some(next_object) = next.as_object() else {
        return existing.clone();
    };

    let additions = existing_object
        .get("additions")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + next_object
            .get("additions")
            .and_then(Value::as_i64)
            .unwrap_or(0);
    let deletions = existing_object
        .get("deletions")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        + next_object
            .get("deletions")
            .and_then(Value::as_i64)
            .unwrap_or(0);

    let mut merged = existing_object.clone();
    for key in ["path", "binary"] {
        if let Some(value) = next_object.get(key) {
            merged.insert(key.to_owned(), value.clone());
        }
    }
    if let Some(value) = next_object.get("old_path").filter(|value| !value.is_null()) {
        merged.insert("old_path".to_owned(), value.clone());
    }
    let change_type = merged_change_type(
        existing_object.get("change_type").and_then(Value::as_str),
        next_object.get("change_type").and_then(Value::as_str),
    );
    merged.insert("change_type".to_owned(), Value::String(change_type));
    merged.insert("additions".to_owned(), json!(additions));
    merged.insert("deletions".to_owned(), json!(deletions));
    Value::Object(merged)
}

fn merged_change_type(existing: Option<&str>, next: Option<&str>) -> String {
    match (existing, next) {
        (Some("created"), Some("modified")) => "created".to_owned(),
        (_, Some(next)) => next.to_owned(),
        (Some(existing), _) => existing.to_owned(),
        _ => "modified".to_owned(),
    }
}

fn file_changes_from_file_change_item(
    item: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    let status = string_field(item, "status").unwrap_or_else(|| "completed".to_owned());
    if !status.eq_ignore_ascii_case("completed") {
        return None;
    }
    let changes = item.get("changes")?.as_array()?;
    let files = changes
        .iter()
        .filter_map(|change| file_change_from_codex_change(change, workspace_path))
        .collect::<Vec<_>>();
    file_changes_summary(
        &item_id(item, "file-change"),
        turn_id,
        device_id,
        workspace_path,
        files,
        combined_diff_from_file_change_item(item, workspace_path),
    )
}

fn file_changes_from_patch_apply_end(
    item: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    if bool_field(item, "success").is_some_and(|success| !success) {
        return None;
    }
    let changes = item.get("changes")?.as_object()?;
    let files = changes
        .iter()
        .filter_map(|(path, change)| file_change_from_patch_change(path, change, workspace_path))
        .collect::<Vec<_>>();
    file_changes_summary(
        &item_id(item, "patch"),
        turn_id,
        device_id,
        workspace_path,
        files,
        combined_diff_from_patch_apply_end(item, workspace_path),
    )
}

fn file_changes_summary(
    item_id: &str,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
    files: Vec<Value>,
    diff: Option<String>,
) -> Option<Value> {
    if files.is_empty() {
        return None;
    }
    let additions = files
        .iter()
        .filter_map(|file| file.get("additions").and_then(Value::as_i64))
        .sum::<i64>();
    let deletions = files
        .iter()
        .filter_map(|file| file.get("deletions").and_then(Value::as_i64))
        .sum::<i64>();
    let mut summary = json!({
        "version": 1,
        "status": "active",
        "artifact_id": format!("codex-{turn_id}-{item_id}"),
        "device_id": device_id,
        "workspace_path": workspace_path,
        "file_count": files.len(),
        "additions": additions,
        "deletions": deletions,
        "files": files,
        "reverted_at": Value::Null,
        "revertible": false,
    });
    if let Some(diff) = diff.filter(|diff| !diff.trim().is_empty()) {
        if let Some(object) = summary.as_object_mut() {
            object.insert("diff".to_owned(), Value::String(diff));
        }
    }
    Some(summary)
}

fn file_change_from_codex_change(change: &Value, workspace_path: &str) -> Option<Value> {
    let source_path = workspace_relative_path(&string_field(change, "path")?, workspace_path);
    let kind = change
        .get("kind")
        .and_then(Value::as_object)
        .and_then(|kind| kind.get("type").and_then(Value::as_str))
        .unwrap_or("update")
        .to_ascii_lowercase();
    let diff = raw_string_field(change, "diff").unwrap_or_default();
    let move_path = change
        .get("kind")
        .and_then(|kind| string_field(kind, "movePath").or_else(|| string_field(kind, "move_path")))
        .map(|path| workspace_relative_path(&path, workspace_path));
    let change_type = match kind.as_str() {
        "add" | "create" | "created" => "created",
        "delete" | "deleted" => "deleted",
        "update" if move_path.is_some() => "renamed",
        _ => "modified",
    };
    let (path, old_path) = if change_type == "renamed" {
        (
            move_path.unwrap_or_else(|| source_path.clone()),
            Some(source_path),
        )
    } else {
        (source_path, None)
    };
    let (additions, deletions) = diff_stats(&diff, change_type);
    Some(json!({
        "old_path": old_path,
        "path": path,
        "change_type": change_type,
        "additions": additions,
        "deletions": deletions,
        "binary": false,
    }))
}

fn file_change_from_patch_change(
    path: &str,
    change: &Value,
    workspace_path: &str,
) -> Option<Value> {
    let kind = string_field(change, "type").unwrap_or_else(|| "update".to_owned());
    let diff = raw_string_field(change, "unified_diff")
        .or_else(|| raw_string_field(change, "diff"))
        .or_else(|| raw_string_field(change, "content"))
        .unwrap_or_default();
    let source_path = workspace_relative_path(path, workspace_path);
    let move_path = string_field(change, "move_path")
        .or_else(|| string_field(change, "movePath"))
        .map(|path| workspace_relative_path(&path, workspace_path));
    let change_type = match kind.to_ascii_lowercase().as_str() {
        "add" | "create" | "created" => "created",
        "delete" | "deleted" => "deleted",
        "update" if move_path.is_some() => "renamed",
        _ => "modified",
    };
    let (path, old_path) = if change_type == "renamed" {
        (
            move_path.unwrap_or_else(|| source_path.clone()),
            Some(source_path),
        )
    } else {
        (source_path, None)
    };
    let (additions, deletions) = diff_stats(&diff, change_type);
    Some(json!({
        "old_path": old_path,
        "path": path,
        "change_type": change_type,
        "additions": additions,
        "deletions": deletions,
        "binary": false,
    }))
}

fn workspace_relative_path(path: &str, workspace_path: &str) -> String {
    let trimmed_path = path.trim();
    let normalized_path = normalize_workspace_path(trimmed_path);
    let normalized_workspace = normalize_workspace_path(workspace_path);
    if normalized_path.is_empty() || normalized_workspace.is_empty() {
        return trimmed_path.replace('\\', "/");
    }

    let workspace_prefix = normalized_workspace.trim_end_matches(['/', '\\']);
    if normalized_path == workspace_prefix {
        return String::new();
    }
    if let Some(relative_path) = normalized_path.strip_prefix(workspace_prefix) {
        if relative_path.starts_with('/') || relative_path.starts_with('\\') {
            return relative_path
                .trim_start_matches(['/', '\\'])
                .replace('\\', "/");
        }
    }

    trimmed_path.replace('\\', "/")
}

fn diff_stats(diff: &str, change_type: &str) -> (i64, i64) {
    let additions = diff
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .count() as i64;
    let deletions = diff
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .count() as i64;
    if additions > 0 || deletions > 0 {
        return (additions, deletions);
    }
    let line_count = diff.lines().count() as i64;
    match change_type {
        "created" => (line_count, 0),
        "deleted" => (0, line_count),
        _ => (0, 0),
    }
}

fn combined_diff_from_file_change_item(item: &Value, workspace_path: &str) -> Option<String> {
    let diff = item
        .get("changes")?
        .as_array()?
        .iter()
        .filter_map(|change| {
            let path = string_field(change, "path")?;
            let move_path = change.get("kind").and_then(|kind| {
                string_field(kind, "movePath").or_else(|| string_field(kind, "move_path"))
            });
            raw_string_field(change, "diff").map(|diff| match move_path {
                Some(move_path) => {
                    diff_with_file_header(&move_path, Some(&path), &diff, workspace_path)
                }
                None => diff_with_file_header(&path, None, &diff, workspace_path),
            })
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(diff).filter(|diff| !diff.is_empty())
}

fn combined_diff_from_patch_apply_end(item: &Value, workspace_path: &str) -> Option<String> {
    let diff = item
        .get("changes")?
        .as_object()?
        .iter()
        .filter_map(|(path, change)| {
            let move_path =
                string_field(change, "move_path").or_else(|| string_field(change, "movePath"));
            raw_string_field(change, "unified_diff")
                .or_else(|| raw_string_field(change, "diff"))
                .or_else(|| raw_string_field(change, "content"))
                .map(|diff| match move_path {
                    Some(move_path) => {
                        diff_with_file_header(&move_path, Some(path), &diff, workspace_path)
                    }
                    None => diff_with_file_header(path, None, &diff, workspace_path),
                })
        })
        .collect::<Vec<_>>()
        .join("\n");
    Some(diff).filter(|diff| !diff.is_empty())
}

fn diff_with_file_header(
    path: &str,
    old_path: Option<&str>,
    diff: &str,
    workspace_path: &str,
) -> String {
    if diff.trim_start().starts_with("diff --git ") {
        return diff.to_owned();
    }

    let relative_path = workspace_relative_path(path, workspace_path);
    if relative_path.is_empty() {
        return diff.to_owned();
    }

    let relative_old_path = old_path
        .map(|path| workspace_relative_path(path, workspace_path))
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| relative_path.clone());
    format!(
        "diff --git {} {}\n{}",
        diff_git_path("a", &relative_old_path),
        diff_git_path("b", &relative_path),
        diff.trim_end()
    )
}

fn diff_git_path(prefix: &str, path: &str) -> String {
    let path = format!("{prefix}/{}", path.replace('\\', "/"));
    if path.chars().any(char::is_whitespace) {
        format!("\"{path}\"")
    } else {
        path
    }
}

fn context_event(item: &Value, timestamp: i64, event_type: &str, status: &str) -> Value {
    json!({
        "id": item_id(item, event_type),
        "type": event_type,
        "status": status,
        "createdAt": timestamp,
    })
}

fn memory_citation(item: &Value) -> Option<Value> {
    item.get("memoryCitation")
        .or_else(|| item.get("memory_citation"))
        .filter(|value| value.is_object())
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_turn_keeps_commentary_visible_and_cancelled_status() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "interruptedAt": 1_780_000_152,
                    "status": "interrupted",
                    "items": [
                        {
                            "id": "user-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "inspect package"}]
                        },
                        {
                            "id": "commentary-1",
                            "type": "agentMessage",
                            "phase": "commentary",
                            "text": "I will inspect the package file."
                        },
                        {
                            "id": "call-1",
                            "type": "functionCall",
                            "call_id": "call-1",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"cat package.json\",\"workdir\":\"/tmp/project\"}",
                            "status": "completed"
                        },
                        {
                            "id": "final-1",
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": "partial answer"
                        },
                        {
                            "id": "user-2",
                            "type": "userMessage",
                            "timestamp": 1_780_000_140,
                            "content": [{"type": "text", "text": "# Files mentioned by the user:\n\n## pnpm-lock.yaml: /tmp/project/pnpm-lock.yaml\n\n## My request for Codex:\n"}]
                        },
                        {
                            "id": "commentary-2",
                            "type": "agentMessage",
                            "phase": "commentary",
                            "timestamp": 1_780_000_145,
                            "text": "I will use the lockfile context."
                        },
                        {
                            "id": "abort-marker",
                            "type": "userMessage",
                            "timestamp": 1_780_000_150,
                            "content": [{"type": "text", "text": "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>"}]
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[1]["status"], "cancelled");
        assert_eq!(messages[1]["stoppedNotice"], true);
        assert_eq!(messages[1]["content"], "");
        assert_eq!(messages[1]["completedAt"], 1_780_000_152_000_i64);
        assert_eq!(messages[1]["blocks"][0]["type"], "text");
        assert_eq!(
            messages[1]["blocks"][0]["content"],
            "I will inspect the package file."
        );
        assert_eq!(messages[1]["blocks"][1]["tool_name"], "exec_command");
        assert_eq!(
            messages[1]["blocks"][1]["tool_input"]["cmd"],
            "cat package.json"
        );
        assert_eq!(messages[1]["blocks"][2]["type"], "text");
        assert_eq!(messages[1]["blocks"][2]["content"], "partial answer");
        assert_eq!(messages[1]["blocks"][2]["timestamp"], 1_780_000_152_000_i64);
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["createdAt"], 1_780_000_140_000_i64);
        assert!(messages[2]["content"]
            .as_str()
            .unwrap_or_default()
            .contains("pnpm-lock.yaml"));
        assert_eq!(messages[3]["status"], "cancelled");
        assert_eq!(messages[3]["stoppedNotice"], false);
        assert_eq!(
            messages[3]["blocks"][0]["tool_name"],
            "conversation_guidance"
        );
        assert_eq!(messages[3]["blocks"][1]["type"], "text");
        assert_eq!(
            messages[3]["blocks"][1]["content"],
            "I will use the lockfile context."
        );
    }
}
