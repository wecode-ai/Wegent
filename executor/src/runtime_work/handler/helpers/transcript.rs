fn cached_transcript_response(
    link: &RuntimeTaskLink,
    mut messages: Vec<Value>,
    context_usage: Option<Value>,
    running: bool,
    limit: Option<usize>,
    before_cursor: Option<&str>,
    after_cursor: Option<&str>,
) -> Value {
    remove_superseded_transcript_turns(&mut messages, &link.runtime_handle);
    transcript_response(TranscriptResponseInput {
        local_task_id: link.local_task_id.clone(),
        workspace_path: link.workspace_path.clone(),
        runtime: link.runtime.clone(),
        messages,
        context_usage,
        running,
        pagination: transcript_pagination(
            &link.runtime,
            limit,
            before_cursor.map(ToOwned::to_owned),
            after_cursor.map(ToOwned::to_owned),
        ),
        full_content: false,
        turn_item_source: TranscriptTurnItemSource::CachedMessages,
    })
}

pub(super) fn remove_superseded_transcript_turns(
    messages: &mut Vec<Value>,
    runtime_handle: &Value,
) {
    let superseded_turn_ids = runtime_handle
        .get("supersededTranscriptTurnIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|turn_id| !turn_id.is_empty())
        .collect::<Vec<_>>();
    if superseded_turn_ids.is_empty() {
        return;
    }

    messages.retain(|message| {
        string_field(message, "turnId")
            .or_else(|| string_field(message, "turn_id"))
            .or_else(|| string_field(message, "subtaskId"))
            .or_else(|| string_field(message, "subtask_id"))
            .map_or(true, |turn_id| {
                !superseded_turn_ids.contains(&turn_id.as_str())
            })
    });
}

#[derive(Clone, Copy)]
enum TranscriptTurnItemSource {
    CodexItems,
    CachedMessages,
}

struct TranscriptResponseInput {
    local_task_id: String,
    workspace_path: String,
    runtime: String,
    messages: Vec<Value>,
    context_usage: Option<Value>,
    running: bool,
    pagination: TranscriptPagination,
    full_content: bool,
    turn_item_source: TranscriptTurnItemSource,
}

enum TranscriptPagination {
    Offset {
        limit: Option<usize>,
        before_cursor: Option<String>,
        after_cursor: Option<String>,
    },
    Opaque {
        before_cursor: Option<String>,
        after_cursor: Option<String>,
    },
}

struct ResolvedTranscriptPagination {
    messages: Vec<Value>,
    range_start: Option<usize>,
    range_end: Option<usize>,
    has_more_before: bool,
    before_cursor: Option<String>,
    has_more_after: bool,
    after_cursor: Option<String>,
    opaque_cursor: bool,
}

fn transcript_pagination(
    runtime: &str,
    limit: Option<usize>,
    before_cursor: Option<String>,
    after_cursor: Option<String>,
) -> TranscriptPagination {
    if runtime_has_provider_transcript_reader(runtime) {
        return TranscriptPagination::Opaque {
            before_cursor: None,
            after_cursor: None,
        };
    }
    TranscriptPagination::Offset {
        limit,
        before_cursor,
        after_cursor,
    }
}

fn transcript_response(input: TranscriptResponseInput) -> Value {
    let TranscriptResponseInput {
        local_task_id,
        workspace_path,
        runtime,
        messages,
        context_usage,
        running,
        pagination,
        full_content,
        turn_item_source,
    } = input;
    let ResolvedTranscriptPagination {
        messages,
        range_start,
        range_end,
        has_more_before,
        before_cursor,
        has_more_after,
        after_cursor,
        opaque_cursor,
    } = match pagination {
        TranscriptPagination::Offset {
            limit,
            before_cursor,
            after_cursor,
        } => {
            let page = transcript_page(
                messages,
                limit,
                before_cursor.as_deref(),
                after_cursor.as_deref(),
            );
            ResolvedTranscriptPagination {
                messages: page.messages,
                range_start: Some(page.range_start),
                range_end: Some(page.range_end),
                has_more_before: page.has_more_before,
                before_cursor: page.before_cursor,
                has_more_after: page.has_more_after,
                after_cursor: page.after_cursor,
                opaque_cursor: false,
            }
        }
        TranscriptPagination::Opaque {
            before_cursor,
            after_cursor,
        } => {
            let has_more_before = before_cursor.is_some();
            let has_more_after = after_cursor.is_some();
            ResolvedTranscriptPagination {
                messages,
                range_start: None,
                range_end: None,
                has_more_before,
                before_cursor,
                has_more_after,
                after_cursor,
                opaque_cursor: true,
            }
        }
    };
    let turn_navigation = transcript_turn_navigation(&messages, opaque_cursor);
    let turns = transcript_canonical_turns(&messages, turn_item_source);
    json!({
        "success": true,
        "taskId": local_task_id,
        "workspacePath": workspace_path,
        "runtime": runtime,
        "running": running,
        "messages": messages,
        "turns": turns,
        "fullContent": full_content,
        "contextUsage": context_usage.unwrap_or(Value::Null),
        "turnNavigation": turn_navigation,
        "rangeStart": range_start,
        "rangeEnd": range_end,
        "hasMoreBefore": has_more_before,
        "beforeCursor": before_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
        "hasMoreAfter": has_more_after,
        "afterCursor": after_cursor
            .map(Value::String)
            .unwrap_or(Value::Null),
    })
}

fn transcript_canonical_turns(
    messages: &[Value],
    item_source: TranscriptTurnItemSource,
) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    let mut turn_indexes = std::collections::HashMap::<String, usize>::new();

    for message in messages {
        let message_index = message
            .get("messageIndex")
            .or_else(|| message.get("message_index"))
            .and_then(Value::as_u64);
        let Some(turn_id) = string_field(message, "turnId")
            .or_else(|| string_field(message, "turn_id"))
            .or_else(|| string_field(message, "subtaskId"))
            .or_else(|| string_field(message, "subtask_id"))
        else {
            continue;
        };
        let turn_index = if let Some(index) = turn_indexes.get(&turn_id).copied() {
            index
        } else {
            let index = turns.len();
            turns.push(json!({
                "id": turn_id,
                "items": [],
                "messageIndex": message_index,
                "status": "done",
            }));
            turn_indexes.insert(turn_id.clone(), index);
            index
        };
        let Some(turn) = turns.get_mut(turn_index).and_then(Value::as_object_mut) else {
            continue;
        };
        if let Some(message_index) = message_index {
            let earliest_index = turn
                .get("messageIndex")
                .and_then(Value::as_u64)
                .map_or(message_index, |current| current.min(message_index));
            turn.insert("messageIndex".to_owned(), json!(earliest_index));
        }
        for key in [
            "status",
            "runtimeStatus",
            "completedAt",
            "error",
            "errorType",
            "stoppedNotice",
            "fileChanges",
            "references",
            "memoryCitations",
        ] {
            if let Some(value) = message.get(key) {
                turn.insert(key.to_owned(), value.clone());
            }
        }
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };
        let role = string_field(message, "role").unwrap_or_default();
        if role.eq_ignore_ascii_case("user") {
            let Some(item_id) = string_field(message, "clientUserMessageId")
                .or_else(|| string_field(message, "client_user_message_id"))
                .or_else(|| string_field(message, "id"))
            else {
                continue;
            };
            items.push(json!({
                "id": item_id,
                "type": "user_message",
                "message": message,
            }));
            continue;
        }
        if !role.eq_ignore_ascii_case("assistant") {
            continue;
        }

        match item_source {
            TranscriptTurnItemSource::CodexItems => {
                if let Some(runtime_items) =
                    message.get("runtimeItems").and_then(Value::as_array)
                {
                    items.extend(runtime_items.iter().cloned());
                }
            }
            TranscriptTurnItemSource::CachedMessages => {
                append_runtime_message_items(items, message);
            }
        }

    }

    turns
}

