use super::*;

pub(super) fn append_input(
    input: &Value,
    context: &ToolContext,
    messages: &mut Vec<Value>,
) -> Result<(), String> {
    let items: Vec<&Value> = match input {
        Value::Array(values) => values.iter().collect(),
        other => vec![other],
    };
    let mut pending_calls = Vec::new();
    let mut pending_reasoning = String::new();
    let mut call_names = BTreeMap::new();
    let mut pending_tool_image_content = Vec::new();
    let mut last_assistant_index = None;

    for item in items {
        let item_type = item.get("type").and_then(Value::as_str);
        if !is_tool_output_item(item_type)
            && flush_tool_image_content_to_chat(messages, &mut pending_tool_image_content)
        {
            last_assistant_index = None;
        }
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                append_text(&mut pending_reasoning, &reasoning_text(item));
            }
            Some("function_call") | Some("custom_tool_call") | Some("tool_search_call") => {
                let is_tool_search =
                    item.get("type").and_then(Value::as_str) == Some("tool_search_call");
                let name = if is_tool_search {
                    TOOL_SEARCH_NAME
                } else {
                    item.get("name").and_then(Value::as_str).unwrap_or_default()
                };
                let namespace = item.get("namespace").and_then(Value::as_str);
                let wire_name = context.wire_name(namespace, name).unwrap_or(name);
                let call_id = item
                    .get("call_id")
                    .or_else(|| item.get("id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = if is_tool_search {
                    json_string(item.get("arguments"))
                } else if context.is_custom(wire_name)
                    || item.get("type").and_then(Value::as_str) == Some("custom_tool_call")
                {
                    let raw = item
                        .get("input")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    serde_json::to_string(&json!({CUSTOM_TOOL_INPUT_FIELD: raw}))
                        .map_err(|error| error.to_string())?
                } else {
                    json_string(item.get("arguments"))
                };
                call_names.insert(call_id.to_owned(), name.to_owned());
                pending_calls.push(json!({
                    "id": call_id,
                    "type": "function",
                    "function": {"name": wire_name, "arguments": arguments}
                }));
            }
            Some("function_call_output")
            | Some("custom_tool_call_output")
            | Some("tool_search_output") => {
                if let Some(index) =
                    flush_calls(messages, &mut pending_calls, &mut pending_reasoning)
                {
                    last_assistant_index = Some(index);
                }
                append_chat_tool_output(
                    item,
                    &call_names,
                    messages,
                    &mut pending_tool_image_content,
                );
            }
            _ => {
                if let Some(index) =
                    flush_calls(messages, &mut pending_calls, &mut pending_reasoning)
                {
                    last_assistant_index = Some(index);
                }
                if item.is_string() {
                    attach_pending_reasoning_to_previous_assistant(
                        messages,
                        last_assistant_index,
                        &mut pending_reasoning,
                    );
                    messages.push(json!({"role": "user", "content": item}));
                    last_assistant_index = None;
                } else if item.get("role").is_some() || item.get("content").is_some() {
                    let role = match item.get("role").and_then(Value::as_str) {
                        Some("developer") | Some("system") => "system",
                        Some("assistant") => "assistant",
                        _ => "user",
                    };
                    if role == "assistant" {
                        append_text(&mut pending_reasoning, &message_reasoning_text(item));
                    } else {
                        attach_pending_reasoning_to_previous_assistant(
                            messages,
                            last_assistant_index,
                            &mut pending_reasoning,
                        );
                    }
                    let mut message = json!({
                        "role": role,
                        "content": chat_content(item.get("content").unwrap_or(&Value::Null))
                    });
                    if role == "assistant" && !pending_reasoning.is_empty() {
                        message["reasoning_content"] =
                            Value::String(std::mem::take(&mut pending_reasoning));
                    }
                    last_assistant_index = (role == "assistant").then_some(messages.len());
                    messages.push(message);
                }
            }
        }
    }
    if let Some(index) = flush_calls(messages, &mut pending_calls, &mut pending_reasoning) {
        last_assistant_index = Some(index);
    }
    if flush_tool_image_content_to_chat(messages, &mut pending_tool_image_content) {
        last_assistant_index = None;
    }
    attach_pending_reasoning_to_previous_assistant(
        messages,
        last_assistant_index,
        &mut pending_reasoning,
    );
    Ok(())
}

