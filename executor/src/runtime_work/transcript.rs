// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use serde_json::{json, Map, Value};

use crate::{
    agents::executor_home,
    protocol::{CODEX_FILES_MENTIONED_HEADER, CODEX_REQUEST_MARKER},
    services::turn_file_changes::persist_named_artifact,
};

use super::util::{
    bool_field, codex_wrapped_item_payload, extract_text, id_field, integer_field,
    is_codex_context_compaction_item_type, is_codex_tool_item_type, is_codex_tool_output_item_type,
    is_likely_codex_tool_item_type, is_likely_codex_tool_output_item_type, item_id, item_type,
    normalize_workspace_path, now_ms, raw_string_field, raw_string_field_ref, reasoning_content,
    string_field, timestamp_ms_field,
};

const MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_TRANSCRIPT_MESSAGE_CONTENT_CHARS: usize = 200_000;
const MAX_TRANSCRIPT_BLOCK_CONTENT_CHARS: usize = 120_000;
const APPLICATION_CONTEXT_OPEN: &str = "<application_context>";
const APPLICATION_CONTEXT_CLOSE: &str = "</application_context>";

#[derive(Clone, Copy)]
pub(crate) struct TranscriptBuildOptions {
    truncate_content: bool,
}

impl TranscriptBuildOptions {
    fn truncated() -> Self {
        Self {
            truncate_content: true,
        }
    }

    fn full_content() -> Self {
        Self {
            truncate_content: false,
        }
    }
}

pub(crate) fn transcript_messages(thread: &Value, device_id: &str) -> Vec<Value> {
    transcript_messages_with_options(thread, device_id, TranscriptBuildOptions::truncated())
}

pub(crate) fn full_transcript_messages(thread: &Value, device_id: &str) -> Vec<Value> {
    transcript_messages_with_options(thread, device_id, TranscriptBuildOptions::full_content())
}

fn transcript_messages_with_options(
    thread: &Value,
    device_id: &str,
    options: TranscriptBuildOptions,
) -> Vec<Value> {
    let workspace_path = string_field(thread, "cwd").unwrap_or_default();
    let root_thread_id = string_field(thread, "id");
    let mut messages = Vec::new();
    for (turn_index, turn) in thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if !is_root_transcript_item(turn)
            || !is_root_thread_transcript_item(turn, root_thread_id.as_deref())
        {
            continue;
        }
        TurnTranscriptProjector::new(
            &mut messages,
            turn,
            turn_index,
            device_id,
            &workspace_path,
            root_thread_id.as_deref(),
            options,
        )
        .project();
    }
    make_transcript_ids_unique(&mut messages);
    messages
}

struct TurnTranscriptProjector<'a> {
    messages: &'a mut Vec<Value>,
    items: Vec<Value>,
    later_process: Vec<bool>,
    device_id: &'a str,
    workspace_path: &'a str,
    turn_id: String,
    subtask_id: String,
    created_at: i64,
    completed_at: Option<i64>,
    assistant_status: &'static str,
    assistant_error: Option<String>,
    fold_commentary: bool,
    turn_cancelled: bool,
    options: TranscriptBuildOptions,
    assistant_segment_index: usize,
    assistant: AssistantTurnAccumulation,
    seen_user_messages: HashMap<String, usize>,
}

impl<'a> TurnTranscriptProjector<'a> {
    fn new(
        messages: &'a mut Vec<Value>,
        turn: &Value,
        turn_index: usize,
        device_id: &'a str,
        workspace_path: &'a str,
        root_thread_id: Option<&str>,
        options: TranscriptBuildOptions,
    ) -> Self {
        let turn_id = stable_indexed_id(turn, "turn", turn_index);
        let items = canonical_turn_items(turn, &turn_id, root_thread_id);
        let later_process = later_process_flags(&items);
        let created_at = turn_started_at(turn);
        Self {
            messages,
            items,
            later_process,
            device_id,
            workspace_path,
            subtask_id: turn_subtask_id(turn, &turn_id),
            completed_at: turn_completed_at(turn, created_at),
            assistant_status: turn_assistant_status(turn),
            assistant_error: turn_error_message(turn),
            fold_commentary: turn_should_fold_commentary(turn),
            turn_cancelled: turn_interrupted(turn),
            assistant: AssistantTurnAccumulation::new(file_changes(turn)),
            turn_id,
            created_at,
            options,
            assistant_segment_index: 0,
            seen_user_messages: HashMap::new(),
        }
    }

