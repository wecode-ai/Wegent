use super::*;

pub(super) fn extract_custom_tool_input(arguments: &str) -> Option<String> {
    if let Ok(value) = serde_json::from_str::<Value>(arguments) {
        if let Some(input) = value.get(CUSTOM_TOOL_INPUT_FIELD).cloned() {
            return match input {
                Value::String(text) => Some(text),
                other => serde_json::to_string(&other).ok(),
            };
        }
    }
    Some(arguments.to_owned())
}

pub(super) fn restore_responses_tool_item(
    item: &mut Value,
    identity: &ToolIdentity,
    arguments: Option<&str>,
) {
    if matches!(identity.kind, ToolKind::Custom | ToolKind::Function) {
        item["name"] = Value::String(identity.name.clone());
        if let Some(namespace) = &identity.namespace {
            item["namespace"] = Value::String(namespace.clone());
        }
    }
    match identity.kind {
        ToolKind::Custom => {
            item["type"] = Value::String("custom_tool_call".to_owned());
            let input = arguments.and_then(extract_custom_tool_input).or_else(|| {
                item.get("arguments")
                    .and_then(Value::as_str)
                    .and_then(extract_custom_tool_input)
            });
            if let Some(input) = input {
                item["input"] = Value::String(input);
            }
            if let Some(object) = item.as_object_mut() {
                object.remove("arguments");
            }
        }
        ToolKind::ToolSearch => {
            item["type"] = Value::String("tool_search_call".to_owned());
            item["execution"] = Value::String("client".to_owned());
            let raw_arguments = arguments.map(str::to_owned).or_else(|| {
                item.get("arguments")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
            let parsed_arguments = raw_arguments
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok());
            if parsed_arguments.is_none() {
                if let Some(raw_arguments) = raw_arguments.as_deref() {
                    log_executor_event(
                        "local model proxy invalid tool search arguments",
                        &[("arguments_bytes", raw_arguments.len().to_string())],
                    );
                }
            }
            let arguments = parsed_arguments.unwrap_or_else(|| json!({}));
            item["arguments"] = arguments;
            if let Some(object) = item.as_object_mut() {
                object.remove("name");
            }
        }
        ToolKind::Function => {}
    }
}

/// Transform a Responses API SSE stream back into Codex-native tool events.
pub(crate) fn responses_sse_to_responses<S, E>(
    stream: S,
    context: ToolContext,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    use std::collections::VecDeque;

    let state = ResponsesStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        pending_utf8: Vec::new(),
        output: VecDeque::new(),
        context_state: ResponsesToolState {
            context,
            calls: HashMap::new(),
        },
        source_done: false,
        terminal_seen: false,
    };

    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            if state.terminal_seen {
                return None;
            }
            if state.source_done {
                state.terminal_seen = true;
                return Some((
                    Ok(crate::local_model_proxy::responses_failed_event(
                        "Upstream Responses stream ended before a terminal event",
                    )),
                    state,
                ));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) = crate::local_model_proxy::append_stream_utf8(
                        &mut state.pending,
                        &mut state.pending_utf8,
                        &bytes,
                    ) {
                        state.source_done = true;
                        state.terminal_seen = true;
                        return Some((
                            Ok(crate::local_model_proxy::responses_failed_event(
                                &error.to_string(),
                            )),
                            state,
                        ));
                    }
                    while let Some(block) =
                        crate::local_model_proxy::take_sse_block(&mut state.pending)
                    {
                        if crate::local_model_proxy::is_responses_terminal_event(&block) {
                            state.terminal_seen = true;
                        }
                        let rewritten =
                            rewrite_responses_sse_block(&block, &mut state.context_state);
                        if let Some(rewritten) = rewritten {
                            if !rewritten.is_empty() {
                                state
                                    .output
                                    .push_back(Ok(Bytes::from(format!("{}\n\n", rewritten))));
                            }
                        } else {
                            state
                                .output
                                .push_back(Ok(Bytes::from(format!("{}\n\n", block))));
                        }
                    }
                }
                Some(Err(error)) => {
                    state.source_done = true;
                    state.terminal_seen = true;
                    return Some((
                        Ok(crate::local_model_proxy::responses_failed_event(
                            &error.to_string(),
                        )),
                        state,
                    ));
                }
                None => {
                    state.source_done = true;
                    if let Err(error) =
                        crate::local_model_proxy::finish_stream_utf8(&state.pending_utf8)
                    {
                        state.terminal_seen = true;
                        return Some((
                            Ok(crate::local_model_proxy::responses_failed_event(
                                &error.to_string(),
                            )),
                            state,
                        ));
                    }
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        let trailing = trailing.trim_end();
                        if crate::local_model_proxy::is_responses_terminal_event(trailing) {
                            state.terminal_seen = true;
                        }
                        let rewritten =
                            rewrite_responses_sse_block(trailing, &mut state.context_state);
                        if let Some(rewritten) = rewritten {
                            if !rewritten.is_empty() {
                                state
                                    .output
                                    .push_back(Ok(Bytes::from(format!("{}\n\n", rewritten))));
                            }
                        } else {
                            state
                                .output
                                .push_back(Ok(Bytes::from(format!("{}\n\n", trailing))));
                        }
                    }
                }
            }
        }
    })
}