fn append_runtime_message_items(items: &mut Vec<Value>, message: &Value) {
    if let (Some(item_id), Some(content)) = (
        string_field(message, "id"),
        string_field(message, "content"),
    ) {
        let mut item = json!({
            "id": item_id,
            "type": "assistant_text",
            "content": content,
        });
        if let Some(created_at) = message.get("createdAt").or_else(|| message.get("created_at")) {
            item["createdAt"] = created_at.clone();
        }
        items.push(item);
    }

    let Some(blocks) = message.get("blocks").and_then(Value::as_array) else {
        return;
    };
    let mut ordered_blocks = blocks.iter().enumerate().collect::<Vec<_>>();
    ordered_blocks.sort_by_key(|(index, block)| {
        (
            timestamp_ms_field(block, "createdAt").unwrap_or(i64::MAX),
            *index,
        )
    });
    for (_, block) in ordered_blocks {
        let Some(block_id) = string_field(block, "id") else {
            continue;
        };
        items.push(json!({
            "id": block_id,
            "type": "block",
            "block": block,
        }));
    }
}

fn transcript_context_usage(thread: &Value) -> Option<Value> {
    rollout_context_usage(thread)
}

fn transcript_turn_navigation(messages: &[Value], opaque_cursor: bool) -> Vec<Value> {
    if opaque_cursor {
        return Vec::new();
    }
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
            "id": transcript_navigation_message_id(message, message_index),
            "turnIndex": turns.len(),
            "messageIndex": message_index,
            "promptPreview": transcript_message_preview(message),
            "responsePreview": "",
            "cursor": format!("offset:{message_index}"),
        }));
        pending_response_turn_indexes.push(turns.len() - 1);
    }

    turns
}

