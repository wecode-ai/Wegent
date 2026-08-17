use serde_json::{json, Value};

pub(crate) fn text_result(data: impl Into<Value>, is_error: bool) -> Value {
    text_result_with_options(data, is_error, false)
}

pub(crate) fn text_result_with_options(
    data: impl Into<Value>,
    is_error: bool,
    include_json: bool,
) -> Value {
    let data = data.into();
    let text = combined_text_result_with_options(&data, include_json)
        .or_else(|| inspect_text_result_with_options(&data, include_json))
        .or_else(|| action_text_result_with_options(&data, include_json))
        .unwrap_or_else(|| {
            data.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| serde_json::to_string_pretty(&data).unwrap_or_default())
        });
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

#[cfg(test)]
pub(crate) fn combined_text_result(data: &Value) -> Option<String> {
    combined_text_result_with_options(data, false)
}

fn combined_text_result_with_options(data: &Value, include_json: bool) -> Option<String> {
    if data.get("kind").and_then(Value::as_str) != Some("browser.combined") {
        return None;
    }
    let tool = data
        .get("tool")
        .and_then(Value::as_str)
        .unwrap_or("combined");
    let ok = data.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut sections = vec![format!("Combined: {tool} ok={ok}")];
    if let Some(action) = data.get("action") {
        let action_name = action
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("action");
        let action_ok = action.get("ok").and_then(Value::as_bool).unwrap_or(false);
        sections.push(format!("Action: {action_name} ok={action_ok}"));
        if let Some(outcome) = action.get("outcome").and_then(Value::as_str) {
            sections.push(format!("Action outcome: {outcome}"));
        }
        if let Some(effect) = action.get("effect") {
            sections.push(format!(
                "Effect: {}",
                serde_json::to_string(effect).unwrap_or_default()
            ));
        }
    }
    if let Some(wait) = data.get("wait") {
        let reason = wait
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let wait_ok = wait.get("ok").and_then(Value::as_bool).unwrap_or(false);
        sections.push(format!("Wait: {reason} ok={wait_ok}"));
    }
    if let Some(error) = data.get("error") {
        sections.push(format!(
            "Error: {}",
            serde_json::to_string(error).unwrap_or_default()
        ));
    }
    if let Some(inspect_text) = data
        .pointer("/inspect/inspectText")
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
    {
        sections.push(format!(
            "Inspect:\n{inspect_text}\n\n{}",
            action_guidance_text()
        ));
    }
    if include_json {
        sections.push(format!(
            "JSON:\n{}",
            serde_json::to_string_pretty(data).unwrap_or_default()
        ));
    } else {
        sections.push(format!(
            "Metadata: {}",
            serde_json::to_string(&json!({
                "kind": "browser.combined",
                "ok": ok,
                "tool": tool,
                "elapsedMs": data.get("elapsedMs"),
                "warningCount": data
                    .get("warnings")
                    .and_then(Value::as_array)
                    .map(Vec::len)
                    .unwrap_or(0),
            }))
            .unwrap_or_default()
        ));
    }
    Some(sections.join("\n\n"))
}

#[cfg(test)]
pub(crate) fn inspect_text_result(data: &Value) -> Option<String> {
    inspect_text_result_with_options(data, false)
}

pub(crate) fn inspect_text_result_with_options(data: &Value, include_json: bool) -> Option<String> {
    if data.get("kind").and_then(Value::as_str) != Some("browser.inspect") {
        return None;
    }
    let inspect_text = data.get("inspectText").and_then(Value::as_str)?;
    let suffix = if include_json {
        format!(
            "JSON:\n{}",
            serde_json::to_string_pretty(data).unwrap_or_default()
        )
    } else {
        format!(
            "Metadata: {}",
            serde_json::to_string(&json!({
                "kind": "browser.inspect",
                "inspectId": data.get("inspectId"),
                "partial": data.get("partial"),
                "truncated": data.get("truncated"),
                "stats": data.get("stats"),
            }))
            .unwrap_or_default()
        )
    };
    Some(format!(
        "{inspect_text}\n\n{}\n\n{suffix}",
        action_guidance_text()
    ))
}

#[cfg(test)]
pub(crate) fn action_text_result(data: &Value) -> Option<String> {
    action_text_result_with_options(data, false)
}

fn action_text_result_with_options(data: &Value, include_json: bool) -> Option<String> {
    let action = data.get("action").and_then(Value::as_str)?;
    let ok = data.get("ok").and_then(Value::as_bool)?;
    let outcome = data.get("outcome").and_then(Value::as_str);
    let mut summary = json!({
        "success": ok,
        "action": action,
    });
    if let (Some(outcome), Some(summary)) = (outcome, summary.as_object_mut()) {
        summary.insert("outcome".to_owned(), Value::String(outcome.to_owned()));
    }
    let mut sections = vec![serde_json::to_string(&summary).unwrap_or_default()];
    if let Some(error) = data.get("error") {
        sections.push(format!(
            "Error: {}",
            serde_json::to_string(error).unwrap_or_default()
        ));
    }
    let next = if ok && matches!(action, "fill" | "type" | "typeText") {
        "Next: Continue any remaining requested action and reuse known targets without another inspect."
    } else if ok && action == "click" && outcome == Some("dispatched_unverified") {
        "Next: The click event was dispatched, but no immediate effect was observed. Call browser_wait_and_inspect for an expected condition or inspect once before treating the click as complete."
    } else if ok && action == "click" {
        "Next: The click succeeded. Continue any remaining user-requested actions. If none remain and the task needs final-page understanding, call browser_inspect once, summarize that page, and stop."
    } else if !ok {
        "Recovery: Call browser_inspect and retry this same direct action once with a fresh index/ref/selector. Do not reopen an already available page."
    } else {
        "Next action: Continue any remaining requested browser actions."
    };
    sections.push(next.to_owned());
    if include_json {
        sections.push(format!(
            "JSON:\n{}",
            serde_json::to_string_pretty(data).unwrap_or_default()
        ));
    }
    Some(sections.join("\n\n"))
}

fn action_guidance_text() -> &'static str {
    "Action guidance: Continue the user's requested actions, reuse known targets, and avoid redundant inspections. Inspect again only after a page change, an unknown/stale target, or when a final-page summary is needed."
}