pub(super) fn append_chat_tool_output(
    item: &Value,
    call_names: &BTreeMap<String, String>,
    messages: &mut Vec<Value>,
    pending_tool_image_content: &mut Vec<Value>,
) {
    let call_id = item
        .get("call_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut output = if item.get("type").and_then(Value::as_str) == Some("tool_search_output") {
        ToolOutput {
            text: serde_json::to_string(&json!({
                "tools": item.get("tools").cloned().unwrap_or_else(|| json!([]))
            }))
            .unwrap_or_else(|_| "{\"tools\":[]}".to_owned()),
            images: Vec::new(),
        }
    } else {
        item.get("output")
            .map(split_tool_output)
            .unwrap_or_default()
    };
    let tool_name = call_names.get(call_id).map(String::as_str);
    if tool_name == Some("apply_patch") {
        output.text = friendly_apply_patch_output(&output.text);
    }
    let has_images = !output.images.is_empty();
    if has_images {
        append_tool_image_content(pending_tool_image_content, tool_name, output.images);
    }
    if has_images && output.text.is_empty() {
        output.text = tool_image_output_notice().to_owned();
    }
    messages.push(json!({"role": "tool", "tool_call_id": call_id, "content": output.text}));
}

pub(crate) fn friendly_apply_patch_output(output: &str) -> String {
    let lower = output.to_ascii_lowercase();
    if !lower.contains("apply_patch")
        || !(lower.contains("failed")
            || lower.contains("error")
            || lower.contains("invalid")
            || lower.contains("could not"))
    {
        return output.to_owned();
    }

    let diagnosis = if lower.contains("invalid hunk") || lower.contains("hunk header") {
        "The patch contains an invalid hunk. After `*** Update File`, start a hunk with `@@` (optionally followed by context text), then prefix unchanged lines with one space, removed lines with `-`, and added lines with `+`."
    } else if lower.contains("add file") {
        "For `*** Add File`, every file-content line must start with `+`, including blank lines (write a line containing only `+`)."
    } else if lower.contains("begin patch") || lower.contains("end patch") {
        "The input must start with `*** Begin Patch`, end with `*** End Patch`, and contain no Markdown fence or prose outside those markers."
    } else if lower.contains("context") || lower.contains("does not match") {
        "The update context did not match the current file. Read the relevant file section again and build a smaller hunk using the exact current lines."
    } else {
        "Use the exact apply_patch grammar and correct the specific error reported above."
    };

    format!(
        "{output}\n\nThe patch was not applied. {diagnosis}\n\nCorrect update example:\n*** Begin Patch\n*** Update File: path/to/file.txt\n@@\n-old line\n+new line\n*** End Patch\n\nCorrect new-file example:\n*** Begin Patch\n*** Add File: path/to/new-file.txt\n+first line\n+\n+third line\n*** End Patch\n\nFix the reported error and call `apply_patch` again. Do not switch to shell redirection, `cat`, Python, or another file-writing workaround."
    )
}

pub(super) fn flush_calls(
    messages: &mut Vec<Value>,
    calls: &mut Vec<Value>,
    reasoning: &mut String,
) -> Option<usize> {
    if calls.is_empty() {
        return None;
    }
    let calls = std::mem::take(calls);
    if let Some(last) = messages
        .last_mut()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    {
        if let Some(existing) = last.get_mut("tool_calls").and_then(Value::as_array_mut) {
            existing.extend(calls);
        } else {
            last["tool_calls"] = Value::Array(calls);
        }
        merge_reasoning_content(last, reasoning);
        return Some(messages.len() - 1);
    }
    let mut message = json!({
        "role": "assistant",
        "content": Value::Null,
        "tool_calls": calls
    });
    merge_reasoning_content(&mut message, reasoning);
    let index = messages.len();
    messages.push(message);
    Some(index)
}

pub(super) fn merge_reasoning_content(message: &mut Value, reasoning: &mut String) {
    if reasoning.is_empty() {
        return;
    }
    let mut combined = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    append_text(&mut combined, &std::mem::take(reasoning));
    message["reasoning_content"] = Value::String(combined);
}

pub(super) fn attach_pending_reasoning_to_previous_assistant(
    messages: &mut [Value],
    last_assistant_index: Option<usize>,
    reasoning: &mut String,
) {
    if reasoning.trim().is_empty() {
        return;
    }
    let Some(message) = last_assistant_index.and_then(|index| messages.get_mut(index)) else {
        reasoning.clear();
        return;
    };
    merge_reasoning_content(message, reasoning);
}

pub(super) fn backfill_kimi_tool_call_reasoning(messages: &mut [Value]) {
    for message in messages {
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| !calls.is_empty());
        if message.get("role").and_then(Value::as_str) != Some("assistant") || !has_tool_calls {
            continue;
        }
        let has_reasoning = message
            .get("reasoning_content")
            .and_then(Value::as_str)
            .is_some_and(|reasoning| !reasoning.trim().is_empty());
        if !has_reasoning {
            message["reasoning_content"] = Value::String("tool call".to_owned());
        }
    }
}