pub(super) fn rewrite_responses_sse_block(
    block: &str,
    state: &mut ResponsesToolState,
) -> Option<String> {
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<&str> = Vec::new();
    for raw_line in block.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim_start();
        if let Some(value) = line.strip_prefix("event:") {
            event_name = Some(value.trim().to_owned());
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start());
        }
    }
    if data_lines.is_empty() {
        return None;
    }
    let data = data_lines.join("\n");
    let data = data.trim();
    let mut value = serde_json::from_str::<Value>(data).ok()?;
    let ids_normalized = normalize_responses_stream_ids(&mut value);

    let rewritten = match event_name.as_deref() {
        Some("response.output_item.added") => {
            if let Some(item) = value.get_mut("item") {
                if let Some(identity) = state.bridged_identity(item) {
                    let item_id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned();
                    state.start_call(&item_id, identity.clone());
                    restore_responses_tool_item(item, &identity, None);
                }
            }
            rewrite_event_data(block, &value)
        }
        Some("response.function_call_arguments.delta") => {
            let item_id = value
                .get("item_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                state.append_arguments(&item_id, delta);
            }
            if state.identity(&item_id).is_some_and(|identity| {
                matches!(identity.kind, ToolKind::Custom | ToolKind::ToolSearch)
            }) {
                // Codex's custom and tool-search calls do not consume standard
                // function argument delta events.
                return Some(String::new());
            }
            None
        }
        Some("response.function_call_arguments.done") => {
            let item_id = value
                .get("item_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let arguments = value.get("arguments").and_then(Value::as_str);
            state.finish_arguments(&item_id, arguments);
            if state
                .identity(&item_id)
                .is_some_and(|identity| identity.kind == ToolKind::Custom)
            {
                let input = state.custom_input(&item_id).unwrap_or_default();
                let output_index = value.get("output_index").cloned().unwrap_or(Value::Null);
                let mut events = String::new();
                events.push_str(&format_sse_event(
                    "response.custom_tool_call_input.delta",
                    &json!({
                        "type": "response.custom_tool_call_input.delta",
                        "item_id": item_id,
                        "output_index": output_index,
                        "delta": input,
                    }),
                ));
                events.push_str(&format_sse_event(
                    "response.custom_tool_call_input.done",
                    &json!({
                        "type": "response.custom_tool_call_input.done",
                        "item_id": item_id,
                        "output_index": output_index,
                        "input": input,
                    }),
                ));
                return Some(events);
            }
            if state
                .identity(&item_id)
                .is_some_and(|identity| identity.kind == ToolKind::ToolSearch)
            {
                return Some(String::new());
            }
            None
        }
        Some("response.output_item.done") => {
            if let Some(item) = value.get_mut("item") {
                let item_id = item
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let identity = state
                    .identity(&item_id)
                    .cloned()
                    .or_else(|| state.bridged_identity(item));
                if let Some(identity) = identity {
                    let arguments = state.arguments(&item_id);
                    restore_responses_tool_item(item, &identity, arguments);
                }
            }
            rewrite_event_data(block, &value)
        }
        Some("response.completed") => {
            if let Some(response) = value.get_mut("response") {
                if let Some(output) = response.get_mut("output").and_then(Value::as_array_mut) {
                    for item in output {
                        let item_id = item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned();
                        let identity = state
                            .identity(&item_id)
                            .cloned()
                            .or_else(|| state.bridged_identity(item));
                        if let Some(identity) = identity {
                            let arguments = state.arguments(&item_id);
                            restore_responses_tool_item(item, &identity, arguments);
                        }
                    }
                }
            }
            rewrite_event_data(block, &value)
        }
        _ => None,
    };

    rewritten
        .or_else(|| {
            ids_normalized
                .then(|| rewrite_event_data(block, &value))
                .flatten()
        })
        .or_else(|| Some(block.to_owned()))
}

