use super::tool_schema::flattened_namespace_tool_name;
use super::*;

pub(super) fn responses_tools(
    tools: &[Value],
    context: &ToolContext,
    convert_custom_tools: CustomToolConversion,
    bridge_tool_search: bool,
    bridge_namespace_tools: bool,
) -> Vec<Value> {
    let mut converted = Vec::new();
    for tool in tools {
        match tool.get("type").and_then(Value::as_str) {
            Some("tool_search") => {
                if !bridge_tool_search {
                    converted.push(tool.clone());
                    continue;
                }
                let Some(name) = context.wire_name(None, TOOL_SEARCH_NAME) else {
                    continue;
                };
                let mut function = Map::new();
                function.insert("type".to_owned(), Value::String("function".to_owned()));
                function.insert("name".to_owned(), Value::String(name.to_owned()));
                function.insert(
                    "description".to_owned(),
                    bridged_tool_search_description(tool),
                );
                function.insert(
                    "parameters".to_owned(),
                    bridged_tool_search_parameters(tool),
                );
                converted.push(Value::Object(function));
                continue;
            }
            Some("namespace") => {
                if !bridge_namespace_tools {
                    let mut namespace = tool.clone();
                    if let Some(tools) = tool.get("tools").and_then(Value::as_array) {
                        namespace["tools"] = Value::Array(responses_tools(
                            tools,
                            context,
                            convert_custom_tools,
                            bridge_tool_search,
                            false,
                        ));
                    }
                    converted.push(namespace);
                    continue;
                }
                let Some(namespace) = tool.get("name").and_then(Value::as_str) else {
                    continue;
                };
                for inner_tool in tool
                    .get("tools")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let Some(name) = inner_tool.get("name").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(wire_name) = context.wire_name(Some(namespace), name) else {
                        continue;
                    };
                    let mut flattened = responses_tools(
                        std::slice::from_ref(inner_tool),
                        context,
                        CustomToolConversion::All,
                        bridge_tool_search,
                        false,
                    )
                    .remove(0);
                    flattened["type"] = Value::String("function".to_owned());
                    flattened["name"] = Value::String(wire_name.to_owned());
                    converted.push(flattened);
                }
                continue;
            }
            _ => {}
        }

        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            converted.push(tool.clone());
            continue;
        };
        converted.push(if convert_custom_tools.converts(name)
            && tool["type"] == "custom" {
            let contract = if name == "apply_patch" {
                format!("{APPLY_PATCH_OUTPUT_CONTRACT}\n\n")
            } else {
                "Put only the custom tool's raw input in the function's `input` field. Do not add Markdown fences or explanatory text.\n\n".to_owned()
            };
            let description = if name == "apply_patch" {
                contract
            } else {
                let definition = serde_json::to_string(tool).unwrap_or_default();
                format!("{contract}Original tool definition:\n```json\n{definition}\n```")
            };
            json!({
                "type": "function",
                "name": name,
                "description": description,
                "parameters": {
                    "type": "object",
                    "properties": {
                        CUSTOM_TOOL_INPUT_FIELD: {
                            "type": "string",
                            "description": CUSTOM_TOOL_INPUT_DESCRIPTION
                        }
                    },
                    "required": [CUSTOM_TOOL_INPUT_FIELD],
                    "additionalProperties": false
                }
            })
        } else {
            tool.clone()
        });
    }
    if bridge_tool_search {
        for tool in &mut converted {
            remove_defer_loading(tool);
        }
    }
    converted
}

pub(super) fn remove_defer_loading(tool: &mut Value) {
    let Some(object) = tool.as_object_mut() else {
        return;
    };
    object.remove("defer_loading");
    if object.get("type").and_then(Value::as_str) != Some("namespace") {
        return;
    }
    for inner_tool in object
        .get_mut("tools")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        remove_defer_loading(inner_tool);
    }
}

