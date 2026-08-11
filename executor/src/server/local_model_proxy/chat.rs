// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! OpenAI Responses to Chat Completions compatibility for Codex.
//!
//! Codex no longer accepts `wire_api = "chat"`, so providers exposing only
//! Chat Completions must be adapted at the local executor boundary. The event
//! shapes and custom-tool mapping preserve Codex semantics across protocols.

use std::{
    collections::{BTreeMap, HashMap},
    pin::Pin,
};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};

use crate::logging::log_executor_event;

const CUSTOM_TOOL_INPUT_FIELD: &str = "input";
const TOOL_SEARCH_NAME: &str = "tool_search";
const CUSTOM_TOOL_INPUT_DESCRIPTION: &str = "Raw string input for the original custom tool. Put only the tool input in this field, preserve every character exactly, and follow the original definition embedded in the function description. Do not add Markdown fences or explanatory text.";
const APPLY_PATCH_OUTPUT_CONTRACT: &str = r#"Critical apply_patch input contract:
- Set the function's `input` field to the patch text itself. JSON escaping is handled by the function-call protocol.
- The first characters must be exactly `*** Begin Patch\n`; put the first file hunk immediately on the next line with no blank line.
- The final marker must be `*** End Patch`, optionally followed by one newline, with no text after it.
- Do not include Markdown code fences, prose, labels, or any characters before `*** Begin Patch` or after `*** End Patch`.
- Follow the embedded Lark grammar exactly.
- For `*** Add File`, every added-file content line must start with `+`, including empty lines (use a line containing only `+`). Never emit raw file contents below an Add File directive.

Valid new-file example (the value of `input`, not a Markdown block):
*** Begin Patch
*** Add File: hello.txt
+first line
+
+third line
*** End Patch

Valid update example:
*** Begin Patch
*** Update File: hello.txt
@@
-old line
+new line
*** End Patch"#;

#[derive(Debug, Clone, PartialEq, Eq)]
enum ToolKind {
    Function,
    Custom,
    ToolSearch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ToolIdentity {
    name: String,
    namespace: Option<String>,
    kind: ToolKind,
}

#[derive(Debug, Clone, Default)]
pub(super) struct ToolContext {
    tools: BTreeMap<String, ToolIdentity>,
    wire_names: BTreeMap<(Option<String>, String), String>,
}

impl ToolContext {
    fn insert_tool(&mut self, wire_name: String, identity: ToolIdentity) {
        self.wire_names
            .entry((identity.namespace.clone(), identity.name.clone()))
            .or_insert_with(|| wire_name.clone());
        self.tools.entry(wire_name).or_insert(identity);
    }

    #[cfg(test)]
    fn insert(&mut self, name: String, kind: ToolKind) {
        self.insert_tool(
            name.clone(),
            ToolIdentity {
                name,
                namespace: None,
                kind,
            },
        );
    }

    fn is_custom(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .or_else(|| {
                self.wire_name(None, name)
                    .and_then(|wire_name| self.tools.get(wire_name))
            })
            .map(|tool| &tool.kind)
            == Some(&ToolKind::Custom)
    }

    fn identity(&self, wire_name: &str) -> Option<&ToolIdentity> {
        self.tools.get(wire_name)
    }

