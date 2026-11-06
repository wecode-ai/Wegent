use super::*;

pub(super) fn build_tool_context(tools: &[Value], preserve_namespace: bool) -> ToolContext {
    let name_counts = tool_name_counts(tools);

    let mut context = ToolContext::default();
    for tool in tools {
        if tool.get("type").and_then(Value::as_str) == Some("tool_search") {
            let wire_name = unique_wire_name(&context, bounded_wire_name(BRIDGED_TOOL_SEARCH_NAME));
            context.insert_tool(
                wire_name,
                ToolIdentity {
                    name: TOOL_SEARCH_NAME.to_owned(),
                    namespace: None,
                    kind: ToolKind::ToolSearch,
                },
            );
            continue;
        }
        if tool.get("type").and_then(Value::as_str) == Some("namespace") {
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
                let preferred_wire_name = if preserve_namespace
                    || name_counts.get(name).is_some_and(|count| *count > 1)
                {
                    flattened_namespace_tool_name(namespace, name)
                } else {
                    bounded_wire_name(name)
                };
                let wire_name = unique_wire_name(&context, preferred_wire_name);
                context.insert_tool(
                    wire_name,
                    ToolIdentity {
                        name: name.to_owned(),
                        namespace: Some(namespace.to_owned()),
                        kind: ToolKind::Function,
                    },
                );
            }
            continue;
        }
        let Some(name) = tool.get("name").and_then(Value::as_str) else {
            continue;
        };
        let kind = if tool.get("type").and_then(Value::as_str) == Some("custom") {
            ToolKind::Custom
        } else {
            ToolKind::Function
        };
        let preferred_wire_name = if preserve_namespace || name_counts.get(name) == Some(&1) {
            bounded_wire_name(name)
        } else {
            bounded_wire_name(&format!("functions__{name}"))
        };
        let wire_name = unique_wire_name(&context, preferred_wire_name);
        context.insert_tool(
            wire_name,
            ToolIdentity {
                name: name.to_owned(),
                namespace: None,
                kind,
            },
        );
    }
    context
}

pub(super) fn tool_name_counts(tools: &[Value]) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for tool in tools {
        if tool.get("type").and_then(Value::as_str) == Some("namespace") {
            for nested_tool in tool
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(name) = nested_tool.get("name").and_then(Value::as_str) {
                    *counts.entry(name.to_owned()).or_default() += 1;
                }
            }
        } else if let Some(name) = tool.get("name").and_then(Value::as_str) {
            *counts.entry(name.to_owned()).or_default() += 1;
        }
    }
    counts
}

pub(super) fn apply_reasoning_options(
    body: &Value,
    result: &mut Map<String, Value>,
    kimi_k3_compat: bool,
) {
    if kimi_k3_compat {
        let Some(reasoning_enabled) = reasoning_requested(body) else {
            return;
        };
        result.insert(
            "thinking".to_owned(),
            json!({
                "type": if reasoning_enabled { "enabled" } else { "disabled" }
            }),
        );
        return;
    }
    if let Some(effort) = body.pointer("/reasoning/effort") {
        result.insert("reasoning_effort".to_owned(), effort.clone());
    }
}

pub(super) fn reasoning_requested(body: &Value) -> Option<bool> {
    if let Some(effort) = body.pointer("/reasoning/effort").and_then(Value::as_str) {
        return Some(!matches!(
            effort.trim().to_ascii_lowercase().as_str(),
            "none" | "off" | "disabled"
        ));
    }
    body.get("reasoning").map(|reasoning| !reasoning.is_null())
}

pub(super) fn is_kimi_k3_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().contains("kimi-k3")
}

pub(super) fn request_uses_kimi_k3(body: &Value, model_hint: Option<&str>) -> bool {
    model_hint.is_some_and(is_kimi_k3_model)
        || body
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(is_kimi_k3_model)
}

pub(super) fn flattened_namespace_tool_name(namespace: &str, name: &str) -> String {
    let flattened = if namespace.ends_with('_') || name.starts_with('_') {
        format!("{namespace}{name}")
    } else {
        format!("{namespace}__{name}")
    };
    bounded_wire_name(&flattened)
}