pub(super) fn responses_tool_choice(
    choice: &Value,
    context: &ToolContext,
    convert_custom_tools: CustomToolConversion,
    bridge_namespace_tools: bool,
) -> Option<Value> {
    let choice_type = choice.get("type").and_then(Value::as_str)?;
    if choice_type == "custom" {
        if !choice["name"].as_str().is_some_and(|name| {
            convert_custom_tools.converts_identity(
                name,
                choice["namespace"].as_str(),
                bridge_namespace_tools,
            )
        }) {
            return None;
        }
        let mut converted = choice.clone();
        converted["type"] = Value::String("function".to_owned());
        if bridge_namespace_tools {
            let name = choice["name"].as_str()?;
            let wire_name = context.wire_name(choice["namespace"].as_str(), name)?;
            converted["name"] = Value::String(wire_name.to_owned());
            converted.as_object_mut()?.remove("namespace");
        }
        return Some(converted);
    }
    if let Some(name) = choice.get("name").and_then(Value::as_str) {
        let namespace = choice.get("namespace").and_then(Value::as_str);
        if namespace.is_some() && !bridge_namespace_tools {
            return None;
        }
        let wire_name = context.wire_name(namespace, name)?;
        let mut converted = choice.clone();
        converted["type"] = Value::String("function".to_owned());
        converted["name"] = Value::String(wire_name.to_owned());
        converted.as_object_mut()?.remove("namespace");
        return Some(converted);
    }
    None
}

/// Convert Codex-only tool types into ordinary Responses function tools.
///
/// Namespace tools and `tool_search` are bridged only when the upstream does
/// not support their Codex-native forms. Custom tools such as `apply_patch`
/// are bridged only when the model configuration requests it.
pub(crate) fn responses_to_responses(
    body: &Value,
    convert_custom_tools: impl Into<CustomToolConversion>,
    native_tool_search: bool,
    native_namespace_tools: bool,
) -> Result<(Value, ToolContext), String> {
    let mut result = body.clone();
    let convert_custom_tools = convert_custom_tools.into();
    let effective_tools = effective_tools(&result);
    for namespace in effective_tools
        .iter()
        .filter(|tool| tool["type"] == "namespace")
    {
        for child in namespace["tools"].as_array().into_iter().flatten() {
            if let Some(kind) = child["type"].as_str() {
                if !matches!(kind, "function" | "custom") {
                    return Err(format!("Unsupported tool type in namespace: {kind}"));
                }
            }
        }
    }
    let context = build_tool_context(&effective_tools, true);
    let bridge_tool_search = !native_tool_search;
    let bridge_namespace_tools = !native_namespace_tools;

    let bridge_native_catalog =
        convert_custom_tools.enabled() || bridge_tool_search || bridge_namespace_tools;
    if result.get("tools").is_none() && bridge_native_catalog {
        result["tools"] = Value::Array(effective_tools.clone());
    }
    if bridge_native_catalog {
        if let Some(input) = result.get_mut("input").and_then(Value::as_array_mut) {
            input.retain(|item| {
                item.get("type").and_then(Value::as_str) != Some("additional_tools")
            });
        }
    }

    if let Some(tools) = result.get("tools").and_then(Value::as_array) {
        if !tools.is_empty() {
            let tools = if bridge_namespace_tools {
                effective_tools.as_slice()
            } else {
                tools.as_slice()
            };
            result["tools"] = Value::Array(responses_tools(
                tools,
                &context,
                convert_custom_tools,
                bridge_tool_search,
                bridge_namespace_tools,
            ));
        }
    }

    if let Some(input) = result.get("input") {
        result["input"] = convert_responses_input_items(
            input,
            &context,
            convert_custom_tools,
            bridge_tool_search,
            bridge_namespace_tools,
        )?;
    }

    if let Some(choice) = result.get("tool_choice") {
        if let Some(converted) = responses_tool_choice(
            choice,
            &context,
            convert_custom_tools,
            bridge_namespace_tools,
        ) {
            result["tool_choice"] = converted;
        }
    }

    Ok((
        result,
        responses_bridge_context(
            &context,
            convert_custom_tools,
            bridge_tool_search,
            bridge_namespace_tools,
        ),
    ))
}

