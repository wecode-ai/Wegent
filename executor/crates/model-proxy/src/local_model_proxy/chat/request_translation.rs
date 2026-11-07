use super::*;

pub(crate) fn responses_to_chat_with_model_hint(
    body: &Value,
    model_hint: Option<&str>,
) -> Result<(Value, ToolContext), String> {
    responses_to_chat_with_namespace_mode(body, model_hint, true, true)
}

pub(crate) fn responses_to_chat_for_anthropic(
    body: &Value,
) -> Result<(Value, ToolContext), String> {
    responses_to_chat_with_namespace_mode(body, None, false, false)
}

pub(super) fn responses_to_chat_with_namespace_mode(
    body: &Value,
    model_hint: Option<&str>,
    preserve_namespace: bool,
    enable_kimi_k3_compat: bool,
) -> Result<(Value, ToolContext), String> {
    let mut result = Map::new();
    copy_field(body, &mut result, "model", "model");
    let tools = effective_tools(body);
    let context = build_tool_context(&tools, preserve_namespace);
    let mut messages = Vec::new();

    if let Some(instructions) = body.get("instructions") {
        let text = text_value(instructions);
        if !text.is_empty() {
            messages.push(json!({"role": "system", "content": text}));
        }
    }
    if let Some(input) = body.get("input") {
        append_input(input, &context, &mut messages)?;
    }
    let kimi_k3_compat = enable_kimi_k3_compat && request_uses_kimi_k3(body, model_hint);
    if kimi_k3_compat {
        backfill_kimi_tool_call_reasoning(&mut messages);
    }
    result.insert(
        "messages".to_owned(),
        Value::Array(collapse_system_messages(messages)),
    );

    if let Some(max_tokens) = body
        .get("max_output_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .or_else(|| body.get("max_tokens"))
    {
        result.insert("max_tokens".to_owned(), max_tokens.clone());
    }
    for field in [
        "temperature",
        "top_p",
        "stream",
        "parallel_tool_calls",
        "service_tier",
        "stop",
        "user",
    ] {
        copy_field(body, &mut result, field, field);
    }
    if body.get("stream").and_then(Value::as_bool) == Some(true) {
        result.insert("stream_options".to_owned(), json!({"include_usage": true}));
    }
    apply_reasoning_options(body, &mut result, kimi_k3_compat);

    let converted_tools = chat_tools(&tools, &context, kimi_k3_compat);
    if !converted_tools.is_empty() {
        result.insert("tools".to_owned(), Value::Array(converted_tools));
        if let Some(choice) = body.get("tool_choice") {
            if choice != "auto" {
                result.insert("tool_choice".to_owned(), chat_tool_choice(choice, &context));
            }
        }
    }
    Ok((Value::Object(result), context))
}

pub(super) fn copy_field(
    body: &Value,
    result: &mut Map<String, Value>,
    source: &str,
    target: &str,
) {
    if let Some(value) = body.get(source) {
        result.insert(target.to_owned(), value.clone());
    }
}
