// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use sha2::{Digest, Sha256};

fn command_block(item: &Value, timestamp: i64, options: TranscriptBuildOptions) -> Value {
    let mut block = new_tool_block(
        item,
        item_timestamp(item).unwrap_or(timestamp),
        "bash",
        Some(command_input(item)),
    );
    enrich_tool_block(&mut block, item, options, false);
    block
}

pub(super) fn tool_block(item: &Value, timestamp: i64, options: TranscriptBuildOptions) -> Value {
    if matches!(
        item_type(item).as_str(),
        "commandexecution" | "shellcall" | "localshellcall"
    ) {
        return command_block(item, timestamp, options);
    }
    let mut block = new_tool_block(
        item,
        item_timestamp(item).unwrap_or(timestamp),
        &tool_name(item),
        Some(tool_input(item)),
    );
    enrich_tool_block(&mut block, item, options, true);
    block
}

pub(super) fn merge_tool_output(
    blocks: &mut Vec<Value>,
    item: &Value,
    timestamp: i64,
    options: TranscriptBuildOptions,
) {
    let call_id = tool_call_id(item);
    if let Some(block) = blocks.iter_mut().rev().find(|block| {
        block
            .get("tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|value| value == call_id)
    }) {
        if let Some(object) = block.as_object_mut() {
            merge_tool_input(object, command_input_from_output(item));
            merge_tool_timing(object, item);
        }
        enrich_tool_block(block, item, options, true);
        return;
    }
    if item_type(item) == "commandexecution" {
        blocks.push(command_block(item, timestamp, options));
        return;
    }
    let mut block = new_tool_block(
        item,
        item_timestamp(item).unwrap_or(timestamp),
        &tool_name(item),
        command_input_from_output(item),
    );
    enrich_tool_block(&mut block, item, options, true);
    blocks.push(block);
}

fn merge_tool_timing(object: &mut Map<String, Value>, item: &Value) {
    let completed_at = item_completed_at(item);
    let duration_ms =
        integer_field(item, "durationMs").or_else(|| integer_field(item, "duration_ms"));
    if completed_at.is_none() && duration_ms.is_none() {
        return;
    }
    if let Some(timestamp) = item_timestamp(item) {
        object.insert("timestamp".to_owned(), json!(timestamp));
    }
    if let Some(completed_at) = completed_at {
        object.insert("completedAt".to_owned(), json!(completed_at));
    }
    if let Some(duration_ms) = duration_ms {
        object.insert("durationMs".to_owned(), json!(duration_ms.max(0)));
    }
}

fn new_tool_block(
    item: &Value,
    timestamp: i64,
    tool_name: &str,
    tool_input: Option<Value>,
) -> Value {
    let call_id = tool_call_id(item);
    let mut block = json!({
        "id": call_id,
        "type": "tool",
        "tool_use_id": call_id,
        "tool_name": tool_name,
        "status": tool_status(item),
        "timestamp": timestamp,
    });
    if let (Some(object), Some(tool_input)) = (block.as_object_mut(), tool_input) {
        object.insert("tool_input".to_owned(), tool_input);
    }
    if let Some(object) = block.as_object_mut() {
        if let Some(completed_at) = item_completed_at(item) {
            object.insert("completedAt".to_owned(), json!(completed_at));
        }
        if let Some(duration_ms) =
            integer_field(item, "durationMs").or_else(|| integer_field(item, "duration_ms"))
        {
            object.insert("durationMs".to_owned(), json!(duration_ms.max(0)));
        }
    }
    block
}

fn enrich_tool_block(
    block: &mut Value,
    item: &Value,
    options: TranscriptBuildOptions,
    include_interaction: bool,
) {
    let Some(object) = block.as_object_mut() else {
        return;
    };
    insert_tool_output_fields(object, item, options);
    insert_image_generation_render_payload(object, item);
    if include_interaction {
        insert_request_user_input_render_payload(object, item);
    }
    object.insert("status".to_owned(), Value::String(tool_status(item)));
}

pub(super) fn insert_tool_output_fields(
    object: &mut Map<String, Value>,
    item: &Value,
    options: TranscriptBuildOptions,
) {
    let output = limited_tool_output(item, options);
    if object.contains_key("tool_output") && !is_meaningful_tool_output(&output.value) {
        return;
    }
    object.insert("tool_output".to_owned(), output.value);
    if output.truncated {
        object.insert("tool_output_truncated".to_owned(), Value::Bool(true));
        object.insert(
            "tool_output_original_bytes".to_owned(),
            json!(output.original_bytes),
        );
    } else {
        object.remove("tool_output_truncated");
        object.remove("tool_output_original_bytes");
    }
}

fn is_meaningful_tool_output(output: &Value) -> bool {
    match output {
        Value::Null => false,
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

pub(super) fn insert_image_generation_render_payload(
    object: &mut Map<String, Value>,
    item: &Value,
) {
    if item_type(item) != "imagegeneration" {
        return;
    }
    let mut payload = Map::from_iter([(
        "kind".to_owned(),
        Value::String("image_generation".to_owned()),
    )]);
    if let Some(result) = raw_string_field(item, "result").filter(|result| !result.is_empty()) {
        payload.insert("imageBase64".to_owned(), Value::String(result));
    }
    if let Some(prompt) =
        string_field(item, "revisedPrompt").or_else(|| string_field(item, "revised_prompt"))
    {
        payload.insert("revisedPrompt".to_owned(), Value::String(prompt));
    }
    if let Some(path) = string_field(item, "savedPath").or_else(|| string_field(item, "saved_path"))
    {
        payload.insert("savedPath".to_owned(), Value::String(path));
    }
    object.insert("render_payload".to_owned(), Value::Object(payload));
}

fn insert_request_user_input_render_payload(object: &mut Map<String, Value>, item: &Value) {
    if item_type(item) == "functioncall" && tool_name(item) == "request_user_input" {
        let mut payload = parse_json_object_string(item, "arguments")
            .and_then(|value| value.as_object().cloned())
            .unwrap_or_default();
        payload.insert(
            "kind".to_owned(),
            Value::String("request_user_input".to_owned()),
        );
        payload.insert("requestId".to_owned(), Value::String(tool_call_id(item)));
        object.insert("render_payload".to_owned(), Value::Object(payload));
        return;
    }

    if item_type(item) != "functioncalloutput" {
        return;
    }
    let Some(payload) = object
        .get_mut("render_payload")
        .and_then(Value::as_object_mut)
        .filter(|payload| {
            payload.get("kind").and_then(Value::as_str) == Some("request_user_input")
        })
    else {
        return;
    };
    let Some(response) = output_payload_text(item)
        .and_then(|output| serde_json::from_str::<Value>(&output).ok())
        .filter(Value::is_object)
    else {
        return;
    };
    payload.insert("response".to_owned(), response);
}

fn command_input(item: &Value) -> Value {
    json!({
        "command": command_string(item)
            .or_else(|| command_from_local_shell_action(item))
            .unwrap_or_default(),
        "cwd": command_cwd(item).unwrap_or_default(),
    })
}

#[derive(Debug)]
struct LimitedToolOutput {
    value: Value,
    truncated: bool,
    original_bytes: usize,
}

fn limited_tool_output(item: &Value, options: TranscriptBuildOptions) -> LimitedToolOutput {
    match raw_tool_output(item) {
        RawToolOutput::String(text) => {
            if options.truncate_content {
                limited_tool_output_string(text)
            } else {
                LimitedToolOutput {
                    value: Value::String(text.to_owned()),
                    truncated: false,
                    original_bytes: text.len(),
                }
            }
        }
        RawToolOutput::Value(Value::String(text)) if options.truncate_content => {
            limited_tool_output_string(&text)
        }
        RawToolOutput::Value(value) => {
            let original_bytes = value.as_str().map_or(0, str::len);
            LimitedToolOutput {
                value,
                truncated: false,
                original_bytes,
            }
        }
    }
}

enum RawToolOutput<'a> {
    String(&'a str),
    Value(Value),
}

fn limited_tool_output_string(text: &str) -> LimitedToolOutput {
    let original_bytes = text.len();
    if original_bytes <= MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES {
        return LimitedToolOutput {
            value: Value::String(text.to_owned()),
            truncated: false,
            original_bytes,
        };
    }
    LimitedToolOutput {
        value: Value::String(tail_utf8_bytes(text, MAX_TRANSCRIPT_TOOL_OUTPUT_BYTES)),
        truncated: true,
        original_bytes,
    }
}

fn tail_utf8_bytes(text: &str, max_bytes: usize) -> String {
    let mut start = text.len().saturating_sub(max_bytes);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_owned()
}

pub(super) fn limit_content_field(value: &mut Value, max_chars: usize) {
    let Some(object) = value.as_object_mut() else {
        return;
    };
    let Some(content) = object
        .get("content")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let original_chars = content.chars().count();
    if original_chars <= max_chars {
        object.remove("content_truncated");
        object.remove("content_original_chars");
        return;
    }

    object.insert(
        "content".to_owned(),
        Value::String(tail_chars(&content, max_chars)),
    );
    object.insert("content_truncated".to_owned(), Value::Bool(true));
    object.insert("content_original_chars".to_owned(), json!(original_chars));
}

fn tail_chars(text: &str, max_chars: usize) -> String {
    let total_chars = text.chars().count();
    if total_chars <= max_chars {
        return text.to_owned();
    }
    text.chars().skip(total_chars - max_chars).collect()
}

fn command_output_ref(item: &Value) -> Option<&str> {
    raw_string_field_ref(item, "aggregatedOutput")
        .or_else(|| raw_string_field_ref(item, "aggregated_output"))
        .or_else(|| raw_string_field_ref(item, "output"))
}

pub(super) fn command_input_from_output(item: &Value) -> Option<Value> {
    if !matches!(
        item_type(item).as_str(),
        "commandexecution" | "execcommandend"
    ) {
        return None;
    }
    Some(command_input(item))
}

fn merge_tool_input(object: &mut Map<String, Value>, next_input: Option<Value>) {
    let Some(next_input) = next_input.and_then(|value| value.as_object().cloned()) else {
        return;
    };
    let input = object
        .entry("tool_input".to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !input.is_object() {
        *input = Value::Object(Map::new());
    }
    let Some(input_object) = input.as_object_mut() else {
        return;
    };
    for (key, value) in next_input {
        if input_object
            .get(&key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty())
        {
            continue;
        }
        input_object.insert(key, value);
    }
}

fn command_string(item: &Value) -> Option<String> {
    string_field(item, "command").or_else(|| {
        let command = item.get("command")?.as_array()?;
        let parts = command
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        (!parts.is_empty()).then(|| parts.join(" "))
    })
}

fn command_cwd(item: &Value) -> Option<String> {
    string_field(item, "cwd").or_else(|| string_field(item, "workdir"))
}

fn command_from_local_shell_action(item: &Value) -> Option<String> {
    item.get("action").and_then(|action| {
        string_field(action, "command")
            .or_else(|| string_field(action, "cmd"))
            .or_else(|| string_field(action, "commandLine"))
    })
}

pub(super) fn tool_call_id(item: &Value) -> String {
    string_field(item, "call_id")
        .or_else(|| string_field(item, "callId"))
        .or_else(|| string_field(item, "id"))
        .unwrap_or_else(|| {
            let serialized = serde_json::to_vec(item).unwrap_or_default();
            let digest = Sha256::digest(serialized);
            let suffix = digest[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            format!("tool-{suffix}")
        })
}

fn tool_name(item: &Value) -> String {
    match item_type(item).as_str() {
        "functioncall" | "functioncalloutput" => string_field(item, "name")
            .or_else(|| string_field(item, "tool"))
            .unwrap_or_else(|| "function_call".to_owned()),
        "customtoolcall" | "customtoolcalloutput" => string_field(item, "name")
            .or_else(|| string_field(item, "tool"))
            .unwrap_or_else(|| "custom_tool".to_owned()),
        "dynamictoolcall" => {
            string_field(item, "tool").unwrap_or_else(|| "dynamic_tool".to_owned())
        }
        "mcptoolcall" | "mcpcall" | "mcptoolcallbegin" | "mcptoolcallend" => {
            let server =
                string_field(item, "server").or_else(|| mcp_invocation_field(item, "server"));
            let tool = string_field(item, "tool")
                .or_else(|| string_field(item, "name"))
                .or_else(|| mcp_invocation_field(item, "tool"))
                .unwrap_or_else(|| "mcp_tool".to_owned());
            server
                .map(|server| format!("{server}.{tool}"))
                .unwrap_or(tool)
        }
        "toolsearchcall" | "toolsearchoutput" => "tool_search".to_owned(),
        "execcommandend" => "exec_command".to_owned(),
        "websearch" | "websearchcall" => "web_search".to_owned(),
        "imagegeneration" => "image_generation".to_owned(),
        "imageview" => "view_image".to_owned(),
        "sleep" => "sleep".to_owned(),
        _ => string_field(item, "name")
            .or_else(|| string_field(item, "tool"))
            .or_else(|| raw_string_field(item, "type"))
            .unwrap_or_else(|| "tool".to_owned()),
    }
}

pub(super) fn tool_input(item: &Value) -> Value {
    match item_type(item).as_str() {
        "execcommandend" => command_input(item),
        "functioncall" => parse_json_object_string(item, "arguments").unwrap_or_else(
            || json!({"arguments": raw_string_field(item, "arguments").unwrap_or_default()}),
        ),
        "customtoolcall" => {
            json!({"input": raw_string_field(item, "input").unwrap_or_default()})
        }
        "dynamictoolcall" | "toolsearchcall" => {
            item.get("arguments").cloned().unwrap_or(Value::Null)
        }
        "mcptoolcall" | "mcpcall" | "mcptoolcallbegin" | "mcptoolcallend" => item
            .get("arguments")
            .or_else(|| item.get("input"))
            .or_else(|| {
                item.get("invocation")
                    .and_then(|invocation| invocation.get("arguments"))
            })
            .cloned()
            .unwrap_or(Value::Null),
        "websearch" | "websearchcall" => item
            .get("action")
            .cloned()
            .unwrap_or_else(|| json!({"query": string_field(item, "query").unwrap_or_default()})),
        "imageview" => json!({"path": string_field(item, "path").unwrap_or_default()}),
        "sleep" => {
            json!({"duration_ms": item.get("durationMs").or_else(|| item.get("duration_ms")).cloned().unwrap_or(Value::Null)})
        }
        "imagegeneration" => {
            json!({"revised_prompt": string_field(item, "revisedPrompt").or_else(|| string_field(item, "revised_prompt")).unwrap_or_default()})
        }
        _ => default_tool_input(item),
    }
}

fn default_tool_input(item: &Value) -> Value {
    let mut input = Map::new();
    for key in [
        "type",
        "id",
        "call_id",
        "callId",
        "name",
        "tool",
        "server",
        "command",
        "cwd",
        "workdir",
        "arguments",
        "input",
        "action",
    ] {
        if let Some(value) = item.get(key).cloned() {
            input.insert(key.to_owned(), value);
        }
    }
    Value::Object(input)
}

fn parse_json_object_string(item: &Value, key: &str) -> Option<Value> {
    let text = raw_string_field(item, key)?;
    serde_json::from_str::<Value>(&text)
        .ok()
        .filter(Value::is_object)
}

fn raw_tool_output(item: &Value) -> RawToolOutput<'_> {
    match item_type(item).as_str() {
        "commandexecution" | "shellcall" | "localshellcall" | "execcommandend" => {
            RawToolOutput::String(command_output_ref(item).unwrap_or_default())
        }
        "functioncalloutput" | "customtoolcalloutput" => output_payload_text(item)
            .map(|output| RawToolOutput::Value(Value::String(output)))
            .unwrap_or_else(|| {
                RawToolOutput::Value(item.get("output").cloned().unwrap_or(Value::Null))
            }),
        "toolsearchoutput" => item
            .get("results")
            .cloned()
            .unwrap_or_else(|| {
                output_payload_text(item)
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            })
            .into(),
        "dynamictoolcall" => item
            .get("contentItems")
            .or_else(|| item.get("content_items"))
            .map(output_content_items_text)
            .map(|output| RawToolOutput::Value(Value::String(output)))
            .unwrap_or_else(|| {
                RawToolOutput::Value(item.get("result").cloned().unwrap_or(Value::Null))
            }),
        "mcptoolcall" | "mcpcall" | "mcptoolcallend" => RawToolOutput::Value(mcp_tool_output(item)),
        "imagegeneration" => string_field(item, "savedPath")
            .or_else(|| string_field(item, "saved_path"))
            .or_else(|| raw_string_field(item, "result"))
            .map(|output| RawToolOutput::Value(Value::String(output)))
            .unwrap_or(RawToolOutput::Value(Value::Null)),
        _ => default_tool_output(item),
    }
}

impl From<Value> for RawToolOutput<'_> {
    fn from(value: Value) -> Self {
        RawToolOutput::Value(value)
    }
}

fn default_tool_output(item: &Value) -> RawToolOutput<'_> {
    if let Some(output) = output_payload_text(item) {
        return RawToolOutput::Value(Value::String(output));
    }
    if let Some(command_output) = command_output_ref(item) {
        if !command_output.is_empty() {
            return RawToolOutput::String(command_output);
        }
    }
    let stdout = raw_string_field_ref(item, "stdout").unwrap_or_default();
    let stderr = raw_string_field_ref(item, "stderr").unwrap_or_default();
    let combined = [stdout, stderr]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if !combined.is_empty() {
        return RawToolOutput::Value(Value::String(combined));
    }
    RawToolOutput::Value(
        item.get("result")
            .or_else(|| item.get("formatted_output"))
            .cloned()
            .unwrap_or(Value::Null),
    )
}

fn mcp_invocation_field(item: &Value, key: &str) -> Option<String> {
    item.get("invocation")
        .and_then(|invocation| string_field(invocation, key))
}

fn mcp_tool_output(item: &Value) -> Value {
    if let Some(message) = item
        .get("error")
        .and_then(|error| string_field(error, "message"))
    {
        return Value::String(message);
    }

    let Some(result) = item.get("result") else {
        return Value::Null;
    };

    if let Some(message) = result
        .get("Err")
        .or_else(|| result.get("err"))
        .and_then(Value::as_str)
    {
        return Value::String(message.to_owned());
    }

    result
        .get("Ok")
        .or_else(|| result.get("ok"))
        .cloned()
        .unwrap_or_else(|| result.clone())
}

fn output_payload_text(item: &Value) -> Option<String> {
    let output = item.get("output")?;
    output
        .as_str()
        .map(str::to_owned)
        .or_else(|| Some(output_content_items_text(output)).filter(|value| !value.is_empty()))
}

fn output_content_items_text(value: &Value) -> String {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.as_str().map(str::to_owned).or_else(|| {
                part.get("text")
                    .or_else(|| part.get("content"))
                    .or_else(|| part.get("inputText"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn tool_status(item: &Value) -> String {
    let item_type = item_type(item);
    if let Some(status) = mcp_tool_status(item, &item_type) {
        return status;
    }
    let status = string_field(item, "status").unwrap_or_else(|| {
        if matches!(item_type.as_str(), "imageview" | "sleep" | "websearch")
            || is_codex_tool_output_item_type(&item_type)
            || is_likely_codex_tool_output_item_type(&item_type)
            || item.get("output").is_some()
            || item.get("result").is_some()
            || item.get("aggregatedOutput").is_some()
            || item.get("aggregated_output").is_some()
            || item.get("stdout").is_some()
            || item.get("stderr").is_some()
        {
            "completed".to_owned()
        } else {
            "inProgress".to_owned()
        }
    });
    if status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("failure")
        || status.eq_ignore_ascii_case("error")
        || bool_field(item, "success").is_some_and(|success| !success)
        || has_error_value(item)
    {
        "error".to_owned()
    } else if is_command_status_item_type(&item_type) {
        match command_exit_code(item) {
            Some(0) => "done".to_owned(),
            Some(_) => "error".to_owned(),
            None => status_from_completion_signal(item, &status),
        }
    } else if status.eq_ignore_ascii_case("completed")
        || status.eq_ignore_ascii_case("complete")
        || status.eq_ignore_ascii_case("done")
        || status.eq_ignore_ascii_case("succeeded")
        || bool_field(item, "success").is_some_and(|success| success)
    {
        "done".to_owned()
    } else {
        "pending".to_owned()
    }
}

fn status_from_completion_signal(item: &Value, status: &str) -> String {
    if status.eq_ignore_ascii_case("completed")
        || status.eq_ignore_ascii_case("complete")
        || status.eq_ignore_ascii_case("done")
        || status.eq_ignore_ascii_case("succeeded")
        || bool_field(item, "success").is_some_and(|success| success)
    {
        "done".to_owned()
    } else {
        "pending".to_owned()
    }
}

fn mcp_tool_status(item: &Value, item_type: &str) -> Option<String> {
    if !matches!(item_type, "mcptoolcall" | "mcpcall" | "mcptoolcallend") {
        return None;
    }

    if has_error_value(item) {
        return Some("error".to_owned());
    }

    let result = item.get("result")?;
    if result.get("Err").or_else(|| result.get("err")).is_some() {
        return Some("error".to_owned());
    }

    let ok_result = result
        .get("Ok")
        .or_else(|| result.get("ok"))
        .unwrap_or(result);
    if ok_result
        .get("isError")
        .or_else(|| ok_result.get("is_error"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Some("error".to_owned());
    }

    Some("done".to_owned())
}

fn has_error_value(item: &Value) -> bool {
    item.get("error").is_some_and(|error| match error {
        Value::Null => false,
        Value::String(message) => !message.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
        Value::Bool(value) => *value,
        Value::Number(_) => true,
    })
}

fn command_exit_code(item: &Value) -> Option<i64> {
    integer_field(item, "exit_code").or_else(|| integer_field(item, "exitCode"))
}

fn is_command_status_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandexecution" | "shellcall" | "localshellcall" | "execcommandend"
    )
}