    pub(super) fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    fn wire_name(&self, namespace: Option<&str>, name: &str) -> Option<&str> {
        self.wire_names
            .get(&(namespace.map(str::to_owned), name.to_owned()))
            .map(String::as_str)
    }
}

#[cfg(test)]
pub(super) fn responses_to_chat(body: &Value) -> Result<(Value, ToolContext), String> {
    responses_to_chat_with_model_hint(body, None)
}

pub(super) fn responses_to_chat_with_model_hint(
    body: &Value,
    model_hint: Option<&str>,
) -> Result<(Value, ToolContext), String> {
    responses_to_chat_with_namespace_mode(body, model_hint, true, true)
}

pub(super) fn responses_to_chat_for_anthropic(
    body: &Value,
) -> Result<(Value, ToolContext), String> {
    responses_to_chat_with_namespace_mode(body, None, false, false)
}

fn responses_to_chat_with_namespace_mode(
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

fn copy_field(body: &Value, result: &mut Map<String, Value>, source: &str, target: &str) {
    if let Some(value) = body.get(source) {
        result.insert(target.to_owned(), value.clone());
    }
}

fn effective_tools(body: &Value) -> Vec<Value> {
    let mut tools = body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for searched_tool in body
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("tool_search_output"))
        .flat_map(|item| {
            item.get("tools")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
    {
        merge_effective_tool(&mut tools, searched_tool);
    }
    tools
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
        }
    }
}

fn build_tool_context(tools: &[Value], preserve_namespace: bool) -> ToolContext {
    let name_counts = tool_name_counts(tools);

    let mut context = ToolContext::default();
    for tool in tools {
        if tool.get("type").and_then(Value::as_str) == Some("tool_search") {
            let wire_name = unique_wire_name(&context, bounded_wire_name(TOOL_SEARCH_NAME));
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

fn tool_name_counts(tools: &[Value]) -> BTreeMap<String, usize> {
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

fn apply_reasoning_options(body: &Value, result: &mut Map<String, Value>, kimi_k3_compat: bool) {
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

fn reasoning_requested(body: &Value) -> Option<bool> {
    if let Some(effort) = body.pointer("/reasoning/effort").and_then(Value::as_str) {
        return Some(!matches!(
            effort.trim().to_ascii_lowercase().as_str(),
            "none" | "off" | "disabled"
        ));
    }
    body.get("reasoning").map(|reasoning| !reasoning.is_null())
}

fn is_kimi_k3_model(model: &str) -> bool {
    model.trim().to_ascii_lowercase().contains("kimi-k3")
}

fn request_uses_kimi_k3(body: &Value, model_hint: Option<&str>) -> bool {
    model_hint.is_some_and(is_kimi_k3_model)
        || body
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(is_kimi_k3_model)
}

fn flattened_namespace_tool_name(namespace: &str, name: &str) -> String {
    let flattened = if namespace.ends_with('_') || name.starts_with('_') {
        format!("{namespace}{name}")
    } else {
        format!("{namespace}__{name}")
    };
    bounded_wire_name(&flattened)
}

fn bounded_wire_name(value: &str) -> String {
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

fn unique_wire_name(context: &ToolContext, preferred: String) -> String {
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

fn chat_tools(tools: &[Value], context: &ToolContext, kimi_k3_compat: bool) -> Vec<Value> {
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

fn chat_tool_search(tool: &Value, context: &ToolContext, kimi_k3_compat: bool) -> Option<Value> {
    let wire_name = context.wire_name(None, TOOL_SEARCH_NAME)?;
    let mut function = Map::new();
    function.insert("name".to_owned(), Value::String(wire_name.to_owned()));
    if let Some(description) = tool.get("description") {
        function.insert("description".to_owned(), description.clone());
    }
    function.insert(
        "parameters".to_owned(),
        normalize_function_parameters(tool.get("parameters"), kimi_k3_compat),
    );
    Some(json!({"type": "function", "function": function}))
}

fn chat_tool(
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

fn normalize_function_parameters(parameters: Option<&Value>, kimi_k3_compat: bool) -> Value {
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

fn ensure_function_parameters_object_type(schema: &mut Value) {
    let object = schema
        .as_object_mut()
        .expect("normalized function parameters must be an object");
    if object.get("type").and_then(Value::as_str) != Some("object") {
        object.insert("type".to_owned(), Value::String("object".to_owned()));
    }
}

fn normalize_kimi_k3_schema(schema: &mut Value) {
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

fn move_compatible_parent_type_to_any_of(schema: &mut Map<String, Value>) {
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

fn nest_root_any_of_constraint(schema: &mut Value) {
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

fn responses_tools(
    tools: &[Value],
    context: &ToolContext,
    convert_custom_tools: bool,
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
                if let Some(description) = tool.get("description") {
                    function.insert("description".to_owned(), description.clone());
                }
                function.insert(
                    "parameters".to_owned(),
                    tool.get("parameters").cloned().unwrap_or_else(|| {
                        json!({
                            "type": "object",
                            "properties": {},
                            "additionalProperties": false
                        })
                    }),
                );
                converted.push(Value::Object(function));
                continue;
            }
            Some("namespace") => {
                if !bridge_namespace_tools {
                    converted.push(tool.clone());
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
                    let mut flattened = inner_tool.clone();
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
        converted.push(if convert_custom_tools && context.is_custom(name) {
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
    converted
}

fn responses_tool_choice(
    choice: &Value,
    context: &ToolContext,
    convert_custom_tools: bool,
    bridge_namespace_tools: bool,
) -> Option<Value> {
    let choice_type = choice.get("type").and_then(Value::as_str)?;
    if choice_type == "custom" && convert_custom_tools {
        let mut converted = choice.clone();
        converted["type"] = Value::String("function".to_owned());
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
pub(super) fn responses_to_responses(
    body: &Value,
    convert_custom_tools: bool,
    native_tool_search: bool,
    native_namespace_tools: bool,
) -> Result<(Value, ToolContext), String> {
    let mut result = body.clone();
    let effective_tools = effective_tools(&result);
    let context = build_tool_context(&effective_tools, true);
    let bridge_tool_search = !native_tool_search;
    let bridge_namespace_tools = !native_namespace_tools;

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

fn convert_responses_input_items(
    input: &Value,
    context: &ToolContext,
    convert_custom_tools: bool,
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

fn responses_call_identities(
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
        let Some(identity) = context
            .wire_name(namespace, name)
            .and_then(|wire_name| context.identity(wire_name))
        else {
            continue;
        };
        identities.insert(call_id.to_owned(), identity.clone());
    }
    identities
}

fn move_responses_tool_output_images(
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

fn is_tool_output_item(item_type: Option<&str>) -> bool {
    matches!(
        item_type,
        Some("function_call_output") | Some("custom_tool_call_output") | Some("tool_search_output")
    )
}

fn convert_responses_input_item(
    item: &Value,
    context: &ToolContext,
    call_id_to_identity: &HashMap<String, ToolIdentity>,
    convert_custom_tools: bool,
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
        Some("custom_tool_call") if convert_custom_tools && context.is_custom(name) => {
            let mut converted = item.clone();
            converted["type"] = Value::String("function_call".to_owned());
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
                if convert_custom_tools && identity.kind == ToolKind::Custom {
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
            let Some(wire_name) = context.wire_name(namespace, name) else {
                return Ok(item.clone());
            };
            if namespace.is_none() || wire_name == name {
                return Ok(item.clone());
            }
            let mut converted = item.clone();
            converted["name"] = Value::String(wire_name.to_owned());
            converted.as_object_mut().unwrap().remove("namespace");
            Ok(converted)
        }
        _ => Ok(item.clone()),
    }
}

fn responses_bridge_context(
    context: &ToolContext,
    convert_custom_tools: bool,
    bridge_tool_search: bool,
    bridge_namespace_tools: bool,
) -> ToolContext {
    let mut bridged = ToolContext::default();
    for (wire_name, identity) in &context.tools {
        let include = match identity.kind {
            ToolKind::Custom => convert_custom_tools,
            ToolKind::ToolSearch => bridge_tool_search,
            ToolKind::Function => bridge_namespace_tools && identity.namespace.is_some(),
        };
        if include {
            bridged.insert_tool(wire_name.clone(), identity.clone());
        }
    }
    bridged
}

fn chat_tool_choice(choice: &Value, context: &ToolContext) -> Value {
    if let Some(name) = choice.get("name").and_then(Value::as_str) {
        let namespace = choice.get("namespace").and_then(Value::as_str);
        let wire_name = context.wire_name(namespace, name).unwrap_or(name);
        json!({"type": "function", "function": {"name": wire_name}})
    } else {
        choice.clone()
    }
}

fn append_input(
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

fn append_chat_tool_output(
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

pub(super) fn friendly_apply_patch_output(output: &str) -> String {
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

fn flush_calls(
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

fn merge_reasoning_content(message: &mut Value, reasoning: &mut String) {
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

fn attach_pending_reasoning_to_previous_assistant(
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

fn backfill_kimi_tool_call_reasoning(messages: &mut [Value]) {
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

fn chat_content(content: &Value) -> Value {
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

fn collapse_system_messages(messages: Vec<Value>) -> Vec<Value> {
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

fn reasoning_text(item: &Value) -> String {
    item.get("summary")
        .or_else(|| item.get("content"))
        .map(text_value)
        .unwrap_or_default()
}

fn message_reasoning_text(item: &Value) -> String {
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

fn text_value(value: &Value) -> String {
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

#[derive(Debug, Default)]
struct ToolOutput {
    text: String,
    images: Vec<Value>,
}

fn split_tool_output(value: &Value) -> ToolOutput {
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

fn is_tool_output_image(part: &Value) -> bool {
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

fn tool_image_output_notice() -> &'static str {
    "[Image output attached in the following user message.]"
}

fn append_tool_image_content(
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

fn flush_tool_image_content_to_chat(
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

fn flush_tool_image_content_to_responses(input: &mut Vec<Value>, pending_content: &mut Vec<Value>) {
    if !pending_content.is_empty() {
        input.push(json!({
            "type": "message",
            "role": "user",
            "content": std::mem::take(pending_content)
        }));
    }
}

fn json_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) if !value.trim().is_empty() => value.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned()),
        None => "{}".to_owned(),
    }
}

fn append_text(target: &mut String, value: &str) {
    if value.is_empty() {
        return;
    }
    if !target.is_empty() {
        target.push_str("\n\n");
    }
    target.push_str(value);
}

#[derive(Debug, Default)]
struct TextState {
    started: bool,
    text: String,
    output_index: u32,
    item_id: String,
}

#[derive(Debug, Default)]
struct ReasoningState {
    started: bool,
    text: String,
    output_index: u32,
    item_id: String,
}

#[derive(Debug, Default)]
struct CallState {
    started: bool,
    output_index: u32,
    item_id: String,
    call_id: String,
    name: String,
    namespace: Option<String>,
    custom: bool,
    tool_search: bool,
    arguments: String,
}

#[derive(Debug)]
struct ChatStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    pending_utf8: Vec<u8>,
    output: std::collections::VecDeque<Result<Bytes, std::io::Error>>,
    context: ToolContext,
    response_started: bool,
    completed: bool,
    response_id: String,
    model: String,
    created_at: u64,
    next_output_index: u32,
    text: TextState,
    reasoning: ReasoningState,
    calls: BTreeMap<usize, CallState>,
    usage: Value,
    finish_reason: Option<String>,
    saw_done: bool,
    saw_choice: bool,
}

/// State kept while rewriting ordinary Responses function calls back into
/// Codex-native custom, namespace, and tool-search calls.
struct ResponsesToolState {
    context: ToolContext,
    calls: HashMap<String, ResponsesToolCallState>,
}

#[derive(Default)]
struct ResponsesToolCallState {
    identity: Option<ToolIdentity>,
    arguments: String,
    done: bool,
}

impl ResponsesToolState {
    fn bridged_identity(&self, item: &Value) -> Option<ToolIdentity> {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            return None;
        }
        let name = item.get("name").and_then(Value::as_str)?;
        let identity = self.context.identity(name)?;
        if identity.kind == ToolKind::Function && identity.namespace.is_none() {
            return None;
        }
        Some(identity.clone())
    }

    fn start_call(&mut self, item_id: &str, identity: ToolIdentity) {
        self.calls.entry(item_id.to_owned()).or_default().identity = Some(identity);
    }

    fn append_arguments(&mut self, item_id: &str, delta: &str) {
        if let Some(state) = self.calls.get_mut(item_id) {
            state.arguments.push_str(delta);
        }
    }

    fn finish_arguments(&mut self, item_id: &str, arguments: Option<&str>) {
        let Some(state) = self.calls.get_mut(item_id) else {
            return;
        };
        if let Some(arguments) = arguments {
            state.arguments = arguments.to_owned();
        }
        state.done = true;
    }

    fn identity(&self, item_id: &str) -> Option<&ToolIdentity> {
        self.calls.get(item_id)?.identity.as_ref()
    }

    fn arguments(&self, item_id: &str) -> Option<&str> {
        let state = self.calls.get(item_id)?;
        (!state.arguments.is_empty()).then_some(state.arguments.as_str())
    }

    fn custom_input(&self, item_id: &str) -> Option<String> {
        let state = self.calls.get(item_id)?;
        if state.arguments.is_empty() {
            return None;
        }
        extract_custom_tool_input(&state.arguments)
    }
}

fn extract_custom_tool_input(arguments: &str) -> Option<String> {
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

fn restore_responses_tool_item(item: &mut Value, identity: &ToolIdentity, arguments: Option<&str>) {
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
        ToolKind::Function => {
            item["name"] = Value::String(identity.name.clone());
            if let Some(namespace) = &identity.namespace {
                item["namespace"] = Value::String(namespace.clone());
            }
        }
    }
}

/// Transform a Responses API SSE stream back into Codex-native tool events.
pub(super) fn responses_sse_to_responses<S, E>(
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
                    Ok(super::responses_failed_event(
                        "Upstream Responses stream ended before a terminal event",
                    )),
                    state,
                ));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) = super::append_stream_utf8(
                        &mut state.pending,
                        &mut state.pending_utf8,
                        &bytes,
                    ) {
                        state.source_done = true;
                        state.terminal_seen = true;
                        return Some((
                            Ok(super::responses_failed_event(&error.to_string())),
                            state,
                        ));
                    }
                    while let Some(block) = super::take_sse_block(&mut state.pending) {
                        if super::is_responses_terminal_event(&block) {
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
                    return Some((Ok(super::responses_failed_event(&error.to_string())), state));
                }
                None => {
                    state.source_done = true;
                    if let Err(error) = super::finish_stream_utf8(&state.pending_utf8) {
                        state.terminal_seen = true;
                        return Some((
                            Ok(super::responses_failed_event(&error.to_string())),
                            state,
                        ));
                    }
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        let trailing = trailing.trim_end();
                        if super::is_responses_terminal_event(trailing) {
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

struct ResponsesStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    pending_utf8: Vec<u8>,
    output: std::collections::VecDeque<Result<Bytes, std::io::Error>>,
    context_state: ResponsesToolState,
    source_done: bool,
    terminal_seen: bool,
}

fn rewrite_responses_sse_block(block: &str, state: &mut ResponsesToolState) -> Option<String> {
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

fn normalize_responses_stream_ids(value: &mut Value) -> bool {
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

fn normalize_responses_item_ids(item: &mut Value) -> bool {
    normalize_id_field(item, "id") | normalize_id_field(item, "call_id")
}

fn normalize_id_field(value: &mut Value, field: &str) -> bool {
    let Some(id) = value.get(field).and_then(Value::as_str) else {
        return false;
    };
    let normalized = super::normalized_responses_api_id(id);
    if normalized != id {
        value[field] = Value::String(normalized);
        return true;
    }
    false
}

fn format_sse_event(event: &str, data: &Value) -> String {
    format!(
        "event: {}\ndata: {}\n\n",
        event,
        serde_json::to_string(data).unwrap_or_default()
    )
}

fn rewrite_event_data(block: &str, value: &Value) -> Option<String> {
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

pub(super) fn chat_sse_to_responses<S, E>(
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
                    if let Err(error) = super::append_stream_utf8(
                        &mut state.pending,
                        &mut state.pending_utf8,
                        &bytes,
                    ) {
                        let event = state.failed_event(error.to_string());
                        state.completed = true;
                        return Some((Ok(event), state));
                    }
                    while let Some(block) = super::take_sse_block(&mut state.pending) {
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
                    if let Err(error) = super::finish_stream_utf8(&state.pending_utf8) {
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

impl<S> ChatStreamState<S> {
    fn emit(&mut self, event: Bytes) {
        self.output.push_back(Ok(event));
    }

    fn handle_block(&mut self, block: &str, strict: bool) {
        let mut event_name = None;
        let mut data_lines = Vec::new();
        for raw_line in block.lines() {
            let line = raw_line.trim_start_matches('\u{feff}').trim_start();
            if let Some(value) = line.strip_prefix("event:") {
                event_name = Some(value.trim());
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.trim_start());
            }
        }
        if data_lines.is_empty() {
            return;
        }
        let data = data_lines.join("\n");
        let data = data.trim();
        if data == "[DONE]" {
            self.saw_done = true;
            self.finish();
            return;
        }
        let chunk = match serde_json::from_str::<Value>(data) {
            Ok(chunk) => chunk,
            Err(_) if !strict => return,
            Err(error) => {
                self.emit(
                    self.failed_event(format!("Failed to parse upstream SSE chunk: {error}")),
                );
                self.completed = true;
                return;
            }
        };
        if event_name.is_some_and(|value| value.eq_ignore_ascii_case("error")) {
            let message = meaningful_error_message(chunk.get("error").unwrap_or(&chunk))
                .unwrap_or_else(|| "upstream error event in SSE stream".to_owned());
            self.emit(self.failed_event(message));
            self.completed = true;
            return;
        }
        if let Some(message) = chunk.get("error").and_then(meaningful_error_message) {
            self.emit(self.failed_event(message));
            self.completed = true;
            return;
        }
        self.handle_chunk(&chunk);
    }

    fn handle_chunk(&mut self, chunk: &Value) {
        if let Some(id) = chunk.get("id").and_then(Value::as_str) {
            self.response_id = format!("resp_{}", id.trim_start_matches("chatcmpl-"));
        }
        if let Some(model) = chunk.get("model").and_then(Value::as_str) {
            self.model = model.to_owned();
        }
        if let Some(created) = chunk.get("created").and_then(Value::as_u64) {
            self.created_at = created;
        }
        if let Some(usage) = chunk.get("usage").filter(|value| !value.is_null()) {
            self.usage = responses_usage(Some(usage));
        }
        self.ensure_started();

        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| {
                choices
                    .iter()
                    .find(|choice| choice.get("index").and_then(Value::as_u64).unwrap_or(0) == 0)
            })
        else {
            return;
        };
        self.saw_choice = true;
        let delta_nonempty = choice
            .get("delta")
            .and_then(Value::as_object)
            .is_some_and(|value| !value.is_empty());
        let (payload, is_snapshot) = if delta_nonempty {
            (choice.get("delta"), false)
        } else if choice.get("message").is_some() {
            (choice.get("message"), true)
        } else {
            (choice.get("delta"), false)
        };
        if let Some(payload) = payload {
            if let Some(reasoning) = reasoning_delta(payload) {
                let delta = if is_snapshot {
                    snapshot_suffix(&self.reasoning.text, &reasoning).to_owned()
                } else {
                    reasoning
                };
                self.push_reasoning(&delta);
            }
            if let Some(content) = content_delta(payload) {
                let delta = if is_snapshot {
                    snapshot_suffix(&self.text.text, &content).to_owned()
                } else {
                    content
                };
                self.push_text(&delta);
            }
            if let Some(calls) = payload.get("tool_calls").and_then(Value::as_array) {
                for (position, call) in calls.iter().enumerate() {
                    self.push_call(call, position, is_snapshot);
                }
            } else if let Some(function_call) = payload.get("function_call") {
                self.push_call(
                    &json!({
                        "index": 0,
                        "id": function_call.get("id").cloned().unwrap_or(Value::Null),
                        "function": function_call
                    }),
                    0,
                    is_snapshot,
                );
            }
        }
        if self.finish_reason.is_none() {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_owned());
            }
        }
    }

    fn ensure_started(&mut self) {
        if self.response_started {
            return;
        }
        self.response_started = true;
        let response = self.response("in_progress", Vec::new());
        self.emit(sse(
            "response.created",
            json!({"type": "response.created", "response": response}),
        ));
        self.emit(sse(
            "response.in_progress",
            json!({"type": "response.in_progress", "response": response}),
        ));
    }

    fn next_index(&mut self) -> u32 {
        let result = self.next_output_index;
        self.next_output_index += 1;
        result
    }

    fn push_reasoning(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if !self.reasoning.started {
            let output_index = self.next_index();
            let item_id = format!("rs_{}", self.response_id);
            self.reasoning.started = true;
            self.reasoning.output_index = output_index;
            self.reasoning.item_id = item_id.clone();
            let item =
                json!({"id": item_id, "type": "reasoning", "status": "in_progress", "summary": []});
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
            self.emit(sse("response.reasoning_summary_part.added", json!({"type": "response.reasoning_summary_part.added", "item_id": item_id, "output_index": output_index, "summary_index": 0, "part": {"type": "summary_text", "text": ""}})));
        }
        self.reasoning.text.push_str(delta);
        self.emit(sse("response.reasoning_summary_text.delta", json!({"type": "response.reasoning_summary_text.delta", "item_id": self.reasoning.item_id, "output_index": self.reasoning.output_index, "summary_index": 0, "delta": delta})));
    }

    fn push_text(&mut self, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if !self.text.started {
            let output_index = self.next_index();
            let item_id = format!("{}_msg", self.response_id);
            self.text.started = true;
            self.text.output_index = output_index;
            self.text.item_id = item_id.clone();
            let item = json!({"id": item_id, "type": "message", "status": "in_progress", "role": "assistant", "content": []});
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
            self.emit(sse("response.content_part.added", json!({"type": "response.content_part.added", "item_id": item_id, "output_index": output_index, "content_index": 0, "part": {"type": "output_text", "text": "", "annotations": []}})));
        }
        self.text.text.push_str(delta);
        self.emit(sse("response.output_text.delta", json!({"type": "response.output_text.delta", "item_id": self.text.item_id, "output_index": self.text.output_index, "content_index": 0, "delta": delta})));
    }

    fn push_call(&mut self, call: &Value, fallback_index: usize, is_snapshot: bool) {
        let index = call
            .get("index")
            .and_then(Value::as_u64)
            .map(|value| value as usize)
            .unwrap_or(fallback_index);
        let id = call.get("id").and_then(Value::as_str).unwrap_or_default();
        let function = call.get("function").unwrap_or(&Value::Null);
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let arguments = match function.get("arguments") {
            Some(Value::String(value)) => value.clone(),
            Some(value) if !value.is_null() => {
                serde_json::to_string(value).unwrap_or_else(|_| "{}".to_owned())
            }
            _ => String::new(),
        };
        let (
            needs_start,
            call_id,
            complete_name,
            complete_namespace,
            custom,
            tool_search,
            matched_tool,
        ) = {
            let state = self.calls.entry(index).or_default();
            if !id.is_empty() {
                state.call_id = super::normalized_responses_api_id(id);
            }
            let mut matched_tool = false;
            if !name.is_empty() {
                if let Some(identity) = self.context.identity(name) {
                    state.name = identity.name.clone();
                    state.namespace = identity.namespace.clone();
                    state.custom = identity.kind == ToolKind::Custom;
                    state.tool_search = identity.kind == ToolKind::ToolSearch;
                    matched_tool = true;
                } else {
                    state.name = name.to_owned();
                    state.namespace = None;
                    state.custom = false;
                    state.tool_search = false;
                }
            }
            if !arguments.is_empty() {
                if is_snapshot {
                    state.arguments = arguments.clone();
                } else {
                    state.arguments.push_str(&arguments);
                }
            }
            (
                !state.started && !state.name.is_empty(),
                state.call_id.clone(),
                state.name.clone(),
                state.namespace.clone(),
                state.custom,
                state.tool_search,
                matched_tool,
            )
        };
        if needs_start {
            let output_index = self.next_index();
            let call_id = if call_id.is_empty() {
                format!("call_{index}")
            } else {
                call_id
            };
            let item_id = format!("fc_{}", call_id.trim_start_matches("call_"));
            let state = self.calls.entry(index).or_default();
            state.started = true;
            state.output_index = output_index;
            state.item_id = item_id.clone();
            state.call_id = call_id.clone();
            let item_type = if tool_search {
                "tool_search_call"
            } else if custom {
                "custom_tool_call"
            } else {
                "function_call"
            };
            let mut item = if tool_search {
                json!({
                    "id": item_id,
                    "type": item_type,
                    "status": "in_progress",
                    "call_id": call_id,
                    "execution": "client",
                    "arguments": {}
                })
            } else if item_type == "custom_tool_call" {
                json!({"id": item_id, "type": item_type, "status": "in_progress", "call_id": call_id, "name": complete_name.clone(), "input": ""})
            } else {
                json!({"id": item_id, "type": item_type, "status": "in_progress", "call_id": call_id, "name": complete_name.clone(), "arguments": ""})
            };
            if let Some(namespace) = complete_namespace {
                item["namespace"] = Value::String(namespace);
            }
            log_executor_event(
                "local model proxy tool call started",
                &[
                    ("call_index", index.to_string()),
                    ("upstream_tool_name", name.to_owned()),
                    ("resolved_tool_name", complete_name),
                    ("matched_tool", matched_tool.to_string()),
                    (
                        "namespace",
                        item.get("namespace")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ),
                    ("custom_tool", custom.to_string()),
                    ("tool_search", tool_search.to_string()),
                ],
            );
            self.emit(sse("response.output_item.added", json!({"type": "response.output_item.added", "output_index": output_index, "item": item})));
        }
        if !arguments.is_empty() {
            let (output_index, item_id, custom, tool_search) = {
                let state = self.calls.entry(index).or_default();
                (
                    state.output_index,
                    state.item_id.clone(),
                    state.custom,
                    state.tool_search,
                )
            };
            if !custom && !tool_search && !item_id.is_empty() {
                let event = "response.function_call_arguments.delta";
                self.emit(sse(event, json!({"type": event, "item_id": item_id, "output_index": output_index, "delta": arguments})));
            }
        }
    }

    fn finish(&mut self) {
        if self.completed {
            return;
        }
        if !self.saw_choice {
            self.completed = true;
            self.emit(
                self.failed_event("Upstream stream ended without a completion choice".to_owned()),
            );
            return;
        }
        self.ensure_started();
        self.completed = true;
        let tool_call_count = self.calls.values().filter(|state| state.started).count();
        log_executor_event(
            "local model proxy chat completion summary",
            &[
                ("model", self.model.clone()),
                (
                    "finish_reason",
                    self.finish_reason.clone().unwrap_or_default(),
                ),
                ("text_bytes", self.text.text.len().to_string()),
                ("reasoning_bytes", self.reasoning.text.len().to_string()),
                ("tool_calls", tool_call_count.to_string()),
                (
                    "empty_output",
                    (!self.text.started && !self.reasoning.started && tool_call_count == 0)
                        .to_string(),
                ),
            ],
        );
        let mut output = Vec::new();
        if self.reasoning.started {
            let item = json!({"id": self.reasoning.item_id, "type": "reasoning", "status": "completed", "summary": [{"type": "summary_text", "text": self.reasoning.text}]});
            self.emit(sse("response.reasoning_summary_text.done", json!({"type": "response.reasoning_summary_text.done", "item_id": self.reasoning.item_id, "output_index": self.reasoning.output_index, "summary_index": 0, "text": self.reasoning.text})));
            self.emit(sse("response.reasoning_summary_part.done", json!({"type": "response.reasoning_summary_part.done", "item_id": self.reasoning.item_id, "output_index": self.reasoning.output_index, "summary_index": 0, "part": {"type": "summary_text", "text": self.reasoning.text}})));
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": self.reasoning.output_index, "item": item})));
            output.push((self.reasoning.output_index, item));
        }
        if self.text.started {
            let part = json!({"type": "output_text", "text": self.text.text, "annotations": []});
            let item = json!({"id": self.text.item_id, "type": "message", "status": "completed", "role": "assistant", "content": [part]});
            self.emit(sse("response.output_text.done", json!({"type": "response.output_text.done", "item_id": self.text.item_id, "output_index": self.text.output_index, "content_index": 0, "text": self.text.text})));
            self.emit(sse("response.content_part.done", json!({"type": "response.content_part.done", "item_id": self.text.item_id, "output_index": self.text.output_index, "content_index": 0, "part": part})));
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": self.text.output_index, "item": item})));
            output.push((self.text.output_index, item));
        }
        let calls = std::mem::take(&mut self.calls);
        for (_, state) in calls {
            if !state.started {
                continue;
            }
            log_executor_event(
                "local model proxy tool call completed",
                &[
                    ("tool_name", state.name.clone()),
                    ("namespace", state.namespace.clone().unwrap_or_default()),
                    ("custom_tool", state.custom.to_string()),
                    ("tool_search", state.tool_search.to_string()),
                    ("arguments_bytes", state.arguments.len().to_string()),
                ],
            );
            let custom = state.custom;
            let tool_search = state.tool_search;
            let arguments = if custom {
                custom_input(&state.name, &state.arguments)
            } else {
                normalize_arguments(&state.arguments)
            };
            let mut item = if tool_search {
                json!({
                    "id": state.item_id,
                    "type": "tool_search_call",
                    "status": "completed",
                    "call_id": state.call_id,
                    "execution": "client",
                    "arguments": serde_json::from_str::<Value>(&arguments)
                        .unwrap_or_else(|_| json!({}))
                })
            } else if custom {
                json!({"id": state.item_id, "type": "custom_tool_call", "status": "completed", "call_id": state.call_id, "name": state.name, "input": arguments})
            } else {
                json!({"id": state.item_id, "type": "function_call", "status": "completed", "call_id": state.call_id, "name": state.name, "arguments": arguments})
            };
            if let Some(namespace) = state.namespace {
                item["namespace"] = Value::String(namespace);
            }
            let done_event = if tool_search {
                None
            } else if custom {
                Some("response.custom_tool_call_input.done")
            } else {
                Some("response.function_call_arguments.done")
            };
            if custom && !arguments.is_empty() {
                let delta_event = "response.custom_tool_call_input.delta";
                self.emit(sse(
                    delta_event,
                    json!({
                        "type": delta_event,
                        "item_id": state.item_id,
                        "output_index": state.output_index,
                        "delta": arguments
                    }),
                ));
            }
            if let Some(done_event) = done_event {
                let done_payload = if custom {
                    json!({"type": done_event, "item_id": state.item_id, "output_index": state.output_index, "input": arguments})
                } else {
                    json!({"type": done_event, "item_id": state.item_id, "output_index": state.output_index, "arguments": arguments})
                };
                self.emit(sse(done_event, done_payload));
            }
            self.emit(sse("response.output_item.done", json!({"type": "response.output_item.done", "output_index": state.output_index, "item": item})));
            output.push((state.output_index, item));
        }
        output.sort_by_key(|(index, _)| *index);
        let incomplete = self.finish_reason.as_deref() == Some("length");
        let status = if incomplete {
            "incomplete"
        } else {
            "completed"
        };
        let event = if incomplete {
            "response.incomplete"
        } else {
            "response.completed"
        };
        let response = self.response(status, output.into_iter().map(|(_, value)| value).collect());
        self.emit(sse(event, json!({"type": event, "response": response})));
    }

    fn response(&self, status: &str, output: Vec<Value>) -> Value {
        json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "status": status,
            "model": self.model,
            "output": output,
            "usage": self.usage,
            "error": Value::Null,
            "incomplete_details": if status == "incomplete" { json!({"reason": "max_output_tokens"}) } else { Value::Null }
        })
    }

    fn failed_event(&self, message: String) -> Bytes {
        let mut response = self.response("failed", Vec::new());
        response["error"] = json!({"type": "upstream_error", "message": message});
        sse(
            "response.failed",
            json!({"type": "response.failed", "response": response}),
        )
    }
}

fn reasoning_delta(delta: &Value) -> Option<String> {
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

fn content_delta(payload: &Value) -> Option<String> {
    let mut content = payload.get("content").map(text_value).unwrap_or_default();
    if let Some(refusal) = payload.get("refusal").and_then(Value::as_str) {
        content.push_str(refusal);
    }
    (!content.is_empty()).then_some(content)
}

fn snapshot_suffix<'a>(existing: &str, snapshot: &'a str) -> &'a str {
    snapshot.strip_prefix(existing).unwrap_or(snapshot)
}

fn meaningful_error_message(value: &Value) -> Option<String> {
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

fn custom_input(tool_name: &str, arguments: &str) -> String {
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

fn log_apply_patch_diagnostics(
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

fn normalize_apply_patch_input(input: &str) -> String {
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

fn normalize_arguments(arguments: &str) -> String {
    if arguments.trim().is_empty() {
        "{}".to_owned()
    } else {
        arguments.to_owned()
    }
}

fn responses_usage(usage: Option<&Value>) -> Value {
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

fn sse(event: &str, data: Value) -> Bytes {
    Bytes::from(format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(&data).unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    fn typed_any_of_parameters() -> Value {
        json!({
            "type": "object",
            "properties": {
                "project_id": {"type": "string"},
                "title": {"type": "string"},
                "metadata": {
                    "type": "object",
                    "anyOf": [
                        {"type": "object", "required": ["label"]},
                        {"required": ["description"]}
                    ]
                }
            },
            "required": ["project_id"],
            "anyOf": [
                {"type": "object", "required": ["title"]},
                {"type": "object", "required": ["metadata"]}
            ],
            "additionalProperties": false
        })
    }

    #[test]
    fn converts_responses_request_with_history_and_custom_tool() {
        let input = json!({
            "model": "kimi-for-coding",
            "instructions": "You are a coding agent.",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Edit it"}]},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Need patch"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
            ],
            "tools": [{"type": "custom", "name": "apply_patch", "description": "Patch files"}],
            "stream": true
        });

        let (converted, context) = responses_to_chat(&input).expect("request should convert");
        assert!(context.is_custom("apply_patch"));
        assert!(converted["tools"][0]["function"]["description"]
            .as_str()
            .is_some_and(|value| value.contains("Original tool definition:")));
        let description = converted["tools"][0]["function"]["description"]
            .as_str()
            .expect("custom tool description");
        assert!(description.starts_with("Critical apply_patch input contract:"));
        assert!(description.contains("exactly `*** Begin Patch\\n`"));
        assert!(description.contains("with no blank line"));
        assert!(description.contains("Do not include Markdown code fences"));
        assert!(description.contains("every added-file content line must start with `+`"));
        assert!(description.contains("*** Add File: hello.txt\n+first line\n+\n+third line"));
        assert!(description.contains("*** Update File: hello.txt\n@@\n-old line\n+new line"));
        assert_eq!(
            converted["tools"][0]["function"]["parameters"]["properties"]["input"]["description"],
            CUSTOM_TOOL_INPUT_DESCRIPTION
        );
        assert_eq!(converted["messages"][0]["role"], "system");
        assert_eq!(
            converted["messages"][2]["tool_calls"][0]["function"]["name"],
            "apply_patch"
        );
        assert_eq!(converted["messages"][2]["reasoning_content"], "Need patch");
        assert_eq!(converted["messages"][3]["role"], "tool");
        assert_eq!(converted["stream_options"]["include_usage"], true);
    }

    #[test]
    fn moves_tool_output_images_to_a_multimodal_user_message() {
        let input = json!({
            "model": "kimi-k3",
            "input": [
                {"type": "function_call", "call_id": "image_1", "name": "view_image", "arguments": "{}"},
                {"type": "function_call", "call_id": "text_1", "name": "exec_command", "arguments": "{}"},
                {
                    "type": "function_call_output",
                    "call_id": "image_1",
                    "output": [{
                        "type": "input_image",
                        "image_url": "data:image/png;base64,aGVsbG8="
                    }]
                },
                {"type": "function_call_output", "call_id": "text_1", "output": "done"}
            ],
            "tools": [
                {"type": "function", "name": "view_image", "parameters": {"type": "object"}},
                {"type": "function", "name": "exec_command", "parameters": {"type": "object"}}
            ]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let messages = converted["messages"].as_array().expect("messages");

        assert_eq!(messages.len(), 4);
        assert_eq!(messages[0]["role"], "assistant");
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "image_1");
        assert_eq!(
            messages[1]["content"],
            "[Image output attached in the following user message.]"
        );
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[2]["tool_call_id"], "text_1");
        assert_eq!(messages[2]["content"], "done");
        assert_eq!(messages[3]["role"], "user");
        assert_eq!(
            messages[3]["content"][0]["text"],
            "Image output from tool view_image:"
        );
        assert_eq!(messages[3]["content"][1]["type"], "image_url");
        assert_eq!(
            messages[3]["content"][1]["image_url"]["url"],
            "data:image/png;base64,aGVsbG8="
        );
        assert!(!messages[1]["content"]
            .as_str()
            .is_some_and(|content| content.contains("aGVsbG8=")));
    }

    #[test]
    fn converts_user_input_images_to_chat_image_parts() {
        let input = json!({
            "model": "kimi-k3",
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Describe this image"},
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64,dXNlci1pbWFnZQ=="
                    }
                ]
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(converted["messages"][0]["content"][0]["type"], "text");
        assert_eq!(converted["messages"][0]["content"][1]["type"], "image_url");
        assert_eq!(
            converted["messages"][0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,dXNlci1pbWFnZQ=="
        );
    }

    #[test]
    fn preserves_tool_text_and_structured_content_while_extracting_images() {
        let mixed = split_tool_output(&json!([
            {"type": "text", "text": "Rendered preview"},
            {"type": "input_image", "image_url": "data:image/png;base64,bWl4ZWQ="}
        ]));
        assert_eq!(mixed.text, "Rendered preview");
        assert_eq!(mixed.images.len(), 1);

        let structured = split_tool_output(&json!({
            "content": [
                {"type": "text", "text": "Human-readable fallback"},
                {"type": "input_image", "image_url": "data:image/jpeg;base64,cHJldmlldw=="}
            ],
            "structuredContent": {
                "width": 1280,
                "business_value": {
                    "type": "input_image",
                    "image_url": "data:image/png;base64,bm90LWEtYmxvY2s="
                }
            }
        }));
        assert_eq!(
            structured.text,
            "{\"business_value\":{\"image_url\":\"data:image/png;base64,bm90LWEtYmxvY2s=\",\"type\":\"input_image\"},\"width\":1280}"
        );
        assert_eq!(structured.images.len(), 1);
        assert_eq!(
            structured.images[0]["image_url"],
            "data:image/jpeg;base64,cHJldmlldw=="
        );

        let malformed = split_tool_output(&json!([{"type": "input_image"}]));
        assert_eq!(malformed.text, "{\"type\":\"input_image\"}");
        assert!(malformed.images.is_empty());
    }

    #[test]
    fn keeps_assistant_text_and_tool_calls_in_one_chat_message() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Inspect it"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect it."}]},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Need the logs"}]},
                {"type": "function_call", "call_id": "call_1", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "function_call_output", "call_id": "call_1", "output": "/workspace"}
            ],
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let messages = converted["messages"].as_array().expect("messages");

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["content"], "I will inspect it.");
        assert_eq!(messages[1]["reasoning_content"], "Need the logs");
        assert_eq!(
            messages[1]["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        assert_eq!(messages[2]["role"], "tool");
        assert!(!messages
            .windows(2)
            .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
    }

    #[test]
    fn flattens_namespace_tools_and_namespaced_history_for_chat() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "browser_snapshot",
                    "namespace": "wework_browser",
                    "arguments": "{}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "snapshot"
                }
            ],
            "tools": [{
                "type": "namespace",
                "name": "wework_browser",
                "description": "Wework built-in browser tools",
                "tools": [{
                    "type": "function",
                    "name": "browser_snapshot",
                    "description": "Capture the page",
                    "parameters": {"type": "object", "properties": {}}
                }]
            }],
            "tool_choice": {
                "type": "function",
                "name": "browser_snapshot",
                "namespace": "wework_browser"
            }
        });

        let (converted, context) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(converted["tools"].as_array().unwrap().len(), 1);
        assert_eq!(
            converted["tools"][0]["function"]["name"],
            "wework_browser__browser_snapshot"
        );
        assert_eq!(
            converted["messages"][0]["tool_calls"][0]["function"]["name"],
            "wework_browser__browser_snapshot"
        );
        assert_eq!(
            converted["tool_choice"]["function"]["name"],
            "wework_browser__browser_snapshot"
        );
        assert_eq!(
            context.identity("wework_browser__browser_snapshot"),
            Some(&ToolIdentity {
                name: "browser_snapshot".to_owned(),
                namespace: Some("wework_browser".to_owned()),
                kind: ToolKind::Function,
            })
        );
    }

    #[test]
    fn bridges_tool_search_and_history_for_chat_completions() {
        let input = json!({
            "model": "third-party-chat-model",
            "input": [
                {"role": "user", "content": "Find the GitHub App"},
                {
                    "type": "tool_search_call",
                    "call_id": "search_1",
                    "execution": "client",
                    "arguments": {"query": "GitHub"}
                },
                {
                    "type": "tool_search_output",
                    "call_id": "search_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": [{
                        "type": "namespace",
                        "name": "github",
                        "tools": [{
                            "type": "function",
                            "name": "create_issue",
                            "description": "Create an issue",
                            "parameters": {
                                "type": "object",
                                "properties": {"title": {"type": "string"}}
                            }
                        }]
                    }]
                }
            ],
            "tools": [{
                "type": "tool_search",
                "execution": "client",
                "description": "Search available Apps",
                "parameters": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"]
                }
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(converted["tools"][0]["type"], "function");
        assert_eq!(converted["tools"][0]["function"]["name"], "tool_search");
        assert_eq!(
            converted["tools"][1]["function"]["name"],
            "github__create_issue"
        );
        assert_eq!(
            converted["messages"][1]["tool_calls"][0]["function"]["name"],
            "tool_search"
        );
        assert_eq!(
            converted["messages"][1]["tool_calls"][0]["function"]["arguments"],
            "{\"query\":\"GitHub\"}"
        );
        assert_eq!(converted["messages"][2]["role"], "tool");
        assert!(converted["messages"][2]["content"]
            .as_str()
            .is_some_and(|value| value.contains("\"tools\"")));
    }

    #[test]
    fn preserves_structured_app_tool_results_for_chat_completions() {
        let input = json!({
            "model": "third-party-chat-model",
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "namespace": "wegent_apps",
                    "name": "wegent-sites__get_site",
                    "arguments": "{\"project_id\":\"prj_1\"}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": {
                        "_meta": null,
                        "content": [{
                            "type": "text",
                            "text": "Wegent Sites tool completed successfully."
                        }],
                        "structuredContent": {
                            "id": "prj_1",
                            "title": "Palette"
                        }
                    }
                }
            ],
            "tools": [{
                "type": "namespace",
                "name": "wegent_apps",
                "tools": [{
                    "type": "function",
                    "name": "wegent-sites__get_site",
                    "parameters": {"type": "object"}
                }]
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(
            converted["messages"][1]["content"],
            "{\"id\":\"prj_1\",\"title\":\"Palette\"}"
        );
    }

    #[test]
    fn maps_kimi_reasoning_to_thinking_toggle() {
        let input = json!({
            "model": "moonshot-kimi-k3",
            "reasoning": {"effort": "low"},
            "input": "hello"
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(converted["thinking"], json!({"type": "enabled"}));
        assert!(converted.get("reasoning_effort").is_none());
    }

    #[test]
    fn matches_only_model_names_containing_kimi_k3() {
        assert!(is_kimi_k3_model("moonshot-kimi-k3"));
        assert!(is_kimi_k3_model("vendor/MOONSHOT-KIMI-K3-turbo"));
        assert!(!is_kimi_k3_model("moonshot-v1-128k"));
        assert!(!is_kimi_k3_model("moonshotai/kimi-k2.5"));
    }

    #[test]
    fn preserves_reasoning_effort_for_non_kimi_chat_models() {
        let input = json!({
            "model": "gpt-compatible-model",
            "reasoning": {"effort": "none"},
            "input": "hello"
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(converted["reasoning_effort"], "none");
        assert!(converted.get("thinking").is_none());
    }

    #[test]
    fn keeps_kimi_reasoning_on_each_assistant_turn() {
        let input = json!({
            "model": "kimi-k3",
            "input": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "first thought"}]},
                {"type": "message", "role": "assistant", "content": "First answer."},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "second thought"}]},
                {"type": "message", "role": "assistant", "content": "Second answer."},
                {"type": "message", "role": "user", "content": "Continue"}
            ]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let messages = converted["messages"].as_array().expect("messages");

        assert_eq!(messages[0]["reasoning_content"], "first thought");
        assert_eq!(messages[1]["reasoning_content"], "second thought");
        assert!(messages[2].get("reasoning_content").is_none());
    }

    #[test]
    fn appends_trailing_kimi_reasoning_before_user_boundary() {
        let input = json!({
            "model": "kimi-k3",
            "input": [
                {
                    "type": "message",
                    "role": "assistant",
                    "reasoning_content": "Embedded thought.",
                    "content": "Done."
                },
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "Trailing thought."}]},
                {"type": "message", "role": "user", "content": "Continue"}
            ]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let messages = converted["messages"].as_array().expect("messages");

        assert_eq!(
            messages[0]["reasoning_content"],
            "Embedded thought.\n\nTrailing thought."
        );
        assert!(messages[1].get("reasoning_content").is_none());
    }

    #[test]
    fn does_not_move_reasoning_across_a_user_boundary() {
        let input = json!({
            "model": "kimi-k3",
            "input": [
                {"type": "message", "role": "assistant", "content": "Done."},
                {"type": "message", "role": "user", "content": "Continue"},
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "New thought."}]},
                {"type": "message", "role": "user", "content": "Changed direction"}
            ]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let messages = converted["messages"].as_array().expect("messages");

        assert!(messages[0].get("reasoning_content").is_none());
        assert!(messages[1].get("reasoning_content").is_none());
        assert!(messages[2].get("reasoning_content").is_none());
    }

    #[test]
    fn backfills_kimi_tool_call_reasoning_and_normalizes_parameters() {
        let input = json!({
            "model": "kimi-k3",
            "input": [{
                "type": "function_call",
                "call_id": "call_1",
                "name": "read_file",
                "arguments": "{}"
            }],
            "tools": [{
                "type": "function",
                "name": "read_file",
                "parameters": {"type": null, "properties": {}}
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");

        assert_eq!(converted["messages"][0]["reasoning_content"], "tool call");
        assert_eq!(
            converted["tools"][0]["function"]["parameters"]["type"],
            "object"
        );
    }

    #[test]
    fn normalizes_typed_any_of_schemas_for_kimi_k3() {
        let input = json!({
            "model": "kimi-k3",
            "tools": [{
                "type": "namespace",
                "name": "wegent_apps",
                "tools": [{
                    "type": "function",
                    "name": "wegent_sites__update_site_metadata",
                    "parameters": typed_any_of_parameters()
                }]
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let parameters = &converted["tools"][0]["function"]["parameters"];

        assert_eq!(parameters["type"], "object");
        assert!(parameters.get("anyOf").is_none());
        assert!(parameters["properties"]["metadata"].get("type").is_none());
        assert!(parameters["allOf"][0]["anyOf"]
            .as_array()
            .expect("root anyOf")
            .iter()
            .all(|branch| branch["type"] == "object"));
        assert!(parameters["properties"]["metadata"]["anyOf"]
            .as_array()
            .expect("nested anyOf")
            .iter()
            .all(|branch| branch["type"] == "object"));
    }

    #[test]
    fn normalizes_untyped_root_any_of_schema_for_kimi_k3() {
        let input = json!({
            "model": "kimi-k3",
            "tools": [{
                "type": "function",
                "name": "update_site_metadata",
                "parameters": {
                    "anyOf": [{"required": ["title"]}]
                }
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let parameters = &converted["tools"][0]["function"]["parameters"];

        assert_eq!(parameters["type"], "object");
        assert!(parameters.get("anyOf").is_none());
        assert_eq!(parameters["allOf"][0]["anyOf"][0]["type"], "object");
    }

    #[test]
    fn preserves_existing_root_all_of_when_nesting_any_of_for_kimi_k3() {
        let existing_constraint = json!({
            "type": "object",
            "required": ["project_id"]
        });
        let input = json!({
            "model": "kimi-k3",
            "tools": [{
                "type": "function",
                "name": "update_site_metadata",
                "parameters": {
                    "type": "object",
                    "allOf": [existing_constraint.clone()],
                    "anyOf": [{"required": ["title"]}]
                }
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let parameters = &converted["tools"][0]["function"]["parameters"];
        let all_of = parameters["allOf"].as_array().expect("root allOf");

        assert_eq!(parameters["type"], "object");
        assert_eq!(all_of.len(), 2);
        assert_eq!(all_of[0], existing_constraint);
        assert_eq!(all_of[1]["anyOf"][0]["type"], "object");
    }

    #[test]
    fn preserves_typed_any_of_schema_for_non_kimi_chat_models() {
        let input = json!({
            "model": "gpt-compatible-model",
            "tools": [{
                "type": "function",
                "name": "update_site_metadata",
                "parameters": typed_any_of_parameters()
            }]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let parameters = &converted["tools"][0]["function"]["parameters"];

        assert_eq!(parameters["type"], "object");
        assert_eq!(parameters["properties"]["metadata"]["type"], "object");
    }

    #[test]
    fn disambiguates_colliding_namespace_tool_names() {
        let input = json!({
            "tools": [
                {
                    "type": "namespace",
                    "name": "calendar",
                    "tools": [{
                        "type": "function",
                        "name": "search",
                        "parameters": {"type": "object"}
                    }]
                },
                {
                    "type": "namespace",
                    "name": "mail",
                    "tools": [{
                        "type": "function",
                        "name": "search",
                        "parameters": {"type": "object"}
                    }]
                }
            ]
        });

        let (converted, context) = responses_to_chat(&input).expect("request should convert");
        let names = converted["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(names, vec!["calendar__search", "mail__search"]);
        assert_eq!(
            context
                .identity("calendar__search")
                .and_then(|tool| tool.namespace.as_deref()),
            Some("calendar")
        );
        assert_eq!(
            context
                .identity("mail__search")
                .and_then(|tool| tool.namespace.as_deref()),
            Some("mail")
        );
    }

    #[test]
    fn keeps_legacy_anthropic_names_for_colliding_tools() {
        let input = json!({
            "tools": [
                {
                    "type": "namespace",
                    "name": "calendar",
                    "tools": [{"type": "function", "name": "search"}]
                },
                {
                    "type": "namespace",
                    "name": "mail",
                    "tools": [{"type": "function", "name": "search"}]
                },
                {"type": "function", "name": "search"}
            ]
        });

        let (converted, _) =
            responses_to_chat_for_anthropic(&input).expect("request should convert");
        let names = converted["tools"]
            .as_array()
            .expect("tools")
            .iter()
            .filter_map(|tool| tool.pointer("/function/name").and_then(Value::as_str))
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["calendar__search", "mail__search", "functions__search"]
        );
    }

    #[test]
    fn explains_apply_patch_hunk_failures_and_requests_a_retry() {
        let input = json!({
            "model": "kimi-for-coding",
            "input": [
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "apply_patch verification failed: invalid hunk at line 3"}
            ],
            "tools": [{"type": "custom", "name": "apply_patch"}]
        });

        let (converted, _) = responses_to_chat(&input).expect("request should convert");
        let output = converted["messages"][1]["content"]
            .as_str()
            .expect("tool output should be text");

        assert!(output.starts_with("apply_patch verification failed: invalid hunk at line 3"));
        assert!(output.contains("prefix unchanged lines with one space"));
        assert!(output.contains("Correct update example:"));
        assert!(output.contains("Fix the reported error and call `apply_patch` again"));
        assert!(output.contains("Do not switch to shell redirection"));
    }

    #[test]
    fn leaves_successful_apply_patch_output_unchanged() {
        assert_eq!(friendly_apply_patch_output("Done!"), "Done!");
    }

    #[test]
    fn converts_chat_usage_to_responses_usage() {
        assert_eq!(
            responses_usage(Some(&json!({
                "prompt_tokens": 12,
                "completion_tokens": 7,
                "prompt_tokens_details": {"cached_tokens": 3},
                "completion_tokens_details": {"reasoning_tokens": 4}
            }))),
            json!({
                "input_tokens": 12,
                "input_tokens_details": {"cached_tokens": 3},
                "output_tokens": 7,
                "output_tokens_details": {"reasoning_tokens": 4},
                "total_tokens": 19
            })
        );
    }

    #[tokio::test]
    async fn converts_streaming_reasoning_text_and_custom_tool() {
        let chunks: Vec<Result<Bytes, std::io::Error>> = vec![Ok(Bytes::from(concat!(
            "data: {\"id\":\"chatcmpl-1\",\"model\":\"kimi-for-coding\",\"created\":1,",
            "\"choices\":[{\"delta\":{\"reasoning_content\":\"plan\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"patch\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n",
            "data: [DONE]\n\n"
        )))];
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = chat_sse_to_responses(futures_util::stream::iter(chunks), context)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|item| String::from_utf8(item.expect("stream should convert").to_vec()).unwrap())
            .collect::<String>();

        assert!(output.contains("response.reasoning_summary_text.delta"));
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("response.custom_tool_call_input.delta"));
        assert!(output.contains("\"input\":\"patch\""));
        assert!(output.contains("response.completed"));
        assert!(output.contains("\"input_tokens\":10"));
    }

    #[tokio::test]
    async fn normalizes_provider_tool_call_ids_in_responses_streams() {
        let chunks = vec![Ok::<_, std::io::Error>(Bytes::from(concat!(
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{",
            "\"index\":0,\"id\":\"functions.exec_command:0\",\"function\":{",
            "\"name\":\"exec_command\",\"arguments\":\"{\"}}]},",
            "\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"tool_calls\":[{",
            "\"index\":0,\"id\":\"functions.exec_command:0\",\"function\":{",
            "\"name\":\"exec_command\",\"arguments\":\"}\"}}]},",
            "\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n"
        )))];

        let output =
            chat_sse_to_responses(futures_util::stream::iter(chunks), ToolContext::default())
                .collect::<Vec<_>>()
                .await
                .into_iter()
                .map(Result::unwrap)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .collect::<String>();
        let call_id = super::super::normalized_responses_api_id("functions.exec_command:0");
        let item_id = format!("fc_{}", call_id.trim_start_matches("call_"));

        assert!(output.contains(&format!("\"call_id\":\"{call_id}\"")));
        assert!(output.contains(&format!("\"id\":\"{item_id}\"")));
        assert!(!output.contains("functions.exec_command:0"));
    }

    #[tokio::test]
    async fn normalizes_wrapped_apply_patch_function_arguments() {
        let chunks = vec![Ok::<_, std::io::Error>(Bytes::from(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"apply_patch\",\"arguments\":\"{\\\"patch\\\":\\\"```diff\\\\n*** Update File: a.txt\\\\n@@\\\\n-old\\\\n+new\\\\n```\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
        ))];
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = chat_sse_to_responses(futures_util::stream::iter(chunks), context)
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(Result::unwrap)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .collect::<String>();

        assert!(output.contains("*** Begin Patch\\n*** Update File: a.txt"));
        assert!(output.contains("+new\\n*** End Patch"));
        assert!(!output.contains("```diff"));
    }

    #[test]
    fn leaves_truncated_apply_patch_incomplete() {
        assert_eq!(
            normalize_apply_patch_input("prefix *** Begin Patch\n*** Update File: a.txt\n@@"),
            "*** Begin Patch\n*** Update File: a.txt\n@@"
        );
    }

    async fn convert_stream(input: &str, context: ToolContext) -> String {
        chat_sse_to_responses(
            futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
                input.to_owned(),
            ))]),
            context,
        )
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item.expect("stream item")).into_owned())
        .collect()
    }

    #[tokio::test]
    async fn converts_legacy_function_call() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"read_file\",\"arguments\":\"{}\"}},\"finish_reason\":\"function_call\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"type\":\"function_call\""));
        assert!(output.contains("\"name\":\"read_file\""));
    }

    #[tokio::test]
    async fn converts_complete_message_tool_calls_without_delta() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_1\""));
        assert!(output.contains("\"name\":\"read_file\""));
    }

    #[tokio::test]
    async fn restores_namespace_on_chat_tool_calls() {
        let input = json!({
            "tools": [{
                "type": "namespace",
                "name": "wework_browser",
                "tools": [{
                    "type": "function",
                    "name": "browser_snapshot",
                    "parameters": {"type": "object"}
                }]
            }]
        });
        let context = responses_to_chat(&input).expect("context should build").1;
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"wework_browser__browser_snapshot\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            context,
        )
        .await;

        assert!(output.contains("\"name\":\"browser_snapshot\""));
        assert!(output.contains("\"namespace\":\"wework_browser\""));
    }

    #[tokio::test]
    async fn restores_tool_search_on_chat_tool_calls() {
        let input = json!({
            "tools": [{
                "type": "tool_search",
                "execution": "client",
                "parameters": {"type": "object"}
            }]
        });
        let context = responses_to_chat(&input).expect("context should build").1;
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"search_1\",\"function\":{\"name\":\"tool_search\",\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            context,
        )
        .await;

        assert!(output.contains("\"type\":\"tool_search_call\""), "{output}");
        assert!(
            output.contains("\"arguments\":{\"query\":\"GitHub\"}"),
            "{output}"
        );
        assert!(output.contains("\"execution\":\"client\""), "{output}");
        assert!(!output.contains("\"name\":\"tool_search\""), "{output}");
    }

    #[tokio::test]
    async fn reports_truncated_stream_as_failed() {
        let output = convert_stream(
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}",
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn reports_max_token_finish_as_incomplete() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"still thinking\"},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;

        assert!(output.contains("response.incomplete"));
        assert!(output.contains("\"status\":\"incomplete\""));
        assert!(output.contains("\"reason\":\"max_output_tokens\""));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn restores_parallel_fragmented_tool_calls() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}},{\"index\":3,\"id\":\"call_2\",\"function\":{\"name\":\"list_files\",\"arguments\":\"{\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}},{\"index\":3,\"function\":{\"arguments\":\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_1\""));
        assert!(output.contains("\"call_id\":\"call_2\""));
        assert!(output.contains("a.txt"));
        assert!(output.contains("path"));
    }

    #[tokio::test]
    async fn serializes_object_arguments_from_non_streaming_compatible_chunks() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("a.txt"));
        assert!(output.contains("path"));
    }

    #[tokio::test]
    async fn ignores_repeated_complete_tool_name_and_id() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"name\":\"read_file\""));
        assert!(!output.contains("read_fileread_file"));
        assert!(!output.contains("call_1call_1"));
    }

    #[tokio::test]
    async fn accepts_done_marker_without_finish_reason_after_a_choice() {
        let output = convert_stream(
            concat!(
                "data: {\"id\":\"chatcmpl-1\",\"choices\":[{\"delta\":{\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[tokio::test]
    async fn handles_crlf_stream_delimiters() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}\r\n\r\n",
                "data: [DONE]\r\n\r\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.output_text.delta"));
        assert!(output.contains("response.completed"));
    }

    #[tokio::test]
    async fn rejects_done_stream_without_completion_chunks() {
        let output =
            convert_stream(": keepalive\n\ndata: [DONE]\n\n", ToolContext::default()).await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("without a completion choice"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn rejects_choiceless_usage_stream() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":0}}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn converts_upstream_error_event_to_failed_response() {
        let output = convert_stream(
            concat!(
                "data: {\"error\":{\"message\":\"rate limited\",\"type\":\"rate_limit\"}}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("rate limited"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn sparse_large_tool_index_does_not_create_placeholder_calls() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":4000000000,\"id\":\"call_sparse\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_sparse\""));
        assert!(!output.contains("\"call_id\":\"call_0\""));
    }

    #[tokio::test]
    async fn ignores_empty_upstream_error_placeholders() {
        let output = convert_stream(
            concat!(
                "data: {\"error\":{},\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[tokio::test]
    async fn rejects_named_error_events_without_an_error_wrapper() {
        let output = convert_stream(
            "event: error\ndata: {\"message\":\"quota exhausted\"}\n\n",
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("quota exhausted"));
        assert!(!output.contains("response.completed"));
    }

    #[tokio::test]
    async fn uses_full_message_when_delta_is_empty() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{},\"message\":{\"role\":\"assistant\",\"content\":\"full answer\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("full answer"));
        assert!(output.contains("response.completed"));
    }

    #[tokio::test]
    async fn uses_array_position_for_complete_calls_without_indices() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"message\":{\"tool_calls\":[{\"id\":\"call_1\",\"function\":{\"name\":\"first\",\"arguments\":\"{}\"}},{\"id\":\"call_2\",\"function\":{\"name\":\"second\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("\"call_id\":\"call_1\""));
        assert!(output.contains("\"call_id\":\"call_2\""));
        assert!(output.contains("\"name\":\"first\""));
        assert!(output.contains("\"name\":\"second\""));
    }

    #[tokio::test]
    async fn selects_choice_zero_instead_of_the_first_choice() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"wrong\"},\"finish_reason\":\"stop\"},{\"index\":0,\"delta\":{\"content\":\"right\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("right"));
        assert!(!output.contains("wrong"));
    }

    #[tokio::test]
    async fn preserves_content_parts_refusal_and_reasoning_details() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"reasoning_details\":[{\"type\":\"reasoning.text\",\"text\":\"think\"}],\"content\":[{\"type\":\"text\",\"text\":\"visible\"}],\"refusal\":\" denied\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("think"));
        assert!(output.contains("visible denied"));
    }

    #[tokio::test]
    async fn accepts_bom_and_indented_sse_fields() {
        let output = convert_stream(
            concat!(
                "\u{feff}  data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "  data: [DONE]\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(output.contains("ok"));
    }

    #[tokio::test]
    async fn rejects_malformed_complete_sse_blocks() {
        let output = convert_stream(
            "data: {\"choices\":[{not-json}]}\n\n",
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.failed"));
        assert!(output.contains("Failed to parse upstream SSE chunk"));
    }

    #[tokio::test]
    async fn ignores_a_truncated_tail_after_a_finish_reason() {
        let output = convert_stream(
            concat!(
                "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\n",
                "data: {\"choices\":["
            ),
            ToolContext::default(),
        )
        .await;
        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[test]
    fn responses_to_responses_converts_custom_apply_patch_tool() {
        let input = json!({
            "model": "wework-gpt-5.6-sol",
            "instructions": "You are a coding agent.",
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Edit it"}]},
                {"type": "custom_tool_call", "call_id": "call_1", "name": "apply_patch", "input": "*** Begin Patch\n*** End Patch"},
                {"type": "custom_tool_call_output", "call_id": "call_1", "output": "Done"}
            ],
            "tools": [
                {"type": "function", "name": "exec_command", "description": "Run commands", "parameters": {"type": "object", "properties": {}}},
                {"type": "custom", "name": "apply_patch", "description": "Patch files"}
            ],
            "stream": true
        });

        let (converted, context) =
            responses_to_responses(&input, true, false, false).expect("request should convert");
        assert!(context.is_custom("apply_patch"));
        assert_eq!(converted["tools"][0]["type"], "function");
        assert_eq!(converted["tools"][0]["name"], "exec_command");
        assert_eq!(converted["tools"][0]["description"], "Run commands");
        assert_eq!(converted["tools"][1]["type"], "function");
        assert_eq!(converted["tools"][1]["name"], "apply_patch");
        assert!(converted["tools"][1]["description"]
            .as_str()
            .is_some_and(
                |value| value.starts_with("Critical apply_patch input contract:")
                    && !value.contains("Original tool definition:")
            ));
        assert_eq!(
            converted["tools"][1]["parameters"]["properties"]["input"]["type"],
            "string"
        );
        assert_eq!(converted["input"][1]["type"], "function_call");
        assert_eq!(
            converted["input"][1]["arguments"],
            "{\"input\":\"*** Begin Patch\\n*** End Patch\"}"
        );
        assert_eq!(converted["input"][2]["type"], "function_call_output");
    }

    #[test]
    fn responses_to_responses_moves_tool_images_after_all_tool_results() {
        let input = json!({
            "model": "wework-gpt-5.6-sol",
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [{
                        "type": "input_image",
                        "image_url": "data:image/png;base64,dXNlci1pbWFnZQ=="
                    }]
                },
                {"type": "function_call", "call_id": "image_1", "name": "view_image", "arguments": "{}"},
                {"type": "function_call", "call_id": "text_1", "name": "exec_command", "arguments": "{}"},
                {
                    "type": "function_call_output",
                    "call_id": "image_1",
                    "output": [{
                        "type": "input_image",
                        "image_url": "data:image/jpeg;base64,dG9vbC1pbWFnZQ=="
                    }]
                },
                {"type": "function_call_output", "call_id": "text_1", "output": "done"}
            ],
            "tools": [
                {"type": "function", "name": "view_image", "parameters": {"type": "object"}},
                {"type": "function", "name": "exec_command", "parameters": {"type": "object"}}
            ]
        });

        let (converted, _) =
            responses_to_responses(&input, false, true, true).expect("request should convert");
        let converted_input = converted["input"].as_array().expect("input");

        assert_eq!(converted_input.len(), 6);
        assert_eq!(
            converted_input[0]["content"][0]["image_url"],
            "data:image/png;base64,dXNlci1pbWFnZQ=="
        );
        assert_eq!(converted_input[3]["type"], "function_call_output");
        assert_eq!(converted_input[3]["output"], tool_image_output_notice());
        assert_eq!(converted_input[4]["type"], "function_call_output");
        assert_eq!(converted_input[4]["output"], "done");
        assert_eq!(converted_input[5]["role"], "user");
        assert_eq!(converted_input[5]["content"][0]["type"], "input_text");
        assert_eq!(
            converted_input[5]["content"][0]["text"],
            "Image output from tool view_image:"
        );
        assert_eq!(converted_input[5]["content"][1]["type"], "input_image");
        assert_eq!(
            converted_input[5]["content"][1]["image_url"],
            "data:image/jpeg;base64,dG9vbC1pbWFnZQ=="
        );
    }

    #[test]
    fn responses_to_responses_bridges_tool_search_and_loaded_app_tools() {
        let input = json!({
            "model": "third-party-responses-model",
            "input": [
                {"role": "user", "content": "Create an issue"},
                {
                    "type": "tool_search_call",
                    "id": "tsc_bridge_1",
                    "call_id": "search_1",
                    "execution": "client",
                    "arguments": {"query": "GitHub create issue"}
                },
                {
                    "type": "tool_search_output",
                    "id": "tso_bridge_1",
                    "call_id": "search_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": [{
                        "type": "namespace",
                        "name": "github",
                        "tools": [{
                            "type": "function",
                            "name": "create_issue",
                            "description": "Create an issue",
                            "parameters": {
                                "type": "object",
                                "properties": {"title": {"type": "string"}}
                            }
                        }]
                    }]
                },
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "namespace": "github",
                    "name": "create_issue",
                    "arguments": "{\"title\":\"Bug\"}"
                }
            ],
            "tools": [
                {
                    "type": "tool_search",
                    "execution": "client",
                    "description": "Search available Apps",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"]
                    }
                }
            ]
        });

        let (converted, context) =
            responses_to_responses(&input, false, false, false).expect("request should convert");

        assert_eq!(converted["tools"].as_array().unwrap().len(), 2);
        assert_eq!(converted["tools"][0]["type"], "function");
        assert_eq!(converted["tools"][0]["name"], TOOL_SEARCH_NAME);
        assert_eq!(converted["tools"][1]["type"], "function");
        assert_eq!(converted["tools"][1]["name"], "github__create_issue");
        assert_eq!(converted["input"][1]["type"], "function_call");
        assert_eq!(converted["input"][1]["name"], TOOL_SEARCH_NAME);
        assert!(converted["input"][1].get("id").is_none());
        assert_eq!(converted["input"][1]["call_id"], "search_1");
        assert_eq!(
            converted["input"][1]["arguments"],
            "{\"query\":\"GitHub create issue\"}"
        );
        assert_eq!(converted["input"][2]["type"], "function_call_output");
        assert!(converted["input"][2].get("id").is_none());
        assert_eq!(converted["input"][2]["call_id"], "search_1");
        assert!(converted["input"][2]["output"]
            .as_str()
            .is_some_and(|value| value.contains("\"tools\"")));
        assert_eq!(converted["input"][3]["name"], "github__create_issue");
        assert!(converted["input"][3].get("namespace").is_none());
        assert_eq!(
            context.identity("github__create_issue"),
            Some(&ToolIdentity {
                name: "create_issue".to_owned(),
                namespace: Some("github".to_owned()),
                kind: ToolKind::Function,
            })
        );
    }

    #[test]
    fn responses_bridge_omits_missing_tool_search_description() {
        let input = json!({
            "model": "third-party-responses-model",
            "tools": [{
                "type": "tool_search",
                "execution": "client",
                "parameters": {"type": "object"}
            }]
        });

        let (converted, _) =
            responses_to_responses(&input, false, false, false).expect("request should convert");

        assert_eq!(converted["tools"][0]["type"], "function");
        assert!(converted["tools"][0].get("description").is_none());
    }

    #[test]
    fn responses_to_responses_preserves_native_tool_search_and_namespaces() {
        let input = json!({
            "model": "native-responses-model",
            "input": [
                {
                    "type": "tool_search_call",
                    "id": "tsc_native_1",
                    "call_id": "search_1",
                    "execution": "client",
                    "arguments": {"query": "GitHub"}
                },
                {
                    "type": "tool_search_output",
                    "id": "tso_native_1",
                    "call_id": "search_1",
                    "execution": "client",
                    "status": "completed",
                    "tools": [{"namespace": "github", "name": "create_issue"}]
                },
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "namespace": "github",
                    "name": "create_issue",
                    "arguments": "{\"title\":\"Bug\"}"
                }
            ],
            "tools": [
                {
                    "type": "tool_search",
                    "execution": "client",
                    "parameters": {"type": "object"}
                },
                {
                    "type": "namespace",
                    "name": "github",
                    "tools": [{
                        "type": "function",
                        "name": "create_issue",
                        "parameters": {"type": "object"}
                    }]
                },
                {"type": "web_search_preview"}
            ],
            "tool_choice": {
                "type": "function",
                "namespace": "github",
                "name": "create_issue"
            }
        });

        let (converted, bridge_context) =
            responses_to_responses(&input, false, true, true).expect("request should convert");

        assert_eq!(converted, input);
        assert!(bridge_context.is_empty());
    }

    async fn convert_responses_stream(input: &str, context: ToolContext) -> String {
        responses_sse_to_responses(
            futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from(
                input.to_owned(),
            ))]),
            context,
        )
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .map(|item| String::from_utf8_lossy(&item.expect("stream item")).into_owned())
        .collect()
    }

    #[tokio::test]
    async fn normalizes_provider_ids_in_responses_streams() {
        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_functions.exec_command:0\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"functions.exec_command:0\",\"name\":\"exec_command\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_functions.exec_command:0\",\"output_index\":0,\"delta\":\"{}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_functions.exec_command:0\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"functions.exec_command:0\",\"name\":\"exec_command\",\"arguments\":\"{}\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_functions.exec_command:0\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"functions.exec_command:0\",\"name\":\"exec_command\",\"arguments\":\"{}\"}]}}\n\n"
            ),
            ToolContext::default(),
        )
        .await;
        let call_id = super::super::normalized_responses_api_id("functions.exec_command:0");
        let item_id = super::super::normalized_responses_api_id("fc_functions.exec_command:0");

        assert!(output.contains(&format!("\"call_id\":\"{call_id}\"")));
        assert!(output.contains(&format!("\"item_id\":\"{item_id}\"")));
        assert!(output.contains(&format!("\"id\":\"{item_id}\"")));
        assert!(!output.contains("functions.exec_command:0"));
    }

    #[tokio::test]
    async fn responses_sse_to_responses_rewrites_function_call_for_custom_tool() {
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}]}}\n\n"
            ),
            context,
        )
        .await;

        assert!(
            output.contains("\"type\":\"custom_tool_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("\"input\":\"*** Begin Patch\\n*** End Patch\""),
            "output: {output}"
        );
        assert!(
            !output.contains("\"type\":\"function_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("response.custom_tool_call_input.delta"),
            "output: {output}"
        );
        assert!(
            output.contains("response.custom_tool_call_input.done"),
            "output: {output}"
        );
    }

    #[tokio::test]
    async fn responses_sse_to_responses_restores_tool_search_and_app_namespace() {
        let request = json!({
            "tools": [
                {
                    "type": "tool_search",
                    "execution": "client",
                    "parameters": {"type": "object"}
                },
                {
                    "type": "namespace",
                    "name": "github",
                    "tools": [{
                        "type": "function",
                        "name": "create_issue",
                        "parameters": {"type": "object"}
                    }]
                }
            ]
        });
        let (_, context) =
            responses_to_responses(&request, false, false, false).expect("request should convert");
        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"search_1\",\"name\":\"tool_search\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_search\",\"output_index\":0,\"delta\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_search\",\"output_index\":0,\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"name\":\"tool_search\",\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"}}\n\n",
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"github__create_issue\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_app\",\"output_index\":1,\"delta\":\"{\\\"title\\\":\\\"Bug\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"id\":\"fc_search\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"search_1\",\"name\":\"tool_search\",\"arguments\":\"{\\\"query\\\":\\\"GitHub\\\"}\"},{\"id\":\"fc_app\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"github__create_issue\",\"arguments\":\"{\\\"title\\\":\\\"Bug\\\"}\"}]}}\n\n"
            ),
            context,
        )
        .await;

        assert!(output.contains("\"type\":\"tool_search_call\""), "{output}");
        assert!(
            output.contains("\"arguments\":{\"query\":\"GitHub\"}"),
            "{output}"
        );
        assert!(output.contains("\"execution\":\"client\""), "{output}");
        assert!(output.contains("\"namespace\":\"github\""), "{output}");
        assert!(output.contains("\"name\":\"create_issue\""), "{output}");
        assert!(
            !output.contains("\"name\":\"github__create_issue\""),
            "{output}"
        );
    }

    #[tokio::test]
    async fn responses_sse_to_responses_extracts_input_for_generic_custom_tool() {
        let mut context = ToolContext::default();
        context.insert("my_custom_tool".to_owned(), ToolKind::Custom);

        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"my_custom_tool\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"my_custom_tool\",\"arguments\":\"{\\\"input\\\":\\\"raw custom input\\\"}\"}}\n\n"
            ),
            context,
        )
        .await;

        assert!(
            output.contains("\"type\":\"custom_tool_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("\"input\":\"raw custom input\""),
            "output: {output}"
        );
        assert!(!output.contains("\"arguments\""), "output: {output}");
        assert!(
            output.contains("response.custom_tool_call_input.done"),
            "output: {output}"
        );
    }

    #[tokio::test]
    async fn responses_sse_to_responses_extracts_input_from_done_item_without_delta() {
        let mut context = ToolContext::default();
        context.insert("apply_patch".to_owned(), ToolKind::Custom);

        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"apply_patch\"}}\n\n",
                "event: response.output_item.done\n",
                "data: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[{\"type\":\"function_call\",\"status\":\"completed\",\"call_id\":\"call_1\",\"name\":\"apply_patch\",\"arguments\":\"{\\\"input\\\":\\\"*** Begin Patch\\\\n*** End Patch\\\"}\"}]}}\n\n"
            ),
            context,
        )
        .await;

