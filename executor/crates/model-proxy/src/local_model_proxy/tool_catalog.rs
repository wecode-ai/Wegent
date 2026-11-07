//! Reconstruct native incremental tool declarations for stateless protocol adapters.
use serde_json::Value;

pub(super) fn effective_tools(body: &Value) -> Vec<Value> {
    let mut tools = body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_current_tools = body.get("tools").is_some();
    for item in body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("type").and_then(Value::as_str) {
            Some("additional_tools") if !has_current_tools => {
                for tool in item
                    .get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    merge_effective_tool(&mut tools, tool);
                }
            }
            Some("tool_search_output") => {
                for tool in item
                    .get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    merge_effective_tool(&mut tools, tool);
                }
            }
            Some("message") if item.get("role").and_then(Value::as_str) == Some("developer") => {
                for content in item
                    .get("content")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    if let Some(text) = content.get("text").and_then(Value::as_str) {
                        apply_native_tool_removals(&mut tools, text);
                    }
                }
            }
            _ => {}
        }
    }
    for tool in body
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        merge_effective_tool(&mut tools, tool);
    }
    tools
}

// These are Codex's bundled incremental catalog directives, not user-message commands.
fn apply_native_tool_removals(tools: &mut Vec<Value>, text: &str) {
    let mut namespace_section = None;
    for line in text.lines() {
        match line {
            "The following tools are no longer available. Do not call them:" => namespace_section = Some(false),
            "The following namespaces are no longer available. Do not call tools in them unless those tools are declared in a later update:" => namespace_section = Some(true),
            "" => namespace_section = None,
            _ => {
                let Some((name, namespaces)) = line.strip_prefix("- ").zip(namespace_section) else { continue };
                tools.retain_mut(|tool| {
                    let namespace = tool.get("name").and_then(Value::as_str).unwrap_or_default();
                    if tool.get("type").and_then(Value::as_str) == Some("namespace") {
                        if namespaces && namespace == name { return false; }
                        let namespace = namespace.to_owned();
                        if let Some(members) = tool.get_mut("tools").and_then(Value::as_array_mut) {
                            members.retain(|member| format!("{}.{}", namespace, member["name"].as_str().unwrap_or_default()) != name);
                            return !members.is_empty();
                        }
                        true
                    } else {
                        !(namespaces && name == "functions" || !namespaces && (namespace == name || format!("functions.{namespace}") == name))
                    }
                });
            }
        }
    }
}

fn merge_effective_tool(tools: &mut Vec<Value>, searched_tool: &Value) {
    let searched_type = searched_tool.get("type").and_then(Value::as_str);
    if searched_type != Some("namespace") {
        if !matches!(searched_type, Some("function" | "custom" | "tool_search")) {
            return;
        }
        let searched_name = searched_tool.get("name").and_then(Value::as_str);
        if !tools.iter().any(|tool| {
            tool.get("type") == searched_tool.get("type")
                && tool.get("name").and_then(Value::as_str) == searched_name
        }) {
            tools.push(searched_tool.clone());
        } else if let Some(existing) = tools
            .iter_mut()
            .find(|tool| tool.get("name") == searched_tool.get("name"))
        {
            *existing = searched_tool.clone();
        }
        return;
    }

    let Some(namespace) = searched_tool.get("name").and_then(Value::as_str) else {
        return;
    };
    let Some(existing) = tools.iter_mut().find(|tool| {
        tool.get("type").and_then(Value::as_str) == Some("namespace")
            && tool.get("name").and_then(Value::as_str) == Some(namespace)
    }) else {
        tools.push(searched_tool.clone());
        return;
    };
    let Some(existing_tools) = existing.get_mut("tools").and_then(Value::as_array_mut) else {
        *existing = searched_tool.clone();
        return;
    };
    for inner_tool in searched_tool
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let inner_name = inner_tool.get("name").and_then(Value::as_str);
        if !existing_tools
            .iter()
            .any(|tool| tool.get("name").and_then(Value::as_str) == inner_name)
        {
            existing_tools.push(inner_tool.clone());
        } else if let Some(existing) = existing_tools
            .iter_mut()
            .find(|tool| tool.get("name").and_then(Value::as_str) == inner_name)
        {
            *existing = inner_tool.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn incremental_catalog_replaces_definitions_and_respects_native_removals() {
        let body = json!({"input": [
            {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","description":"old"},
                {"type":"function","name":"removed"}
            ]}]},
            {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","description":"new"}
            ]}]},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"The following tools are no longer available. Do not call them:\n- functions.exec"}]},
            {"type":"message","role":"developer","content":[{"type":"input_text","text":"The following tools are no longer available. Do not call them:\n- functions.removed"}]}
        ]});
        let tools = effective_tools(&body);
        assert_eq!(tools[0]["tools"].as_array().unwrap().len(), 1);
        assert_eq!(tools[0]["tools"][0]["description"], "new");
    }

    #[test]
    fn current_top_level_tools_do_not_resurrect_historical_additional_tools() {
        let body = json!({"tools": [], "input": [{"type":"additional_tools","tools":[{"type":"function","name":"revoked"}]}]});
        assert!(effective_tools(&body).is_empty());
    }

    #[test]
    fn removed_namespace_can_be_explicitly_redeclared_later() {
        let namespace =
            json!({"type":"namespace","name":"app","tools":[{"type":"function","name":"read"}]});
        let body = json!({"input":[
            {"type":"additional_tools","tools":[namespace.clone()]},
            {"type":"message","role":"developer","content":[{"type":"input_text","text":"The following namespaces are no longer available. Do not call tools in them unless those tools are declared in a later update:\n- app"}]},
            {"type":"additional_tools","tools":[namespace.clone()]}
        ]});
        assert_eq!(effective_tools(&body), vec![namespace]);
    }
}