pub(super) fn chat_content(content: &Value) -> Value {
    match content {
        Value::String(_) => content.clone(),
        Value::Array(parts) => {
            let converted = parts
                .iter()
                .filter_map(|part| {
                    match part.get("type").and_then(Value::as_str) {
                    Some("input_text") | Some("output_text") | Some("text") => Some(json!({
                        "type": "text",
                        "text": part.get("text").and_then(Value::as_str).unwrap_or_default()
                    })),
                    Some("input_image") => part.get("image_url").map(|url| json!({
                        "type": "image_url",
                        "image_url": if url.is_string() { json!({"url": url}) } else { url.clone() }
                    })),
                    _ => None,
                }
                })
                .collect::<Vec<_>>();
            if converted.len() == 1 && converted[0].get("type") == Some(&json!("text")) {
                converted[0].get("text").cloned().unwrap_or(Value::Null)
            } else {
                Value::Array(converted)
            }
        }
        _ => Value::Null,
    }
}

pub(super) fn collapse_system_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut system = Vec::new();
    let mut rest = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            let text = text_value(message.get("content").unwrap_or(&Value::Null));
            if !text.is_empty() {
                system.push(text);
            }
        } else {
            rest.push(message);
        }
    }
    if system.is_empty() {
        rest
    } else {
        let mut result = vec![json!({"role": "system", "content": system.join("\n\n")})];
        result.extend(rest);
        result
    }
}

pub(super) fn reasoning_text(item: &Value) -> String {
    item.get("summary")
        .or_else(|| item.get("content"))
        .map(text_value)
        .unwrap_or_default()
}

pub(super) fn message_reasoning_text(item: &Value) -> String {
    [
        "reasoning_content",
        "reasoning",
        "reasoning_text",
        "reasoning_details",
    ]
    .iter()
    .find_map(|field| item.get(*field))
    .map(text_value)
    .unwrap_or_default()
}

pub(super) fn text_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(text_value)
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => object
            .get("text")
            .or_else(|| object.get("content"))
            .map(text_value)
            .unwrap_or_else(|| value.to_string()),
        Value::Null => String::new(),
        _ => value.to_string(),
    }
}

pub(super) fn split_tool_output(value: &Value) -> ToolOutput {
    let structured_content = value
        .get("structuredContent")
        .or_else(|| value.get("structured_content"))
        .filter(|value| !value.is_null());
    let content = value
        .as_array()
        .or_else(|| value.get("content").and_then(Value::as_array));
    let images = content
        .into_iter()
        .flatten()
        .filter(|part| is_tool_output_image(part))
        .cloned()
        .collect::<Vec<_>>();
    let text = if let Some(structured_content) = structured_content {
        json_string(Some(structured_content))
    } else if let Some(content) = content {
        content
            .iter()
            .filter(|part| !is_tool_output_image(part))
            .map(text_value)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        text_value(value)
    };
    ToolOutput { text, images }
}

pub(super) fn is_tool_output_image(part: &Value) -> bool {
    if part.get("type").and_then(Value::as_str) != Some("input_image") {
        return false;
    }
    part.get("image_url").is_some_and(|image_url| {
        image_url
            .as_str()
            .or_else(|| image_url.get("url").and_then(Value::as_str))
            .is_some_and(|url| !url.is_empty())
    })
}

pub(super) fn tool_image_output_notice() -> &'static str {
    "[Image output attached in the following user message.]"
}

pub(super) fn append_tool_image_content(
    pending_content: &mut Vec<Value>,
    tool_name: Option<&str>,
    images: Vec<Value>,
) {
    let label = tool_name
        .filter(|name| !name.is_empty())
        .map(|name| format!("Image output from tool {name}:"))
        .unwrap_or_else(|| "Image output from tool:".to_owned());
    pending_content.push(json!({"type": "input_text", "text": label}));
    pending_content.extend(images);
}

pub(super) fn flush_tool_image_content_to_chat(
    messages: &mut Vec<Value>,
    pending_content: &mut Vec<Value>,
) -> bool {
    if pending_content.is_empty() {
        return false;
    }
    let content = chat_content(&Value::Array(std::mem::take(pending_content)));
    messages.push(json!({
        "role": "user",
        "content": content
    }));
    true
}

pub(super) fn flush_tool_image_content_to_responses(
    input: &mut Vec<Value>,
    pending_content: &mut Vec<Value>,
) {
    if !pending_content.is_empty() {
        input.push(json!({
            "type": "message",
            "role": "user",
            "content": std::mem::take(pending_content)
        }));
    }
}

pub(super) fn json_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned()),
        None => "{}".to_owned(),
    }
}

pub(super) fn append_text(target: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push_str("\n\n");
    }
    target.push_str(value);
}