    fn project(mut self) {
        let items = std::mem::take(&mut self.items);
        for (item_index, item) in items.into_iter().enumerate() {
            let previous_block_count = self.assistant.blocks.len();
            let previous_assistant_part_count = self.assistant.assistant_part_count();
            self.project_item(&item, self.later_process[item_index]);
            self.assistant
                .record_new_items(previous_block_count, previous_assistant_part_count);
        }
        self.emit_assistant(true);
    }

    fn project_item(&mut self, item: &Value, has_later_process: bool) {
        match item_type(item).as_str() {
            "usermessage" => self.project_user_message(item),
            "reasoning" => push_reasoning_block(
                &mut self.assistant.blocks,
                item,
                self.created_at,
                self.options,
            ),
            "plan" => self
                .assistant
                .blocks
                .push(plan_block(item, self.created_at, self.options)),
            "commandexecution" | "functioncall" | "customtoolcall" | "dynamictoolcall"
            | "mcptoolcall" | "mcpcall" | "toolsearchcall" | "websearchcall" | "websearch"
            | "imagegeneration" | "imageview" | "sleep" | "localshellcall" | "shellcall" => {
                self.push_workbench_block(item)
            }
            "functioncalloutput"
            | "customtoolcalloutput"
            | "toolsearchoutput"
            | "execcommandend"
            | "mcptoolcallend" => merge_tool_output(
                &mut self.assistant.blocks,
                item,
                self.created_at,
                self.options,
            ),
            "filechange" => {
                let summary = file_changes_from_file_change_item(
                    item,
                    &self.turn_id,
                    self.device_id,
                    self.workspace_path,
                );
                self.project_file_change(item, summary);
            }
            "patchapplyend" => {
                let summary = file_changes_from_patch_apply_end(
                    item,
                    &self.turn_id,
                    self.device_id,
                    self.workspace_path,
                );
                self.project_file_change(item, summary);
            }
            item_type if is_codex_context_compaction_item_type(item_type) => {
                self.push_workbench_block(item)
            }
            "agentmessage" | "agentmessageevent" => {
                self.project_assistant_message(item, has_later_process)
            }
            "message" => self.project_role_message(item, has_later_process),
            _ if is_default_tool_output_item(item) => merge_tool_output(
                &mut self.assistant.blocks,
                item,
                self.created_at,
                self.options,
            ),
            _ if is_default_tool_item(item) => self.push_workbench_block(item),
            _ => {}
        }
    }

    fn project_role_message(&mut self, item: &Value, has_later_process: bool) {
        match string_field(item, "role")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "user" => self.project_user_message(item),
            "assistant" => self.project_assistant_message(item, has_later_process),
            _ => {}
        }
    }

    fn project_user_message(&mut self, item: &Value) {
        if is_internal_turn_abort_message(item) {
            return;
        }
        let is_guidance = self.assistant_segment_index > 0 || self.assistant.has_non_file_output();
        self.emit_assistant(false);
        let pushed_user = push_user_message_once(
            self.messages,
            item,
            self.created_at,
            &self.subtask_id,
            self.assistant_status,
            &mut self.seen_user_messages,
        );
        if is_guidance && pushed_user {
            self.assistant.blocks.push(guidance_block(
                item,
                item_timestamp(item).unwrap_or(self.created_at),
            ));
        }
    }

    fn project_assistant_message(&mut self, item: &Value, has_later_process: bool) {
        collect_assistant_message(
            item,
            self.created_at,
            self.fold_commentary,
            self.turn_cancelled && self.fold_commentary,
            has_later_process,
            &mut self.assistant,
            self.options,
        );
        if let Some(file_changes) = file_changes(item) {
            self.merge_file_changes(file_changes);
        }
    }

    fn project_file_change(&mut self, item: &Value, summary: Option<Value>) {
        let Some(summary) = summary else {
            return;
        };
        if self.fold_commentary {
            self.push_workbench_block(item);
        }
        self.merge_file_changes(summary);
    }

    fn push_workbench_block(&mut self, item: &Value) {
        if let Some(block) = workbench_block_from_codex_item(
            item,
            &self.turn_id,
            self.device_id,
            self.workspace_path,
            self.created_at,
            self.options,
        ) {
            self.assistant.blocks.push(block);
        }
    }

    fn merge_file_changes(&mut self, next: Value) {
        self.assistant.file_changes = merge_file_changes(self.assistant.file_changes.take(), next);
    }

    fn emit_assistant(&mut self, final_segment: bool) {
        push_accumulated_assistant(
            self.messages,
            &mut self.assistant_segment_index,
            AssistantEmitContext {
                turn_id: &self.turn_id,
                subtask_id: &self.subtask_id,
                created_at: self.created_at,
                completed_at: self.completed_at,
                status: self.assistant_status,
                error: self.assistant_error.as_deref(),
            },
            &mut self.assistant,
            final_segment,
            self.options,
        );
    }
}

