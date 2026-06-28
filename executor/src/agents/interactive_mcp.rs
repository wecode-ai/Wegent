// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::{json, Map, Value};

const INVALID_FORM_MESSAGE: &str = "模型给出的表单格式不对";
const FORM_GENERATION_FAILED_MESSAGE: &str = "交互式表单生成失败";
const TOOL_PROTOCOL_MCP_CALL: &str = "mcp_call";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedMcpToolName {
    pub server_name: String,
    pub tool_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeferredToolUse {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeferredMcpProxyRequest {
    pub tool_use_id: String,
    pub original_tool_name: String,
    pub server_name: String,
    pub tool_name: String,
    pub server_url: String,
    pub headers: Value,
    pub timeout_seconds: Option<u64>,
    pub arguments: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeferredMcpProxyResult {
    pub tool_use_id: String,
    pub tool_name: String,
    pub server_name: String,
    pub tool_result: Value,
    pub output_text: String,
    pub is_deferred_user_input: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractiveMcpError {
    InvalidMcpToolName,
    MissingServerConfig,
    MissingServerUrl,
    MissingToolUseId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskTerminalStatus {
    Completed,
    Failed,
    DeferredMcpRetry,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeferredMcpResponseAction {
    CompleteWaitingForUser,
    Retry,
    Fail,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolStartEvent {
    pub call_id: String,
    pub name: String,
    pub tool_protocol: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolDoneEvent {
    pub call_id: String,
    pub name: String,
    pub tool_protocol: String,
    pub server_label: String,
    pub output: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DoneEvent {
    pub content: String,
    pub usage: Value,
    pub stop_reason: String,
    pub silent_exit: bool,
    pub silent_exit_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeferredMcpResponseDecision {
    pub action: DeferredMcpResponseAction,
    pub status: TaskTerminalStatus,
    pub tool_start: Option<ToolStartEvent>,
    pub tool_done: Option<ToolDoneEvent>,
    pub done: Option<DoneEvent>,
    pub retry_query: Option<Value>,
    pub user_error: Option<String>,
    pub internal_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InteractiveFormResumePlan {
    pub query: ClaudeFollowUpQuery,
    pub session_id: Option<String>,
    pub drain_stale_defer_before_query: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClaudeFollowUpQuery {
    Prompt(String),
    ToolResult(Value),
}

pub fn parse_mcp_tool_name(name: &str) -> Option<ParsedMcpToolName> {
    let remainder = name.strip_prefix("mcp__")?;
    let (server_name, tool_name) = remainder.split_once("__")?;
    let server_name = server_name.trim();
    let tool_name = tool_name.trim();

    if server_name.is_empty() || tool_name.is_empty() {
        return None;
    }

    Some(ParsedMcpToolName {
        server_name: server_name.to_owned(),
        tool_name: tool_name.to_owned(),
    })
}

pub fn build_pre_tool_use_defer_response() -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "defer"
        }
    })
}

pub fn is_deferred_user_input_result(result: &Value) -> bool {
    contains_waiting_for_user_payload(result)
}

pub fn build_deferred_mcp_proxy_request(
    deferred_tool_use: &DeferredToolUse,
    mcp_servers: &Value,
) -> Result<DeferredMcpProxyRequest, InteractiveMcpError> {
    let parsed = parse_mcp_tool_name(&deferred_tool_use.name)
        .ok_or(InteractiveMcpError::InvalidMcpToolName)?;
    let server = resolve_mcp_server_config(mcp_servers, &parsed.server_name)
        .ok_or(InteractiveMcpError::MissingServerConfig)?;
    let server_url = server
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(InteractiveMcpError::MissingServerUrl)?;
    let headers = server
        .get("headers")
        .filter(|value| value.as_object().is_some())
        .cloned()
        .unwrap_or_else(|| json!({}));

    Ok(DeferredMcpProxyRequest {
        tool_use_id: deferred_tool_use.id.clone(),
        original_tool_name: deferred_tool_use.name.clone(),
        server_name: parsed.server_name,
        tool_name: parsed.tool_name,
        server_url: server_url.to_owned(),
        headers,
        timeout_seconds: server.get("timeout").and_then(Value::as_u64),
        arguments: deferred_tool_use.input.clone(),
    })
}

pub fn normalize_mcp_tool_result(
    request: &DeferredMcpProxyRequest,
    raw_result: Value,
) -> DeferredMcpProxyResult {
    let content = raw_result
        .get("content")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let tool_result = json!({ "content": content });
    let output_text = collect_text_content(&tool_result).join("\n");
    let is_deferred_user_input = is_deferred_user_input_result(&tool_result);

    DeferredMcpProxyResult {
        tool_use_id: request.tool_use_id.clone(),
        tool_name: request.original_tool_name.clone(),
        server_name: request.server_name.clone(),
        tool_result,
        output_text,
        is_deferred_user_input,
    }
}

pub fn deferred_proxy_response_decision(
    proxy_result: &DeferredMcpProxyResult,
    stop_reason: &str,
    usage: Value,
    deferred_mcp_retry_count: usize,
    max_deferred_mcp_retries: usize,
) -> DeferredMcpResponseDecision {
    let tool_start = Some(tool_start_event(
        &proxy_result.tool_use_id,
        &proxy_result.tool_name,
    ));
    let tool_done = Some(tool_done_event(
        &proxy_result.tool_use_id,
        &proxy_result.tool_name,
        &proxy_result.server_name,
        Some(proxy_result.output_text.clone()),
        None,
    ));

    if proxy_result.is_deferred_user_input
        || is_deferred_user_input_result(&proxy_result.tool_result)
    {
        return DeferredMcpResponseDecision {
            action: DeferredMcpResponseAction::CompleteWaitingForUser,
            status: TaskTerminalStatus::Completed,
            tool_start,
            tool_done,
            done: Some(DoneEvent {
                content: String::new(),
                usage,
                stop_reason: stop_reason.to_owned(),
                silent_exit: true,
                silent_exit_reason: Some("waiting_for_user_input".to_owned()),
            }),
            retry_query: None,
            user_error: None,
            internal_error: None,
        };
    }

    if deferred_mcp_retry_count < max_deferred_mcp_retries {
        return DeferredMcpResponseDecision {
            action: DeferredMcpResponseAction::Retry,
            status: TaskTerminalStatus::DeferredMcpRetry,
            tool_start,
            tool_done,
            done: None,
            retry_query: Some(build_retry_tool_result_query(
                &proxy_result.tool_use_id,
                &Value::Null,
                &proxy_result.output_text,
            )),
            user_error: None,
            internal_error: None,
        };
    }

    DeferredMcpResponseDecision {
        action: DeferredMcpResponseAction::Fail,
        status: TaskTerminalStatus::Failed,
        tool_start,
        tool_done,
        done: None,
        retry_query: None,
        user_error: Some(INVALID_FORM_MESSAGE.to_owned()),
        internal_error: None,
    }
}

pub fn build_retry_tool_result_query(
    tool_use_id: &str,
    _original_input: &Value,
    _proxy_output_text: &str,
) -> Value {
    let payload = json!({
        "error": "interactive_form_question arguments were invalid",
        "message": "Call interactive_form_question again with valid questions. Each question must include an id and question text."
    });

    build_tool_result_query(tool_use_id, payload, true)
}

pub fn deferred_proxy_exception_failure(
    deferred_tool_use: &DeferredToolUse,
    internal_error: &str,
) -> DeferredMcpResponseDecision {
    let parsed = parse_mcp_tool_name(&deferred_tool_use.name);
    let server_label = parsed
        .as_ref()
        .map(|name| name.server_name.clone())
        .unwrap_or_default();

    DeferredMcpResponseDecision {
        action: DeferredMcpResponseAction::Fail,
        status: TaskTerminalStatus::Failed,
        tool_start: Some(tool_start_event(
            &deferred_tool_use.id,
            &deferred_tool_use.name,
        )),
        tool_done: Some(tool_done_event(
            &deferred_tool_use.id,
            &deferred_tool_use.name,
            &server_label,
            Some(FORM_GENERATION_FAILED_MESSAGE.to_owned()),
            Some(FORM_GENERATION_FAILED_MESSAGE.to_owned()),
        )),
        done: None,
        retry_query: None,
        user_error: Some(FORM_GENERATION_FAILED_MESSAGE.to_owned()),
        internal_error: Some(internal_error.to_owned()),
    }
}

pub fn build_interactive_form_answer_payload(answer: &Value) -> Value {
    let mut payload = Map::new();

    for key in [
        "type",
        "tool_use_id",
        "task_id",
        "subtask_id",
        "answers",
        "success",
        "status",
        "message",
    ] {
        if let Some(value) = answer.get(key) {
            payload.insert(key.to_owned(), value.clone());
        }
    }

    Value::Object(payload)
}

pub fn build_interactive_form_answer_query(answer: &Value) -> Result<Value, InteractiveMcpError> {
    let payload = build_interactive_form_answer_payload(answer);
    let tool_use_id = payload
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or(InteractiveMcpError::MissingToolUseId)?;

    Ok(build_tool_result_query(&tool_use_id, payload, false))
}

pub fn build_interactive_form_resume_plan(
    prompt: &str,
    cwd: Option<&str>,
    interactive_form_answer: Option<&Value>,
    session_id: Option<&str>,
) -> Result<InteractiveFormResumePlan, InteractiveMcpError> {
    if let Some(answer) = interactive_form_answer {
        return Ok(InteractiveFormResumePlan {
            query: ClaudeFollowUpQuery::ToolResult(build_interactive_form_answer_query(answer)?),
            session_id: session_id.map(ToOwned::to_owned),
            drain_stale_defer_before_query: session_id.is_some(),
        });
    }

    Ok(InteractiveFormResumePlan {
        query: ClaudeFollowUpQuery::Prompt(build_prompt_follow_up(prompt, cwd)),
        session_id: session_id.map(ToOwned::to_owned),
        drain_stale_defer_before_query: false,
    })
}

fn build_tool_result_query(tool_use_id: &str, payload: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string());

    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": [
                        {
                            "type": "text",
                            "text": text
                        }
                    ],
                    "is_error": is_error
                }
            ]
        },
        "parent_tool_use_id": Value::Null
    })
}

fn build_prompt_follow_up(prompt: &str, cwd: Option<&str>) -> String {
    let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) else {
        return prompt.to_owned();
    };

    format!("{prompt}\n\nCurrent working directory: {cwd}")
}

