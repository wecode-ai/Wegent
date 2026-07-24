// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashSet, path::Path};

use serde_json::{json, Map, Value};

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
    let mut messages = Vec::new();
    let workspace_path = string_field(thread, "cwd").unwrap_or_default();
    let root_thread_id = string_field(thread, "id");
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
        let created_at = turn_started_at(turn);
        let completed_at = turn_completed_at(turn, created_at);
        let turn_file_changes = file_changes(turn);
        let turn_id = stable_indexed_id(turn, "turn", turn_index);
        let subtask_id = turn_subtask_id(turn, &turn_id);
        let turn_cancelled = turn_interrupted(turn);
        let assistant_status = turn_assistant_status(turn);
        let fold_commentary = turn_should_fold_commentary(turn);
        let mut assistant_segment_index = 0;
        let mut assistant = AssistantTurnAccumulation::new(turn_file_changes.clone());
        let mut seen_user_messages = HashSet::new();
        let prefer_user_message_events = turn_has_user_message_event(turn);
        for (item_index, raw_item) in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let item = transcript_item_with_stable_id(raw_item, &turn_id, item_index);
            if !is_root_transcript_item(raw_item)
                || !is_root_thread_transcript_item(raw_item, root_thread_id.as_deref())
            {
                continue;
            }
            match item_type(&item).as_str() {
                "usermessage" => {
                    if is_internal_turn_abort_message(&item) {
                        continue;
                    }
                    let is_guidance =
                        assistant_segment_index > 0 || assistant.has_non_file_output();
                    push_accumulated_assistant(
                        &mut messages,
                        &mut assistant_segment_index,
                        AssistantEmitContext {
                            turn_id: &turn_id,
                            subtask_id: &subtask_id,
                            created_at,
                            completed_at,
                            status: assistant_status,
                        },
                        &mut assistant,
                        false,
                        options,
                    );
                    let pushed_user = push_user_message_once(
                        &mut messages,
                        &item,
                        created_at,
                        &subtask_id,
                        &mut seen_user_messages,
                    );
                    if is_guidance && pushed_user {
                        assistant.blocks.push(guidance_block(
                            &item,
                            item_timestamp(&item).unwrap_or(created_at),
                        ));
                    }
                }
                "reasoning" => {
                    push_reasoning_block(&mut assistant.blocks, &item, created_at, options)
                }
                "plan" => assistant
                    .blocks
                    .push(plan_block(&item, created_at, options)),
                "commandexecution" | "functioncall" | "customtoolcall" | "dynamictoolcall"
                | "mcptoolcall" | "mcpcall" | "toolsearchcall" | "websearchcall" | "websearch"
                | "imagegeneration" | "imageview" | "sleep" | "localshellcall" | "shellcall" => {
                    if let Some(block) = workbench_block_from_codex_item(
                        &item,
                        &turn_id,
                        device_id,
                        &workspace_path,
                        created_at,
                        options,
                    ) {
                        assistant.blocks.push(block);
                    }
                }
                "functioncalloutput"
                | "customtoolcalloutput"
                | "toolsearchoutput"
                | "execcommandend"
                | "mcptoolcallend" => {
                    merge_tool_output(&mut assistant.blocks, &item, created_at, options);
                }
                "filechange" => {
                    if let Some(summary) = file_changes_from_file_change_item(
                        &item,
                        &turn_id,
                        device_id,
                        &workspace_path,
                    ) {
                        if fold_commentary {
                            if let Some(block) = workbench_block_from_codex_item(
                                &item,
                                &turn_id,
                                device_id,
                                &workspace_path,
                                created_at,
                                options,
                            ) {
                                assistant.blocks.push(block);
                            }
                        }
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), summary);
                    }
                }
                "patchapplyend" => {
                    if let Some(summary) = file_changes_from_patch_apply_end(
                        &item,
                        &turn_id,
                        device_id,
                        &workspace_path,
                    ) {
                        if fold_commentary {
                            if let Some(block) = workbench_block_from_codex_item(
                                &item,
                                &turn_id,
                                device_id,
                                &workspace_path,
                                created_at,
                                options,
                            ) {
                                assistant.blocks.push(block);
                            }
                        }
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), summary);
                    }
                }
                item_type if is_codex_context_compaction_item_type(item_type) => {
                    if let Some(block) = workbench_block_from_codex_item(
                        &item,
                        &turn_id,
                        device_id,
                        &workspace_path,
                        created_at,
                        options,
                    ) {
                        assistant.blocks.push(block);
                    }
                }
                "agentmessage" => {
                    collect_assistant_message(
                        &item,
                        created_at,
                        fold_commentary,
                        turn_cancelled && fold_commentary,
                        &mut assistant,
                        options,
                    );
                    if let Some(file_changes) = file_changes(&item) {
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), file_changes);
                    }
                }
                "message" => match string_field(&item, "role")
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str()
                {
                    "user" => {
                        if prefer_user_message_events {
                            continue;
                        }
                        if is_internal_turn_abort_message(&item) {
                            continue;
                        }
                        let is_guidance =
                            assistant_segment_index > 0 || assistant.has_non_file_output();
                        push_accumulated_assistant(
                            &mut messages,
                            &mut assistant_segment_index,
                            AssistantEmitContext {
                                turn_id: &turn_id,
                                subtask_id: &subtask_id,
                                created_at,
                                completed_at,
                                status: assistant_status,
                            },
                            &mut assistant,
                            false,
                            options,
                        );
                        let pushed_user = push_user_message_once(
                            &mut messages,
                            &item,
                            created_at,
                            &subtask_id,
                            &mut seen_user_messages,
                        );
                        if is_guidance && pushed_user {
                            assistant.blocks.push(guidance_block(
                                &item,
                                item_timestamp(&item).unwrap_or(created_at),
                            ));
                        }
                    }
                    "assistant" => {
                        collect_assistant_message(
                            &item,
                            created_at,
                            fold_commentary,
                            turn_cancelled && fold_commentary,
                            &mut assistant,
                            options,
                        );
                        if let Some(file_changes) = file_changes(&item) {
                            assistant.file_changes =
                                merge_file_changes(assistant.file_changes.take(), file_changes);
                        }
                    }
                    _ => {}
                },
                "agentmessageevent" => {
                    collect_assistant_message(
                        &item,
                        created_at,
                        fold_commentary,
                        turn_cancelled && fold_commentary,
                        &mut assistant,
                        options,
                    );
                    if let Some(file_changes) = file_changes(&item) {
                        assistant.file_changes =
                            merge_file_changes(assistant.file_changes.take(), file_changes);
                    }
                }
                _ => {
                    if is_default_tool_output_item(&item) {
                        merge_tool_output(&mut assistant.blocks, &item, created_at, options);
                    } else if is_default_tool_item(&item) {
                        if let Some(block) = workbench_block_from_codex_item(
                            &item,
                            &turn_id,
                            device_id,
                            &workspace_path,
                            created_at,
                            options,
                        ) {
                            assistant.blocks.push(block);
                        }
                    }
                }
            }
        }
        push_accumulated_assistant(
            &mut messages,
            &mut assistant_segment_index,
            AssistantEmitContext {
                turn_id: &turn_id,
                subtask_id: &subtask_id,
                created_at,
                completed_at,
                status: assistant_status,
            },
            &mut assistant,
            true,
            options,
        );
    }
    make_transcript_ids_unique(&mut messages);
    messages
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