pub(super) fn normalize_responses_stream_ids(value: &mut Value) -> bool {
    let mut normalized = normalize_id_field(value, "item_id");
    normalized |= normalize_id_field(value, "call_id");

    if let Some(item) = value.get_mut("item") {
        normalized |= normalize_responses_item_ids(item);
    }
    if let Some(output) = value
        .pointer_mut("/response/output")
        .and_then(Value::as_array_mut)
    {
        for item in output {
            normalized |= normalize_responses_item_ids(item);
        }
    }
    normalized
}

pub(super) fn normalize_responses_item_ids(item: &mut Value) -> bool {
    normalize_id_field(item, "id") | normalize_id_field(item, "call_id")
}

pub(super) fn normalize_id_field(value: &mut Value, field: &str) -> bool {
    let Some(id) = value.get(field).and_then(Value::as_str) else {
        return false;
    };
    let normalized = crate::local_model_proxy::normalized_responses_api_id(id);
    if normalized != id {
        value[field] = Value::String(normalized);
        return true;
    }
    false
}

pub(super) fn format_sse_event(event: &str, data: &Value) -> String {
    format!(
        "event: {}\ndata: {}\n\n",
        event,
        serde_json::to_string(data).unwrap_or_default()
    )
}

pub(super) fn rewrite_event_data(block: &str, value: &Value) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut replaced = false;
    for raw_line in block.lines() {
        let line = raw_line.trim_start_matches('\u{feff}').trim_start();
        if let Some(data) = line.strip_prefix("data:") {
            if !replaced {
                lines.push(format!(
                    "data: {}",
                    serde_json::to_string(value).unwrap_or_else(|_| data.trim_start().to_owned())
                ));
                replaced = true;
                continue;
            }
        }
        lines.push(raw_line.to_owned());
    }
    Some(lines.join("\n"))
}

pub(crate) fn chat_sse_to_responses<S, E>(
    stream: S,
    context: ToolContext,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: std::error::Error + Send + 'static,
{
    let state = ChatStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        pending_utf8: Vec::new(),
        output: std::collections::VecDeque::new(),
        context,
        response_started: false,
        completed: false,
        response_id: "resp_wework_chat".to_owned(),
        model: String::new(),
        created_at: 0,
        next_output_index: 0,
        text: TextState::default(),
        reasoning: ReasoningState::default(),
        calls: BTreeMap::new(),
        usage: responses_usage(None),
        finish_reason: None,
        saw_done: false,
        saw_choice: false,
    };

    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) = crate::local_model_proxy::append_stream_utf8(
                        &mut state.pending,
                        &mut state.pending_utf8,
                        &bytes,
                    ) {
                        let event = state.failed_event(error.to_string());
                        state.completed = true;
                        return Some((Ok(event), state));
                    }
                    while let Some(block) =
                        crate::local_model_proxy::take_sse_block(&mut state.pending)
                    {
                        state.handle_block(&block, true);
                    }
                }
                Some(Err(error)) => {
                    let event = state.failed_event(error.to_string());
                    state.completed = true;
                    return Some((Ok(event), state));
                }
                None => {
                    if state.completed {
                        return None;
                    }
                    if let Err(error) =
                        crate::local_model_proxy::finish_stream_utf8(&state.pending_utf8)
                    {
                        let event = state.failed_event(error.to_string());
                        state.completed = true;
                        return Some((Ok(event), state));
                    }
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        state.handle_block(&trailing, false);
                    }
                    if state.response_started && state.finish_reason.is_none() && !state.saw_done {
                        let event = state.failed_event(
                            "Upstream stream ended before a finish reason or [DONE] marker"
                                .to_owned(),
                        );
                        state.completed = true;
                        state.emit(event);
                    } else {
                        state.finish();
                    }
                    if let Some(output) = state.output.pop_front() {
                        return Some((output, state));
                    }
                    return None;
                }
            }
        }
    })
}