fn tool_start_event(call_id: &str, name: &str) -> ToolStartEvent {
    ToolStartEvent {
        call_id: call_id.to_owned(),
        name: name.to_owned(),
        tool_protocol: TOOL_PROTOCOL_MCP_CALL.to_owned(),
    }
}

fn tool_done_event(
    call_id: &str,
    name: &str,
    server_label: &str,
    output: Option<String>,
    error: Option<String>,
) -> ToolDoneEvent {
    ToolDoneEvent {
        call_id: call_id.to_owned(),
        name: name.to_owned(),
        tool_protocol: TOOL_PROTOCOL_MCP_CALL.to_owned(),
        server_label: server_label.to_owned(),
        output,
        error,
    }
}

fn collect_text_content(result: &Value) -> Vec<String> {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn contains_waiting_for_user_payload(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            is_waiting_for_user_payload(object)
                || object
                    .get("text")
                    .and_then(Value::as_str)
                    .is_some_and(text_contains_waiting_for_user_payload)
                || object
                    .get("content")
                    .is_some_and(contains_waiting_for_user_payload)
                || object
                    .get("result")
                    .is_some_and(contains_waiting_for_user_payload)
        }
        Value::Array(items) => items.iter().any(contains_waiting_for_user_payload),
        Value::String(text) => text_contains_waiting_for_user_payload(text),
        _ => false,
    }
}