fn stable_indexed_id(item: &Value, prefix: &str, index: usize) -> String {
    string_field(item, "id").unwrap_or_else(|| format!("{prefix}-{}", index + 1))
}

fn turn_has_user_message_event(turn: &Value) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(transcript_item)
        .any(|item| item_type(&item) == "usermessage" && !is_internal_turn_abort_message(&item))
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

fn turn_assistant_status(turn: &Value) -> &'static str {
    if turn_running(turn) {
        "streaming"
    } else if turn_interrupted(turn) {
        "cancelled"
    } else {
        "done"
    }
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
    assistant_parts: Vec<String>,
    memory_citations: Vec<Value>,
}

impl AssistantTurnAccumulation {
    fn new(file_changes: Option<Value>) -> Self {
        Self {
            blocks: Vec::new(),
            file_changes,
            assistant_parts: Vec::new(),
            memory_citations: Vec::new(),
        }
    }

    fn has_non_file_output(&self) -> bool {
        !self.blocks.is_empty()
            || !self.assistant_parts.is_empty()
            || !self.memory_citations.is_empty()
    }

    fn has_output(&self) -> bool {
        self.has_non_file_output() || self.file_changes.is_some()
    }

    fn clear_after_emit(&mut self) {
        self.blocks.clear();
        self.file_changes = None;
        self.assistant_parts.clear();
        self.memory_citations.clear();
    }
}

struct AssistantEmitContext<'a> {
    turn_id: &'a str,
    subtask_id: &'a str,
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
    options: TranscriptBuildOptions,
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
        assistant_parts: &assistant.assistant_parts,
        memory_citations: &assistant.memory_citations,
        options,
    }));
    *segment_index += 1;
    assistant.clear_after_emit();
}

fn push_user_message(messages: &mut Vec<Value>, item: &Value, created_at: i64, turn_id: &str) {
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
        "subtaskId": turn_id,
        "turnId": turn_id,
    });
    if let Some(client_message_id) =
        string_field(item, "clientId").or_else(|| string_field(item, "client_id"))
    {
        if let Some(object) = message.as_object_mut() {
            object.insert(
                "clientMessageId".to_owned(),
                Value::String(client_message_id),
            );
        }
    }
    if !attachments.is_empty() {
        if let Some(object) = message.as_object_mut() {
            object.insert("attachments".to_owned(), Value::Array(attachments));
        }
    }
    messages.push(message);
}

fn push_user_message_once(
    messages: &mut Vec<Value>,
    item: &Value,
    created_at: i64,
    turn_id: &str,
    seen: &mut HashSet<String>,
) -> bool {
    let Some(signature) = user_message_signature(item) else {
        push_user_message(messages, item, created_at, turn_id);
        return true;
    };
    if !seen.insert(signature) {
        return false;
    }
    push_user_message(messages, item, created_at, turn_id);
    true
}

fn user_message_signature(item: &Value) -> Option<String> {
    let content = extract_text(item)?;
    let normalized = content.trim();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.to_owned())
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

