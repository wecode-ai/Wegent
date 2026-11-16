// Canonical display overlays keep execution instructions out of user-visible turns.

fn normalize_user_message_presentation(payload: &mut Value) -> Result<(), AppIpcError> {
    let Some(presentation) = payload.get("userMessagePresentation") else {
        return Ok(());
    };
    let invalid = || {
        AppIpcError::new("bad_request", "An explicit message presentation requires visible content and a stable client message ID")
    };
    let content = presentation
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if content.trim().is_empty() && normalized_attachments(payload.get("attachments")).is_empty() {
        return Err(invalid());
    }
    let client = ["clientUserMessageId", "client_user_message_id"]
        .into_iter()
        .filter_map(|field| payload.get(field).and_then(Value::as_str))
        .find(|id| !id.trim().is_empty())
        .ok_or_else(invalid)?;
    let content = content.to_owned();
    let client = client.trim().to_owned();
    let source = presentation
        .get("source")
        .filter(|value| value.is_object())
        .cloned();
    payload["message"] = json!(content);
    payload["clientUserMessageId"] = json!(client);
    payload["restoreUserMessageContent"] = json!(true);
    // The transport's existing source owns attribution, not the display override.
    if let Some(source) = source.filter(|_| !payload.get("source").is_some_and(Value::is_object)) {
        payload["source"] = source;
    }
    payload
        .as_object_mut()
        .unwrap()
        .remove("userMessagePresentation");
    Ok(())
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
        .unwrap_or_default();
    let attachments = normalized_attachments(payload.get("attachments"));
    if content.is_empty() && attachments.is_empty() {
        return None;
    }
    let references = local_presentation_reference_descriptors(content);
    let source = payload
        .get("source")
        .filter(|value| value.is_object())
        .cloned();
    let mut presentation = json!({
        "clientUserMessageId": client_user_message_id,
        "content": content,
        "attachments": attachments,
        "createdAt": timestamp_ms_field(payload, "createdAt").unwrap_or_else(now_ms),
        "ensureVisible": true,
        "references": references,
        "source": source,
    });
    if bool_field(payload, "restoreUserMessageContent") == Some(true) {
        presentation["restoreContent"] = json!(true);
    }
    Some(presentation)
}

#[cfg(test)]
fn attach_user_message_presentations(messages: &mut Vec<Value>, presentations: Vec<Value>) {
    let page_messages = messages.clone();
    attach_user_message_presentations_for_page(
        messages,
        presentations,
        &page_messages,
        &[],
        false,
        false,
    );
}

fn native_page_user_presentations(mut presentations: Vec<Value>, thread: &Value) -> Vec<Value> {
    if thread["timeline"] != true {
        return presentations;
    }
    let owning_turns = thread["turns"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|turn| turn["ownsUserPresentation"] == true)
        .filter_map(|turn| turn["id"].as_str())
        .collect::<Vec<_>>();
    // A turn can span pages. Only its native user entry or opening boundary owns a prompt.
    for presentation in &mut presentations {
        let turn_id =
            string_field(presentation, "turnId").or_else(|| string_field(presentation, "turn_id"));
        if !turn_id.is_some_and(|id| owning_turns.contains(&id.as_str())) {
            presentation["ensureVisible"] = json!(false);
        }
    }
    presentations
}

fn bind_native_user_presentations(messages: &mut [Value], presentations: &[Value]) {
    for index in 0..messages.len() {
        let message = &messages[index];
        if message["role"] != "user" || message.get("clientUserMessageId").is_some() {
            continue;
        }
        let turn_id = &message["turnId"];
        let users = messages
            .iter()
            .filter(|message| message["role"] == "user" && &message["turnId"] == turn_id)
            .count();
        let owners = presentations
            .iter()
            .filter(|presentation| &presentation["turnId"] == turn_id)
            .collect::<Vec<_>>();
        if users == 1 && owners.len() == 1 {
            if let Some(id) = owners[0].get("clientUserMessageId") {
                messages[index]["clientUserMessageId"] = id.clone();
            }
        }
    }
}