fn is_waiting_for_user_payload(object: &Map<String, Value>) -> bool {
    object
        .get("__deferred_user_input__")
        .and_then(Value::as_bool)
        == Some(true)
        && object.get("success").and_then(Value::as_bool) == Some(true)
        && object.get("status").and_then(Value::as_str) == Some("waiting_for_user_response")
}

fn text_contains_waiting_for_user_payload(text: &str) -> bool {
    serde_json::from_str::<Value>(text)
        .ok()
        .is_some_and(|value| contains_waiting_for_user_payload(&value))
}

fn resolve_mcp_server_config<'a>(mcp_servers: &'a Value, server_name: &str) -> Option<&'a Value> {
    match mcp_servers {
        Value::Object(object) => {
            for key in ["mcpServers", "mcp_servers"] {
                if let Some(server) = object
                    .get(key)
                    .and_then(|nested| resolve_mcp_server_config(nested, server_name))
                {
                    return Some(server);
                }
            }

            object.get(server_name).or_else(|| {
                let normalized_target = normalize_mcp_server_name(server_name);
                object.iter().find_map(|(name, config)| {
                    (config.is_object() && normalize_mcp_server_name(name) == normalized_target)
                        .then_some(config)
                })
            })
        }
        Value::Array(items) => {
            let normalized_target = normalize_mcp_server_name(server_name);
            items.iter().find(|item| {
                item.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|name| normalize_mcp_server_name(name) == normalized_target)
            })
        }
        _ => None,
    }
}

fn normalize_mcp_server_name(name: &str) -> String {
    name.replace('_', "-")
}