fn push_reasoning_block(
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

fn plan_block(item: &Value, fallback_timestamp: i64, options: TranscriptBuildOptions) -> Value {
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

fn collect_assistant_message(
    item: &Value,
    fallback_timestamp: i64,
    fold_commentary: bool,
    interleave_visible_text: bool,
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
            match assistant_message_phase(item, fold_commentary) {
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
                        assistant.assistant_parts.push(content);
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
    subtask_id: &'a str,
    created_at: i64,
    completed_at: Option<i64>,
    status: &'a str,
    stopped_notice: bool,
    blocks: &'a [Value],
    file_changes: Option<Value>,
    assistant_parts: &'a [String],
    memory_citations: &'a [Value],
    options: TranscriptBuildOptions,
}

fn synthetic_assistant_message(draft: AssistantMessageDraft<'_>) -> Value {
    let mut message = json!({
        "id": format!("assistant-{}", draft.turn_id),
        "role": "assistant",
        "content": draft.assistant_parts.join("\n\n"),
        "status": draft.status,
        "subtaskId": draft.subtask_id,
        "turnId": draft.turn_id,
        "createdAt": draft.created_at,
        "blocks": draft.blocks,
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

fn command_block(item: &Value, timestamp: i64, options: TranscriptBuildOptions) -> Value {
    let mut block = json!({
        "id": item_id(item, "tool"),
        "type": "tool",
        "tool_use_id": item_id(item, "tool"),
        "tool_name": "bash",
        "tool_input": command_input(item),
        "status": tool_status(item),
        "timestamp": timestamp,
    });
    if let Some(object) = block.as_object_mut() {
        insert_tool_output_fields(object, item, options);
        insert_image_generation_render_payload(object, item);
    }
    block
}

fn tool_block(item: &Value, timestamp: i64, options: TranscriptBuildOptions) -> Value {
    if matches!(
        item_type(item).as_str(),
        "commandexecution" | "shellcall" | "localshellcall"
    ) {
        return command_block(item, timestamp, options);
    }
    let mut block = json!({
        "id": tool_call_id(item),
        "type": "tool",
        "tool_use_id": tool_call_id(item),
        "tool_name": tool_name(item),
        "tool_input": tool_input(item),
        "status": tool_status(item),
        "timestamp": timestamp,
    });
    if let Some(object) = block.as_object_mut() {
        insert_tool_output_fields(object, item, options);
        insert_image_generation_render_payload(object, item);
    }
    block
}

fn merge_tool_output(
    blocks: &mut Vec<Value>,
    item: &Value,
    timestamp: i64,
    options: TranscriptBuildOptions,
) {
    let call_id = tool_call_id(item);
    if let Some(block) = blocks.iter_mut().rev().find(|block| {
        block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|value| value == call_id)
    }) {
        if let Some(object) = block.as_object_mut() {
            merge_tool_input(object, command_input_from_output(item));
            insert_tool_output_fields(object, item, options);
            insert_image_generation_render_payload(object, item);
            object.insert("status".to_owned(), Value::String(tool_status(item)));
        }
        return;
    }
    let mut block = json!({
        "id": call_id,
        "type": "tool",
        "tool_use_id": tool_call_id(item),
        "tool_name": tool_name(item),
        "status": tool_status(item),
        "timestamp": timestamp,
    });
    if let Some(object) = block.as_object_mut() {
        insert_tool_output_fields(object, item, options);
        insert_image_generation_render_payload(object, item);
    }
    if let Some(input) = command_input_from_output(item) {
        if let Some(object) = block.as_object_mut() {
            object.insert("tool_input".to_owned(), input);
        }
    }
    blocks.push(block);
}

fn insert_tool_output_fields(
    object: &mut Map<String, Value>,
    item: &Value,
    options: TranscriptBuildOptions,
) {
    let output = limited_tool_output(item, options);
    object.insert("tool_output".to_owned(), output.value);
    if output.truncated {
        object.insert("tool_output_truncated".to_owned(), Value::Bool(true));
        object.insert(
            "tool_output_original_bytes".to_owned(),
            json!(output.original_bytes),
        );
    } else {
        object.remove("tool_output_truncated");
        object.remove("tool_output_original_bytes");
    }
}

fn insert_image_generation_render_payload(object: &mut Map<String, Value>, item: &Value) {
    if item_type(item) != "imagegeneration" {
        return;
    }
    let mut payload = Map::from_iter([(
        "kind".to_owned(),
        Value::String("image_generation".to_owned()),
    )]);
    if let Some(result) = raw_string_field(item, "result").filter(|result| !result.is_empty()) {
        payload.insert("imageBase64".to_owned(), Value::String(result));
    }
    if let Some(prompt) =
        string_field(item, "revisedPrompt").or_else(|| string_field(item, "revised_prompt"))
    {
        payload.insert("revisedPrompt".to_owned(), Value::String(prompt));
    }
    if let Some(path) = string_field(item, "savedPath").or_else(|| string_field(item, "saved_path"))
    {
        payload.insert("savedPath".to_owned(), Value::String(path));
    }
    object.insert("render_payload".to_owned(), Value::Object(payload));
}

fn command_input(item: &Value) -> Value {
    json!({
        "command": command_string(item)
            .or_else(|| command_from_local_shell_action(item))
            .unwrap_or_default(),
        "cwd": command_cwd(item).unwrap_or_default(),
    })
}

#[derive(Debug)]
struct LimitedToolOutput {
    value: Value,
    truncated: bool,
    original_bytes: usize,
}

fn limited_tool_output(item: &Value, options: TranscriptBuildOptions) -> LimitedToolOutput {
    match raw_tool_output(item) {
        RawToolOutput::String(text) => {
            if options.truncate_content {
                limited_tool_output_string(text)
            } else {
                LimitedToolOutput {
                    value: Value::String(text.to_owned()),
                    truncated: false,
                    original_bytes: text.len(),
                }
            }
        }
        RawToolOutput::Value(value) => LimitedToolOutput {
            value,
            truncated: false,
            original_bytes: 0,
        },
    }
}

enum RawToolOutput<'a> {
    String(&'a str),
    Value(Value),
}

fn limited_tool_output_string(text: &str) -> LimitedToolOutput {
    let original_bytes = text.len();
    if original_bytes <= MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES {
        return LimitedToolOutput {
            value: Value::String(text.to_owned()),
            truncated: false,
            original_bytes,
        };
    }
    LimitedToolOutput {
        value: Value::String(tail_utf8_bytes(text, MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES)),
        truncated: true,
        original_bytes,
    }
}

fn tail_utf8_bytes(text: &str, max_bytes: usize) -> String {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

fn limit_content_field(value: &mut Value, max_chars: usize) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(content) = object
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let original_chars = content.chars().count();
    if original_chars <= max_chars {
        object.remove("content_truncated");
        object.remove("content_original_chars");
        return;
    }

    object.insert(
        "content".to_owned(),
        Value::String(tail_chars(&content, max_chars)),
    );
    object.insert("content_truncated".to_owned(), Value::Bool(true));
    object.insert("content_original_chars".to_owned(), json!(original_chars));
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let total_chars = text.chars().count();
    if total_chars <= max_chars {
        return text.to_owned();
    }
    text.chars().skip(total_chars - max_chars).collect()
}

fn command_output_ref(item: &Value) -> Option<&str> {
    raw_string_field_ref(item, "aggregatedOutput")
        .or_else(|| raw_string_field_ref(item, "aggregated_output"))
        .or_else(|| raw_string_field_ref(item, "output"))
}

fn command_input_from_output(item: &Value) -> Option<Value> {
    if item_type(item) != "execcommandend" {
        return None;
    }
    Some(command_input(item))
}

fn merge_tool_input(object: &mut Map<String, Value>, next_input: Option<Value>) {
    let Some(next_input) = next_input.and_then(|value| value.as_object().cloned()) else {
        return;
    };
    let input = object
        .entry("tool_input".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !input.is_object() {
        *input = Value::Object(Map::new());
    }
    let Some(input_object) = input.as_object_mut() else {
        return;
    };
    for (key, value) in next_input {
        if input_object
            .get(&key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            continue;
        }
        input_object.insert(key, value);
    }
}

fn command_string(item: &Value) -> Option<String> {
    string_field(item, "command").or_else(|| {
        let command = item.get("command")?.as_array()?;
        let parts = command
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        (!parts.is_empty()).then(|| parts.join(" "))
    })
}

fn command_cwd(item: &Value) -> Option<String> {
    string_field(item, "cwd").or_else(|| string_field(item, "workdir"))
}

fn command_from_local_shell_action(item: &Value) -> Option<String> {
    item.get("action").and_then(|action| {
        string_field(action, "command")
            .or_else(|| string_field(action, "cmd"))
            .or_else(|| string_field(action, "commandLine"))
    })
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
        "mcptoolcall" | "mcpcall" | "mcptoolcallbegin" | "mcptoolcallend" => {
            let server =
                string_field(item, "server").or_else(|| mcp_invocation_field(item, "server"));
            let tool = string_field(item, "tool")
                .or_else(|| string_field(item, "name"))
                .or_else(|| mcp_invocation_field(item, "tool"))
                .unwrap_or_else(|| "mcp_tool".to_owned());
            server
                .map(|server| format!("{server}.{tool}"))
                .unwrap_or(tool)
        }
        "toolsearchcall" | "toolsearchoutput" => "tool_search".to_owned(),
        "execcommandend" => "exec_command".to_owned(),
        "websearch" | "websearchcall" => "web_search".to_owned(),
        "imagegeneration" => "image_generation".to_owned(),
        "imageview" => "view_image".to_owned(),
        "sleep" => "sleep".to_owned(),
        _ => string_field(item, "name")
            .or_else(|| string_field(item, "tool"))
            .or_else(|| raw_string_field(item, "type"))
            .unwrap_or_else(|| "tool".to_owned()),
    }
}

fn tool_input(item: &Value) -> Value {
    match item_type(item).as_str() {
        "execcommandend" => command_input(item),
        "functioncall" => parse_json_object_string(item, "arguments").unwrap_or_else(
            || json!({"arguments": raw_string_field(item, "arguments").unwrap_or_default()}),
        ),
        "customtoolcall" => json!({"input": raw_string_field(item, "input").unwrap_or_default()}),
        "dynamictoolcall" | "toolsearchcall" => {
            item.get("arguments").cloned().unwrap_or(Value::Null)
        }
        "mcptoolcall" | "mcpcall" | "mcptoolcallbegin" | "mcptoolcallend" => item
            .get("arguments")
            .or_else(|| item.get("input"))
            .or_else(|| {
                item.get("invocation")
                    .and_then(|invocation| invocation.get("arguments"))
            })
            .cloned()
            .unwrap_or(Value::Null),
        "websearch" | "websearchcall" => item
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
        _ => default_tool_input(item),
    }
}

fn default_tool_input(item: &Value) -> Value {
    let mut input = Map::new();
    for key in [
        "type",
        "id",
        "call_id",
        "callId",
        "name",
        "tool",
        "server",
        "command",
        "cwd",
        "workdir",
        "arguments",
        "input",
        "action",
    ] {
        if let Some(value) = item.get(key).cloned() {
            input.insert(key.to_owned(), value);
        }
    }
    Value::Object(input)
}

fn parse_json_object_string(item: &Value, key: &str) -> Option<Value> {
    let text = raw_string_field(item, key)?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

fn raw_tool_output(item: &Value) -> RawToolOutput<'_> {
    match item_type(item).as_str() {
        "commandexecution" | "shellcall" | "localshellcall" | "execcommandend" => {
            RawToolOutput::String(command_output_ref(item).unwrap_or_default())
        }
        "functioncalloutput" | "customtoolcalloutput" => output_payload_text(item)
            .map(|output| RawToolOutput::Value(Value::String(output)))
            .unwrap_or_else(|| {
                RawToolOutput::Value(item.get("output").cloned().unwrap_or(Value::Null))
            }),
        "toolsearchoutput" => item
            .get("results")
            .cloned()
            .unwrap_or_else(|| {
                output_payload_text(item)
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            })
            .into(),
        "dynamictoolcall" => item
            .get("contentItems")
            .or_else(|| item.get("content_items"))
            .map(output_content_items_text)
            .map(|output| RawToolOutput::Value(Value::String(output)))
            .unwrap_or_else(|| {
                RawToolOutput::Value(item.get("result").cloned().unwrap_or(Value::Null))
            }),
        "mcptoolcall" | "mcpcall" | "mcptoolcallend" => RawToolOutput::Value(mcp_tool_output(item)),
        "imagegeneration" => string_field(item, "savedPath")
            .or_else(|| string_field(item, "saved_path"))
            .or_else(|| raw_string_field(item, "result"))
            .map(|output| RawToolOutput::Value(Value::String(output)))
            .unwrap_or(RawToolOutput::Value(Value::Null)),
        _ => default_tool_output(item),
    }
}

impl From<Value> for RawToolOutput<'_> {
    fn from(value: Value) -> Self {
        RawToolOutput::Value(value)
    }
}

fn default_tool_output(item: &Value) -> RawToolOutput<'_> {
    if let Some(output) = output_payload_text(item) {
        return RawToolOutput::Value(Value::String(output));
    }
    if let Some(command_output) = command_output_ref(item) {
        if !command_output.is_empty() {
            return RawToolOutput::String(command_output);
        }
    }
    let stdout = raw_string_field_ref(item, "stdout").unwrap_or_default();
    let stderr = raw_string_field_ref(item, "stderr").unwrap_or_default();
    let combined = [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !combined.is_empty() {
        return RawToolOutput::Value(limited_tool_output_string(&combined).value);
    }
    RawToolOutput::Value(
        item.get("result")
            .or_else(|| item.get("formatted_output"))
            .cloned()
            .unwrap_or(Value::Null),
    )
}

fn mcp_invocation_field(item: &Value, key: &str) -> Option<String> {
    item.get("invocation")
        .and_then(|invocation| string_field(invocation, key))
}

fn mcp_tool_output(item: &Value) -> Value {
    if let Some(message) = item
        .get("error")
        .and_then(|error| string_field(error, "message"))
    {
        return Value::String(message);
    }

    let Some(result) = item.get("result") else {
        return Value::Null;
    };

    if let Some(message) = result
        .get("Err")
        .or_else(|| result.get("err"))
        .and_then(Value::as_str)
    {
        return Value::String(message.to_owned());
    }

    result
        .get("Ok")
        .or_else(|| result.get("ok"))
        .cloned()
        .unwrap_or_else(|| result.clone())
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
    let item_type = item_type(item);
    if let Some(status) = mcp_tool_status(item, &item_type) {
        return status;
    }
    let status = string_field(item, "status").unwrap_or_else(|| {
        if matches!(item_type.as_str(), "imageview" | "sleep" | "websearch")
            || is_codex_tool_output_item_type(&item_type)
            || is_likely_codex_tool_output_item_type(&item_type)
            || item.get("output").is_some()
            || item.get("result").is_some()
            || item.get("aggregatedOutput").is_some()
            || item.get("aggregated_output").is_some()
            || item.get("stdout").is_some()
            || item.get("stderr").is_some()
        {
            "completed".to_owned()
        } else {
            "inProgress".to_owned()
        }
    });
    if is_command_status_item_type(&item_type) && command_exit_code(item).is_some() {
        "done".to_owned()
    } else if status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("failure")
        || status.eq_ignore_ascii_case("error")
        || bool_field(item, "success").is_some_and(|success| !success)
        || has_error_value(item)
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

fn mcp_tool_status(item: &Value, item_type: &str) -> Option<String> {
    if !matches!(item_type, "mcptoolcall" | "mcpcall" | "mcptoolcallend") {
        return None;
    }

    if has_error_value(item) {
        return Some("error".to_owned());
    }

    let result = item.get("result")?;
    if result.get("Err").or_else(|| result.get("err")).is_some() {
        return Some("error".to_owned());
    }

    let ok_result = result
        .get("Ok")
        .or_else(|| result.get("ok"))
        .unwrap_or(result);
    if ok_result
        .get("isError")
        .or_else(|| ok_result.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("error".to_owned());
    }

    Some("done".to_owned())
}

fn has_error_value(item: &Value) -> bool {
    item.get("error").is_some_and(|error| match error {
        Value::Null => false,
        Value::String(message) => !message.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        Value::Bool(value) => *value,
        Value::Number(_) => true,
    })
}

fn command_exit_code(item: &Value) -> Option<i64> {
    integer_field(item, "exit_code").or_else(|| integer_field(item, "exitCode"))
}

fn is_command_status_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandexecution" | "shellcall" | "localshellcall" | "execcommandend"
    )
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

fn file_changes_from_patch_updated(
    params: &Value,
    turn_id: &str,
    device_id: &str,
    workspace_path: &str,
) -> Option<Value> {
    let changes = params.get("changes")?.as_array()?;
    let files = changes
        .iter()
        .filter_map(|change| file_change_from_codex_change(change, workspace_path))
        .collect::<Vec<_>>();
    file_changes_summary(
        &patch_updated_item_id(params),
        turn_id,
        device_id,
        workspace_path,
        files,
        combined_diff_from_patch_updated(params, workspace_path),
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
    if looks_like_unified_diff(diff) {
        return prefixed_diff_stats(diff);
    }

    let line_count = diff.lines().count() as i64;
    match change_type {
        "created" => (line_count, 0),
        "deleted" => (0, line_count),
        _ => prefixed_diff_stats(diff),
    }
}

fn looks_like_unified_diff(diff: &str) -> bool {
    diff.lines().any(|line| {
        line.starts_with("@@ ")
            || line.starts_with("diff --git ")
            || line.starts_with("+++ ")
            || line.starts_with("--- ")
    })
}

fn prefixed_diff_stats(diff: &str) -> (i64, i64) {
    let additions = diff
        .lines()
        .filter(|line| line.starts_with('+') && !line.starts_with("+++"))
        .count() as i64;
    let deletions = diff
        .lines()
        .filter(|line| line.starts_with('-') && !line.starts_with("---"))
        .count() as i64;
    (additions, deletions)
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

fn combined_diff_from_patch_updated(params: &Value, workspace_path: &str) -> Option<String> {
    let diff = params
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

fn patch_updated_item(params: &Value) -> Value {
    json!({
        "id": patch_updated_item_id(params),
        "type": "fileChange",
    })
}

fn patch_updated_item_id(params: &Value) -> String {
    string_field(params, "itemId")
        .or_else(|| string_field(params, "item_id"))
        .unwrap_or_else(|| item_id(params, "file-change"))
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
mod tests {
    use super::*;

    #[test]
    fn web_search_updates_preserve_all_action_payloads() {
        let actions = [
            json!({
                "type": "openPage",
                "url": "https://docs.wegent.ai/guide"
            }),
            json!({
                "type": "findInPage",
                "url": "https://docs.wegent.ai/guide",
                "pattern": "install"
            }),
        ];

        for (index, action) in actions.into_iter().enumerate() {
            let params = json!({
                "item": {
                    "id": format!("search-{index}"),
                    "type": "webSearch",
                    "query": "",
                    "action": action.clone()
                }
            });

            let (_, updates) = tool_update_from_notification(&params)
                .expect("completed web search should produce a tool update");

            assert_eq!(updates["status"], "done");
            assert_eq!(updates["tool_input"], action);
        }
    }

    #[test]
    fn completed_statusless_tools_are_done() {
        for (item_type, id) in [
            ("imageView", "image-view-1"),
            ("sleep", "sleep-1"),
            ("webSearch", "web-search-1"),
        ] {
            let params = json!({
                "item": {
                    "id": id,
                    "type": item_type
                }
            });

            let (block_id, updates) = tool_update_from_notification(&params)
                .expect("completed statusless tool should produce a tool update");

            assert_eq!(block_id, id);
            assert_eq!(updates["status"], "done");
        }
    }

    #[test]
    fn transcript_marks_image_view_without_status_as_done() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [{
                "id": "turn-1",
                "startedAt": 1_780_000_000,
                "completedAt": 1_780_000_005,
                "status": "completed",
                "items": [{
                    "type": "response_item",
                    "payload": {
                        "id": "image-view-1",
                        "type": "imageView",
                        "path": "/tmp/image.png"
                    }
                }]
            }]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["tool_name"], "view_image");
        assert_eq!(block["status"], "done");
    }

    #[test]
    fn image_generation_blocks_preserve_renderable_image_data() {
        let item = json!({
            "id": "ig-1",
            "type": "imageGeneration",
            "status": "completed",
            "result": "aW1hZ2U=",
            "revisedPrompt": "A minimal blue circle",
            "savedPath": "/tmp/ig-1.png"
        });

        let block = workbench_block_from_codex_item(
            &item,
            "turn-1",
            "device-1",
            "/tmp",
            1,
            TranscriptBuildOptions::truncated(),
        )
        .expect("image generation should produce a workbench block");

        assert_eq!(block["tool_name"], "image_generation");
        assert_eq!(block["render_payload"]["kind"], "image_generation");
        assert_eq!(block["render_payload"]["imageBase64"], "aW1hZ2U=");
        assert_eq!(
            block["render_payload"]["revisedPrompt"],
            "A minimal blue circle"
        );
    }

    #[test]
    fn created_plain_content_counts_lines_as_additions() {
        let content = "# CPU System Report\n\n- CPU: Apple M1 Max\n- Thermal status: normal\n";

        assert_eq!(diff_stats(content, "created"), (4, 0));
    }

    #[test]
    fn unified_diff_counts_prefixed_lines() {
        let diff = "@@ -1,2 +1,2 @@\n-old\n+new\n context\n";

        assert_eq!(diff_stats(diff, "modified"), (1, 1));
    }

    #[test]
    fn modified_plain_patch_counts_prefixed_lines() {
        let diff = "-old\n+new\n context\n";

        assert_eq!(diff_stats(diff, "modified"), (1, 1));
    }

    #[test]
    fn transcript_unwraps_codex_response_item_and_event_msg_items() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "completedAt": 1_780_000_005,
                    "status": "completed",
                    "items": [
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_000,
                            "payload": {
                                "id": "context-response",
                                "type": "message",
                                "role": "user",
                                "content": [
                                    {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"}
                                ]
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_000,
                            "payload": {
                                "id": "user-1",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "inspect runtime"}]
                            }
                        },
                        {
                            "type": "event_msg",
                            "timestamp": 1_780_000_000,
                            "payload": {
                                "id": "user-event-1",
                                "type": "user_message",
                                "message": "inspect runtime"
                            }
                        },
                        {
                            "type": "event_msg",
                            "timestamp": 1_780_000_001,
                            "payload": {
                                "id": "commentary-1",
                                "type": "agent_message",
                                "phase": "commentary",
                                "message": "I will inspect the runtime."
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_002,
                            "payload": {
                                "id": "reasoning-1",
                                "type": "reasoning",
                                "summary": ["Checking the relevant files."]
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_003,
                            "payload": {
                                "id": "call-1",
                                "type": "function_call",
                                "call_id": "call-1",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"rg runtime\",\"workdir\":\"/tmp/project\"}"
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_004,
                            "payload": {
                                "id": "call-output-1",
                                "type": "function_call_output",
                                "call_id": "call-1",
                                "output": "runtime.rs"
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_005,
                            "payload": {
                                "id": "final-1",
                                "type": "message",
                                "role": "assistant",
                                "phase": "final_answer",
                                "content": [{"type": "output_text", "text": "Done."}]
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "inspect runtime");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "Done.");
        assert_eq!(messages[1]["blocks"][0]["type"], "text");
        assert_eq!(
            messages[1]["blocks"][0]["content"],
            "I will inspect the runtime."
        );
        assert_eq!(messages[1]["blocks"][0]["timestamp"], 1_780_000_001_000_i64);
        assert_eq!(messages[1]["blocks"][1]["type"], "thinking");
        assert_eq!(
            messages[1]["blocks"][1]["content"],
            "Checking the relevant files."
        );
        assert_eq!(messages[1]["blocks"][2]["tool_name"], "exec_command");
        assert_eq!(messages[1]["blocks"][2]["tool_input"]["cmd"], "rg runtime");
        assert_eq!(messages[1]["blocks"][2]["tool_output"], "runtime.rs");
        assert_eq!(messages[1]["blocks"][2]["status"], "done");
    }

    #[test]
    fn transcript_marks_successful_legacy_mcp_tool_call_end_as_done() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_001,
                            "payload": {
                                "type": "function_call",
                                "id": "fc-1",
                                "name": "ask",
                                "namespace": "askhuman",
                                "arguments": "{\"message\":\"Confirm?\"}",
                                "call_id": "call-ask"
                            }
                        },
                        {
                            "type": "event_msg",
                            "timestamp": 1_780_000_002,
                            "payload": {
                                "type": "mcp_tool_call_end",
                                "call_id": "call-ask",
                                "invocation": {
                                    "server": "askhuman",
                                    "tool": "ask",
                                    "arguments": {"message": "Confirm?"}
                                },
                                "result": {
                                    "Ok": {
                                        "content": [
                                            {
                                                "type": "text",
                                                "text": "{\"answers\":[{\"question_index\":0,\"user_input\":\"done\"}]}"
                                            }
                                        ],
                                        "structuredContent": {
                                            "answers": [
                                                {"question_index": 0, "user_input": "done"}
                                            ]
                                        },
                                        "isError": false
                                    }
                                }
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "ask");
        assert_eq!(block["tool_output"]["isError"], false);
        assert_eq!(block["status"], "done");
    }

    #[test]
    fn transcript_marks_completed_mcp_tool_call_with_null_error_as_done() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "event_msg",
                            "timestamp": 1_780_000_001,
                            "payload": {
                                "type": "mcpToolCall",
                                "id": "call-mcp",
                                "server": "codex",
                                "tool": "list_mcp_resources",
                                "arguments": {},
                                "status": "completed",
                                "error": null,
                                "result": {
                                    "_meta": null,
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "{\"resources\":[]}"
                                        }
                                    ],
                                    "structuredContent": null
                                }
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "codex.list_mcp_resources");
        assert_eq!(block["status"], "done");
    }

    #[test]
    fn transcript_unwraps_codex_plan_items_as_plan_blocks() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "completedAt": 1_780_000_010,
                    "status": "completed",
                    "items": [
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_001,
                            "payload": {
                                "id": "user-1",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "make a plan"}]
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_002,
                            "payload": {
                                "id": "plan-1",
                                "type": "plan",
                                "text": "# Plan\n\n- Inspect the repo."
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "");
        assert_eq!(messages[1]["blocks"][0]["id"], "plan-plan-1");
        assert_eq!(messages[1]["blocks"][0]["type"], "plan");
        assert_eq!(messages[1]["blocks"][0]["process_kind"], "plan");
        assert_eq!(
            messages[1]["blocks"][0]["content"],
            "# Plan\n\n- Inspect the repo."
        );
        assert_eq!(messages[1]["blocks"][0]["status"], "done");
    }

    #[test]
    fn transcript_unwraps_completed_plan_events_and_skips_duplicate_final_text() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "completedAt": 1_780_000_010,
                    "status": "completed",
                    "items": [
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_001,
                            "payload": {
                                "id": "user-1",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "make a plan"}]
                            }
                        },
                        {
                            "type": "event_msg",
                            "timestamp": 1_780_000_002,
                            "payload": {
                                "type": "item_completed",
                                "completed_at_ms": 1_780_000_003,
                                "item": {
                                    "id": "turn-1-plan",
                                    "type": "Plan",
                                    "text": "# Plan\n\n- Inspect the repo."
                                }
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_004,
                            "payload": {
                                "id": "assistant-final",
                                "type": "message",
                                "role": "assistant",
                                "phase": "final_answer",
                                "content": [
                                    {
                                        "type": "output_text",
                                        "text": "<proposed_plan>\n# Plan\n\n- Inspect the repo.\n</proposed_plan>"
                                    }
                                ]
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "");
        assert_eq!(messages[1]["blocks"].as_array().unwrap().len(), 1);
        assert_eq!(messages[1]["blocks"][0]["id"], "plan-turn-1-plan");
        assert_eq!(messages[1]["blocks"][0]["type"], "plan");
        assert_eq!(
            messages[1]["blocks"][0]["content"],
            "# Plan\n\n- Inspect the repo."
        );
    }

    #[test]
    fn transcript_deduplicates_user_event_when_response_item_is_present() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_000,
                            "payload": {
                                "id": "user-response",
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_text", "text": "start app"}]
                            }
                        },
                        {
                            "type": "event_msg",
                            "timestamp": 1_780_000_001,
                            "payload": {
                                "id": "user-event",
                                "type": "user_message",
                                "clientId": "runtime-local-pane-1",
                                "message": "start app\n"
                            }
                        },
                        {
                            "type": "response_item",
                            "timestamp": 1_780_000_002,
                            "payload": {
                                "id": "assistant-1",
                                "type": "message",
                                "role": "assistant",
                                "content": [{"type": "output_text", "text": "working"}]
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let user_messages = messages
            .iter()
            .filter(|message| message["role"] == "user")
            .collect::<Vec<_>>();

        assert_eq!(user_messages.len(), 1);
        assert_eq!(user_messages[0]["content"], "start app");
        assert_eq!(user_messages[0]["clientMessageId"], "runtime-local-pane-1");
        assert!(!messages.iter().any(|message| {
            message["content"]
                .as_str()
                .is_some_and(|content| content.contains("AGENTS.md"))
        }));
    }

    #[test]
    fn transcript_makes_message_and_block_ids_unique() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "completed",
                    "items": [
                        {
                            "id": "duplicate-user",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "first request"}]
                        },
                        {
                            "id": "duplicate-user",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "second request"}]
                        },
                        {
                            "id": "duplicate-file-change",
                            "type": "patchApplyEnd",
                            "status": "completed",
                            "changes": {
                                "/tmp/project/src/one.rs": {
                                    "type": "update",
                                    "unified_diff": "@@ -1 +1 @@\n-old\n+new\n",
                                    "move_path": null
                                }
                            }
                        },
                        {
                            "id": "duplicate-file-change",
                            "type": "patchApplyEnd",
                            "status": "completed",
                            "changes": {
                                "/tmp/project/src/two.rs": {
                                    "type": "update",
                                    "unified_diff": "@@ -1 +1 @@\n-old\n+new\n",
                                    "move_path": null
                                }
                            }
                        },
                        {
                            "id": "agent-1",
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": "Done"
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let message_ids = messages
            .iter()
            .filter_map(|message| message["id"].as_str())
            .collect::<Vec<_>>();
        let unique_message_ids = message_ids.iter().copied().collect::<HashSet<_>>();
        assert_eq!(message_ids.len(), unique_message_ids.len());
        assert_eq!(message_ids[0], "duplicate-user");
        assert_eq!(message_ids[1], "duplicate-user-2");

        let block_ids = messages
            .last()
            .and_then(|message| message["blocks"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|block| block["id"].as_str())
            .collect::<Vec<_>>();
        let unique_block_ids = block_ids.iter().copied().collect::<HashSet<_>>();
        assert_eq!(block_ids.len(), unique_block_ids.len());
        assert_eq!(block_ids[0], "file-changes-duplicate-file-change");
        assert_eq!(block_ids[1], "file-changes-duplicate-file-change-2");
    }

    #[test]
    fn transcript_generates_stable_ids_for_items_without_raw_ids() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "startedAt": 1_780_000_000,
                    "status": "completed",
                    "items": [
                        {
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "first request"}]
                        },
                        {
                            "type": "reasoning",
                            "text": "thinking"
                        },
                        {
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": "Done"
                        }
                    ]
                }
            ]
        });

        let first = transcript_messages(&thread, "device-1");
        let second = transcript_messages(&thread, "device-1");
        let first_ids = first
            .iter()
            .filter_map(|message| message["id"].as_str())
            .collect::<Vec<_>>();
        let second_ids = second
            .iter()
            .filter_map(|message| message["id"].as_str())
            .collect::<Vec<_>>();

        assert_eq!(first_ids, second_ids);
        assert_eq!(first_ids[0], "turn-1:item:1");
    }

    #[test]
    fn transcript_merges_exec_command_end_into_function_call_block() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "response_item",
                            "payload": {
                                "id": "call-1",
                                "type": "function_call",
                                "call_id": "call-1",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"pwd\",\"workdir\":\"/tmp/project\"}"
                            }
                        },
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "exec_command_end",
                                "call_id": "call-1",
                                "command": ["/bin/zsh", "-lc", "pwd"],
                                "cwd": "/tmp/project",
                                "aggregated_output": "/tmp/project\n",
                                "status": "completed",
                                "exit_code": 0
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(messages[0]["status"], "streaming");
        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "exec_command");
        assert_eq!(block["tool_input"]["cmd"], "pwd");
        assert_eq!(block["tool_input"]["cwd"], "/tmp/project");
        assert_eq!(block["tool_output"], "/tmp/project\n");
        assert_eq!(block["status"], "done");
    }

    #[test]
    fn transcript_truncates_large_exec_command_output() {
        let output = format!(
            "{}tail",
            "x".repeat(MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 1024)
        );
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "exec_command_end",
                                "call_id": "call-1",
                                "command": ["/bin/zsh", "-lc", "cat large.log"],
                                "cwd": "/tmp/project",
                                "aggregated_output": output,
                                "status": "completed",
                                "exit_code": 0
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];
        let tool_output = block["tool_output"].as_str().unwrap();

        assert_eq!(tool_output.len(), MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES);
        assert!(tool_output.ends_with("tail"));
        assert_eq!(block["tool_output_truncated"], true);
        assert_eq!(
            block["tool_output_original_bytes"],
            MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 1028
        );
    }

    #[test]
    fn full_transcript_messages_keep_large_content_and_tool_output() {
        let assistant_content = format!(
            "{}assistant-tail",
            "a".repeat(MAX_TRANSCRIPT_MESSAGE_CONTENT_CHARS + 16)
        );
        let output = format!(
            "{}tool-tail",
            "x".repeat(MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES + 1024)
        );
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "completed",
                    "items": [
                        {
                            "type": "agentMessage",
                            "phase": "final_answer",
                            "text": assistant_content
                        },
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "exec_command_end",
                                "call_id": "call-1",
                                "command": ["/bin/zsh", "-lc", "cat large.log"],
                                "cwd": "/tmp/project",
                                "aggregated_output": output,
                                "status": "completed",
                                "exit_code": 0
                            }
                        }
                    ]
                }
            ]
        });

        let messages = full_transcript_messages(&thread, "device-1");
        let message = &messages[0];
        let block = &message["blocks"][0];

        assert_eq!(message["content"], assistant_content);
        assert!(message.get("content_truncated").is_none());
        assert_eq!(block["tool_output"], output);
        assert!(block.get("tool_output_truncated").is_none());
    }

    #[test]
    fn transcript_treats_non_zero_command_exit_as_done() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "response_item",
                            "payload": {
                                "id": "call-1",
                                "type": "function_call",
                                "call_id": "call-1",
                                "name": "exec_command",
                                "arguments": "{\"cmd\":\"grep missing file.txt\",\"workdir\":\"/tmp/project\"}"
                            }
                        },
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "exec_command_end",
                                "call_id": "call-1",
                                "command": ["/bin/zsh", "-lc", "grep missing file.txt"],
                                "cwd": "/tmp/project",
                                "aggregated_output": "",
                                "status": "failed",
                                "exit_code": 1
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "exec_command");
        assert_eq!(block["status"], "done");
    }

    #[test]
    fn transcript_keeps_command_failures_without_exit_code_as_error() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "exec_command_end",
                                "call_id": "call-1",
                                "command": ["missing-binary"],
                                "cwd": "/tmp/project",
                                "status": "failed",
                                "error": "No such file or directory"
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["type"], "tool");
        assert_eq!(block["status"], "error");
    }

    #[test]
    fn transcript_keeps_non_command_tool_failures_with_exit_code_as_error() {
        let thread = json!({
            "id": "thread-1",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "response_item",
                            "payload": {
                                "id": "call-1",
                                "type": "function_call",
                                "call_id": "call-1",
                                "name": "custom_tool",
                                "arguments": "{\"path\":\"input.json\"}"
                            }
                        },
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "function_call_output",
                                "call_id": "call-1",
                                "status": "failed",
                                "output": "{\"exit_code\":2,\"message\":\"tool failed\"}",
                                "exit_code": 2
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "custom_tool");
        assert_eq!(block["status"], "error");
    }

    #[test]
    fn transcript_renders_unknown_tool_events_with_default_blocks() {
        let thread = json!({
            "id": "thread-1",
            "turns": [
                {
                    "id": "turn-1",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "custom_command_begin",
                                "call_id": "call-unknown",
                                "name": "unknown_runner",
                                "input": {"path": "src/main.rs"}
                            }
                        },
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "custom_command_end",
                                "call_id": "call-unknown",
                                "stdout": "ok\n"
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");
        let block = &messages[0]["blocks"][0];

        assert_eq!(block["type"], "tool");
        assert_eq!(block["tool_name"], "unknown_runner");
        assert_eq!(block["tool_input"]["input"]["path"], "src/main.rs");
        assert_eq!(block["tool_output"], "ok\n");
        assert_eq!(block["status"], "done");
    }

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

    #[test]
    fn transcript_ignores_subagent_items() {
        let thread = json!({
            "turns": [
                {
                    "id": "turn-1",
                    "status": "completed",
                    "items": [
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "assistant",
                                "agent_path": "/root/worker",
                                "content": [{"type": "output_text", "text": "child output"}]
                            }
                        },
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "assistant",
                                "agent_path": "/root",
                                "content": [{"type": "output_text", "text": "root output"}]
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "root output");
    }

    #[test]
    fn transcript_ignores_cross_thread_items() {
        let thread = json!({
            "id": "root-thread",
            "turns": [
                {
                    "id": "turn-1",
                    "status": "completed",
                    "items": [
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "assistant",
                                "threadId": "child-thread",
                                "content": [{"type": "output_text", "text": "child output"}]
                            }
                        },
                        {
                            "type": "response_item",
                            "payload": {
                                "type": "message",
                                "role": "assistant",
                                "threadId": "root-thread",
                                "content": [{"type": "output_text", "text": "root output"}]
                            }
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "root output");
    }

    #[test]
    fn transcript_ignores_cross_thread_turns() {
        let thread = json!({
            "id": "root-thread",
            "turns": [
                {
                    "id": "child-turn",
                    "threadId": "child-thread",
                    "status": "completed",
                    "items": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "child output"}]
                        }
                    ]
                },
                {
                    "id": "root-turn",
                    "threadId": "root-thread",
                    "status": "completed",
                    "items": [
                        {
                            "type": "message",
                            "role": "assistant",
                            "content": [{"type": "output_text", "text": "root output"}]
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device");

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "root output");
    }

    #[test]
    fn running_turn_stays_streaming_without_final_file_changes_card() {
        let thread = json!({
            "id": "thread-running",
            "cwd": "/tmp/project",
            "turns": [
                {
                    "id": "turn-running",
                    "startedAt": 1_780_000_000,
                    "status": "running",
                    "items": [
                        {
                            "id": "user-1",
                            "type": "userMessage",
                            "content": [{"type": "text", "text": "keep working"}]
                        },
                        {
                            "id": "reasoning-1",
                            "type": "reasoning",
                            "summary": ["Still inspecting."]
                        },
                        {
                            "id": "call-1",
                            "type": "function_call",
                            "call_id": "call-1",
                            "name": "exec_command",
                            "arguments": "{\"cmd\":\"sed -n '1,20p' src/main.rs\",\"workdir\":\"/tmp/project\"}"
                        },
                        {
                            "id": "patch-1",
                            "type": "patchApplyEnd",
                            "status": "completed",
                            "changes": [{"path": "src/main.rs", "kind": "modified", "additions": 2, "deletions": 1}]
                        }
                    ]
                }
            ]
        });

        let messages = transcript_messages(&thread, "device-1");

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["status"], "streaming");
        assert!(messages[1].get("completedAt").is_none());
        assert!(messages[1].get("fileChanges").is_none());
        assert_eq!(messages[1]["blocks"][0]["type"], "thinking");
        assert_eq!(messages[1]["blocks"][1]["tool_name"], "exec_command");
        assert_eq!(messages[1]["blocks"][1]["status"], "pending");
        assert_eq!(
            messages[1]["blocks"][1]["tool_input"]["cmd"],
            "sed -n '1,20p' src/main.rs"
        );
    }
}