fn later_process_flags(items: &[Value]) -> Vec<bool> {
    let mut has_later_process = false;
    let mut flags = vec![false; items.len()];
    for (index, item) in items.iter().enumerate().rev() {
        flags[index] = has_later_process;
        has_later_process |= is_substantive_process_item(item);
    }
    flags
}

fn make_transcript_ids_unique(messages: &mut [Value]) {
    let mut message_ids = HashSet::new();
    for (message_index, message) in messages.iter_mut().enumerate() {
        ensure_unique_id(
            message,
            &mut message_ids,
            &format!("message-{message_index}"),
        );
        let message_id =
            string_field(message, "id").unwrap_or_else(|| format!("message-{message_index}"));

        let Some(blocks) = message.get_mut("blocks").and_then(Value::as_array_mut) else {
            continue;
        };
        let mut block_ids = HashSet::new();
        for (block_index, block) in blocks.iter_mut().enumerate() {
            ensure_unique_id(
                block,
                &mut block_ids,
                &format!("{message_id}-block-{block_index}"),
            );
        }
    }
}

fn ensure_unique_id(value: &mut Value, used: &mut HashSet<String>, fallback: &str) {
    let base = string_field(value, "id").unwrap_or_else(|| fallback.to_owned());
    let unique = unique_id(base, used);
    if let Some(object) = value.as_object_mut() {
        object.insert("id".to_owned(), Value::String(unique));
    }
}

fn unique_id(base: String, used: &mut HashSet<String>) -> String {
    if used.insert(base.clone()) {
        return base;
    }

    let mut suffix = 2;
    loop {
        let candidate = format!("{base}-{suffix}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        suffix += 1;
    }
}

pub(crate) fn workbench_block_from_notification(
    params: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
    status: Option<&str>,
) -> Option<Value> {
    let item = notification_item(params);
    let mut block = workbench_block_from_codex_item(
        &item,
        turn_id,
        device_id,
        workspace_path,
        now_ms(),
        TranscriptBuildOptions::truncated(),
    )?;
    if let Some(status) = status {
        if let Some(object) = block.as_object_mut() {
            object.insert("status".to_owned(), Value::String(status.to_owned()));
        }
    }
    Some(block)
}

pub(crate) fn completed_workbench_block_from_notification(
    params: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    let block =
        workbench_block_from_notification(params, turn_id, device_id, workspace_path, None)?;
    if is_completed_workbench_block(&block) {
        Some(block)
    } else {
        None
    }
}

fn is_completed_workbench_block(block: &Value) -> bool {
    if block
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|block_type| block_type == "file_changes")
    {
        return true;
    }
    block
        .get("tool_name")
        .and_then(Value::as_str)
        .is_some_and(|tool_name| tool_name == "context_compaction")
}

