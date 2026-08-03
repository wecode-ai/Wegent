fn cached_transcript_response(
    link: &RuntimeTaskLink,
    messages: Vec<Value>,
    context_usage: Option<Value>,
    running: bool,
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
        running,
        limit,
        before_cursor: before_cursor.map(ToOwned::to_owned),
        after_cursor: after_cursor.map(ToOwned::to_owned),
        full_content: false,
        turn_item_source: TranscriptTurnItemSource::CachedMessages,
    })
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
    limit: Option<usize>,
    before_cursor: Option<String>,
    after_cursor: Option<String>,
    full_content: bool,
    turn_item_source: TranscriptTurnItemSource,
}

fn transcript_response(input: TranscriptResponseInput) -> Value {
    let TranscriptResponseInput {
        local_task_id,
        workspace_path,
        runtime,
        messages,
        context_usage,
        running,
        limit,
        before_cursor,
        after_cursor,
        full_content,
        turn_item_source,
    } = input;
    let turn_navigation = transcript_turn_navigation(&messages);
    let page = transcript_page(
        messages,
        limit,
        before_cursor.as_deref(),
        after_cursor.as_deref(),
    );
    let turns = transcript_canonical_turns(&page.messages, turn_item_source);
    json!({
        "success": true,
        "taskId": local_task_id,
        "workspacePath": workspace_path,
        "runtime": runtime,
        "running": running,
        "messages": page.messages,
        "turns": turns,
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

fn transcript_canonical_turns(
    messages: &[Value],
    item_source: TranscriptTurnItemSource,
) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    let mut turn_indexes = std::collections::HashMap::<String, usize>::new();

    for message in messages {
        let message_index = message.get("messageIndex").and_then(Value::as_u64);
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

fn transcript_turn_navigation(messages: &[Value]) -> Vec<Value> {
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
            "cursor": format!("offset:{message_index}"),
            "promptPreview": transcript_message_preview(message),
            "responsePreview": "",
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
        .and_then(Value::as_str)?;
    let references = local_presentation_reference_descriptors(content);
    (!references.is_empty()).then(|| {
        json!({
            "clientUserMessageId": client_user_message_id,
            "references": references,
        })
    })
}

fn attach_user_message_presentations(messages: &mut [Value], presentations: Vec<Value>) {
    for presentation in presentations {
        let Some(client_user_message_id) = string_field(&presentation, "clientUserMessageId")
            .or_else(|| string_field(&presentation, "client_user_message_id"))
        else {
            continue;
        };
        let Some(message) = messages.iter_mut().find(|message| {
            string_field(message, "clientUserMessageId")
                .or_else(|| string_field(message, "client_user_message_id"))
                .as_deref()
                == Some(client_user_message_id.as_str())
        }) else {
            continue;
        };
        let Some(content) = string_field(message, "content") else {
            continue;
        };
        let references = presentation
            .get("references")
            .and_then(Value::as_array)
            .map(|references| presentation_reference_ranges(references, &content))
            .unwrap_or_default();
        if references.is_empty() {
            continue;
        }
        if let Some(message) = message.as_object_mut() {
            message.insert(
                "presentationReferences".to_owned(),
                Value::Array(references),
            );
        }
    }
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