        assert!(
            output.contains("\"type\":\"custom_tool_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("\"input\":\"*** Begin Patch\\n*** End Patch\""),
            "output: {output}"
        );
        assert!(
            !output.contains("\"type\":\"function_call\""),
            "output: {output}"
        );
        assert!(!output.contains("\"arguments\""), "output: {output}");
    }

    #[tokio::test]
    async fn responses_sse_to_responses_leaves_regular_function_calls_unchanged() {
        let output = convert_responses_stream(
            concat!(
                "event: response.output_item.added\n",
                "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"status\":\"in_progress\",\"call_id\":\"call_1\",\"name\":\"read_file\",\"arguments\":\"\"}}\n\n",
                "event: response.function_call_arguments.delta\n",
                "data: {\"type\":\"response.function_call_arguments.delta\",\"item_id\":\"fc_1\",\"output_index\":0,\"delta\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}\n\n",
                "event: response.function_call_arguments.done\n",
                "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"fc_1\",\"output_index\":0,\"arguments\":\"{\\\"path\\\":\\\"a.txt\\\"}\"}\n\n",
                "event: response.completed\n",
                "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_1\",\"status\":\"completed\",\"output\":[]}}\n\n"
            ),
            ToolContext::default(),
        )
        .await;

        assert!(
            output.contains("\"type\":\"function_call\""),
            "output: {output}"
        );
        assert!(
            output.contains("response.function_call_arguments.delta"),
            "output: {output}"
        );
        assert!(!output.contains("custom_tool_call"), "output: {output}");
    }
}