pub(crate) fn file_changes_block_from_patch_updated(
    params: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
    status: &str,
) -> Option<Value> {
    let summary = file_changes_from_patch_updated(params, turn_id, device_id, workspace_path)?;
    let item = patch_updated_item(params);
    let mut block = file_changes_block(&item, &summary, now_ms());
    if let Some(object) = block.as_object_mut() {
        object.insert("status".to_owned(), Value::String(status.to_owned()));
    }
    Some(block)
}

pub(crate) fn file_changes_update_from_patch_updated(
    params: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
    status: &str,
) -> Option<(String, Value)> {
    let summary = file_changes_from_patch_updated(params, turn_id, device_id, workspace_path)?;
    let block_id = format!("file-changes-{}", patch_updated_item_id(params));
    Some((
        block_id,
        json!({
            "file_changes": summary,
            "status": status,
        }),
    ))
}

pub(crate) fn workbench_block_from_codex_item(
    item: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
    fallback_timestamp: i64,
    options: TranscriptBuildOptions,
) -> Option<Value> {
    let item_type = item_type(item);
    if item_type == "filechange" {
        return file_changes_from_file_change_item(item, turn_id, device_id, workspace_path)
            .map(|summary| file_changes_block(item, &summary, fallback_timestamp));
    }
    if item_type == "patchapplyend" {
        return file_changes_from_patch_apply_end(item, turn_id, device_id, workspace_path)
            .map(|summary| file_changes_block(item, &summary, fallback_timestamp));
    }
    if is_codex_context_compaction_item_type(&item_type) {
        return Some(context_compaction_block(
            item,
            item_timestamp(item).unwrap_or(fallback_timestamp),
        ));
    }
    if is_likely_codex_tool_item_type(&item_type) || is_default_tool_item(item) {
        return Some(tool_block(item, fallback_timestamp, options));
    }
    None
}

pub(crate) fn tool_update_from_notification(params: &Value) -> Option<(String, Value)> {
    let item = notification_item(params);
    let item_type = item_type(&item);
    if !is_likely_codex_tool_item_type(&item_type)
        && !is_likely_codex_tool_output_item_type(&item_type)
    {
        return None;
    }
    let status = tool_status(&item);
    let status =
        if matches!(item_type.as_str(), "websearch" | "websearchcall") && status == "pending" {
            "done".to_owned()
        } else {
            status
        };
    let mut updates = json!({
        "status": status,
    });
    if let Some(object) = updates.as_object_mut() {
        insert_tool_output_fields(object, &item, TranscriptBuildOptions::truncated());
        insert_image_generation_render_payload(object, &item);
    }
    if let Some(input) = command_input_from_output(&item) {
        if let Some(object) = updates.as_object_mut() {
            object.insert("tool_input".to_owned(), input);
        }
    }
    if matches!(item_type.as_str(), "websearch" | "websearchcall") {
        if let Some(object) = updates.as_object_mut() {
            object.insert("tool_input".to_owned(), tool_input(&item));
        }
    }
    Some((tool_call_id(&item), updates))
}

fn notification_item(params: &Value) -> Value {
    transcript_item(params.get("item").unwrap_or(params))
}

fn transcript_item(item: &Value) -> Value {
    let Some(payload) = codex_wrapped_item_payload(item) else {
        return item.clone();
    };
    if let Some(plan_item) = completed_plan_event_item(item, payload) {
        return plan_item;
    }
    let Some(payload_object) = payload.as_object() else {
        return item.clone();
    };

    let mut object = payload_object.clone();
    for key in ["id", "timestamp", "createdAt", "created_at"] {
        if !object.contains_key(key) {
            if let Some(value) = item.get(key).cloned() {
                object.insert(key.to_owned(), value);
            }
        }
    }
    Value::Object(object)
}