pub(super) fn convert_responses_input_items(
    input: &Value,
    context: &ToolContext,
    convert_custom_tools: CustomToolConversion,
    bridge_tool_search: bool,
    bridge_namespace_tools: bool,
) -> Result<Value, String> {
    let items = match input {
        Value::Array(items) => items,
        _ => return Ok(input.clone()),
    };

    let call_id_to_identity = responses_call_identities(items, context);

    let mut converted = Vec::new();
    let mut pending_tool_image_content = Vec::new();
    for item in items {
        let item_type = item.get("type").and_then(Value::as_str);
        if !is_tool_output_item(item_type) {
            flush_tool_image_content_to_responses(&mut converted, &mut pending_tool_image_content);
        }
        let mut converted_item = convert_responses_input_item(
            item,
            context,
            &call_id_to_identity,
            convert_custom_tools,
            bridge_tool_search,
            bridge_namespace_tools,
        )?;
        move_responses_tool_output_images(
            item,
            &mut converted_item,
            &call_id_to_identity,
            &mut pending_tool_image_content,
        );
        converted.push(converted_item);
    }
    flush_tool_image_content_to_responses(&mut converted, &mut pending_tool_image_content);
    Ok(Value::Array(converted))
}

pub(super) fn responses_call_identities(
    items: &[Value],
    context: &ToolContext,
) -> HashMap<String, ToolIdentity> {
    let mut identities = HashMap::new();
    for item in items {
        let Some(call_id) = item.get("call_id").and_then(Value::as_str) else {
            continue;
        };
        let (namespace, name) = match item.get("type").and_then(Value::as_str) {
            Some("tool_search_call") => (None, TOOL_SEARCH_NAME),
            Some("custom_tool_call") | Some("function_call") => (
                item.get("namespace").and_then(Value::as_str),
                item.get("name").and_then(Value::as_str).unwrap_or_default(),
            ),
            _ => continue,
        };
        let mut identity = context
            .wire_name(namespace, name)
            .and_then(|wire_name| context.identity(wire_name))
            .cloned()
            .unwrap_or_else(|| ToolIdentity {
                name: name.to_owned(),
                namespace: namespace.map(str::to_owned),
                kind: ToolKind::Function,
            });
        if item["type"] == "custom_tool_call" {
            identity.kind = ToolKind::Custom;
        }
        identities.insert(call_id.to_owned(), identity);
    }
    identities
}

pub(super) fn move_responses_tool_output_images(
    item: &Value,
    converted_item: &mut Value,
    call_id_to_identity: &HashMap<String, ToolIdentity>,
    pending_tool_image_content: &mut Vec<Value>,
) {
    if !matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call_output") | Some("custom_tool_call_output")
    ) {
        return;
    }
    let mut output = item
        .get("output")
        .map(split_tool_output)
        .unwrap_or_default();
    if output.images.is_empty() {
        return;
    }
    let tool_name = item
        .get("call_id")
        .and_then(Value::as_str)
        .and_then(|call_id| call_id_to_identity.get(call_id))
        .map(|identity| identity.name.as_str());
    append_tool_image_content(pending_tool_image_content, tool_name, output.images);
    if output.text.is_empty() {
        output.text = tool_image_output_notice().to_owned();
    }
    converted_item["output"] = Value::String(output.text);
}

pub(super) fn is_tool_output_item(item_type: Option<&str>) -> bool {
    matches!(
        item_type,
        Some("function_call_output") | Some("custom_tool_call_output") | Some("tool_search_output")
    )
}

