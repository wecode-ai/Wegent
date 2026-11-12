use super::*;

pub(super) fn normalize_responses_stream<S, E>(
    stream: S,
    expanded_browser_tools: HashSet<String>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: ToString,
{
    let state = ResponsesStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        pending_utf8: Vec::new(),
        output: VecDeque::new(),
        source_done: false,
        terminal_seen: false,
        expanded_browser_tools,
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
                    Ok(responses_failed_event(
                        "Upstream Responses stream ended before a terminal event",
                    )),
                    state,
                ));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) =
                        append_stream_utf8(&mut state.pending, &mut state.pending_utf8, &bytes)
                    {
                        state.source_done = true;
                        state.terminal_seen = true;
                        return Some((Ok(responses_failed_event(&error.to_string())), state));
                    }
                    while let Some(event) = take_sse_block(&mut state.pending) {
                        state.terminal_seen |= is_responses_terminal_event(&event);
                        let normalized = if state.expanded_browser_tools.is_empty() {
                            normalize_responses_event(&event)
                        } else {
                            let rewritten =
                                rewrite_responses_event(&event, &state.expanded_browser_tools);
                            normalize_responses_event(&rewritten)
                        };
                        log_responses_event_diagnostics(&normalized);
                        state
                            .output
                            .push_back(Ok(Bytes::from(format!("{}\n\n", normalized))));
                    }
                }
                Some(Err(error)) => {
                    state.source_done = true;
                    state.terminal_seen = true;
                    return Some((Ok(responses_failed_event(&error.to_string())), state));
                }
                None => {
                    state.source_done = true;
                    if let Err(error) = finish_stream_utf8(&state.pending_utf8) {
                        state.terminal_seen = true;
                        return Some((Ok(responses_failed_event(&error.to_string())), state));
                    }
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        let trailing = trailing.trim_end();
                        state.terminal_seen |= is_responses_terminal_event(trailing);
                        let normalized = normalize_responses_event(trailing);
                        log_responses_event_diagnostics(&normalized);
                        state
                            .output
                            .push_back(Ok(Bytes::from(format!("{}\n\n", normalized))));
                    }
                }
            }
        }
    })
}

pub(super) fn log_responses_event_diagnostics(event: &str) {
    for diagnostic in responses_event_diagnostics(event) {
        match diagnostic {
            ResponsesEventDiagnostic::ToolCall {
                phase,
                tool_name,
                namespace,
                custom_tool,
                arguments_bytes,
            } => {
                log_executor_event(
                    &format!("local model proxy responses tool call {phase}"),
                    &[
                        ("tool_name", tool_name),
                        ("namespace", namespace),
                        ("custom_tool", custom_tool.to_string()),
                        ("arguments_bytes", arguments_bytes.to_string()),
                    ],
                );
            }
            ResponsesEventDiagnostic::Terminal {
                status,
                output_items,
                tool_calls,
                empty_output,
            } => {
                log_executor_event(
                    "local model proxy responses completion summary",
                    &[
                        ("status", status),
                        ("output_items", output_items.to_string()),
                        ("tool_calls", tool_calls.to_string()),
                        ("empty_output", empty_output.to_string()),
                    ],
                );
            }
        }
    }
}

pub(super) fn responses_event_diagnostics(event: &str) -> Vec<ResponsesEventDiagnostic> {
    let mut diagnostics = Vec::new();
    for value in responses_event_values(event) {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let phase = match event_type {
            "response.output_item.added" => Some("started"),
            "response.output_item.done" => Some("completed"),
            _ => None,
        };
        if let Some(phase) = phase {
            if let Some(item) = value.get("item") {
                let item_type = item.get("type").and_then(Value::as_str);
                if matches!(
                    item_type,
                    Some("function_call" | "custom_tool_call" | "tool_search_call")
                ) {
                    diagnostics.push(ResponsesEventDiagnostic::ToolCall {
                        phase,
                        tool_name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        namespace: item
                            .get("namespace")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        custom_tool: item_type == Some("custom_tool_call"),
                        arguments_bytes: item
                            .get("arguments")
                            .or_else(|| item.get("input"))
                            .and_then(Value::as_str)
                            .map_or(0, str::len),
                    });
                }
            }
        }
        if matches!(
            event_type,
            "response.completed" | "response.failed" | "response.incomplete"
        ) {
            let output = value
                .pointer("/response/output")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            diagnostics.push(ResponsesEventDiagnostic::Terminal {
                status: value
                    .pointer("/response/status")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| event_type.trim_start_matches("response."))
                    .to_owned(),
                output_items: output.len(),
                tool_calls: output
                    .iter()
                    .filter(|item| {
                        matches!(
                            item.get("type").and_then(Value::as_str),
                            Some("function_call" | "custom_tool_call" | "tool_search_call")
                        )
                    })
                    .count(),
                empty_output: output.is_empty(),
            });
        }
    }
    diagnostics
}