fn completed_plan_event_item(item: &Value, payload: &Value) -> Option<Value> {
    if item_type(item) != "eventmsg" || item_type(payload) != "itemcompleted" {
        return None;
    }
    let nested_item = payload.get("item")?;
    if item_type(nested_item) != "plan" {
        return None;
    }
    let mut object = nested_item.as_object()?.clone();
    copy_missing_fields(
        &mut object,
        item,
        &[
            "timestamp",
            "createdAt",
            "created_at",
            "threadId",
            "thread_id",
        ],
    );
    copy_missing_fields(
        &mut object,
        payload,
        &[
            "threadId",
            "thread_id",
            "turnId",
            "turn_id",
            "agentPath",
            "agent_path",
        ],
    );
    if !object.contains_key("createdAt") && !object.contains_key("created_at") {
        if let Some(completed_at) = payload
            .get("completed_at_ms")
            .or_else(|| payload.get("completedAtMs"))
            .cloned()
        {
            object.insert("createdAt".to_owned(), completed_at);
        }
    }
    Some(Value::Object(object))
}

fn copy_missing_fields(object: &mut Map<String, Value>, source: &Value, keys: &[&str]) {
    for key in keys {
        if !object.contains_key(*key) {
            if let Some(value) = source.get(*key).cloned() {
                object.insert((*key).to_owned(), value);
            }
        }
    }
}

fn is_root_transcript_item(item: &Value) -> bool {
    transcript_agent_path(item)
        .or_else(|| codex_wrapped_item_payload(item).and_then(transcript_agent_path))
        .map_or(true, |agent_path| agent_path == "/root")
}

fn transcript_agent_path(value: &Value) -> Option<String> {
    string_field(value, "agent_path").or_else(|| string_field(value, "agentPath"))
}

fn is_root_thread_transcript_item(item: &Value, root_thread_id: Option<&str>) -> bool {
    let Some(root_thread_id) = root_thread_id else {
        return true;
    };
    transcript_thread_id(item)
        .or_else(|| codex_wrapped_item_payload(item).and_then(transcript_thread_id))
        .map_or(true, |thread_id| thread_id == root_thread_id)
}

fn transcript_thread_id(value: &Value) -> Option<String> {
    string_field(value, "threadId").or_else(|| string_field(value, "thread_id"))
}

fn transcript_item_with_stable_id(item: &Value, turn_id: &str, item_index: usize) -> Value {
    let mut normalized = transcript_item(item);
    if string_field(&normalized, "id").is_some() {
        return normalized;
    }

    if let Some(object) = normalized.as_object_mut() {
        object.insert(
            "id".to_owned(),
            Value::String(format!("{turn_id}:item:{}", item_index + 1)),
        );
    }
    normalized
}

fn canonical_turn_items(turn: &Value, turn_id: &str, root_thread_id: Option<&str>) -> Vec<Value> {
    let mut items = Vec::new();
    let mut item_positions = HashMap::new();
    for (item_index, raw_item) in turn
        .get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        if !is_root_transcript_item(raw_item)
            || !is_root_thread_transcript_item(raw_item, root_thread_id)
        {
            continue;
        }
        let item = transcript_item_with_stable_id(raw_item, turn_id, item_index);
        let id = item_id(&item, "item");
        if let Some(position) = item_positions.get(&id).copied() {
            items[position] = item;
        } else {
            item_positions.insert(id, items.len());
            items.push(item);
        }
    }
    items
}

