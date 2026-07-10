// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

pub(crate) fn cached_transcript_response(
    link: &RuntimeTaskLink,
    messages: Vec<Value>,
    context_usage: Option<Value>,
    limit: Option<usize>,
    before_cursor: Option<&str>,
    after_cursor: Option<&str>,
) -> Value {
    transcript_response(TranscriptResponseInput {
        local_task_id: link.local_task_id.clone(),
        workspace_path: link.workspace_path.clone(),
        runtime: link.runtime.clone(),
        messages,
        context_usage,
        limit,
        before_cursor: before_cursor.map(ToOwned::to_owned),
        after_cursor: after_cursor.map(ToOwned::to_owned),
        full_content: false,
    })
}

pub(crate) struct TranscriptResponseInput {
    pub(crate) local_task_id: String,
    pub(crate) workspace_path: String,
    pub(crate) runtime: String,
    pub(crate) messages: Vec<Value>,
    pub(crate) context_usage: Option<Value>,
    pub(crate) limit: Option<usize>,
    pub(crate) before_cursor: Option<String>,
    pub(crate) after_cursor: Option<String>,
    pub(crate) full_content: bool,
}

pub(crate) fn transcript_response(input: TranscriptResponseInput) -> Value {
    let TranscriptResponseInput {
        local_task_id,
        workspace_path,
        runtime,
        messages,
        context_usage,
        limit,
        before_cursor,
        after_cursor,
        full_content,
    } = input;
    let turn_navigation = transcript_turn_navigation(&messages);
    let page = transcript_page(
        messages,
        limit,
        before_cursor.as_deref(),
        after_cursor.as_deref(),
    );
    json!({
        "success": true,
        "taskId": local_task_id,
        "workspacePath": workspace_path,
        "runtime": runtime,
        "messages": page.messages,
        "fullContent": full_content,
        "contextUsage": context_usage.unwrap_or(Value::Null),
        "turnNavigation": turn_navigation,
        "rangeStart": page.range_start,
        "rangeEnd": page.range_end,
        "hasMoreBefore": page.has_more_before,
        "beforeCursor": page
            .before_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
        "hasMoreAfter": page.has_more_after,
        "afterCursor": page
            .after_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
    })
}

pub(crate) fn transcript_context_usage(thread: &Value) -> Option<Value> {
    rollout_context_usage(thread)
}

pub(crate) fn transcript_turn_navigation(messages: &[Value]) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    let mut pending_response_turn_indexes: Vec<usize> = Vec::new();

    for (message_index, message) in messages.iter().enumerate() {
        let role = string_field(message, "role").unwrap_or_default();
        if !role.eq_ignore_ascii_case("user") {
            if role.eq_ignore_ascii_case("assistant") && !pending_response_turn_indexes.is_empty() {
                let response_preview = transcript_message_preview(message);
                for turn_index in pending_response_turn_indexes.drain(..) {
                    if let Some(turn) = turns.get_mut(turn_index).and_then(Value::as_object_mut) {
                        turn.insert(
                            "responsePreview".to_owned(),
                            Value::String(response_preview.clone()),
                        );
                    }
                }
            }
            continue;
        }

        turns.push(json!({
            "id": string_field(message, "id").unwrap_or_else(|| format!("message-{message_index}")),
            "turnIndex": turns.len(),
            "messageIndex": message_index,
            "cursor": format!("offset:{message_index}"),
            "promptPreview": transcript_message_preview(message),
            "responsePreview": "",
        }));
        pending_response_turn_indexes.push(turns.len() - 1);
    }

    turns
}

pub(crate) fn transcript_message_preview(message: &Value) -> String {
    truncate_navigation_preview(&string_field(message, "content").unwrap_or_default())
}

pub(crate) fn truncate_navigation_preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut preview = String::new();
    for (index, ch) in normalized.chars().enumerate() {
        if index >= TRANSCRIPT_NAVIGATION_PREVIEW_CHARS {
            preview.push('…');
            return preview;
        }
        preview.push(ch);
    }
    preview
}

