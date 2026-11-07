use super::*;

pub(super) fn reasoning_delta(delta: &Value) -> Option<String> {
    if let Some(value) = ["reasoning_content", "reasoning", "reasoning_text"]
        .iter()
        .find_map(|field| delta.get(*field))
    {
        let text = text_value(value);
        if !text.is_empty() {
            return Some(text);
        }
    }
    delta
        .get("reasoning_details")
        .map(text_value)
        .filter(|value| !value.is_empty())
}

pub(super) fn content_delta(payload: &Value) -> Option<String> {
    let mut content = payload.get("content").map(text_value).unwrap_or_default();
    if let Some(refusal) = payload.get("refusal").and_then(Value::as_str) {
        content.push_str(refusal);
    }
    (!content.is_empty()).then_some(content)
}

pub(super) fn snapshot_suffix<'a>(existing: &str, snapshot: &'a str) -> &'a str {
    snapshot.strip_prefix(existing).unwrap_or(snapshot)
}

pub(super) fn meaningful_error_message(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => (!value.trim().is_empty()).then(|| value.clone()),
        Value::Object(object) => ["message", "detail", "error_description", "type"]
            .iter()
            .find_map(|key| object.get(*key).and_then(meaningful_error_message))
            .or_else(|| object.get("error").and_then(meaningful_error_message)),
        Value::Array(values) => values.iter().find_map(meaningful_error_message),
        _ => None,
    }
}

pub(super) fn custom_input(tool_name: &str, arguments: &str) -> String {
    let parsed = serde_json::from_str::<Value>(arguments).ok();
    let input_field = parsed.as_ref().and_then(|value| {
        [CUSTOM_TOOL_INPUT_FIELD, "patch", "content"]
            .iter()
            .find(|field| value.get(**field).and_then(Value::as_str).is_some())
            .copied()
    });
    let input = input_field
        .and_then(|field| parsed.as_ref()?.get(field)?.as_str().map(str::to_owned))
        .unwrap_or_else(|| arguments.to_owned());
    if tool_name == "apply_patch" {
        let normalized = normalize_apply_patch_input(&input);
        log_apply_patch_diagnostics(arguments, input_field, &input, &normalized);
        normalized
    } else {
        input
    }
}

pub(super) fn log_apply_patch_diagnostics(
    arguments: &str,
    input_field: Option<&str>,
    input: &str,
    normalized: &str,
) {
    let trimmed = input.trim();
    let first_line = trimmed.lines().next().unwrap_or_default();
    let first_line_kind = if first_line == "*** Begin Patch" {
        "begin_patch"
    } else if first_line.starts_with("```") {
        "markdown_fence"
    } else if first_line.starts_with("*** Add File:")
        || first_line.starts_with("*** Update File:")
        || first_line.starts_with("*** Delete File:")
    {
        "file_directive"
    } else if first_line.is_empty() {
        "empty"
    } else {
        "other"
    };
    let begin = trimmed.find("*** Begin Patch");
    let end = trimmed.find("*** End Patch");
    let action = if normalized == input {
        "unchanged"
    } else if begin.is_some() && end.is_some() {
        "extracted_envelope"
    } else if first_line.starts_with("```") {
        "removed_fence_and_added_envelope"
    } else {
        "added_envelope"
    };
    log_executor_event(
        "local model proxy apply_patch normalized",
        &[
            ("arguments_bytes", arguments.len().to_string()),
            (
                "json_parsed",
                serde_json::from_str::<Value>(arguments).is_ok().to_string(),
            ),
            ("input_field", input_field.unwrap_or("raw").to_owned()),
            ("input_bytes", input.len().to_string()),
            ("first_line_kind", first_line_kind.to_owned()),
            (
                "begin_offset",
                begin.map_or_else(|| "none".to_owned(), |value| value.to_string()),
            ),
            (
                "end_offset",
                end.map_or_else(|| "none".to_owned(), |value| value.to_string()),
            ),
            ("normalized_bytes", normalized.len().to_string()),
            ("action", action.to_owned()),
        ],
    );
}

pub(super) fn normalize_apply_patch_input(input: &str) -> String {
    let trimmed = input.trim();
    let without_fence = trimmed
        .strip_prefix("```diff")
        .or_else(|| trimmed.strip_prefix("```patch"))
        .or_else(|| trimmed.strip_prefix("```"))
        .and_then(|value| value.strip_suffix("```"))
        .map(str::trim)
        .unwrap_or(trimmed);

    if let Some(begin) = without_fence.find("*** Begin Patch") {
        if let Some(relative_end) = without_fence[begin..].find("*** End Patch") {
            let end = begin + relative_end + "*** End Patch".len();
            return without_fence[begin..end].to_owned();
        }
        // Preserve an incomplete patch so Codex reports the real grammar error.
        return without_fence[begin..].to_owned();
    }

    if without_fence.lines().any(|line| {
        line.starts_with("*** Add File:")
            || line.starts_with("*** Update File:")
            || line.starts_with("*** Delete File:")
            || line.starts_with("*** Move to:")
    }) {
        return format!("*** Begin Patch\n{without_fence}\n*** End Patch");
    }

    without_fence.to_owned()
}

pub(super) fn normalize_arguments(arguments: &str) -> String {
    if arguments.trim().is_empty() {
        "{}".to_owned()
    } else {
        arguments.to_owned()
    }
}

pub(super) fn responses_usage(usage: Option<&Value>) -> Value {
    let input = usage
        .and_then(|v| v.get("prompt_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output = usage
        .and_then(|v| v.get("completion_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = usage
        .and_then(|v| v.pointer("/prompt_tokens_details/cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let reasoning = usage
        .and_then(|v| v.pointer("/completion_tokens_details/reasoning_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    json!({
        "input_tokens": input,
        "input_tokens_details": {"cached_tokens": cached},
        "output_tokens": output,
        "output_tokens_details": {"reasoning_tokens": reasoning},
        "total_tokens": input + output
    })
}

pub(super) fn sse(event: &str, data: Value) -> Bytes {
    Bytes::from(format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(&data).unwrap_or_default()
    ))
}