pub(super) fn bounded_wire_name(value: &str) -> String {
    const MAX_TOOL_NAME_BYTES: usize = 64;
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.len() <= MAX_TOOL_NAME_BYTES {
        return sanitized;
    }

    let hash = sanitized
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x100_0000_01b3)
        });
    let suffix = format!("__{hash:016x}");
    let prefix_bytes = MAX_TOOL_NAME_BYTES - suffix.len();
    format!("{}{}", &sanitized[..prefix_bytes], suffix)
}

pub(super) fn unique_wire_name(context: &ToolContext, preferred: String) -> String {
    if !context.tools.contains_key(&preferred) {
        return preferred;
    }
    for suffix in 2.. {
        let candidate = bounded_wire_name(&format!("{preferred}__{suffix}"));
        if !context.tools.contains_key(&candidate) {
            return candidate;
        }
    }
    unreachable!("an unused tool name suffix must exist")
}

pub(super) fn chat_tools(
    tools: &[Value],
    context: &ToolContext,
    kimi_k3_compat: bool,
) -> Vec<Value> {
    let mut converted = Vec::new();
    for tool in tools {
        if tool.get("type").and_then(Value::as_str) == Some("tool_search") {
            if let Some(converted_tool) = chat_tool_search(tool, context, kimi_k3_compat) {
                converted.push(converted_tool);
            }
            continue;
        }
        if tool.get("type").and_then(Value::as_str) == Some("namespace") {
            let Some(namespace) = tool.get("name").and_then(Value::as_str) else {
                continue;
            };
            for inner_tool in tool
                .get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if let Some(converted_tool) =
                    chat_tool(inner_tool, Some(namespace), context, kimi_k3_compat)
                {
                    converted.push(converted_tool);
                }
            }
        } else if let Some(converted_tool) = chat_tool(tool, None, context, kimi_k3_compat) {
            converted.push(converted_tool);
        }
    }
    converted
}

pub(super) fn chat_tool_search(
    tool: &Value,
    context: &ToolContext,
    kimi_k3_compat: bool,
) -> Option<Value> {
    let wire_name = context.wire_name(None, TOOL_SEARCH_NAME)?;
    let mut function = Map::new();
    function.insert("name".to_owned(), Value::String(wire_name.to_owned()));
    function.insert(
        "description".to_owned(),
        bridged_tool_search_description(tool),
    );
    function.insert(
        "parameters".to_owned(),
        normalize_function_parameters(Some(&bridged_tool_search_parameters(tool)), kimi_k3_compat),
    );
    Some(json!({"type": "function", "function": function}))
}

pub(super) fn bridged_tool_search_description(tool: &Value) -> Value {
    tool.get("description")
        .filter(|description| {
            !description
                .as_str()
                .is_some_and(|description| description.trim().is_empty())
        })
        .cloned()
        .unwrap_or_else(|| Value::String(TOOL_SEARCH_DESCRIPTION.to_owned()))
}

pub(super) fn bridged_tool_search_parameters(tool: &Value) -> Value {
    let parameters = tool.get("parameters");
    let has_explicit_properties = parameters
        .and_then(|parameters| parameters.get("properties"))
        .and_then(Value::as_object)
        .is_some_and(|properties| !properties.is_empty());
    if has_explicit_properties {
        return parameters
            .cloned()
            .expect("parameters were inspected above");
    }

    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "Describe the MCP or App capability needed to continue the task."
            },
            "limit": {
                "type": "integer",
                "description": "Maximum number of matching tools to return.",
                "minimum": 1
            }
        },
        "required": ["query"],
        "additionalProperties": false
    })
}