fn attach_user_message_presentations_for_page(
    messages: &mut Vec<Value>,
    presentations: Vec<Value>,
    page_messages: &[Value],
    page_turn_ids: &[String],
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
            None if bool_field(&presentation, "ensureVisible") == Some(true)
                && presentation_belongs_to_transcript_page(
                    &presentation,
                    page_messages,
                    page_turn_ids,
                    has_more_before,
                    has_more_after,
                ) =>
            {
                let content = string_field(&presentation, "content").unwrap_or_default();
                let attachments = normalized_attachments(presentation.get("attachments"));
                if content.trim().is_empty() && attachments.is_empty() {
                    continue;
                }
                let created_at =
                    timestamp_ms_field(&presentation, "createdAt").unwrap_or_else(now_ms);
                let turn_id = string_field(&presentation, "turnId")
                    .or_else(|| string_field(&presentation, "turn_id"));
                let index = turn_id
                    .as_deref()
                    .and_then(|turn_id| {
                        messages.iter().position(|message| {
                            string_field(message, "turnId")
                                .or_else(|| string_field(message, "turn_id"))
                                .or_else(|| string_field(message, "subtaskId"))
                                .or_else(|| string_field(message, "subtask_id"))
                                .as_deref()
                                == Some(turn_id)
                        })
                    })
                    .or_else(|| {
                        messages.iter().position(|message| {
                            timestamp_ms_field(message, "createdAt").is_some_and(|message_at| {
                                message_at > created_at
                                    || (message_at == created_at
                                        && string_field(message, "role").as_deref() != Some("user"))
                            })
                        })
                    })
                    .unwrap_or(messages.len());
                let turn_id = turn_id.or_else(|| {
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
                if !attachments.is_empty() {
                    synthetic["attachments"] = Value::Array(attachments);
                }
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
        let presentation_content = string_field(&presentation, "content").unwrap_or_default();
        let attachments = normalized_attachments(presentation.get("attachments"));
        // Provider input is an execution projection, not the user's presentation.
        // Restore native references even when the host routes a plugin to CLI text.
        let restore_content = bool_field(&presentation, "restoreContent") == Some(true)
            || user_presentation_restores_content(&presentation_content, !attachments.is_empty());
        let references = presentation
            .get("references")
            .and_then(Value::as_array)
            .filter(|_| !restore_content)
            .map(|references| presentation_reference_ranges(references, &content))
            .unwrap_or_default();
        if let Some(message) = message.as_object_mut() {
            if restore_content {
                message.insert("content".to_owned(), Value::String(presentation_content));
                message.remove("presentationReferences");
            }
            if !attachments.is_empty() {
                message.insert("attachments".to_owned(), Value::Array(attachments));
            }
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

fn user_presentation_restores_content(content: &str, has_attachments: bool) -> bool {
    has_attachments
        || local_presentation_reference_descriptors(content)
            .iter()
            .any(|reference| {
                reference["href"].as_str().is_some_and(|href| {
                    is_local_path_reference(href)
                        || href.starts_with("app://")
                        || href.starts_with("plugin://")
                })
            })
}

fn presentation_belongs_to_transcript_page(
    presentation: &Value,
    page_messages: &[Value],
    page_turn_ids: &[String],
    has_more_before: bool,
    has_more_after: bool,
) -> bool {
    if !has_more_before && !has_more_after {
        return true;
    }

    let presentation_turn_id =
        string_field(presentation, "turnId").or_else(|| string_field(presentation, "turn_id"));
    if let Some(presentation_turn_id) = presentation_turn_id {
        return page_turn_ids.contains(&presentation_turn_id)
            || page_messages.iter().any(|message| {
                string_field(message, "turnId")
                    .or_else(|| string_field(message, "turn_id"))
                    .or_else(|| string_field(message, "subtaskId"))
                    .or_else(|| string_field(message, "subtask_id"))
                    .as_deref()
                    == Some(presentation_turn_id.as_str())
            });
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
    crate::prompt_mentions::prompt_mentions(content)
        .into_iter()
        .filter_map(|reference| {
            let name = reference.name()?;
            let token = local_presentation_reference_token(name, &reference.href)?;
            Some(json!({ "token": token, "href": reference.href }))
        })
        .collect()
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
        content[end..].chars().next().map_or(Some(start), |next| {
            (!is_presentation_token_continuation(next)).then_some(start)
        })
    })
}

fn is_presentation_token_continuation(character: char) -> bool {
    character.is_alphanumeric() || matches!(character, '-' | '_' | ':')
}

fn is_local_path_reference(href: &str) -> bool {
    href.starts_with("file://") || href.starts_with("folder://")
}

fn local_presentation_reference_token(name: &str, href: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    if crate::prompt_mentions::is_skill_reference(href) {
        return Some(format!("${}", crate::prompt_mentions::skill_name(name)));
    }
    if is_local_path_reference(href) {
        return Some(format!("${name}"));
    }
    if href.starts_with("app://") {
        return Some(format!("${name}"));
    }
    href.starts_with("plugin://").then(|| format!("@{name}"))
}