pub(super) fn convert_responses_input_item(
    item: &Value,
    context: &ToolContext,
    call_id_to_identity: &HashMap<String, ToolIdentity>,
    convert_custom_tools: CustomToolConversion,
    bridge_tool_search: bool,
    bridge_namespace_tools: bool,
) -> Result<Value, String> {
    let item_type = item.get("type").and_then(Value::as_str);
    let name = item.get("name").and_then(Value::as_str).unwrap_or_default();

    match item_type {
        Some("tool_search_call") if bridge_tool_search => {
            let mut converted = item.clone();
            converted["type"] = Value::String("function_call".to_owned());
            converted["name"] = Value::String(
                context
                    .wire_name(None, TOOL_SEARCH_NAME)
                    .unwrap_or(TOOL_SEARCH_NAME)
                    .to_owned(),
            );
            converted["arguments"] = Value::String(json_string(item.get("arguments")));
            if let Some(object) = converted.as_object_mut() {
                object.remove("id");
                object.remove("execution");
            }
            Ok(converted)
        }
        Some("custom_tool_call")
            if convert_custom_tools.converts_identity(
                name,
                item["namespace"].as_str(),
                bridge_namespace_tools,
            ) =>
        {
            let mut converted = item.clone();
            converted["type"] = Value::String("function_call".to_owned());
            if bridge_namespace_tools {
                converted["name"] = Value::String(responses_call_wire_name(
                    context,
                    item["namespace"].as_str(),
                    name,
                ));
                converted.as_object_mut().unwrap().remove("namespace");
            }
            if let Some(input) = converted.get("input").and_then(Value::as_str) {
                let arguments = serde_json::to_string(&json!({CUSTOM_TOOL_INPUT_FIELD: input}))
                    .map_err(|error| error.to_string())?;
                converted["arguments"] = Value::String(arguments);
                converted.as_object_mut().unwrap().remove("input");
            }
            Ok(converted)
        }
        Some("custom_tool_call_output") => {
            let call_id = item
                .get("call_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if let Some(identity) = call_id_to_identity.get(call_id) {
                if convert_custom_tools.converts_identity(
                    &identity.name,
                    identity.namespace.as_deref(),
                    bridge_namespace_tools,
                ) && identity.kind == ToolKind::Custom
                {
                    let mut converted = item.clone();
                    converted["type"] = Value::String("function_call_output".to_owned());
                    return Ok(converted);
                }
            }
            Ok(item.clone())
        }
        Some("tool_search_output") if bridge_tool_search => {
            let mut converted = item.clone();
            converted["type"] = Value::String("function_call_output".to_owned());
            converted["output"] = Value::String(
                serde_json::to_string(&json!({
                    "tools": item.get("tools").cloned().unwrap_or_else(|| json!([]))
                }))
                .map_err(|error| error.to_string())?,
            );
            if let Some(object) = converted.as_object_mut() {
                object.remove("id");
                object.remove("execution");
                object.remove("tools");
            }
            Ok(converted)
        }
        Some("function_call") if bridge_namespace_tools => {
            let namespace = item.get("namespace").and_then(Value::as_str);
            if namespace.is_none() {
                return Ok(item.clone());
            }
            let mut converted = item.clone();
            converted["name"] = Value::String(responses_call_wire_name(context, namespace, name));
            converted.as_object_mut().unwrap().remove("namespace");
            Ok(converted)
        }
        _ => Ok(item.clone()),
    }
}

fn responses_call_wire_name(context: &ToolContext, namespace: Option<&str>, name: &str) -> String {
    context
        .wire_name(namespace, name)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            namespace
                .map(|namespace| flattened_namespace_tool_name(namespace, name))
                .unwrap_or_else(|| name.to_owned())
        })
}

pub(super) fn responses_bridge_context(
    context: &ToolContext,
    convert_custom_tools: CustomToolConversion,
    bridge_tool_search: bool,
    bridge_namespace_tools: bool,
) -> ToolContext {
    let mut bridged = ToolContext::default();
    for (wire_name, identity) in &context.tools {
        let include = match identity.kind {
            ToolKind::Custom => convert_custom_tools.converts_identity(
                &identity.name,
                identity.namespace.as_deref(),
                bridge_namespace_tools,
            ),
            ToolKind::ToolSearch => bridge_tool_search,
            ToolKind::Function => bridge_namespace_tools && identity.namespace.is_some(),
        };
        if include {
            bridged.insert_tool(wire_name.clone(), identity.clone());
        }
    }
    bridged
}

pub(super) fn chat_tool_choice(choice: &Value, context: &ToolContext) -> Value {
    if let Some(name) = choice.get("name").and_then(Value::as_str) {
        let namespace = choice.get("namespace").and_then(Value::as_str);
        let wire_name = context.wire_name(namespace, name).unwrap_or(name);
        json!({"type": "function", "function": {"name": wire_name}})
    } else {
        choice.clone()
    }
}