pub(super) fn responses_event_values(event: &str) -> Vec<Value> {
    sse::blocks(event).filter_map(sse::json).collect()
}

pub(crate) fn is_responses_terminal_event(event: &str) -> bool {
    sse::json(event).is_some_and(|value| {
        matches!(
            value.get("type").and_then(Value::as_str),
            Some("response.completed" | "response.failed" | "response.incomplete")
        )
    })
}

pub(crate) fn responses_failed_event(message: &str) -> Bytes {
    Bytes::from(format!(
        "event: response.failed\ndata: {}\n\n",
        json!({
            "type": "response.failed",
            "response": {
                "id": "resp_wework_proxy_failed",
                "object": "response",
                "status": "failed",
                "output": [],
                "error": {"type": "upstream_error", "message": message}
            }
        })
    ))
}

pub(super) fn normalize_responses_event(event: &str) -> String {
    let Some(mut value) = sse::json(event) else {
        return event.to_owned();
    };
    let completed = value.get("type").and_then(Value::as_str) == Some("response.completed");
    normalize_completed_usage(&mut value);
    let overload_error_normalized = normalize_retryable_overload_error(&mut value);
    if completed || overload_error_normalized {
        sse::rewrite_data(event, &value)
    } else {
        event.to_owned()
    }
}

pub(super) fn rewrite_responses_event(event: &str, expanded: &HashSet<String>) -> String {
    if expanded.is_empty() {
        return event.to_owned();
    }
    let Some(mut value) = sse::json(event) else {
        return event.to_owned();
    };
    let original = value.clone();
    codex_responses_proxy_transform::rewrite_wework_browser_function_calls(&mut value, expanded);
    if value == original {
        event.to_owned()
    } else {
        sse::rewrite_data(event, &value)
    }
}

pub(super) fn normalize_completed_usage(value: &mut Value) {
    if value.get("type").and_then(Value::as_str) != Some("response.completed") {
        return;
    }
    let Some(usage) = value
        .pointer_mut("/response/usage")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    ensure_usage_detail(usage, "input_tokens_details", "cached_tokens");
    ensure_usage_detail(usage, "output_tokens_details", "reasoning_tokens");
}

pub(super) fn normalize_retryable_overload_error(value: &mut Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("response.failed") {
        return false;
    }
    let Some(error) = value
        .pointer_mut("/response/error")
        .and_then(Value::as_object_mut)
    else {
        return false;
    };
    let retryable = error
        .get("code")
        .and_then(Value::as_str)
        .is_some_and(|code| matches!(code, "server_is_overloaded" | "slow_down"));
    if retryable {
        // Codex treats these codes as terminal, while other response failures
        // use its bounded stream retry loop.
        error.insert(
            "code".to_owned(),
            Value::String("server_overloaded_retryable".to_owned()),
        );
    }
    retryable
}

pub(super) fn ensure_usage_detail(usage: &mut Map<String, Value>, details_key: &str, field: &str) {
    match usage.get_mut(details_key) {
        Some(Value::Object(details)) => {
            details.entry(field.to_owned()).or_insert(Value::from(0));
        }
        Some(Value::Null) | None => {}
        Some(_) => {
            usage.insert(details_key.to_owned(), Value::Null);
        }
    }
}
