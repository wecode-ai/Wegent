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
    })
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
        "running": running,
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
    string_field(message, "clientMessageId")
        .or_else(|| string_field(message, "client_message_id"))
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

fn append_missing_cached_user_messages(messages: &mut Vec<Value>, cached_messages: Vec<Value>) {
    let mut matched_provider_indexes = HashSet::new();

    for message in cached_messages {
        let Some(signature) = cached_user_message_signature(&message) else {
            continue;
        };
        let client_message_id = user_message_client_id(&message);
        let client_id_match = client_message_id.as_ref().and_then(|client_message_id| {
            messages
                .iter()
                .enumerate()
                .find_map(|(index, provider_message)| {
                    (!matched_provider_indexes.contains(&index)
                        && user_message_client_id(provider_message).as_ref()
                            == Some(client_message_id))
                    .then_some(index)
                })
        });
        let matching_index = client_id_match.or_else(|| {
            messages
                .iter()
                .enumerate()
                .find_map(|(index, provider_message)| {
                    (!matched_provider_indexes.contains(&index)
                        && cached_user_message_signature(provider_message).as_ref()
                            == Some(&signature)
                        && (client_message_id.is_none()
                            || user_message_client_id(provider_message).is_none()))
                    .then_some(index)
                })
        });
        if let Some(index) = matching_index {
            matched_provider_indexes.insert(index);
            merge_missing_user_message_metadata(&mut messages[index], &message);
            if client_id_match == Some(index) {
                attach_cached_user_message_presentation(&mut messages[index], &message);
            }
            continue;
        }
        messages.push(message);
    }
}

fn user_message_client_id(message: &Value) -> Option<String> {
    string_field(message, "clientMessageId").or_else(|| string_field(message, "client_message_id"))
}

fn attach_cached_user_message_presentation(target: &mut Value, source: &Value) {
    let Some(provider_content) = string_field(target, "content") else {
        return;
    };
    let Some(local_content) = string_field(source, "content") else {
        return;
    };
    if provider_content == local_content {
        return;
    }
    let references = local_presentation_references(&local_content, &provider_content);
    if references.is_empty() {
        return;
    }
    if let Some(target) = target.as_object_mut() {
        target.insert(
            "presentationReferences".to_owned(),
            Value::Array(references),
        );
    }
}

fn local_presentation_references(local_content: &str, provider_content: &str) -> Vec<Value> {
    let mut references = Vec::new();
    let mut local_offset = 0;
    let mut provider_offset = 0;

    while let Some(relative_start) = local_content[local_offset..].find("[$") {
        let reference_start = local_offset + relative_start;
        let name_start = reference_start + 2;
        let Some(relative_name_end) = local_content[name_start..].find("](") else {
            break;
        };
        let name_end = name_start + relative_name_end;
        let href_start = name_end + 2;
        let Some(relative_href_end) = local_content[href_start..].find(')') else {
            break;
        };
        let href_end = href_start + relative_href_end;
        local_offset = href_end + 1;

        let name = &local_content[name_start..name_end];
        let href = &local_content[href_start..href_end];
        let Some(token) = local_presentation_reference_token(name, href) else {
            continue;
        };

        let provider_tail = &provider_content[provider_offset..];
        let token_start = provider_tail.find(&token);
        let reference = &local_content[reference_start..local_offset];
        if let Some(existing_reference_start) = provider_tail.find(reference) {
            if token_start.is_none_or(|start| existing_reference_start <= start) {
                provider_offset += existing_reference_start + reference.len();
                continue;
            }
        }
        let Some(relative_provider_start) = token_start else {
            continue;
        };
        let provider_start = provider_offset + relative_provider_start;
        let provider_end = provider_start + token.len();
        references.push(json!({
            "start": provider_content[..provider_start].encode_utf16().count(),
            "end": provider_content[..provider_end].encode_utf16().count(),
            "href": href,
        }));
        provider_offset = provider_end;
    }

    references
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

fn append_missing_cached_failed_assistant_messages(
    messages: &mut Vec<Value>,
    cached_messages: Vec<Value>,
) {
    let mut message_ids = messages
        .iter()
        .filter_map(|message| string_field(message, "id"))
        .collect::<HashSet<_>>();
    let mut assistant_subtask_ids = messages
        .iter()
        .filter(|message| {
            string_field(message, "role")
                .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
        })
        .filter_map(message_subtask_id)
        .collect::<HashSet<_>>();

    for message in cached_messages {
        let is_failed_assistant = string_field(&message, "role")
            .is_some_and(|role| role.eq_ignore_ascii_case("assistant"))
            && string_field(&message, "status")
                .is_some_and(|status| status.eq_ignore_ascii_case("failed"));
        if !is_failed_assistant {
            continue;
        }
        let Some(message_id) = string_field(&message, "id") else {
            continue;
        };
        let subtask_id = message_subtask_id(&message);
        if subtask_id
            .as_ref()
            .is_some_and(|subtask_id| assistant_subtask_ids.contains(subtask_id))
        {
            continue;
        }
        if !message_ids.insert(message_id) {
            continue;
        }
        if let Some(subtask_id) = subtask_id {
            assistant_subtask_ids.insert(subtask_id);
        }
        let Some(created_at) = message_created_at_ms(&message) else {
            messages.push(message);
            continue;
        };
        if let Some(index) = messages.iter().position(|existing| {
            message_created_at_ms(existing).is_some_and(|existing_at| existing_at > created_at)
        }) {
            messages.insert(index, message);
        } else {
            messages.push(message);
        }
    }
}

fn message_subtask_id(message: &Value) -> Option<String> {
    string_field(message, "subtaskId").or_else(|| string_field(message, "subtask_id"))
}

fn message_created_at_ms(message: &Value) -> Option<i64> {
    timestamp_ms_field(message, "createdAt")
        .or_else(|| timestamp_ms_field(message, "created_at"))
        .or_else(|| timestamp_ms_field(message, "completedAt"))
        .or_else(|| timestamp_ms_field(message, "completed_at"))
}

fn cached_user_message_signature(message: &Value) -> Option<String> {
    string_field(message, "role")
        .filter(|role| role.eq_ignore_ascii_case("user"))
        .and_then(|_| string_field(message, "content"))
        .map(|content| normalized_user_request_content(&content))
        .filter(|content| !content.is_empty())
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
    if let Some(client_message_id) = payload
        .get("clientMessageId")
        .or_else(|| payload.get("client_message_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        message.insert(
            "clientMessageId".to_owned(),
            Value::String(client_message_id.to_owned()),
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