fn transcript_navigation_message_id(message: &Value, message_index: usize) -> String {
    string_field(message, "clientUserMessageId")
        .or_else(|| string_field(message, "client_user_message_id"))
        .or_else(|| string_field(message, "id"))
        .unwrap_or_else(|| format!("message-{message_index}"))
}

fn transcript_message_preview(message: &Value) -> String {
    let content = string_field(message, "content").unwrap_or_default();
    let visible_content = string_field(message, "role")
        .filter(|role| role.eq_ignore_ascii_case("user"))
        .map(|_| normalized_user_request_content(&content))
        .unwrap_or(content);
    truncate_navigation_preview(&visible_content)
}

fn truncate_navigation_preview(content: &str) -> String {
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

fn transcript_limit(payload: &Value) -> Option<usize> {
    integer_field(payload, "limit")
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn cached_runtime_transcript_messages(link: &RuntimeTaskLink) -> Vec<Value> {
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

fn user_message_presentation(payload: &Value) -> Option<Value> {
    let client_user_message_id = payload
        .get("clientUserMessageId")
        .or_else(|| payload.get("client_user_message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let content = payload
        .get("message")
        .or_else(|| payload.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let references = local_presentation_reference_descriptors(content);
    let source = payload.get("source").filter(|value| value.is_object()).cloned();
    let presentation = json!({
        "clientUserMessageId": client_user_message_id,
        "content": content,
        "createdAt": timestamp_ms_field(payload, "createdAt").unwrap_or_else(now_ms),
        "ensureVisible": true,
        "references": references,
        "source": source,
    });
    Some(presentation)
}

fn attach_legacy_thread_preview(
    messages: &mut Vec<Value>,
    thread: &Value,
    has_older_page: bool,
) {
    if has_older_page
        || string_field(thread, "historyMode").as_deref() != Some("legacy")
    {
        return;
    }
    let Some(preview) = string_field(thread, "preview")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    let oldest_turn = thread
        .get("turns")
        .and_then(Value::as_array)
        .and_then(|turns| turns.first());
    let turn_id = oldest_turn.and_then(|turn| id_field(turn, "id"));
    let oldest_turn_has_user_message = messages.iter().any(|message| {
        if string_field(message, "role").as_deref() != Some("user") {
            return false;
        }
        match turn_id.as_deref() {
            Some(turn_id) => string_field(message, "turnId")
                .or_else(|| string_field(message, "turn_id"))
                .or_else(|| string_field(message, "subtaskId"))
                .or_else(|| string_field(message, "subtask_id"))
                .as_deref()
                == Some(turn_id),
            None => true,
        }
    });
    if oldest_turn_has_user_message {
        return;
    }
    let created_at = oldest_turn
        .and_then(|turn| {
            timestamp_ms_field(turn, "startedAt")
                .or_else(|| timestamp_ms_field(turn, "started_at"))
                .or_else(|| timestamp_ms_field(turn, "createdAt"))
                .or_else(|| timestamp_ms_field(turn, "created_at"))
        })
        .or_else(|| timestamp_ms_field(thread, "createdAt"))
        .unwrap_or_else(now_ms);
    let synthetic_id = turn_id
        .as_deref()
        .map(|turn_id| format!("{turn_id}-legacy-preview"))
        .unwrap_or_else(|| "legacy-thread-preview".to_owned());
    let mut synthetic = json!({
        "id": synthetic_id,
        "role": "user",
        "content": preview,
        "status": "done",
        "createdAt": created_at,
    });
    if let Some(turn_id) = turn_id {
        synthetic["turnId"] = Value::String(turn_id.clone());
        synthetic["subtaskId"] = Value::String(turn_id);
    }
    messages.insert(0, synthetic);
}

#[cfg(test)]
fn attach_user_message_presentations(
    messages: &mut Vec<Value>,
    presentations: Vec<Value>,
) {
    let page_messages = messages.clone();
    attach_user_message_presentations_for_page(
        messages,
        presentations,
        &page_messages,
        false,
        false,
    );
}

fn attach_user_message_presentations_for_page(
    messages: &mut Vec<Value>,
    presentations: Vec<Value>,
    page_messages: &[Value],
    has_more_before: bool,
    has_more_after: bool,
) {
    for presentation in presentations {
        let Some(client_user_message_id) = string_field(&presentation, "clientUserMessageId")
            .or_else(|| string_field(&presentation, "client_user_message_id"))
        else {
            continue;
        };
        let message_index = messages.iter().position(|message| {
            string_field(message, "clientUserMessageId")
                .or_else(|| string_field(message, "client_user_message_id"))
                .as_deref()
                == Some(client_user_message_id.as_str())
        });
        let message_index = match message_index {
            Some(index) => index,
            None
                if bool_field(&presentation, "ensureVisible") == Some(true)
                    && presentation_belongs_to_transcript_page(
                        &presentation,
                        page_messages,
                        has_more_before,
                        has_more_after,
                    ) =>
            {
                let content = string_field(&presentation, "content").unwrap_or_default();
                if content.trim().is_empty() {
                    continue;
                }
                let created_at =
                    timestamp_ms_field(&presentation, "createdAt").unwrap_or_else(now_ms);
                let index = messages
                    .iter()
                    .position(|message| {
                        timestamp_ms_field(message, "createdAt")
                            .is_some_and(|message_at| {
                                message_at > created_at
                                    || (message_at == created_at
                                        && string_field(message, "role").as_deref() != Some("user"))
                            })
                    })
                    .unwrap_or(messages.len());
                let turn_id = string_field(&presentation, "turnId")
                    .or_else(|| string_field(&presentation, "turn_id"))
                    .or_else(|| {
                        messages[index..].iter().find_map(|message| {
                            string_field(message, "turnId")
                                .or_else(|| string_field(message, "turn_id"))
                                .or_else(|| string_field(message, "subtaskId"))
                                .or_else(|| string_field(message, "subtask_id"))
                        })
                    });
                let mut synthetic = json!({
                    "id": client_user_message_id,
                    "clientUserMessageId": client_user_message_id,
                    "role": "user",
                    "content": content,
                    "status": "done",
                    "createdAt": created_at,
                    "source": presentation.get("source").cloned(),
                });
                if let Some(turn_id) = turn_id {
                    synthetic["turnId"] = Value::String(turn_id.clone());
                    synthetic["subtaskId"] = Value::String(turn_id);
                }
                messages.insert(index, synthetic);
                index
            }
            None => continue,
        };
        let message = &mut messages[message_index];
        let content = string_field(message, "content").unwrap_or_default();
        let references = presentation
            .get("references")
            .and_then(Value::as_array)
            .map(|references| presentation_reference_ranges(references, &content))
            .unwrap_or_default();
        if let Some(message) = message.as_object_mut() {
            if !references.is_empty() {
                message.insert(
                    "presentationReferences".to_owned(),
                    Value::Array(references),
                );
            }
            if let Some(source) = presentation.get("source").filter(|value| value.is_object()) {
                message.insert("source".to_owned(), source.clone());
            }
        }
    }
}

fn presentation_belongs_to_transcript_page(
    presentation: &Value,
    page_messages: &[Value],
    has_more_before: bool,
    has_more_after: bool,
) -> bool {
    if !has_more_before && !has_more_after {
        return true;
    }

    let presentation_turn_id = string_field(presentation, "turnId")
        .or_else(|| string_field(presentation, "turn_id"));
    if presentation_turn_id.is_some_and(|presentation_turn_id| {
        page_messages.iter().any(|message| {
            string_field(message, "turnId")
                .or_else(|| string_field(message, "turn_id"))
                .or_else(|| string_field(message, "subtaskId"))
                .or_else(|| string_field(message, "subtask_id"))
                .as_deref()
                == Some(presentation_turn_id.as_str())
        })
    }) {
        return true;
    }

    let Some(created_at) = timestamp_ms_field(presentation, "createdAt") else {
        return false;
    };
    let mut page_timestamps = page_messages
        .iter()
        .filter_map(|message| timestamp_ms_field(message, "createdAt"));
    let Some(first_timestamp) = page_timestamps.next() else {
        return false;
    };
    let (page_start, page_end) = page_timestamps.fold(
        (first_timestamp, first_timestamp),
        |(minimum, maximum), timestamp| (minimum.min(timestamp), maximum.max(timestamp)),
    );

    (!has_more_before || created_at >= page_start) && (!has_more_after || created_at <= page_end)
}

fn local_presentation_reference_descriptors(content: &str) -> Vec<Value> {
    let mut references = Vec::new();
    let mut offset = 0;

    while let Some(relative_start) = content[offset..].find("[$") {
        let name_start = offset + relative_start + 2;
        let Some(relative_name_end) = content[name_start..].find("](") else {
            break;
        };
        let name_end = name_start + relative_name_end;
        let href_start = name_end + 2;
        let Some(relative_href_end) = content[href_start..].find(')') else {
            break;
        };
        let href_end = href_start + relative_href_end;
        offset = href_end + 1;

        let name = &content[name_start..name_end];
        let href = &content[href_start..href_end];
        let Some(token) = local_presentation_reference_token(name, href) else {
            continue;
        };
        references.push(json!({
            "token": token,
            "href": href,
        }));
    }

    references
}

fn presentation_reference_ranges(references: &[Value], content: &str) -> Vec<Value> {
    let mut ranges = Vec::new();
    let mut offset = 0;

    for reference in references {
        let Some(token) = string_field(reference, "token") else {
            continue;
        };
        let Some(href) = string_field(reference, "href") else {
            continue;
        };
        let tail = &content[offset..];
        let token_start = find_complete_presentation_token(tail, &token);
        let rich_reference = format!("[{token}]({href})");
        if let Some(rich_start) = tail.find(&rich_reference) {
            if token_start.map_or(true, |start| rich_start <= start) {
                offset += rich_start + rich_reference.len();
                continue;
            }
        }
        let Some(relative_start) = token_start else {
            continue;
        };
        let start = offset + relative_start;
        let end = start + token.len();
        ranges.push(json!({
            "start": content[..start].encode_utf16().count(),
            "end": content[..end].encode_utf16().count(),
            "href": href,
        }));
        offset = end;
    }

    ranges
}

fn find_complete_presentation_token(content: &str, token: &str) -> Option<usize> {
    content.match_indices(token).find_map(|(start, _)| {
        let end = start + token.len();
        content[end..]
            .chars()
            .next()
            .map_or(Some(start), |next| {
                (!is_presentation_token_continuation(next)).then_some(start)
            })
    })
}

fn is_presentation_token_continuation(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '-' | '_' | ':')
}

fn is_local_skill_reference(href: &str) -> bool {
    let path = href.strip_prefix("skill://").unwrap_or(href);
    path.starts_with('/') && path.ends_with("/SKILL.md")
}

fn local_presentation_reference_token(name: &str, href: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    if is_local_skill_reference(href) {
        return Some(format!("${name}"));
    }
    href.starts_with("plugin://").then(|| format!("@{name}"))
}

fn cached_user_message(
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
    if let Some(client_user_message_id) = payload
        .get("clientUserMessageId")
        .or_else(|| payload.get("client_user_message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        message.insert(
            "clientUserMessageId".to_owned(),
            Value::String(client_user_message_id.to_owned()),
        );
    }
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

fn normalized_attachments(value: Option<&Value>) -> Vec<Value> {
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

fn guidance_image_inputs(value: Option<&Value>) -> Vec<Value> {
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

fn guidance_input_items(message: &str, attachments: Option<&Value>) -> Vec<Value> {
    let mut inputs = Vec::new();
    if !message.trim().is_empty() {
        inputs.push(json!({ "type": "text", "text": message }));
    }
    inputs.extend(guidance_image_inputs(attachments));
    inputs
}

fn codex_guidance_failure_code(error: &str) -> &'static str {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("no active turn to steer")
        || (normalized.contains("expected active turn id") && normalized.contains("but found"))
    {
        "no_active_turn"
    } else {
        "guidance_failed"
    }
}

fn active_turn_id_from_steer_mismatch(error: &str) -> Option<String> {
    // Codex app-server 0.146.0 reports this mismatch only in the JSON-RPC
    // message. Prefer structured error data when the protocol exposes it.
    const PREFIX: &str = "expected active turn id `";
    const SEPARATOR: &str = "` but found `";

    error
        .strip_prefix(PREFIX)?
        .split_once(SEPARATOR)?
        .1
        .strip_suffix('`')
        .map(str::to_owned)
        .filter(|turn_id| !turn_id.trim().is_empty())
}

fn copy_attachment_field(source: &Map<String, Value>, target: &mut Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key).cloned() {
        target.insert(key.to_owned(), value);
    }
}

fn copy_attachment_field_alias(
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

fn runtime_handle_json(link: &RuntimeTaskLink) -> Value {
    let mut object = link
        .runtime_handle
        .as_object()
        .cloned()
        .unwrap_or_else(Map::new);
    object.insert(
        "threadId".to_owned(),
        link.thread_id
            .as_ref()
            .map(|thread_id| Value::String(thread_id.clone()))
            .unwrap_or(Value::Null),
    );
    Value::Object(object)
}

fn set_runtime_handle_model_selection(runtime_handle: &mut Value, payload: &Value) {
    if let Some(selection) = payload
        .get("modelSelection")
        .or_else(|| payload.get("model_selection"))
        .filter(|value| value.is_object())
    {
        let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
        object.insert("modelSelection".to_owned(), selection.clone());
        *runtime_handle = Value::Object(object);
        return;
    }

    let Some(model_name) =
        string_field(payload, "modelId").or_else(|| string_field(payload, "model_id"))
    else {
        return;
    };
    let mut selection = Map::new();
    selection.insert("modelName".to_owned(), Value::String(model_name));
    selection.insert(
        "modelType".to_owned(),
        string_field(payload, "modelType")
            .or_else(|| string_field(payload, "model_type"))
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    selection.insert(
        "options".to_owned(),
        payload
            .get("modelOptions")
            .or_else(|| payload.get("model_options"))
            .filter(|value| value.is_object())
            .cloned()
            .unwrap_or_else(|| json!({})),
    );

    let mut object = runtime_handle.as_object().cloned().unwrap_or_default();
    object.insert("modelSelection".to_owned(), Value::Object(selection));
    *runtime_handle = Value::Object(object);
}