fn stable_indexed_id(item: &Value, prefix: &str, index: usize) -> String {
    string_field(item, "id").unwrap_or_else(|| format!("{prefix}-{}", index + 1))
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

fn turn_subtask_id(turn: &Value, turn_id: &str) -> String {
    id_field(turn, "subtaskId")
        .or_else(|| id_field(turn, "subtask_id"))
        .unwrap_or_else(|| turn_id.to_owned())
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
        .any(|raw_item| {
            let item = transcript_item(raw_item);
            let item_type = item_type(&item);
            is_substantive_process_item_type(&item_type)
                || (item_type == "message"
                    && !string_field(&item, "role")
                        .unwrap_or_default()
                        .eq_ignore_ascii_case("user")
                    && !is_agent_message(&item))
        })
}

fn is_agent_message(item: &Value) -> bool {
    matches!(
        item_type(item).as_str(),
        "agentmessage" | "agentmessageevent"
    )
}

fn is_substantive_process_item_type(item_type: &str) -> bool {
    is_codex_tool_item_type(item_type)
        || is_codex_tool_output_item_type(item_type)
        || is_likely_codex_tool_item_type(item_type)
        || matches!(
            item_type,
            "reasoning" | "plan" | "filechange" | "patchapplyend"
        )
        || is_codex_context_compaction_item_type(item_type)
}

fn is_substantive_process_item(item: &Value) -> bool {
    is_substantive_process_item_type(&item_type(item))
        || is_default_tool_item(item)
        || is_default_tool_output_item(item)
}

fn is_default_tool_item(item: &Value) -> bool {
    let item_type = item_type(item);
    !matches!(
        item_type.as_str(),
        "" | "message"
            | "usermessage"
            | "agentmessage"
            | "agentmessageevent"
            | "plan"
            | "reasoning"
            | "filechange"
            | "patchapplyend"
    ) && !is_codex_context_compaction_item_type(&item_type)
        && (is_likely_codex_tool_item_type(&item_type)
            || string_field(item, "call_id").is_some()
            || string_field(item, "callId").is_some())
}

fn is_default_tool_output_item(item: &Value) -> bool {
    let item_type = item_type(item);
    is_default_tool_item(item)
        && (is_likely_codex_tool_output_item_type(&item_type)
            || item.get("output").is_some()
            || item.get("result").is_some()
            || item.get("aggregatedOutput").is_some()
            || item.get("aggregated_output").is_some()
            || item.get("stdout").is_some()
            || item.get("stderr").is_some())
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

fn turn_failed(turn: &Value) -> bool {
    turn_status(turn).is_some_and(|status| {
        matches!(
            status.as_str(),
            "failed" | "failure" | "error" | "systemerror"
        )
    })
}

fn turn_assistant_status(turn: &Value) -> &'static str {
    if turn_running(turn) {
        "streaming"
    } else if turn_interrupted(turn) {
        "cancelled"
    } else if turn_failed(turn) {
        "failed"
    } else {
        "done"
    }
}

fn turn_error_message(turn: &Value) -> Option<String> {
    let error = turn.get("error")?;
    error
        .as_str()
        .map(str::to_owned)
        .or_else(|| string_field(error, "message"))
}

fn turn_status(turn: &Value) -> Option<String> {
    string_field(turn, "status").map(normalized_phase_or_status)
}

fn turn_has_final_assistant_message(turn: &Value) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|item| is_final_assistant_message(&transcript_item(item)))
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

#[path = "transcript/message_projection.rs"]
mod message_projection;

pub(crate) use message_projection::normalized_user_request_content;
use message_projection::{
    assistant_message_phase_name, collect_assistant_message, file_changes_block, guidance_block,
    is_internal_turn_abort_message, item_timestamp, normalized_phase_or_status, plan_block,
    push_accumulated_assistant, push_reasoning_block, push_user_message_once, AssistantEmitContext,
    AssistantTurnAccumulation,
};

#[path = "transcript/tool_projection.rs"]
mod tool_projection;

use tool_projection::{
    command_input_from_output, insert_image_generation_render_payload, insert_tool_output_fields,
    limit_content_field, merge_tool_output, tool_block, tool_call_id, tool_input, tool_status,
};

#[path = "transcript/file_change_projection.rs"]
mod file_change_projection;

#[cfg(test)]
use file_change_projection::diff_stats;
use file_change_projection::{
    file_changes, file_changes_from_file_change_item, file_changes_from_patch_apply_end,
    file_changes_from_patch_updated, merge_file_changes, patch_updated_item, patch_updated_item_id,
};

fn context_compaction_block(item: &Value, timestamp: i64) -> Value {
    let block_id = item_id(item, "context_compaction");
    json!({
        "id": block_id,
        "type": "tool",
        "tool_use_id": block_id,
        "tool_name": "context_compaction",
        "status": "done",
        "timestamp": timestamp,
    })
}

fn memory_citation(item: &Value) -> Option<Value> {
    item.get("memoryCitation")
        .or_else(|| item.get("memory_citation"))
        .filter(|value| value.is_object())
        .cloned()
}

#[cfg(test)]
#[path = "transcript/tests.rs"]
mod tests;