pub(crate) fn transcript_limit(payload: &Value) -> Option<usize> {
    integer_field(payload, "limit")
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

pub(crate) fn append_changed_transcript_messages(
    cached_messages: Vec<Value>,
    thread: &Value,
    turns: &[Value],
    changed_start: Option<usize>,
    device_id: &str,
) -> Vec<Value> {
    let Some(changed_start) = changed_start else {
        return cached_messages;
    };
    let Some(changed_turn_id) = turns
        .get(changed_start)
        .and_then(|turn| string_field(turn, "id"))
    else {
        return transcript_messages(&thread_with_turns(thread, turns.to_vec()), device_id);
    };

    let mut messages = cached_messages
        .into_iter()
        .take_while(|message| string_field(message, "turnId").as_deref() != Some(&changed_turn_id))
        .collect::<Vec<_>>();
    let changed_thread = thread_with_turns(thread, turns[changed_start..].to_vec());
    messages.extend(transcript_messages(&changed_thread, device_id));
    messages
}

pub(crate) fn runtime_message_running(message: &Value) -> bool {
    string_field(message, "status")
        .map(|status| {
            matches!(
                status.replace(['_', '-'], "").to_ascii_lowercase().as_str(),
                "streaming" | "running" | "inprogress" | "active" | "busy" | "pending"
            )
        })
        .unwrap_or(false)
}

pub(crate) fn transcript_running(
    local_link: Option<&RuntimeTaskLink>,
    running_hint: bool,
    messages: &[Value],
) -> bool {
    if local_link.is_some_and(local_task_finished) {
        return false;
    }
    running_hint || messages.iter().any(runtime_message_running)
}

pub(crate) fn local_task_finished(link: &RuntimeTaskLink) -> bool {
    !link.running
        && matches!(
            link.status
                .replace(['_', '-'], "")
                .to_ascii_lowercase()
                .as_str(),
            "done" | "complete" | "completed" | "failed" | "error" | "cancelled" | "canceled"
        )
}

pub(crate) fn transcript_source_signature(thread: &Value) -> Option<TranscriptSourceSignature> {
    string_field(thread, "path").and_then(|path| TranscriptSourceSignature::from_path(&path))
}

pub(crate) fn codex_thread_state(thread: &Value) -> Value {
    thread_with_rollout_turns(thread).unwrap_or_else(|| thread.clone())
}

pub(crate) fn cached_runtime_transcript_messages(link: &RuntimeTaskLink) -> Vec<Value> {
    let messages = cached_messages(link);
    if !runtime_has_provider_transcript_reader(&link.runtime) {
        return messages;
    }
    messages
        .into_iter()
        .filter(|message| {
            !string_field(message, "role")
                .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        })
        .collect()
}

pub(crate) fn cached_runtime_transcript_messages_for_provider(
    link: &RuntimeTaskLink,
    provider_messages: &[Value],
) -> Vec<Value> {
    if provider_messages.is_empty() {
        return cached_messages(link);
    }
    cached_runtime_transcript_messages(link)
}

pub(crate) fn cached_user_message(
    local_task_id: &str,
    request: &ExecutionRequest,
    payload: &Value,
) -> Option<Value> {
    let content = payload
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("content").and_then(Value::as_str))
        .filter(|content| !content.trim().is_empty())?;

    let mut message = Map::new();
    message.insert(
        "id".to_owned(),
        Value::String(format!(
            "{local_task_id}:user:{}",
            if !request.subtask_id.trim().is_empty() {
                request.subtask_id.clone()
            } else {
                now_ms().to_string()
            }
        )),
    );
    message.insert("role".to_owned(), Value::String("user".to_owned()));
    message.insert("content".to_owned(), Value::String(content.to_owned()));
    message.insert("status".to_owned(), Value::String("done".to_owned()));
    message.insert("createdAt".to_owned(), Value::Number(now_ms().into()));
    if let Some(source) = payload
        .get("source")
        .filter(|value| value.is_object())
        .cloned()
    {
        message.insert("source".to_owned(), source);
    }
    let attachments = normalized_attachments(payload.get("attachments"));
    if !attachments.is_empty() {
        message.insert("attachments".to_owned(), Value::Array(attachments));
    }
    Some(Value::Object(message))
}

pub(crate) fn normalized_attachments(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            let object = attachment.as_object()?;
            let mut normalized = Map::new();
            if let Some(id) = object.get("id").cloned() {
                normalized.insert("id".to_owned(), id);
            }
            let filename = object
                .get("filename")
                .or_else(|| object.get("original_filename"))
                .and_then(Value::as_str)
                .unwrap_or("attachment")
                .to_owned();
            normalized.insert("filename".to_owned(), Value::String(filename));
            copy_attachment_field(object, &mut normalized, "file_size");
            copy_attachment_field(object, &mut normalized, "mime_type");
            copy_attachment_field(object, &mut normalized, "subtask_id");
            copy_attachment_field(object, &mut normalized, "file_extension");
            copy_attachment_field(object, &mut normalized, "text_length");
            copy_attachment_field(object, &mut normalized, "text_preview");
            copy_attachment_field_alias(
                object,
                &mut normalized,
                "local_path",
                &["local_path", "localPath"],
            );
            copy_attachment_field_alias(
                object,
                &mut normalized,
                "local_preview_url",
                &["local_preview_url", "localPreviewUrl"],
            );
            if !normalized.contains_key("local_preview_url") {
                if let Some(local_path) = normalized.get("local_path").cloned() {
                    normalized.insert("local_preview_url".to_owned(), local_path);
                }
            }
            normalized.insert("status".to_owned(), Value::String("ready".to_owned()));
            normalized.insert("created_at".to_owned(), Value::Number(now_ms().into()));
            Some(Value::Object(normalized))
        })
        .collect()
}

pub(crate) fn guidance_image_inputs(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|attachment| {
            let mime_type = string_field(attachment, "mime_type")
                .or_else(|| string_field(attachment, "mimeType"))?;
            if !mime_type.starts_with("image/") {
                return None;
            }
            let path = string_field(attachment, "local_path")
                .or_else(|| string_field(attachment, "localPath"))?;
            Some(json!({ "type": "localImage", "path": path }))
        })
        .collect()
}

pub(crate) fn guidance_input_items(message: &str, attachments: Option<&Value>) -> Vec<Value> {
    let mut inputs = Vec::new();
    if !message.trim().is_empty() {
        inputs.push(json!({ "type": "text", "text": message }));
    }
    inputs.extend(guidance_image_inputs(attachments));
    inputs
}

pub(crate) fn copy_attachment_field(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    key: &str,
) {
    if let Some(value) = source.get(key).cloned() {
        target.insert(key.to_owned(), value);
    }
}

pub(crate) fn copy_attachment_field_alias(
    source: &Map<String, Value>,
    target: &mut Map<String, Value>,
    target_key: &str,
    source_keys: &[&str],
) {
    for source_key in source_keys {
        if let Some(value) = source.get(*source_key).cloned() {
            target.insert(target_key.to_owned(), value);
            return;
        }
    }
}