pub(super) fn chat_tool(
    tool: &Value,
    namespace: Option<&str>,
    context: &ToolContext,
    kimi_k3_compat: bool,
) -> Option<Value> {
    let name = tool.get("name")?.as_str()?;
    let wire_name = context.wire_name(namespace, name)?;
    if context.is_custom(wire_name) {
        let definition = serde_json::to_string(tool).ok()?;
        let contract = if name == "apply_patch" {
            format!("{APPLY_PATCH_OUTPUT_CONTRACT}\n\n")
        } else {
            "Put only the custom tool's raw input in the function's `input` field. Do not add Markdown fences or explanatory text.\n\n".to_owned()
        };
        let description =
            format!("{contract}Original tool definition:\n```json\n{definition}\n```");
        return Some(json!({
            "type": "function",
            "function": {
                "name": wire_name,
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
            }
        }));
    }
    let mut function = Map::new();
    function.insert("name".to_owned(), Value::String(wire_name.to_owned()));
    if let Some(description) = tool.get("description") {
        function.insert("description".to_owned(), description.clone());
    }
    function.insert(
        "parameters".to_owned(),
        normalize_function_parameters(tool.get("parameters"), kimi_k3_compat),
    );
    if let Some(strict) = tool.get("strict") {
        function.insert("strict".to_owned(), strict.clone());
    }
    Some(json!({"type": "function", "function": function}))
}

pub(super) fn normalize_function_parameters(
    parameters: Option<&Value>,
    kimi_k3_compat: bool,
) -> Value {
    let mut normalized = match parameters {
        Some(Value::Object(parameters)) => Value::Object(parameters.clone()),
        _ => json!({"type": "object", "properties": {}}),
    };
    if kimi_k3_compat {
        // Moonshot requires function parameters to declare an object type, while anyOf
        // schemas must declare types only on their branches.
        ensure_function_parameters_object_type(&mut normalized);
        normalize_kimi_k3_schema(&mut normalized);
        nest_root_any_of_constraint(&mut normalized);
    }
    ensure_function_parameters_object_type(&mut normalized);
    normalized
}

pub(super) fn ensure_function_parameters_object_type(schema: &mut Value) {
    let object = schema
        .as_object_mut()
        .expect("normalized function parameters must be an object");
    if object.get("type").and_then(Value::as_str) != Some("object") {
        object.insert("type".to_owned(), Value::String("object".to_owned()));
    }
}

pub(super) fn normalize_kimi_k3_schema(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            for (keyword, value) in object.iter_mut() {
                if !matches!(
                    keyword.as_str(),
                    "const" | "default" | "enum" | "example" | "examples"
                ) {
                    normalize_kimi_k3_schema(value);
                }
            }
            move_compatible_parent_type_to_any_of(object);
        }
        Value::Array(values) => {
            for value in values {
                normalize_kimi_k3_schema(value);
            }
        }
        _ => {}
    }
}

pub(super) fn move_compatible_parent_type_to_any_of(schema: &mut Map<String, Value>) {
    let Some(parent_type) = schema.get("type").cloned() else {
        return;
    };
    let can_move = schema
        .get("anyOf")
        .and_then(Value::as_array)
        .is_some_and(|branches| {
            !branches.is_empty()
                && branches.iter().all(|branch| {
                    branch.as_object().is_some_and(|branch| {
                        branch
                            .get("type")
                            .map_or(true, |branch_type| branch_type == &parent_type)
                    })
                })
        });
    if !can_move {
        return;
    }
    if let Some(branches) = schema.get_mut("anyOf").and_then(Value::as_array_mut) {
        for branch in branches {
            branch
                .as_object_mut()
                .expect("compatible anyOf branches must be objects")
                .entry("type".to_owned())
                .or_insert_with(|| parent_type.clone());
        }
    }
    schema.remove("type");
}

pub(super) fn nest_root_any_of_constraint(schema: &mut Value) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    if object.get("allOf").is_some_and(|value| !value.is_array()) {
        return;
    }
    let Some(any_of) = object
        .get("anyOf")
        .and_then(Value::as_array)
        .filter(|branches| !branches.is_empty())
        .cloned()
    else {
        return;
    };
    object.remove("anyOf");
    let constraint = json!({"anyOf": any_of});
    match object.get_mut("allOf") {
        Some(Value::Array(all_of)) => all_of.push(constraint),
        Some(_) => unreachable!("non-array allOf was rejected above"),
        None => {
            object.insert("allOf".to_owned(), Value::Array(vec![constraint]));
        }
    }
}
