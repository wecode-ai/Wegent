// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashSet,
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(not(test))]
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::logging::log_executor_event;
use crate::protocol::ExecutionRequest;

use super::{
    BinaryInput, DeliveryCreate, ProjectCreate, RuntimeTaskAddress, TaskRuntime, TaskSearch,
};

pub const SPACE_MCP_SERVER_NAME: &str = "wework_space";
const SPACE_MCP_LOG_FILE: &str = "space-mcp.log";
pub const SPACE_CONTEXT_GRANT_ENV: &str = "WEWORK_SPACE_CONTEXT_GRANT";
const SPACE_CONTEXT_GRANT_TTL_SECONDS: i64 = 60 * 60;
static SPACE_MCP_LOG_WRITE_ERROR_REPORTED: AtomicBool = AtomicBool::new(false);
#[cfg(not(test))]
static ACTIVE_SPACE_CONTEXT_GRANT: OnceLock<Option<SpaceContextGrant>> = OnceLock::new();

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct SpaceContextGrant {
    version: u8,
    task_id: String,
    space_id: Option<String>,
    item_id: Option<String>,
    device_id: Option<String>,
    automation_run_id: Option<String>,
    automation_manager: bool,
    expires_at_unix: i64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SpaceMcpRequestContext {
    grant: Option<SpaceContextGrant>,
    backend_url: Option<String>,
    auth_token: Option<String>,
}

impl SpaceMcpRequestContext {
    pub(crate) fn new(
        grant: Option<SpaceContextGrant>,
        backend_url: Option<String>,
        auth_token: Option<String>,
    ) -> Self {
        Self {
            grant,
            backend_url,
            auth_token,
        }
    }

    fn from_env() -> Self {
        Self::new(
            current_space_context_grant(),
            non_empty_env("WEWORK_SPACE_BACKEND_URL"),
            non_empty_env("WEWORK_SPACE_AUTH_TOKEN"),
        )
    }

    fn grant(&self) -> Option<&SpaceContextGrant> {
        self.grant.as_ref()
    }
}

pub fn is_space_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("space-mcp-server")
}

pub fn encoded_space_context_grant(request: &ExecutionRequest) -> Option<String> {
    let origin = request.extra.get("origin").and_then(Value::as_object);
    let automation_origin = origin
        .filter(|origin| origin.get("type").and_then(Value::as_str) == Some("project_automation"));
    let automation_manager = automation_origin.is_some_and(|origin| {
        origin.get("automationRole").and_then(Value::as_str) == Some("manager")
    });
    if automation_origin.is_some() && !automation_manager {
        log_executor_event(
            "space capability skipped for project automation",
            &[("task_id", request.task_id.clone())],
        );
        return None;
    }
    let space_id = request
        .extra
        .get("cloudProjectId")
        .or_else(|| request.extra.get("cloud_project_id"))
        .and_then(id_value)
        .or_else(|| {
            origin
                .and_then(|value| {
                    value
                        .get("cloudProjectId")
                        .or_else(|| value.get("cloud_project_id"))
                })
                .and_then(id_value)
        })
        .filter(|value| !value.is_empty());
    let item_id = origin
        .and_then(|value| {
            value
                .get("loopItemId")
                .or_else(|| value.get("loop_item_id"))
        })
        .and_then(id_value)
        .filter(|value| !value.is_empty());
    let prompt_has_cloud_ref = prompt_references_cloud_projects(&request.prompt);
    log_executor_event(
        "space capability context decision",
        &[
            ("task_id", request.task_id.clone()),
            ("space_id", space_id.as_deref().unwrap_or("").to_owned()),
            ("item_id", item_id.as_deref().unwrap_or("").to_owned()),
            (
                "origin_type",
                origin
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            ),
            ("prompt_has_cloud_ref", prompt_has_cloud_ref.to_string()),
            (
                "shell_type",
                request.resolved_shell_type().unwrap_or_default(),
            ),
        ],
    );
    if space_id.is_none() && !prompt_has_cloud_ref {
        return None;
    }
    let grant = SpaceContextGrant {
        version: 1,
        task_id: request.task_id.clone(),
        space_id,
        item_id,
        device_id: request.device_id.clone().filter(|value| !value.is_empty()),
        automation_run_id: automation_origin
            .and_then(|origin| origin.get("run_id"))
            .and_then(id_value)
            .filter(|value| !value.is_empty()),
        automation_manager,
        expires_at_unix: Local::now().timestamp() + SPACE_CONTEXT_GRANT_TTL_SECONDS,
    };
    let encoded = serde_json::to_vec(&grant)
        .ok()
        .map(|bytes| STANDARD.encode(bytes))?;
    log_executor_event(
        "space capability context prepared",
        &[
            ("task_id", request.task_id.clone()),
            ("grant_version", grant.version.to_string()),
        ],
    );
    Some(encoded)
}

fn prompt_references_cloud_projects(prompt: &Value) -> bool {
    match prompt {
        Value::String(text) => text.contains("cloud://projects"),
        Value::Array(blocks) => blocks.iter().any(|block| match block {
            Value::String(text) => text.contains("cloud://projects"),
            Value::Object(object) => object
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains("cloud://projects")),
            _ => false,
        }),
        Value::Object(object) => object
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("cloud://projects")),
        _ => false,
    }
}

fn id_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

pub async fn run() -> Result<(), String> {
    let runtime = TaskRuntime::from_env().map_err(|error| error.to_string())?;
    let context = SpaceMcpRequestContext::from_env();
    let grant = context.grant();
    write_space_mcp_log(&format!(
        "[wework-space-mcp] lifecycle=start version={} pid={} grant_version={} manager_mode={} space_id_present={} item_id_present={} backend_url_present={} auth_token_present={}",
        env!("CARGO_PKG_VERSION"),
        std::process::id(),
        grant.as_ref().map_or(0, |grant| grant.version),
        grant.as_ref().is_some_and(|grant| grant.automation_manager),
        grant.as_ref().is_some_and(|grant| grant.space_id.is_some()),
        grant.as_ref().is_some_and(|grant| grant.item_id.is_some()),
        env_value_present("WEWORK_SPACE_BACKEND_URL"),
        env_value_present("WEWORK_SPACE_AUTH_TOKEN"),
    ));
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    let mut request_count = 0_u64;
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        request_count += 1;
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => {
                let method = request
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>");
                let tool = request
                    .pointer("/params/name")
                    .and_then(Value::as_str)
                    .unwrap_or("-");
                write_space_mcp_log(&format!(
                    "[wework-space-mcp] request={} stage=received method={} tool={}",
                    request_count, method, tool,
                ));
                handle_request_with_context(&runtime, &request, &context).await
            }
            Err(error) => {
                write_space_mcp_log(&format!(
                    "[wework-space-mcp] request={} stage=parse_failed error={}",
                    request_count, error,
                ));
                Some(error_response(Value::Null, -32700, &error.to_string()))
            }
        };
        if let Some(response) = response {
            let mut encoded = serde_json::to_vec(&response).map_err(|error| error.to_string())?;
            encoded.push(b'\n');
            stdout
                .write_all(&encoded)
                .await
                .map_err(|error| error.to_string())?;
            stdout.flush().await.map_err(|error| error.to_string())?;
        }
    }
    write_space_mcp_log(&format!(
        "[wework-space-mcp] lifecycle=stdin_closed pid={} requests={}",
        std::process::id(),
        request_count,
    ));
    Ok(())
}

fn env_value_present(key: &str) -> bool {
    env::var(key).is_ok_and(|value| !value.trim().is_empty())
}

pub(crate) async fn handle_request_with_context(
    runtime: &TaskRuntime,
    request: &Value,
    context: &SpaceMcpRequestContext,
) -> Option<Value> {
    let id = request.get("id").cloned();
    match request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "notifications/initialized" => None,
        "initialize" => id.map(|id| {
            let protocol_version = request
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            result_response(
                id,
                json!({
                    "protocolVersion": protocol_version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {
                        "name": SPACE_MCP_SERVER_NAME,
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }),
        "ping" => id.map(|id| result_response(id, json!({}))),
        "tools/list" => id.map(|id| {
            let tools = visible_tools(runtime, context);
            let names = tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(",");
            write_space_mcp_log(&format!(
                "[wework-space-mcp] stage=tools_list manager_mode={} tool_count={} tools={}",
                is_automation_manager(context.grant()),
                tools.len(),
                names,
            ));
            result_response(id, json!({"tools": tools}))
        }),
        "tools/call" => {
            let id = id?;
            let name = request.pointer("/params/name").and_then(Value::as_str)?;
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let argument_keys = arguments
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>().join(","))
                .unwrap_or_default();
            write_space_mcp_log(&format!(
                "[wework-space-mcp] stage=tool_call tool={} argument_keys={}",
                name, argument_keys,
            ));
            Some(result_response(
                id,
                call_tool_with_context(runtime, name, arguments, context).await,
            ))
        }
        method => id.map(|id| error_response(id, -32601, &format!("Unknown method: {method}"))),
    }
}

fn write_space_mcp_log(message: &str) {
    eprintln!("{message}");
    let path = space_mcp_log_path();
    let result = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
        writeln!(file, "{timestamp} {message}")?;
        file.flush()
    })();
    if let Err(error) = result {
        if !SPACE_MCP_LOG_WRITE_ERROR_REPORTED.swap(true, Ordering::Relaxed) {
            eprintln!(
                "[wework-space-mcp] lifecycle=file_log_error pid={} path={} error={error}",
                std::process::id(),
                path.display(),
            );
        }
    }
}

fn space_mcp_log_path() -> PathBuf {
    if let Some(log_dir) = non_empty_env("WEGENT_EXECUTOR_LOG_DIR") {
        return PathBuf::from(log_dir).join(SPACE_MCP_LOG_FILE);
    }
    if let Some(executor_home) = non_empty_env("WEGENT_EXECUTOR_HOME") {
        return PathBuf::from(executor_home)
            .join("logs")
            .join(SPACE_MCP_LOG_FILE);
    }
    let home = non_empty_env("HOME").unwrap_or_else(|| ".".to_owned());
    PathBuf::from(home)
        .join(".wegent-executor/logs")
        .join(SPACE_MCP_LOG_FILE)
}

fn non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn current_space_context_grant() -> Option<SpaceContextGrant> {
    #[cfg(not(test))]
    {
        ACTIVE_SPACE_CONTEXT_GRANT
            .get_or_init(read_initial_space_context_grant)
            .clone()
    }
    #[cfg(test)]
    read_initial_space_context_grant()
}

fn read_initial_space_context_grant() -> Option<SpaceContextGrant> {
    let encoded = non_empty_env(SPACE_CONTEXT_GRANT_ENV)?;
    decode_space_context_grant(&encoded)
}

pub(crate) fn decode_space_context_grant(encoded: &str) -> Option<SpaceContextGrant> {
    let decoded = STANDARD.decode(encoded).ok()?;
    let grant = serde_json::from_slice::<SpaceContextGrant>(&decoded).ok()?;
    (grant.version == 1 && grant.expires_at_unix >= Local::now().timestamp()).then_some(grant)
}

fn context_scope_error(grant: &SpaceContextGrant, arguments: &Value) -> Option<String> {
    if let Some(requested_space_id) = arguments.get("space_id").and_then(Value::as_str) {
        if grant.space_id.as_deref().is_some_and(|space_id| {
            !requested_space_id.trim().is_empty() && requested_space_id != space_id
        }) {
            return Some("The requested project space is outside this Agent session".to_owned());
        }
    }
    if let Some(requested_item_id) = arguments.get("item_id").and_then(Value::as_str) {
        if grant.item_id.as_deref().is_some_and(|item_id| {
            !requested_item_id.trim().is_empty() && requested_item_id != item_id
        }) {
            return Some("The requested board item is outside this Agent session".to_owned());
        }
    }
    None
}

fn delivery_address(
    grant: Option<&SpaceContextGrant>,
) -> Result<RuntimeTaskAddress, super::TaskRuntimeError> {
    let grant = grant.ok_or_else(|| {
        super::TaskRuntimeError::Invalid(
            "Delivery writes require an Issue-bound Agent session".to_owned(),
        )
    })?;
    let device_id = grant
        .device_id
        .as_ref()
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| {
            super::TaskRuntimeError::Invalid(
                "Delivery writes require a bound Runtime device".to_owned(),
            )
        })?;
    if grant.task_id.is_empty() {
        return Err(super::TaskRuntimeError::Invalid(
            "Delivery writes require a bound Runtime task".to_owned(),
        ));
    }
    Ok(RuntimeTaskAddress {
        device_id,
        task_id: grant.task_id.clone(),
        task_title: None,
        backend_task_id: None,
        workflow_node_id: None,
    })
}

fn delivery_scope_error(
    delivery: &Value,
    address: &RuntimeTaskAddress,
    item_id: &str,
) -> Option<String> {
    if delivery.get("loop_item_id").and_then(Value::as_str) != Some(item_id) {
        return Some("The requested Delivery is outside this Agent session".to_owned());
    }
    if delivery.get("status").and_then(Value::as_str) != Some("draft") {
        return Some("Only a Delivery draft can be changed".to_owned());
    }
    let Some(source) = delivery.get("source_task_snapshot") else {
        return Some("The requested Delivery is not bound to a Runtime task".to_owned());
    };
    let source_device = source
        .get("deviceId")
        .or_else(|| source.get("device_id"))
        .and_then(Value::as_str);
    let source_task = source
        .get("taskId")
        .or_else(|| source.get("task_id"))
        .and_then(Value::as_str);
    if source_device != Some(address.device_id.as_str())
        || source_task != Some(address.task_id.as_str())
    {
        return Some("The requested Delivery belongs to another Runtime task".to_owned());
    }
    None
}

fn delivery_requirements(item: &Value, workflow_node_id: Option<&str>) -> Value {
    let workflow = item
        .get("workflow")
        .or_else(|| item.pointer("/metadata/workflow"));
    let node = workflow_node_id.and_then(|node_id| {
        workflow
            .and_then(|value| value.get("nodes"))
            .and_then(Value::as_array)
            .and_then(|nodes| {
                nodes
                    .iter()
                    .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
            })
    });
    json!({
        "workflow_node_id": workflow_node_id,
        "workflow_node": node,
        "required_deliverables": node
            .and_then(|value| value.get("required_deliverables"))
            .cloned()
            .unwrap_or_else(|| json!([])),
        "delivery_ids": node
            .and_then(|value| value.get("delivery_ids"))
            .cloned()
            .unwrap_or_else(|| json!([])),
    })
}

fn local_workflow_stage_context(item: &Value, workflow_node_id: Option<&str>) -> Value {
    let workflow = item
        .get("workflow")
        .or_else(|| item.pointer("/metadata/workflow"));
    let nodes = workflow
        .and_then(|value| value.get("nodes"))
        .and_then(Value::as_array);
    let target = workflow_node_id.and_then(|node_id| {
        nodes.and_then(|values| {
            values
                .iter()
                .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
        })
    });
    let dependency_ids = target
        .and_then(|value| value.get("depends_on"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let dependencies = dependency_ids
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|dependency_id| {
            nodes.and_then(|values| {
                values
                    .iter()
                    .find(|node| node.get("id").and_then(Value::as_str) == Some(dependency_id))
            })
        })
        .map(|node| {
            json!({
                "stage_id": node.get("id"),
                "stage_name": node.get("name"),
                "status": node.get("status"),
                "delivery_ids": node.get("delivery_ids").cloned().unwrap_or_else(|| json!([])),
                "selected_sources": target
                    .and_then(|value| value.get("dependency_context"))
                    .and_then(|value| value.get(node.get("id").and_then(Value::as_str).unwrap_or_default()))
                    .cloned()
                    .unwrap_or_else(|| json!(["final_result", "deliveries"])),
            })
        })
        .collect::<Vec<_>>();
    json!({
        "version": 1,
        "issue": {
            "id": item.get("id"),
            "title": item.get("title"),
            "description": item.get("description"),
            "status": item.get("status"),
        },
        "target_stage": target,
        "dependencies": dependencies,
    })
}

fn selected_local_delivery_chat(
    runtime: &TaskRuntime,
    project_id: &str,
    item_id: &str,
    arguments: &Value,
) -> Result<Option<Value>, super::TaskRuntimeError> {
    let explicit = arguments.get("chat").filter(|value| !value.is_null());
    let selection = arguments
        .get("chat_selection")
        .filter(|value| !value.is_null());
    if explicit.is_some() && selection.is_some() {
        return Err(super::TaskRuntimeError::Invalid(
            "chat and chat_selection are mutually exclusive".to_owned(),
        ));
    }
    let Some(selection) = selection else {
        return Ok(explicit.cloned());
    };
    let mode = selection
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            super::TaskRuntimeError::Invalid("chat_selection.mode is required".to_owned())
        })?;
    let mut comments = runtime.list_comments(project_id, item_id, 0)?;
    match mode {
        "all" => {}
        "latest" => {
            let count = selection
                .get("count")
                .and_then(Value::as_u64)
                .filter(|count| (1..=500).contains(count))
                .ok_or_else(|| {
                    super::TaskRuntimeError::Invalid(
                        "chat_selection.count must be between 1 and 500".to_owned(),
                    )
                })? as usize;
            if comments.len() > count {
                comments.drain(..comments.len() - count);
            }
        }
        "message_ids" => {
            let ids = selection
                .get("message_ids")
                .and_then(Value::as_array)
                .filter(|ids| !ids.is_empty() && ids.len() <= 500)
                .ok_or_else(|| {
                    super::TaskRuntimeError::Invalid(
                        "chat_selection.message_ids must contain 1 to 500 IDs".to_owned(),
                    )
                })?
                .iter()
                .map(|value| {
                    value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                        super::TaskRuntimeError::Invalid(
                            "chat_selection.message_ids must contain strings".to_owned(),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            let available = comments
                .iter()
                .map(|comment| comment.message_id.as_str())
                .collect::<HashSet<_>>();
            if ids.iter().any(|id| !available.contains(id.as_str())) {
                return Err(super::TaskRuntimeError::Invalid(
                    "One or more selected chat messages do not exist on this Issue".to_owned(),
                ));
            }
            comments.retain(|comment| ids.contains(&comment.message_id));
        }
        _ => {
            return Err(super::TaskRuntimeError::Invalid(
                "chat_selection.mode must be all, latest, or message_ids".to_owned(),
            ));
        }
    }
    Ok(Some(json!({
        "selection": selection,
        "messages": comments,
    })))
}

async fn call_tool_with_context(
    runtime: &TaskRuntime,
    name: &str,
    arguments: Value,
    context: &SpaceMcpRequestContext,
) -> Value {
    call_tool_with_runtime_context(
        runtime,
        name,
        arguments,
        context.grant.clone(),
        context.backend_url.as_deref(),
        context.auth_token.as_deref(),
    )
    .await
}

#[cfg(test)]
async fn call_tool(runtime: &TaskRuntime, name: &str, arguments: Value) -> Value {
    let context = SpaceMcpRequestContext::from_env();
    call_tool_with_context(runtime, name, arguments, &context).await
}

#[cfg(test)]
async fn call_tool_with_grant(
    runtime: &TaskRuntime,
    name: &str,
    arguments: Value,
    grant: Option<SpaceContextGrant>,
) -> Value {
    let backend_url = non_empty_env("WEWORK_SPACE_BACKEND_URL");
    let auth_token = non_empty_env("WEWORK_SPACE_AUTH_TOKEN");
    call_tool_with_runtime_context(
        runtime,
        name,
        arguments,
        grant,
        backend_url.as_deref(),
        auth_token.as_deref(),
    )
    .await
}

async fn call_tool_with_runtime_context(
    runtime: &TaskRuntime,
    name: &str,
    mut arguments: Value,
    grant: Option<SpaceContextGrant>,
    backend_url: Option<&str>,
    auth_token: Option<&str>,
) -> Value {
    if is_automation_manager(grant.as_ref()) && !is_automation_manager_tool(name) {
        return text_result(
            format!("AI-managed automation cannot call wework_space tool: {name}"),
            true,
        );
    }
    if let Some(error) = grant
        .as_ref()
        .and_then(|grant| context_scope_error(grant, &arguments))
    {
        return text_result(error, true);
    }
    let default_project_id = grant.as_ref().and_then(|grant| grant.space_id.clone());
    let default_item_id = grant.as_ref().and_then(|grant| grant.item_id.clone());
    if let Some(object) = arguments.as_object_mut() {
        if !object.contains_key("space_id") {
            if let Some(project_id) = default_project_id.as_deref() {
                object.insert("space_id".to_owned(), json!(project_id));
            }
        }
        if !object.contains_key("item_id") {
            if let Some(item_id) = default_item_id.as_deref() {
                object.insert("item_id".to_owned(), json!(item_id));
            }
        }
    }
    if name == "get_current_context" && (default_project_id.is_none() || default_item_id.is_none())
    {
        return text_result(
            json!({
                "bound": false,
                "space_id": default_project_id,
                "item_id": default_item_id,
            })
            .to_string(),
            false,
        );
    }
    let requested_project_id = arguments
        .get("space_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| default_project_id.clone());
    let is_locally_routed = requested_project_id
        .as_deref()
        .is_some_and(|project_id| is_locally_routed_project(runtime, project_id, name));
    if name == "list_spaces" {
        let local_projects = match runtime.list_projects().and_then(|mut projects| {
            projects.retain(|project| project.metadata["project_store"] != "backend");
            serde_json::to_value(projects).map_err(invalid_json)
        }) {
            Ok(Value::Array(projects)) => projects,
            Ok(_) => Vec::new(),
            Err(error) => return text_result(error.to_string(), true),
        };
        let Some((backend_url, auth_token)) = backend_url.zip(auth_token) else {
            return text_result(Value::Array(local_projects).to_string(), false);
        };
        return match call_backend_tool(
            backend_url,
            auth_token,
            "",
            name,
            &arguments,
            grant.as_ref(),
        )
        .await
        {
            Ok(Value::Array(mut cloud_projects)) => {
                cloud_projects.extend(local_projects);
                text_result(Value::Array(cloud_projects).to_string(), false)
            }
            Ok(value) => text_result(value.to_string(), false),
            Err(error) => text_result(error, true),
        };
    }

    let should_use_backend = backend_url.is_some()
        && auth_token.is_some()
        && (name == "create_space" || (requested_project_id.is_some() && !is_locally_routed));
    if should_use_backend {
        let project_id = requested_project_id.as_deref().unwrap_or_default();
        return match call_backend_tool(
            backend_url.unwrap_or_default(),
            auth_token.unwrap_or_default(),
            project_id,
            name,
            &arguments,
            grant.as_ref(),
        )
        .await
        {
            Ok(value) => text_result(value.to_string(), false),
            Err(error) => text_result(error, true),
        };
    }
    if requested_project_id.is_some() && !is_locally_routed {
        return text_result(
            "The current project space requires the WeWork Backend connection. Retry through wework_space after the connection is restored; do not use git or provider APIs."
                .to_owned(),
            true,
        );
    }
    let result = match name {
        "list_spaces" => unreachable!("list_spaces is handled before tool routing"),
        "get_current_context" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            match (project_id, task_id) {
                (Ok(project_id), Ok(task_id)) => runtime
                    .get_task(project_id, task_id)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json))
                    .map(|item| {
                        json!({
                            "space_id": project_id,
                            "item_id": task_id,
                            "item": item,
                        })
                    }),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "create_space" => parse(arguments)
            .and_then(|input: ProjectCreate| runtime.create_project(input))
            .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
        "update_space" => {
            let project_id = string_argument(&arguments, "space_id");
            let input = parse(
                arguments
                    .get("project")
                    .cloned()
                    .unwrap_or_else(|| arguments.clone()),
            );
            match (project_id, input) {
                (Ok(project_id), Ok(input)) => runtime
                    .update_project(project_id, input)
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "list_board_items" => match string_argument(&arguments, "space_id") {
            Ok(project_id) => runtime
                .list_tasks(project_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
            Err(error) => Err(error),
        },
        "search_board_items" => {
            let requested_space_id = arguments
                .get("space_id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            match parse::<TaskSearch>(arguments) {
                Ok(mut input) => {
                    input.project_id = requested_space_id.or_else(|| default_project_id.clone());
                    runtime
                        .search_tasks(input)
                        .await
                        .and_then(|value| serde_json::to_value(value).map_err(invalid_json))
                }
                Err(error) => Err(error),
            }
        }
        "get_board_item" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            match (project_id, task_id) {
                (Ok(project_id), Ok(task_id)) => runtime
                    .get_task(project_id, task_id)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "get_assignment_candidates"
        | "submit_workflow_plan"
        | "report_workflow_outcome"
        | "assign_board_item" => Err(super::TaskRuntimeError::Invalid(
            "AI-managed orchestration requires a backend project space".to_owned(),
        )),
        "create_board_item" => {
            let project_id = string_argument(&arguments, "space_id");
            let input = parse(
                arguments
                    .get("item")
                    .cloned()
                    .unwrap_or_else(|| arguments.clone()),
            );
            match (project_id, input) {
                (Ok(project_id), Ok(input)) => runtime
                    .create_task(project_id, input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "update_board_item" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            let input = parse(
                arguments
                    .get("item")
                    .cloned()
                    .unwrap_or_else(|| arguments.clone()),
            );
            match (project_id, task_id, input) {
                (Ok(project_id), Ok(task_id), Ok(input)) => runtime
                    .update_task(project_id, task_id, input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "add_board_item_comment" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            let body = string_argument(&arguments, "body");
            match (project_id, task_id, body) {
                (Ok(project_id), Ok(task_id), Ok(body)) => runtime
                    .add_comment(project_id, task_id, body)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "list_item_attachments" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            match (project_id, task_id) {
                (Ok(project_id), Ok(task_id)) => runtime
                    .list_task_attachments(project_id, task_id)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "upload_item_attachment" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            let file_path = string_argument(&arguments, "file_path");
            match (project_id, task_id, file_path) {
                (Ok(project_id), Ok(task_id), Ok(file_path)) => {
                    let input = binary_input_from_path(&arguments, file_path);
                    match input {
                        Ok(input) => runtime
                            .add_task_attachment(project_id, task_id, input)
                            .await
                            .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                        Err(error) => Err(error),
                    }
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "read_item_attachment" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            let attachment_id = string_argument(&arguments, "attachment_id");
            match (project_id, task_id, attachment_id) {
                (Ok(project_id), Ok(task_id), Ok(attachment_id)) => runtime
                    .task_attachment_path(project_id, task_id, attachment_id)
                    .await
                    .and_then(|path| copy_attachment_if_requested(&arguments, &path))
                    .map(|path| json!({"path": path})),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "delete_item_attachment" => {
            let project_id = string_argument(&arguments, "space_id");
            let task_id = string_argument(&arguments, "item_id");
            let attachment_id = string_argument(&arguments, "attachment_id");
            match (project_id, task_id, attachment_id) {
                (Ok(project_id), Ok(task_id), Ok(attachment_id)) => runtime
                    .delete_task_attachment(project_id, task_id, attachment_id)
                    .await
                    .map(|_| json!({"deleted": true})),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "get_delivery_requirements" => {
            let project_id = string_argument(&arguments, "space_id");
            let item_id = string_argument(&arguments, "item_id");
            let address = delivery_address(grant.as_ref());
            match (project_id, item_id, address) {
                (Ok(project_id), Ok(item_id), Ok(address)) => {
                    match runtime.find_task_binding(&address.device_id, &address.task_id) {
                        Ok(binding)
                            if binding.cloud_project_id == project_id
                                && binding.loop_item_id.as_deref() == Some(item_id) =>
                        {
                            runtime
                                .get_task(project_id, item_id)
                                .await
                                .and_then(|item| serde_json::to_value(item).map_err(invalid_json))
                                .map(|item| {
                                    delivery_requirements(
                                        &item,
                                        binding.workflow_node_id.as_deref(),
                                    )
                                })
                        }
                        Ok(_) => Err(super::TaskRuntimeError::Invalid(
                            "The current Runtime task is not bound to this Issue".to_owned(),
                        )),
                        Err(error) => Err(error),
                    }
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "get_workflow_stage_context" => {
            let project_id = string_argument(&arguments, "space_id");
            let item_id = string_argument(&arguments, "item_id");
            let address = delivery_address(grant.as_ref());
            match (project_id, item_id, address) {
                (Ok(project_id), Ok(item_id), Ok(address)) => {
                    match runtime.find_task_binding(&address.device_id, &address.task_id) {
                        Ok(binding)
                            if binding.loop_item_id.as_deref() == Some(item_id)
                                && binding.cloud_project_id == project_id =>
                        {
                            runtime
                                .get_task(project_id, item_id)
                                .await
                                .and_then(|item| serde_json::to_value(item).map_err(invalid_json))
                                .map(|item| {
                                    binding.workflow_stage_input.clone().unwrap_or_else(|| {
                                        local_workflow_stage_context(
                                            &item,
                                            binding.workflow_node_id.as_deref(),
                                        )
                                    })
                                })
                        }
                        Ok(_) => Err(super::TaskRuntimeError::Invalid(
                            "The current Runtime task is not bound to this Issue".to_owned(),
                        )),
                        Err(error) => Err(error),
                    }
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "create_delivery" => {
            let project_id = string_argument(&arguments, "space_id");
            let item_id = string_argument(&arguments, "item_id");
            let address = delivery_address(grant.as_ref());
            match (project_id, item_id, address) {
                (Ok(project_id), Ok(item_id), Ok(address)) => {
                    match selected_local_delivery_chat(runtime, project_id, item_id, &arguments) {
                        Ok(chat) => runtime
                            .create_delivery(
                                project_id,
                                item_id,
                                DeliveryCreate {
                                    markdown: arguments
                                        .get("markdown")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_owned(),
                                    chat,
                                    source_task: Some(address),
                                },
                            )
                            .await
                            .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                        Err(error) => Err(error),
                    }
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "upload_delivery_asset" => {
            let item_id = string_argument(&arguments, "item_id");
            let delivery_id = string_argument(&arguments, "delivery_id");
            let file_path = string_argument(&arguments, "file_path");
            let address = delivery_address(grant.as_ref());
            match (item_id, delivery_id, file_path, address) {
                (Ok(item_id), Ok(delivery_id), Ok(file_path), Ok(address)) => {
                    let relative_path = arguments
                        .get("relative_path")
                        .and_then(Value::as_str)
                        .or_else(|| {
                            Path::new(file_path)
                                .file_name()
                                .and_then(|value| value.to_str())
                        })
                        .ok_or_else(|| {
                            super::TaskRuntimeError::Invalid("relative_path is required".to_owned())
                        });
                    let relative_path = match relative_path {
                        Ok(value) => value,
                        Err(error) => return text_result(error.to_string(), true),
                    };
                    runtime.delivery_detail(delivery_id).and_then(|delivery| {
                        let serialized = serde_json::to_value(&delivery).map_err(invalid_json)?;
                        if let Some(error) = delivery_scope_error(&serialized, &address, item_id) {
                            return Err(super::TaskRuntimeError::Invalid(error));
                        }
                        runtime
                            .add_delivery_asset(
                                delivery_id,
                                relative_path,
                                binary_input_from_path(&arguments, file_path)?,
                            )
                            .and_then(|value| serde_json::to_value(value).map_err(invalid_json))
                    })
                }
                (Err(error), _, _, _)
                | (_, Err(error), _, _)
                | (_, _, Err(error), _)
                | (_, _, _, Err(error)) => Err(error),
            }
        }
        "list_deliveries" => match string_argument(&arguments, "item_id") {
            Ok(item_id) => runtime
                .list_deliveries(item_id)
                .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
            Err(error) => Err(error),
        },
        "read_delivery" => {
            let item_id = string_argument(&arguments, "item_id");
            let delivery_id = string_argument(&arguments, "delivery_id");
            match (item_id, delivery_id) {
                (Ok(item_id), Ok(delivery_id)) => {
                    runtime.delivery_detail(delivery_id).and_then(|delivery| {
                        if delivery.delivery.loop_item_id != item_id {
                            return Err(super::TaskRuntimeError::Invalid(
                                "The requested Delivery is outside this Agent session".to_owned(),
                            ));
                        }
                        serde_json::to_value(delivery).map_err(invalid_json)
                    })
                }
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "download_delivery_asset" => {
            let item_id = string_argument(&arguments, "item_id");
            let delivery_id = string_argument(&arguments, "delivery_id");
            let asset_id = string_argument(&arguments, "asset_id");
            match (item_id, delivery_id, asset_id) {
                (Ok(item_id), Ok(delivery_id), Ok(asset_id)) => {
                    runtime.delivery_detail(delivery_id).and_then(|delivery| {
                        if delivery.delivery.loop_item_id != item_id
                            || !delivery
                                .delivery
                                .assets
                                .iter()
                                .any(|asset| asset.id == asset_id)
                        {
                            return Err(super::TaskRuntimeError::Invalid(
                                "The requested Delivery asset is outside this Agent session"
                                    .to_owned(),
                            ));
                        }
                        runtime
                            .delivery_asset_path(asset_id)
                            .and_then(|path| copy_attachment_if_requested(&arguments, &path))
                            .map(|path| json!({"path": path}))
                    })
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "finalize_delivery" | "discard_delivery_draft" => {
            let item_id = string_argument(&arguments, "item_id");
            let delivery_id = string_argument(&arguments, "delivery_id");
            let address = delivery_address(grant.as_ref());
            match (item_id, delivery_id, address) {
                (Ok(item_id), Ok(delivery_id), Ok(address)) => {
                    runtime.delivery_detail(delivery_id).and_then(|delivery| {
                        let serialized = serde_json::to_value(&delivery).map_err(invalid_json)?;
                        if let Some(error) = delivery_scope_error(&serialized, &address, item_id) {
                            return Err(super::TaskRuntimeError::Invalid(error));
                        }
                        if name == "finalize_delivery" {
                            let input = super::DeliveryFinalize {
                                fulfillments: arguments
                                    .get("fulfillments")
                                    .and_then(Value::as_array)
                                    .cloned()
                                    .unwrap_or_default(),
                            };
                            runtime
                                .finalize_delivery(item_id, delivery_id, input)
                                .and_then(|value| serde_json::to_value(value).map_err(invalid_json))
                        } else {
                            runtime.discard_delivery(delivery_id)?;
                            Ok(json!({"discarded": true}))
                        }
                    })
                }
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "reorder_board_items" => {
            let project_id = string_argument(&arguments, "space_id");
            let input = parse(
                arguments
                    .get("reorder")
                    .cloned()
                    .unwrap_or_else(|| arguments.clone()),
            );
            match (project_id, input) {
                (Ok(project_id), Ok(input)) => runtime
                    .reorder_tasks(project_id, input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "describe_space_table" => match string_argument(&arguments, "space_id") {
            Ok(project_id) => runtime
                .aitable_describe(project_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
            Err(error) => Err(error),
        },
        "list_table_records" => {
            let project_id = string_argument(&arguments, "space_id");
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let cursor = arguments
                .get("cursor")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let limit = arguments
                .get("limit")
                .and_then(Value::as_i64)
                .unwrap_or(100);
            match project_id {
                Ok(project_id) => runtime
                    .aitable_list_records(
                        project_id,
                        query.as_deref(),
                        limit,
                        cursor.as_deref(),
                        None,
                    )
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                Err(error) => Err(error),
            }
        }
        "create_table_record" => {
            let project_id = string_argument(&arguments, "space_id");
            let cells = cells_argument(&arguments);
            match (project_id, cells) {
                (Ok(project_id), Ok(cells)) => runtime
                    .aitable_create_record(project_id, cells)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "update_table_record" => {
            let project_id = string_argument(&arguments, "space_id");
            let record_id = string_argument(&arguments, "record_id");
            let cells = cells_argument(&arguments);
            match (project_id, record_id, cells) {
                (Ok(project_id), Ok(record_id), Ok(cells)) => runtime
                    .aitable_update_record(project_id, record_id, cells)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "delete_table_record" => {
            let project_id = string_argument(&arguments, "space_id");
            let record_id = string_argument(&arguments, "record_id");
            match (project_id, record_id) {
                (Ok(project_id), Ok(record_id)) => runtime
                    .aitable_delete_record(project_id, record_id)
                    .await
                    .map(|_| json!({"deleted": true})),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "create_table_field" => {
            let project_id = string_argument(&arguments, "space_id");
            let name = string_argument(&arguments, "name");
            let field_type = string_argument(&arguments, "field_type");
            let property = arguments
                .get("config")
                .or_else(|| arguments.get("property"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            match (project_id, name, field_type) {
                (Ok(project_id), Ok(name), Ok(field_type)) => runtime
                    .aitable_create_field(project_id, name, field_type, property)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "update_table_field" => {
            let project_id = string_argument(&arguments, "space_id");
            let field_id = string_argument(&arguments, "field_id");
            let payload = arguments
                .get("field")
                .or_else(|| arguments.get("config"))
                .cloned()
                .unwrap_or_else(|| arguments.clone());
            let payload = payload.as_object().cloned().map(|mut map| {
                map.remove("space_id");
                map.remove("field_id");
                if let Some(config) = map.remove("config") {
                    map.insert("property".to_owned(), config);
                }
                map
            });
            match (project_id, field_id, payload) {
                (Ok(project_id), Ok(field_id), Some(payload)) => runtime
                    .aitable_update_field(project_id, field_id, payload)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _, _) | (_, Err(error), _) => Err(error),
                (_, _, None) => Err(super::TaskRuntimeError::Invalid(
                    "field update payload must be an object".to_owned(),
                )),
            }
        }
        "delete_table_field" => {
            let project_id = string_argument(&arguments, "space_id");
            let field_id = string_argument(&arguments, "field_id");
            match (project_id, field_id) {
                (Ok(project_id), Ok(field_id)) => runtime
                    .aitable_delete_field(project_id, field_id)
                    .await
                    .map(|_| json!({"deleted": true})),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        _ => return text_result(format!("Unknown wework_space tool: {name}"), true),
    };
    match result {
        Ok(mut value) => {
            if let Some(project_id) = requested_project_id.as_deref() {
                if is_dingtalk_project(runtime, project_id)
                    && is_dingtalk_read_tool(name)
                    && primary_document_read_failed(&value)
                {
                    if let Some(item_id) = default_item_id.as_deref() {
                        if let Ok(fallback) = runtime.dws_read_fallback(project_id, item_id) {
                            value["bundled_dws_fallback"] = fallback;
                        }
                    }
                }
            }
            text_result(value.to_string(), false)
        }
        Err(error) => {
            let fallback = requested_project_id
                .as_deref()
                .filter(|project_id| {
                    is_dingtalk_project(runtime, project_id) && is_dingtalk_read_tool(name)
                })
                .and_then(|project_id| {
                    default_item_id.as_deref().and_then(|item_id| {
                        runtime
                            .dws_read_fallback(project_id, item_id)
                            .ok()
                            .map(|fallback| {
                                json!({
                                    "provider_error": error.to_string(),
                                    "bundled_dws_fallback": fallback,
                                })
                            })
                    })
                });
            match fallback {
                Some(value) => text_result(value.to_string(), false),
                None => text_result(error.to_string(), true),
            }
        }
    }
}

fn is_locally_routed_project(runtime: &TaskRuntime, project_id: &str, tool_name: &str) -> bool {
    let project = runtime
        .list_projects()
        .unwrap_or_default()
        .into_iter()
        .find(|project| project.id == project_id);
    project.is_some_and(|project| {
        project.metadata["project_store"].as_str() == Some("local")
            || (project.metadata["task_provider"].as_str() == Some("dingtalk_aitable")
                && is_dingtalk_read_tool(tool_name))
    })
}

fn is_dingtalk_project(runtime: &TaskRuntime, project_id: &str) -> bool {
    runtime
        .list_projects()
        .unwrap_or_default()
        .into_iter()
        .find(|project| project.id == project_id)
        .is_some_and(|project| {
            project.metadata["task_provider"].as_str() == Some("dingtalk_aitable")
        })
}

fn is_dingtalk_read_tool(name: &str) -> bool {
    matches!(name, "get_current_context" | "get_board_item")
}

fn primary_document_read_failed(value: &Value) -> bool {
    value
        .pointer("/item/metadata/primary_document/error")
        .or_else(|| value.pointer("/metadata/primary_document/error"))
        .is_some()
}

async fn call_backend_tool(
    backend_url: &str,
    auth_token: &str,
    project_id: &str,
    name: &str,
    arguments: &Value,
    grant: Option<&SpaceContextGrant>,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let base = format!("{}/api/v1", backend_url.trim_end_matches('/'));
    let task_id = || {
        arguments
            .get("item_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "task_id is required".to_owned())
    };
    let request = match name {
        "list_spaces" => client.get(format!("{base}/cloud-projects")),
        "list_space_files" => {
            let mut request = client.get(format!("{base}/cloud-projects/{project_id}/files"));
            if let Some(prefix) = arguments.get("prefix").and_then(Value::as_str) {
                request = request.query(&[("prefix", prefix)]);
            }
            request
        }
        "read_space_file" => {
            let file_id = string_argument(arguments, "file_id").map_err(|e| e.to_string())?;
            let output_path = attachment_output_path(arguments, file_id)
                .map_err(|error| error.to_string())?;
            let access = backend_json(
                client
                    .get(format!(
                        "{base}/cloud-projects/files/{}/access",
                        encode_segment(file_id)
                    ))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            download_backend_object(&client, &access, &output_path).await?;
            return Ok(json!({"path": output_path}));
        }
        "list_board_items" => client.get(format!("{base}/cloud-projects/{project_id}/loop-items")),
        "search_board_items" => {
            let response = backend_json(
                client
                    .get(format!("{base}/cloud-projects/{project_id}/loop-items"))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            return Ok(filter_backend_tasks(response, arguments));
        }
        "get_current_context" => {
            let item_id = task_id()?;
            let item = backend_json(
                client
                    .get(format!("{base}/loop-items/{}", encode_segment(item_id)))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            return Ok(json!({
                "space_id": project_id,
                "item_id": item_id,
                "item": item,
            }));
        }
        "get_board_item" => client.get(format!("{base}/loop-items/{}", encode_segment(task_id()?))),
        "get_assignment_candidates" => {
            let members = backend_json(
                client
                    .get(format!("{base}/cloud-projects/{project_id}/members"))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            let robots = backend_json(
                client
                    .get(format!("{base}/cloud-projects/{project_id}/chat-agents"))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            return Ok(normalize_assignment_candidates(members, robots));
        }
        "submit_workflow_plan" => {
            let request = client
                .post(format!(
                    "{base}/loop-items/{}/workflow-plan",
                    encode_segment(task_id()?)
                ))
                .json(arguments.get("plan").unwrap_or(arguments));
            with_automation_run_header(request, grant)
        }
        "report_workflow_outcome" => client
            .post(format!(
                "{base}/loop-items/{}/workflow-outcome",
                encode_segment(task_id()?)
            ))
            .json(&json!({
                "verdict": arguments.get("verdict").and_then(Value::as_str).unwrap_or_default(),
                "summary": arguments.get("summary").and_then(Value::as_str).unwrap_or_default(),
                "findings": arguments.get("findings").cloned().unwrap_or_else(|| json!([])),
            })),
        "assign_board_item" => {
            let run_id = grant
                .and_then(|grant| grant.automation_run_id.clone())
                .ok_or_else(|| {
                    "assign_board_item is only available to an AI-managed automation"
                        .to_owned()
                })?;
            client
                .post(format!(
                    "{base}/cloud-projects/{project_id}/automation-runs/{}/assign",
                    encode_segment(&run_id)
                ))
                .json(&json!({
                    "assignee_type": arguments.get("assignee_type").and_then(Value::as_str).unwrap_or_default(),
                    "assignee_id": arguments.get("assignee_id").and_then(Value::as_str).unwrap_or_default(),
                }))
        }
        "create_board_item" => client
            .post(format!("{base}/cloud-projects/{project_id}/loop-items"))
            .json(arguments.get("item").unwrap_or(arguments)),
        "update_board_item" => client
            .patch(format!("{base}/loop-items/{}", encode_segment(task_id()?)))
            .json(arguments.get("item").unwrap_or(arguments)),
        "add_board_item_comment" => client
            .post(format!(
                "{base}/loop-items/{}/comments",
                encode_segment(task_id()?)
            ))
            .json(&json!({
                "body": arguments.get("body").and_then(Value::as_str).unwrap_or_default()
            })),
        "list_item_attachments" => client.get(format!(
            "{base}/loop-items/{}/attachments",
            encode_segment(task_id()?)
        )),
        "get_delivery_requirements" => {
            let item_id = task_id()?;
            let address = delivery_address(grant).map_err(|error| error.to_string())?;
            let item = backend_json(
                client
                    .get(format!("{base}/loop-items/{}", encode_segment(item_id)))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            let bindings = backend_json(
                client
                    .get(format!("{base}/loop-items/{}/tasks", encode_segment(item_id)))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            let binding = bindings
                .as_array()
                .and_then(|bindings| {
                    bindings.iter().find(|binding| {
                        binding.get("device_id").and_then(Value::as_str)
                            == Some(address.device_id.as_str())
                            && binding.get("task_id").and_then(Value::as_str)
                                == Some(address.task_id.as_str())
                    })
                })
                .ok_or_else(|| {
                    "The current Runtime task is not bound to this Issue".to_owned()
                })?;
            let node_id = binding
                .get("workflow_node_id")
                .and_then(Value::as_str);
            return Ok(delivery_requirements(&item, node_id));
        }
        "get_workflow_stage_context" => {
            let item_id = task_id()?;
            let address = delivery_address(grant).map_err(|error| error.to_string())?;
            let bindings = backend_json(
                client
                    .get(format!("{base}/loop-items/{}/tasks", encode_segment(item_id)))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            let node_id = bindings
                .as_array()
                .and_then(|bindings| {
                    bindings.iter().find(|binding| {
                        binding.get("device_id").and_then(Value::as_str)
                            == Some(address.device_id.as_str())
                            && binding.get("task_id").and_then(Value::as_str)
                                == Some(address.task_id.as_str())
                    })
                })
                .and_then(|binding| binding.get("workflow_node_id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    "The current Runtime task is not bound to a workflow stage".to_owned()
                })?;
            return backend_json(
                client
                    .get(format!(
                        "{base}/loop-items/{}/workflow-nodes/{}/input-context",
                        encode_segment(item_id),
                        encode_segment(node_id)
                    ))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await;
        }
        "create_delivery" => {
            let address = delivery_address(grant).map_err(|error| error.to_string())?;
            client
                .post(format!(
                    "{base}/loop-items/{}/deliveries",
                    encode_segment(task_id()?)
                ))
                .json(&json!({
                    "markdown": arguments.get("markdown").and_then(Value::as_str).unwrap_or_default(),
                    "chat": arguments.get("chat").cloned().unwrap_or(Value::Null),
                    "chat_selection": arguments
                        .get("chat_selection")
                        .cloned()
                        .unwrap_or(Value::Null),
                    "source_task": {
                        "deviceId": address.device_id,
                        "taskId": address.task_id,
                    }
                }))
        }
        "upload_delivery_asset" => {
            let item_id = task_id()?;
            let delivery_id =
                string_argument(arguments, "delivery_id").map_err(|error| error.to_string())?;
            let file_path =
                string_argument(arguments, "file_path").map_err(|error| error.to_string())?;
            let address = delivery_address(grant).map_err(|error| error.to_string())?;
            let delivery =
                backend_delivery_detail(&client, &base, auth_token, delivery_id).await?;
            if let Some(error) = delivery_scope_error(&delivery, &address, item_id) {
                return Err(error);
            }
            let bytes = fs::read(file_path).map_err(|error| error.to_string())?;
            let relative_path = arguments
                .get("relative_path")
                .and_then(Value::as_str)
                .or_else(|| Path::new(file_path).file_name().and_then(|value| value.to_str()))
                .ok_or_else(|| "relative_path is required".to_owned())?;
            let display_name = arguments
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(relative_path);
            let mut part = reqwest::multipart::Part::bytes(bytes).file_name(display_name.to_owned());
            if let Some(content_type) = arguments.get("content_type").and_then(Value::as_str) {
                part = part.mime_str(content_type).map_err(|error| error.to_string())?;
            }
            let response = client
                .post(format!(
                    "{base}/deliveries/{}/assets",
                    encode_segment(delivery_id)
                ))
                .bearer_auth(auth_token)
                .multipart(
                    reqwest::multipart::Form::new()
                        .text("relative_path", relative_path.to_owned())
                        .part("file", part),
                )
                .send()
                .await
                .map_err(|error| error.to_string())?;
            return backend_json(response).await;
        }
        "list_deliveries" => client.get(format!(
            "{base}/loop-items/{}/deliveries",
            encode_segment(task_id()?)
        )),
        "read_delivery" => {
            let delivery_id = string_argument(arguments, "delivery_id")
                .map_err(|error| error.to_string())?;
            let delivery =
                backend_delivery_detail(&client, &base, auth_token, delivery_id).await?;
            if delivery.get("loop_item_id").and_then(Value::as_str) != Some(task_id()?) {
                return Err("The requested Delivery is outside this Agent session".to_owned());
            }
            return Ok(delivery);
        }
        "download_delivery_asset" => {
            let delivery_id =
                string_argument(arguments, "delivery_id").map_err(|error| error.to_string())?;
            let asset_id =
                string_argument(arguments, "asset_id").map_err(|error| error.to_string())?;
            let delivery =
                backend_delivery_detail(&client, &base, auth_token, delivery_id).await?;
            if delivery.get("loop_item_id").and_then(Value::as_str) != Some(task_id()?)
                || !delivery
                    .get("assets")
                    .and_then(Value::as_array)
                    .is_some_and(|assets| {
                        assets
                            .iter()
                            .any(|asset| asset.get("id").and_then(Value::as_str) == Some(asset_id))
                    })
            {
                return Err(
                    "The requested Delivery asset is outside this Agent session".to_owned(),
                );
            }
            let output_path =
                attachment_output_path(arguments, asset_id).map_err(|error| error.to_string())?;
            let access = backend_json(
                client
                    .get(format!(
                        "{base}/delivery-assets/{}/access",
                        encode_segment(asset_id)
                    ))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            download_backend_object(&client, &access, &output_path).await?;
            return Ok(json!({"path": output_path}));
        }
        "finalize_delivery" | "discard_delivery_draft" => {
            let item_id = task_id()?;
            let delivery_id =
                string_argument(arguments, "delivery_id").map_err(|error| error.to_string())?;
            let address = delivery_address(grant).map_err(|error| error.to_string())?;
            let delivery =
                backend_delivery_detail(&client, &base, auth_token, delivery_id).await?;
            if let Some(error) = delivery_scope_error(&delivery, &address, item_id) {
                return Err(error);
            }
            let response = if name == "finalize_delivery" {
                client
                    .post(format!(
                        "{base}/deliveries/{}/finalize",
                        encode_segment(delivery_id)
                    ))
                    .json(&json!({
                        "fulfillments": arguments
                            .get("fulfillments")
                            .cloned()
                            .unwrap_or_else(|| json!([]))
                    }))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
            } else {
                client
                    .delete(format!("{base}/deliveries/{}", encode_segment(delivery_id)))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?
            };
            return backend_json(response).await;
        }
        "reorder_board_items" => client
            .post(format!(
                "{base}/cloud-projects/{project_id}/loop-items/reorder"
            ))
            .json(arguments.get("reorder").unwrap_or(arguments)),
        "create_space" => client
            .post(format!("{base}/cloud-projects"))
            .json(arguments),
        "update_space" => client
            .patch(format!("{base}/cloud-projects/{project_id}"))
            .json(arguments.get("project").unwrap_or(arguments)),
        "describe_space_table" => {
            client.get(format!("{base}/cloud-projects/{project_id}/aitable/table"))
        }
        "list_table_records" => {
            let mut request = client.get(format!(
                "{base}/cloud-projects/{project_id}/aitable/records"
            ));
            if let Some(query) = arguments.get("query").and_then(Value::as_str) {
                request = request.query(&[("query", query)]);
            }
            if let Some(cursor) = arguments.get("cursor").and_then(Value::as_str) {
                request = request.query(&[("cursor", cursor)]);
            }
            if let Some(limit) = arguments.get("limit").and_then(Value::as_i64) {
                request = request.query(&[("limit", limit.to_string())]);
            }
            return backend_json(request.bearer_auth(auth_token).send().await.map_err(|e| e.to_string())?).await;
        }
        "create_table_record" => client
            .post(format!("{base}/cloud-projects/{project_id}/aitable/records"))
            .json(&json!({"cells": arguments.get("cells").cloned().unwrap_or_else(|| json!({}))})),
        "update_table_record" => {
            let record_id = string_argument(arguments, "record_id").map_err(|e| e.to_string())?;
            client
                .patch(format!(
                    "{base}/cloud-projects/{project_id}/aitable/records/{}",
                    encode_segment(record_id)
                ))
                .json(&json!({"cells": arguments.get("cells").cloned().unwrap_or_else(|| json!({}))}))
        }
        "delete_table_record" => {
            let record_id = string_argument(arguments, "record_id").map_err(|e| e.to_string())?;
            let response = client
                .delete(format!(
                    "{base}/cloud-projects/{project_id}/aitable/records/{}",
                    encode_segment(record_id)
                ))
                .bearer_auth(auth_token)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            return backend_json(response).await;
        }
        "create_table_field" => client
            .post(format!("{base}/cloud-projects/{project_id}/aitable/fields"))
            .json(&json!({
                "name": arguments.get("name").and_then(Value::as_str).unwrap_or_default(),
                "type": arguments.get("field_type").or_else(|| arguments.get("type")).and_then(Value::as_str).unwrap_or_default(),
                "config": arguments.get("config").cloned().unwrap_or_else(|| json!({})),
            })),
        "update_table_field" => {
            let field_id = string_argument(arguments, "field_id").map_err(|e| e.to_string())?;
            let mut payload = json!({});
            if let Some(name) = arguments.get("name").and_then(Value::as_str) {
                payload["name"] = json!(name);
            }
            if let Some(config) = arguments.get("config") {
                payload["config"] = config.clone();
            }
            client
                .patch(format!(
                    "{base}/cloud-projects/{project_id}/aitable/fields/{}",
                    encode_segment(field_id)
                ))
                .json(&payload)
        }
        "delete_table_field" => {
            let field_id = string_argument(arguments, "field_id").map_err(|e| e.to_string())?;
            let response = client
                .delete(format!(
                    "{base}/cloud-projects/{project_id}/aitable/fields/{}",
                    encode_segment(field_id)
                ))
                .bearer_auth(auth_token)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            return backend_json(response).await;
        }
        "upload_item_attachment" => {
            let file_path =
                string_argument(arguments, "file_path").map_err(|error| error.to_string())?;
            let bytes = fs::read(file_path).map_err(|error| error.to_string())?;
            let display_name = arguments
                .get("display_name")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or_else(|| {
                    Path::new(&file_path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(ToOwned::to_owned)
                })
                .unwrap_or_else(|| "attachment".to_owned());
            let response = client
                .post(format!(
                    "{base}/loop-items/{}/attachments",
                    encode_segment(task_id()?)
                ))
                .bearer_auth(auth_token)
                .multipart(reqwest::multipart::Form::new().part(
                    "file",
                    reqwest::multipart::Part::bytes(bytes).file_name(display_name),
                ))
                .send()
                .await
                .map_err(|error| error.to_string())?;
            return backend_json(response).await;
        }
        "read_item_attachment" => {
            let attachment_id =
                string_argument(arguments, "attachment_id").map_err(|error| error.to_string())?;
            let output_path = attachment_output_path(arguments, attachment_id)
                .map_err(|error| error.to_string())?;
            let response = client
                .get(format!(
                    "{base}/loop-item-attachments/{}/content",
                    encode_segment(attachment_id)
                ))
                .bearer_auth(auth_token)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.map_err(|error| error.to_string())?;
                return Err(format!("Backend request failed ({status}): {body}"));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|error| error.to_string())?;
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&output_path, bytes).map_err(|error| error.to_string())?;
            return Ok(json!({"path": output_path}));
        }
        "delete_item_attachment" => {
            let attachment_id =
                string_argument(arguments, "attachment_id").map_err(|error| error.to_string())?;
            let response = client
                .delete(format!(
                    "{base}/loop-item-attachments/{}",
                    encode_segment(attachment_id)
                ))
                .bearer_auth(auth_token)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            return backend_json(response).await;
        }
        _ => return Err(format!("Unknown wework_space tool: {name}")),
    };
    let response = request
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let value = backend_json(response).await?;
    if name == "list_spaces" {
        return Ok(Value::Array(
            value
                .get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ));
    }
    if name == "list_board_items" || name == "list_deliveries" {
        return Ok(value.get("items").cloned().unwrap_or_else(|| json!([])));
    }
    Ok(value)
}

fn with_automation_run_header(
    request: reqwest::RequestBuilder,
    grant: Option<&SpaceContextGrant>,
) -> reqwest::RequestBuilder {
    match grant.and_then(|value| value.automation_run_id.as_deref()) {
        Some(run_id) => request.header("X-Wegent-Automation-Run-ID", run_id),
        None => request,
    }
}

async fn download_backend_object(
    client: &reqwest::Client,
    access: &Value,
    output_path: &Path,
) -> Result<(), String> {
    let url = access["url"]
        .as_str()
        .ok_or_else(|| "Object access URL is missing".to_owned())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Object read failed ({})", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(output_path, bytes).map_err(|error| error.to_string())
}

async fn backend_delivery_detail(
    client: &reqwest::Client,
    base: &str,
    auth_token: &str,
    delivery_id: &str,
) -> Result<Value, String> {
    backend_json(
        client
            .get(format!("{base}/deliveries/{}", encode_segment(delivery_id)))
            .bearer_auth(auth_token)
            .send()
            .await
            .map_err(|error| error.to_string())?,
    )
    .await
}

async fn backend_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Backend request failed ({status}): {text}"));
    }
    if text.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

fn normalize_assignment_candidates(members: Value, robots: Value) -> Value {
    let members = members
        .as_array()
        .into_iter()
        .flatten()
        .map(|member| {
            json!({
                "id": member.get("user_id").cloned().unwrap_or(Value::Null),
                "name": member.get("user_name").cloned().unwrap_or(Value::Null),
                "role": member.get("role").cloned().unwrap_or(Value::Null),
                "capability": member
                    .get("capability_description")
                    .cloned()
                    .unwrap_or_else(|| json!("")),
            })
        })
        .collect::<Vec<_>>();
    let robots = robots
        .as_array()
        .into_iter()
        .flatten()
        .map(|robot| {
            json!({
                "id": robot.get("id").cloned().unwrap_or(Value::Null),
                "name": robot.get("name").cloned().unwrap_or(Value::Null),
                "capability": robot
                    .get("capabilityDescription")
                    .cloned()
                    .unwrap_or_else(|| json!("")),
            })
        })
        .collect::<Vec<_>>();
    json!({"members": members, "robots": robots})
}

fn filter_backend_tasks(response: Value, arguments: &Value) -> Value {
    let tasks = response
        .get("items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_lowercase();
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .clamp(1, 200) as usize;
    Value::Array(
        tasks
            .into_iter()
            .filter(|task| {
                let text = format!(
                    "{} {} {} {}",
                    task["id"].as_str().unwrap_or_default(),
                    task["title"].as_str().unwrap_or_default(),
                    task["description"].as_str().unwrap_or_default(),
                    task["tags"]
                )
                .to_lowercase();
                (query.is_empty() || text.contains(&query))
                    && matches_filter(task, arguments, "status")
                    && matches_filter(task, arguments, "priority")
                    && arguments
                        .get("tag")
                        .and_then(Value::as_str)
                        .map_or(true, |tag| {
                            task["tags"]
                                .as_array()
                                .is_some_and(|tags| tags.iter().any(|value| value == tag))
                        })
                    && arguments
                        .get("creator_user_id")
                        .and_then(Value::as_i64)
                        .map_or(true, |id| task["created_by_user_id"] == id)
                    && matches_filter(task, arguments, "parent_id")
            })
            .take(limit)
            .collect(),
    )
}

fn matches_filter(task: &Value, arguments: &Value, key: &str) -> bool {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map_or(true, |value| task[key] == value)
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn delivery_fulfillments_schema() -> Value {
    json!({
        "type": "array",
        "description": "Typed results bound to required_deliverables by requirement_id. Required when the current stage declares deliverables.",
        "items": {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "requirement_id": {"type": "string"},
                        "kind": {"const": "text"},
                        "text": {"type": "string"}
                    },
                    "required": ["requirement_id", "kind", "text"]
                },
                {
                    "type": "object",
                    "properties": {
                        "requirement_id": {"type": "string"},
                        "kind": {"const": "file"},
                        "asset_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}
                    },
                    "required": ["requirement_id", "kind", "asset_ids"]
                },
                {
                    "type": "object",
                    "properties": {
                        "requirement_id": {"type": "string"},
                        "kind": {"const": "code_snapshot"},
                        "asset_id": {"type": "string"},
                        "changed_files": {"type": "array", "items": {"type": "string"}},
                        "base_revision": {"type": ["string", "null"]},
                        "head_revision": {"type": ["string", "null"]},
                        "sha256": {"type": "string"}
                    },
                    "required": ["requirement_id", "kind", "asset_id", "changed_files", "sha256"]
                },
                {
                    "type": "object",
                    "properties": {
                        "requirement_id": {"type": "string"},
                        "kind": {"const": "git_branch"},
                        "remote_url": {"type": "string"},
                        "branch": {"type": "string"},
                        "commit_sha": {"type": "string"}
                    },
                    "required": ["requirement_id", "kind", "remote_url", "branch", "commit_sha"]
                },
                {
                    "type": "object",
                    "properties": {
                        "requirement_id": {"type": "string"},
                        "kind": {"const": "pull_request"},
                        "provider": {"enum": ["github", "gitlab"]},
                        "url": {"type": "string"},
                        "number": {"type": "integer"},
                        "state": {"const": "draft"},
                        "head_branch": {"type": "string"},
                        "base_branch": {"type": "string"},
                        "head_commit": {"type": "string"}
                    },
                    "required": ["requirement_id", "kind", "provider", "url", "number", "head_branch", "base_branch", "head_commit"]
                },
                {
                    "type": "object",
                    "properties": {
                        "requirement_id": {"type": "string"},
                        "kind": {"const": "url"},
                        "url": {"type": "string"},
                        "title": {"type": "string"}
                    },
                    "required": ["requirement_id", "kind", "url"]
                }
            ]
        }
    })
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "list_spaces",
            "List WeWork project spaces available to the current user",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "get_current_context",
            "Get the project space and board item bound to this conversation, including the Issue description",
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "create_space",
            "Create a WeWork project space",
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "project_key": {"type": "string"},
                    "description": {"type": "string"}
                },
                "required": ["name"]
            }),
        ),
        tool(
            "update_space",
            "Update a WeWork project space",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "project": {
                        "type": "object",
                        "properties": {
                            "version": {"type": "integer"},
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["version"]
                    }
                },
                "required": ["space_id", "project"]
            }),
        ),
        tool(
            "list_board_items",
            "List board items in a project space",
            json!({
                "type": "object",
                "properties": {"space_id": {"type": "string"}},
                "required": ["space_id"]
            }),
        ),
        tool(
            "list_space_files",
            "List files and folders in a WeWork project space",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "prefix": {"type": "string"}
                },
                "required": ["space_id"]
            }),
        ),
        tool(
            "read_space_file",
            "Read a project-space file into the runtime and return its local path",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "file_id": {"type": "string"},
                    "output_path": {"type": "string"}
                },
                "required": ["space_id", "file_id"]
            }),
        ),
        tool(
            "search_board_items",
            "Search board items across one project or all configured projects using text and structured filters",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Matches task id, title, description, or tags"},
                    "space_id": {"type": "string"},
                    "status": {"enum": ["inbox", "pending", "in_progress", "in_review", "completed"]},
                    "priority": {"enum": ["none", "low", "medium", "high", "urgent"]},
                    "tag": {"type": "string"},
                    "creator_user_id": {"type": "integer"},
                    "parent_id": {"type": "string"},
                    "has_children": {"type": "boolean"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 200}
                }
            }),
        ),
        tool(
            "create_board_item",
            "Create an item on a project-space board",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item": {"type": "object"}
                },
                "required": ["space_id", "item"]
            }),
        ),
        tool(
            "get_board_item",
            "Get one board item in a project space",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"}
                },
                "required": ["space_id", "item_id"]
            }),
        ),
        tool(
            "get_assignment_candidates",
            "List assignable project members and robots with their capability descriptions",
            json!({
                "type": "object",
                "properties": {"space_id": {"type": "string"}},
                "required": ["space_id"]
            }),
        ),
        tool(
            "submit_workflow_plan",
            "Submit the AI manager's structured child-task plan; the platform binds the active planning scope",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "plan": {
                        "type": "object",
                        "properties": {
                            "summary": {"type": "string"},
                            "items": {
                                "type": "array",
                                "minItems": 1,
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "client_key": {"type": "string"},
                                        "title": {"type": "string"},
                                        "description": {"type": "string"},
                                        "assignee_type": {"enum": ["user", "agent", "team"]},
                                        "assignee_id": {"type": "string"},
                                        "assignee_name": {"type": "string"},
                                        "rationale": {"type": "string"}
                                    },
                                    "required": [
                                        "client_key",
                                        "title",
                                        "assignee_type",
                                        "assignee_id"
                                    ]
                                }
                            }
                        },
                        "required": ["items"]
                    }
                },
                "required": ["space_id", "item_id", "plan"]
            }),
        ),
        tool(
            "report_workflow_outcome",
            "Report the current workflow child task as passed or needing replanning",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "verdict": {"enum": ["passed", "needs_rework"]},
                    "summary": {"type": "string"},
                    "findings": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["space_id", "item_id", "verdict", "summary"]
            }),
        ),
        tool(
            "assign_board_item",
            "Assign the current AI-managed board item to one project member or robot",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "assignee_type": {"enum": ["user", "agent"]},
                    "assignee_id": {"type": "string"}
                },
                "required": ["space_id", "item_id", "assignee_type", "assignee_id"]
            }),
        ),
        tool(
            "update_board_item",
            "Update an item on a project-space board",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "item": {"type": "object"}
                },
                "required": ["space_id", "item_id", "item"]
            }),
        ),
        tool(
            "add_board_item_comment",
            "Add a comment to a board item",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "body": {"type": "string"}
                },
                "required": ["space_id", "item_id", "body"]
            }),
        ),
        tool(
            "list_item_attachments",
            "List attachments of a board item. Use read_item_attachment to inspect contents.",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"}
                },
                "required": ["space_id", "item_id"]
            }),
        ),
        tool(
            "upload_item_attachment",
            "Upload a local file as a board-item attachment",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "file_path": {"type": "string"},
                    "display_name": {"type": "string"},
                    "content_type": {"type": "string"}
                },
                "required": ["space_id", "item_id", "file_path"]
            }),
        ),
        tool(
            "read_item_attachment",
            "Read a board-item attachment and return its local path for inspection.",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "attachment_id": {"type": "string"},
                    "output_path": {"type": "string"}
                },
                "required": ["space_id", "item_id", "attachment_id"]
            }),
        ),
        tool(
            "delete_item_attachment",
            "Delete a board-item attachment from its project-space storage.",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "attachment_id": {"type": "string"}
                },
                "required": ["space_id", "item_id", "attachment_id"]
            }),
        ),
        tool(
            "get_delivery_requirements",
            "Get the current workflow stage and its required and submitted deliverables",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"}
                },
                "required": ["space_id", "item_id"]
            }),
        ),
        tool(
            "get_workflow_stage_context",
            "Get the immutable upstream context selected for the current workflow stage",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"}
                },
                "required": ["space_id", "item_id"]
            }),
        ),
        tool(
            "create_delivery",
            "Create a Delivery draft bound to the current Runtime task and workflow stage",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "markdown": {"type": "string"},
                    "chat": {
                        "type": ["object", "null"],
                        "description": "Optional structured chat snapshot to preserve with the Delivery"
                    },
                    "chat_selection": {
                        "type": ["object", "null"],
                        "description": "Server-resolved Issue chat selection: all, latest N, or explicit message IDs",
                        "properties": {
                            "mode": {
                                "type": "string",
                                "enum": ["all", "latest", "message_ids"]
                            },
                            "count": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 500
                            },
                            "message_ids": {
                                "type": "array",
                                "items": {"type": "string"},
                                "minItems": 1,
                                "maxItems": 500
                            }
                        },
                        "required": ["mode"]
                    }
                },
                "required": ["space_id", "item_id"]
            }),
        ),
        tool(
            "upload_delivery_asset",
            "Upload a local file into a Delivery draft",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "delivery_id": {"type": "string"},
                    "file_path": {"type": "string"},
                    "relative_path": {"type": "string"},
                    "display_name": {"type": "string"},
                    "content_type": {"type": "string"}
                },
                "required": ["space_id", "item_id", "delivery_id", "file_path"]
            }),
        ),
        tool(
            "list_deliveries",
            "List deliveries associated with a board item",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"}
                },
                "required": ["space_id", "item_id"]
            }),
        ),
        tool(
            "read_delivery",
            "Read a Delivery, its Markdown handoff, structured chat snapshot, and asset list",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "delivery_id": {"type": "string"}
                },
                "required": ["space_id", "item_id", "delivery_id"]
            }),
        ),
        tool(
            "download_delivery_asset",
            "Download a Delivery asset into the Runtime workspace and return its local path",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "delivery_id": {"type": "string"},
                    "asset_id": {"type": "string"},
                    "output_path": {"type": "string"}
                },
                "required": ["space_id", "item_id", "delivery_id", "asset_id"]
            }),
        ),
        tool(
            "finalize_delivery",
            "Finalize the current Runtime task's Delivery draft with typed requirement fulfillments",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "delivery_id": {"type": "string"},
                    "fulfillments": delivery_fulfillments_schema()
                },
                "required": ["space_id", "item_id", "delivery_id"]
            }),
        ),
        tool(
            "discard_delivery_draft",
            "Discard the current Runtime task's unfinished Delivery draft",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "delivery_id": {"type": "string"}
                },
                "required": ["space_id", "item_id", "delivery_id"]
            }),
        ),
        tool(
            "reorder_board_items",
            "Persist the order of board items in one board lane",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "reorder": {
                        "type": "object",
                        "properties": {
                            "parent_id": {"type": ["string", "null"]},
                            "status": {"type": "string"},
                            "item_ids": {
                                "type": "array",
                                "items": {"type": "string"}
                            }
                        },
                        "required": ["status", "item_ids"]
                    }
                },
                "required": ["space_id", "reorder"]
            }),
        ),
        tool(
            "describe_space_table",
            "Describe a project-space table: base, tables, and the dynamic field schema",
            json!({
                "type": "object",
                "properties": {"space_id": {"type": "string"}},
                "required": ["space_id"]
            }),
        ),
        tool(
            "list_table_records",
            "Query project-space table records with optional full-text keyword and cursor pagination",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    "cursor": {"type": "string"}
                },
                "required": ["space_id"]
            }),
        ),
        tool(
            "create_table_record",
            "Create an project-space table record. cells keys must be fieldIds, only provided cells are written",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "cells": {"type": "object", "description": "Map of fieldId to cell value"}
                },
                "required": ["space_id", "cells"]
            }),
        ),
        tool(
            "update_table_record",
            "Patch an project-space table record cell-by-cell. Only the provided fieldIds are modified",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "record_id": {"type": "string"},
                    "cells": {"type": "object", "description": "Map of fieldId to cell value"}
                },
                "required": ["space_id", "record_id", "cells"]
            }),
        ),
        tool(
            "delete_table_record",
            "Delete an project-space table record (irreversible)",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "record_id": {"type": "string"}
                },
                "required": ["space_id", "record_id"]
            }),
        ),
        tool(
            "create_table_field",
            "Add a field (column) to an project-space table",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "name": {"type": "string"},
                    "field_type": {"type": "string", "description": "project-space table field type such as text, number, singleSelect, multipleSelect, date, user, checkbox, url"},
                    "config": {"type": "object", "description": "Field property/options configuration"}
                },
                "required": ["space_id", "name", "field_type"]
            }),
        ),
        tool(
            "update_table_field",
            "Rename or reconfigure an project-space table field. Field type cannot be changed; options are fully replaced",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "field_id": {"type": "string"},
                    "name": {"type": "string"},
                    "config": {"type": "object"}
                },
                "required": ["space_id", "field_id"]
            }),
        ),
        tool(
            "delete_table_field",
            "Delete an project-space table field and clear its values in every record (irreversible)",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "field_id": {"type": "string"}
                },
                "required": ["space_id", "field_id"]
            }),
        ),
    ]
}

fn visible_tools(runtime: &TaskRuntime, context: &SpaceMcpRequestContext) -> Vec<Value> {
    if is_automation_manager(context.grant()) {
        return tools()
            .into_iter()
            .filter(|tool| {
                tool["name"]
                    .as_str()
                    .is_some_and(is_automation_manager_tool)
            })
            .collect();
    }
    tools_for_bound_project(
        runtime,
        context.grant().and_then(|grant| grant.space_id.as_deref()),
    )
}

fn is_automation_manager(grant: Option<&SpaceContextGrant>) -> bool {
    grant.is_some_and(|grant| grant.automation_manager)
}

fn is_automation_manager_tool(name: &str) -> bool {
    matches!(
        name,
        "get_current_context"
            | "get_board_item"
            | "get_assignment_candidates"
            | "submit_workflow_plan"
    )
}

fn tools_for_bound_project(runtime: &TaskRuntime, project_id: Option<&str>) -> Vec<Value> {
    let _ = (runtime, project_id);
    tools()
}

fn tool(name: &str, description: &str, input_schema: Value) -> Value {
    json!({"name": name, "description": description, "inputSchema": input_schema})
}

fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, super::TaskRuntimeError> {
    serde_json::from_value(value)
        .map_err(|error| super::TaskRuntimeError::Invalid(error.to_string()))
}

fn string_argument<'a>(value: &'a Value, key: &str) -> Result<&'a str, super::TaskRuntimeError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| super::TaskRuntimeError::Invalid(format!("{key} is required")))
}

fn cells_argument(
    value: &Value,
) -> Result<serde_json::Map<String, Value>, super::TaskRuntimeError> {
    value
        .get("cells")
        .and_then(Value::as_object)
        .cloned()
        .filter(|cells| !cells.is_empty())
        .ok_or_else(|| super::TaskRuntimeError::Invalid("cells must not be empty".to_owned()))
}

fn binary_input_from_path(
    arguments: &Value,
    file_path: &str,
) -> Result<BinaryInput, super::TaskRuntimeError> {
    let bytes = fs::read(file_path).map_err(|error| {
        super::TaskRuntimeError::Invalid(format!("cannot read attachment file: {error}"))
    })?;
    let display_name = arguments
        .get("display_name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            Path::new(file_path)
                .file_name()
                .and_then(|value| value.to_str())
                .map(ToOwned::to_owned)
        })
        .ok_or_else(|| {
            super::TaskRuntimeError::Invalid("attachment display_name is required".to_owned())
        })?;
    Ok(BinaryInput {
        display_name,
        content_type: arguments
            .get("content_type")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(ToOwned::to_owned),
        base64: STANDARD.encode(bytes),
    })
}

fn copy_attachment_if_requested(
    arguments: &Value,
    source_path: &str,
) -> Result<String, super::TaskRuntimeError> {
    let Some(output_path) = arguments
        .get("output_path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    else {
        return Ok(source_path.to_owned());
    };
    if let Some(parent) = Path::new(output_path).parent() {
        fs::create_dir_all(parent).map_err(|error| {
            super::TaskRuntimeError::Invalid(format!(
                "cannot create attachment output directory: {error}"
            ))
        })?;
    }
    fs::copy(source_path, output_path).map_err(|error| {
        super::TaskRuntimeError::Invalid(format!("cannot copy attachment file: {error}"))
    })?;
    Ok(output_path.to_owned())
}

fn attachment_output_path(
    arguments: &Value,
    attachment_id: &str,
) -> Result<PathBuf, super::TaskRuntimeError> {
    if let Some(output_path) = arguments
        .get("output_path")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Ok(PathBuf::from(output_path));
    }
    let file_name = Path::new(attachment_id)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("attachment");
    Ok(env::temp_dir()
        .join("wegent-task-attachments")
        .join(file_name))
}

fn invalid_json(error: serde_json::Error) -> super::TaskRuntimeError {
    super::TaskRuntimeError::Invalid(error.to_string())
}

fn text_result(text: String, is_error: bool) -> Value {
    json!({
        "content": [{"type": "text", "text": text}],
        "isError": is_error
    })
}

fn result_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_runtime::{
        LocalCommentCreate, LocalTaskStore, ProjectDescriptor, ProjectStoreKind, TaskCreate,
        TaskProviderKind,
    };

    fn decode_grant(request: &ExecutionRequest) -> SpaceContextGrant {
        let encoded = encoded_space_context_grant(request).expect("space context grant");
        let decoded = STANDARD.decode(encoded).expect("base64 grant");
        serde_json::from_slice(&decoded).expect("JSON grant")
    }

    #[test]
    fn leaves_space_context_unbound_without_project_context() {
        let request = ExecutionRequest::default();

        assert!(encoded_space_context_grant(&request).is_none());
    }

    #[test]
    fn leaves_space_context_unbound_for_non_manager_project_automation() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!("cloud-42"));
        request.extra.insert(
            "origin".to_owned(),
            json!({"type": "project_automation", "run_id": "run-1"}),
        );

        assert!(encoded_space_context_grant(&request).is_none());
    }

    #[test]
    fn binds_project_context_for_assigned_board_robot() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!("cloud-42"));
        request.extra.insert(
            "origin".to_owned(),
            json!({"type": "board_task", "run_id": "run-1"}),
        );

        let grant = decode_grant(&request);

        assert_eq!(grant.version, 1);
        assert_eq!(grant.space_id.as_deref(), Some("cloud-42"));
        assert_eq!(grant.item_id, None);
        assert_eq!(grant.automation_run_id, None);
        assert!(!grant.automation_manager);
        assert!(grant.expires_at_unix > Local::now().timestamp());
    }

    #[test]
    fn binds_issue_context_from_origin() {
        let mut request = ExecutionRequest {
            task_id: "runtime-7".to_owned(),
            device_id: Some("device-3".to_owned()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "origin".to_owned(),
            json!({
                "type": "board_task",
                "cloudProjectId": "cloud-42",
                "loopItemId": "ISSUE-7"
            }),
        );

        let grant = decode_grant(&request);

        assert_eq!(grant.space_id.as_deref(), Some("cloud-42"));
        assert_eq!(grant.item_id.as_deref(), Some("ISSUE-7"));
        assert_eq!(grant.task_id, "runtime-7");
        assert_eq!(grant.device_id.as_deref(), Some("device-3"));
    }

    #[test]
    fn binds_automation_manager_scope() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!("cloud-42"));
        request.extra.insert(
            "origin".to_owned(),
            json!({
                "type": "project_automation",
                "automationRole": "manager",
                "run_id": "run-1"
            }),
        );

        let grant = decode_grant(&request);

        assert_eq!(grant.space_id.as_deref(), Some("cloud-42"));
        assert_eq!(grant.automation_run_id.as_deref(), Some("run-1"));
        assert!(grant.automation_manager);
    }

    #[test]
    fn workflow_plan_request_carries_automation_run_header() {
        let grant = SpaceContextGrant {
            automation_run_id: Some("run-1".to_owned()),
            ..SpaceContextGrant::default()
        };
        let request = with_automation_run_header(
            reqwest::Client::new().post("http://backend.test/workflow-plan"),
            Some(&grant),
        )
        .build()
        .expect("workflow plan request");

        assert_eq!(
            request
                .headers()
                .get("X-Wegent-Automation-Run-ID")
                .and_then(|value| value.to_str().ok()),
            Some("run-1")
        );
    }

    #[test]
    fn creates_unbound_context_grant_for_explicit_cloud_reference() {
        let request = ExecutionRequest {
            prompt: json!("请查看 [任务:T-1](cloud://projects/cloud-42/todos/T-1)"),
            ..ExecutionRequest::default()
        };

        let grant = decode_grant(&request);

        assert_eq!(grant.space_id, None);
        assert_eq!(grant.item_id, None);
    }

    #[test]
    fn leaves_space_context_unbound_when_prompt_has_no_project_reference() {
        let request = ExecutionRequest {
            prompt: json!("帮我看一下这个仓库的代码"),
            ..ExecutionRequest::default()
        };

        assert!(encoded_space_context_grant(&request).is_none());
    }

    #[test]
    fn creates_context_grant_for_array_prompt_cloud_reference() {
        let request = ExecutionRequest {
            prompt: json!([{"type": "text", "text": "参考 [整个空间](cloud://projects/proj-7)"}]),
            ..ExecutionRequest::default()
        };

        assert!(encoded_space_context_grant(&request).is_some());
    }

    #[test]
    fn preserves_numeric_project_identity_in_grant() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!(9001));

        assert_eq!(decode_grant(&request).space_id.as_deref(), Some("9001"));
    }

    #[test]
    fn rejects_arguments_outside_the_context_grant() {
        let grant = SpaceContextGrant {
            version: 1,
            task_id: "task-1".to_owned(),
            space_id: Some("space-1".to_owned()),
            item_id: Some("item-1".to_owned()),
            device_id: Some("device-1".to_owned()),
            automation_run_id: None,
            automation_manager: false,
            expires_at_unix: Local::now().timestamp() + 60,
        };

        assert!(
            context_scope_error(&grant, &json!({"space_id": "space-2", "item_id": "item-1"}))
                .is_some()
        );
        assert!(
            context_scope_error(&grant, &json!({"space_id": "space-1", "item_id": "item-2"}))
                .is_some()
        );
        assert!(
            context_scope_error(&grant, &json!({"space_id": "space-1", "item_id": "item-1"}))
                .is_none()
        );
    }

    #[test]
    fn rejects_expired_context_grant() {
        let grant = SpaceContextGrant {
            version: 1,
            task_id: "task-1".to_owned(),
            space_id: Some("space-1".to_owned()),
            item_id: Some("item-1".to_owned()),
            device_id: Some("device-1".to_owned()),
            automation_run_id: None,
            automation_manager: false,
            expires_at_unix: Local::now().timestamp() - 1,
        };
        let encoded = STANDARD.encode(serde_json::to_vec(&grant).unwrap());

        assert!(decode_space_context_grant(&encoded).is_none());
    }

    #[test]
    fn identifies_local_projects_before_selecting_the_backend_route() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Offline project".to_owned(),
                project_key: Some("OFFLINE".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        assert!(is_locally_routed_project(
            &runtime,
            &project.id,
            "list_board_items"
        ));
        assert!(!is_locally_routed_project(
            &runtime,
            "cloud-project",
            "list_board_items"
        ));
    }

    #[tokio::test]
    async fn keeps_project_space_reads_visible_for_bound_dingtalk_issues() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        store
            .configure_external_project(ProjectDescriptor {
                id: "cloud-aitable".to_owned(),
                public_id: None,
                project_key: "AITABLE".to_owned(),
                name: "DingTalk table".to_owned(),
                description: String::new(),
                project_store: ProjectStoreKind::Backend,
                task_provider: TaskProviderKind::DingtalkAitable,
                provider_config: json!({
                    "base_id": "base-1",
                    "table_id": "table-1",
                    "board_mapping": {
                        "title_field_id": "fld-title",
                        "status_field_id": "fld-status"
                    }
                }),
                version: 1,
            })
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        let names = tools_for_bound_project(&runtime, Some("cloud-aitable"))
            .into_iter()
            .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();

        for tool_name in [
            "get_current_context",
            "get_board_item",
            "list_board_items",
            "search_board_items",
            "list_item_attachments",
            "read_item_attachment",
            "describe_space_table",
            "list_table_records",
            "create_table_record",
            "update_table_record",
        ] {
            assert!(names.iter().any(|name| name == tool_name));
        }
        assert!(names.iter().any(|name| name == "list_space_files"));
        assert!(names.iter().any(|name| name == "list_deliveries"));
        assert!(is_locally_routed_project(
            &runtime,
            "cloud-aitable",
            "get_current_context"
        ));
        assert!(!is_locally_routed_project(
            &runtime,
            "cloud-aitable",
            "list_space_files"
        ));
    }

    #[test]
    fn exposes_task_attachment_tools() {
        let names = tools()
            .into_iter()
            .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();

        for name in [
            "list_item_attachments",
            "upload_item_attachment",
            "read_item_attachment",
            "delete_item_attachment",
        ] {
            assert!(names.iter().any(|candidate| candidate == name));
        }
    }

    #[test]
    fn exposes_complete_delivery_lifecycle_tools() {
        let delivery_tools = tools();
        let names = delivery_tools
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();

        for name in [
            "get_delivery_requirements",
            "create_delivery",
            "upload_delivery_asset",
            "list_deliveries",
            "read_delivery",
            "download_delivery_asset",
            "finalize_delivery",
            "discard_delivery_draft",
        ] {
            assert!(names.iter().any(|candidate| candidate == name));
        }
        let create = delivery_tools
            .iter()
            .find(|tool| tool["name"] == "create_delivery")
            .unwrap();
        assert_eq!(
            create["inputSchema"]["properties"]["chat"]["type"],
            json!(["object", "null"])
        );
        let finalize = delivery_tools
            .iter()
            .find(|tool| tool["name"] == "finalize_delivery")
            .unwrap();
        assert_eq!(
            finalize["inputSchema"]["properties"]["fulfillments"]["type"],
            "array"
        );
        assert_eq!(
            finalize["inputSchema"]["properties"]["fulfillments"]["items"]["oneOf"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        assert_eq!(
            finalize["inputSchema"]["properties"]["fulfillments"]["items"]["oneOf"][4]
                ["properties"]["provider"]["enum"],
            json!(["github", "gitlab"])
        );
    }

    #[test]
    fn exposes_bound_current_context_tool() {
        let current_context = tools()
            .into_iter()
            .find(|tool| tool["name"] == "get_current_context")
            .expect("get_current_context tool");

        assert_eq!(
            current_context["inputSchema"],
            json!({"type": "object", "properties": {}})
        );
    }

    #[test]
    fn exposes_task_search_tool() {
        let search = tools()
            .into_iter()
            .find(|tool| tool["name"] == "search_board_items")
            .expect("search_board_items tool");

        assert_eq!(
            search["inputSchema"]["properties"]["status"]["enum"],
            json!(["inbox", "pending", "in_progress", "in_review", "completed"])
        );
        assert_eq!(
            search["inputSchema"]["properties"]["creator_user_id"]["type"],
            "integer"
        );
    }

    #[test]
    fn backend_task_search_filters_by_parent_id() {
        let response = json!({
            "items": [
                {"id": "parent", "parent_id": null},
                {"id": "matching-child", "parent_id": "requested-parent"},
                {"id": "other-child", "parent_id": "other-parent"}
            ]
        });

        let result = filter_backend_tasks(
            response,
            &json!({"parent_id": "requested-parent", "limit": 50}),
        );

        assert_eq!(
            result,
            json!([{"id": "matching-child", "parent_id": "requested-parent"}])
        );
    }

    #[test]
    fn exposes_only_wework_space_business_vocabulary() {
        let exposed_tools = tools();
        for exposed_tool in &exposed_tools {
            let public_surface = format!(
                "{} {}",
                exposed_tool["name"].as_str().unwrap_or_default(),
                exposed_tool["description"].as_str().unwrap_or_default()
            )
            .to_lowercase();
            for forbidden in [
                "wegent_tasks",
                "wegent_delivery",
                "github",
                "gitlab",
                "todo",
                "report_automation_bug",
            ] {
                assert!(
                    !public_surface.contains(forbidden),
                    "found {forbidden} in tool surface {public_surface}"
                );
            }
            let input_properties = exposed_tool["inputSchema"]["properties"]
                .as_object()
                .expect("tool input properties");
            for forbidden in ["project_id", "task_id"] {
                assert!(
                    !input_properties.contains_key(forbidden),
                    "found {forbidden} in {} input",
                    exposed_tool["name"]
                );
            }
        }
        let serialized = serde_json::to_string(&exposed_tools)
            .unwrap()
            .to_lowercase();
        for required in [
            "list_spaces",
            "get_board_item",
            "get_assignment_candidates",
            "submit_workflow_plan",
            "report_workflow_outcome",
            "assign_board_item",
            "list_item_attachments",
            "read_item_attachment",
            "list_space_files",
            "list_deliveries",
        ] {
            assert!(serialized.contains(required), "missing {required}");
        }
    }

    #[test]
    fn automation_manager_has_only_read_and_plan_tools() {
        let names = tools()
            .into_iter()
            .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
            .filter(|name| is_automation_manager_tool(name))
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "get_current_context",
                "get_board_item",
                "get_assignment_candidates",
                "submit_workflow_plan",
            ]
        );
        for forbidden in [
            "create_board_item",
            "update_board_item",
            "add_board_item_comment",
            "delete_item_attachment",
        ] {
            assert!(!is_automation_manager_tool(forbidden));
        }
    }

    #[test]
    fn normalizes_assignment_candidates_to_one_capability_contract() {
        let result = normalize_assignment_candidates(
            json!([{
                "user_id": 7,
                "user_name": "Alice",
                "role": "Developer",
                "capability_description": "Frontend implementation"
            }]),
            json!([{
                "id": "agent-9",
                "name": "Review bot",
                "capabilityDescription": "Code review and release checks"
            }]),
        );

        assert_eq!(
            result,
            json!({
                "members": [{
                    "id": 7,
                    "name": "Alice",
                    "role": "Developer",
                    "capability": "Frontend implementation"
                }],
                "robots": [{
                    "id": "agent-9",
                    "name": "Review bot",
                    "capability": "Code review and release checks"
                }]
            })
        );
    }

    #[tokio::test]
    async fn searches_todos_by_text_and_structured_filters() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Search project".to_owned(),
                project_key: Some("SEARCH".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Fix OAuth callback".to_owned(),
                    description: "Login fails after redirect".to_owned(),
                    status: "in_progress".to_owned(),
                    priority: "high".to_owned(),
                    parent_id: None,
                    tags: vec!["bug".to_owned()],
                    workflow: None,
                },
            )
            .unwrap();
        store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Write deployment guide".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec!["docs".to_owned()],
                    workflow: None,
                },
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        let result = call_tool(
            &runtime,
            "search_board_items",
            json!({
                "space_id": project.id,
                "query": "oauth",
                "status": "in_progress",
                "tag": "bug"
            }),
        )
        .await;
        assert_eq!(result["isError"], false);
        let tasks: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(tasks.as_array().unwrap().len(), 1);
        assert_eq!(tasks[0]["title"], "Fix OAuth callback");
    }

    #[tokio::test]
    async fn search_board_items_honors_the_requested_space() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let first = store
            .create_project(ProjectCreate {
                name: "First".to_owned(),
                project_key: Some("FIRST".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let second = store
            .create_project(ProjectCreate {
                name: "Second".to_owned(),
                project_key: Some("SECOND".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        for (project_id, title) in [
            (&first.id, "First feedback"),
            (&second.id, "Second feedback"),
        ] {
            store
                .create_task(
                    project_id,
                    TaskCreate {
                        title: title.to_owned(),
                        description: String::new(),
                        status: "inbox".to_owned(),
                        priority: "none".to_owned(),
                        parent_id: None,
                        tags: vec!["feedback".to_owned()],
                        workflow: None,
                    },
                )
                .unwrap();
        }
        let runtime = TaskRuntime::new(store).unwrap();

        let result = call_tool(
            &runtime,
            "search_board_items",
            json!({"space_id": second.id, "query": "feedback"}),
        )
        .await;
        let items: Value =
            serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();

        assert_eq!(items.as_array().unwrap().len(), 1);
        assert_eq!(items[0]["title"], "Second feedback");
    }

    #[tokio::test]
    async fn task_attachment_tools_upload_list_download_and_delete() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Local attachments".to_owned(),
                project_key: Some("LOCAL".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Inspect attachment".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: None,
                },
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();
        let source = directory.path().join("source.txt");
        fs::write(&source, "attachment content").unwrap();

        let upload = call_tool(
            &runtime,
            "upload_item_attachment",
            json!({
                "space_id": project.id,
                "item_id": task.id,
                "file_path": source,
                "content_type": "text/plain"
            }),
        )
        .await;
        assert_eq!(upload["isError"], false);
        let attachment: Value =
            serde_json::from_str(upload["content"][0]["text"].as_str().unwrap()).unwrap();
        let attachment_id = attachment["id"].as_str().unwrap();

        let list = call_tool(
            &runtime,
            "list_item_attachments",
            json!({"space_id": project.id, "item_id": task.id}),
        )
        .await;
        let listed: Value =
            serde_json::from_str(list["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let output = directory.path().join("downloaded.txt");
        let download = call_tool(
            &runtime,
            "read_item_attachment",
            json!({
                "space_id": project.id,
                "item_id": task.id,
                "attachment_id": attachment_id,
                "output_path": output
            }),
        )
        .await;
        assert_eq!(download["isError"], false);
        assert_eq!(
            fs::read_to_string(directory.path().join("downloaded.txt")).unwrap(),
            "attachment content"
        );

        let deleted = call_tool(
            &runtime,
            "delete_item_attachment",
            json!({
                "space_id": project.id,
                "item_id": task.id,
                "attachment_id": attachment_id
            }),
        )
        .await;
        assert_eq!(deleted["isError"], false);
        assert!(runtime
            .list_task_attachments(&project.id, &task.id)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn delivery_tools_complete_the_bound_local_workflow_stage() {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let project = store
            .create_project(ProjectCreate {
                name: "Local delivery".to_owned(),
                project_key: Some("DELIVERY".to_owned()),
                description: String::new(),
                task_provider: TaskProviderKind::Local,
                provider_config: json!({}),
            })
            .unwrap();
        let task = store
            .create_task(
                &project.id,
                TaskCreate {
                    title: "Implement stage".to_owned(),
                    description: String::new(),
                    status: "pending".to_owned(),
                    priority: "none".to_owned(),
                    parent_id: None,
                    tags: vec![],
                    workflow: Some(json!({
                        "version": 1,
                        "nodes": [{
                            "id": "implement",
                            "name": "Implement",
                            "kind": "my_task",
                            "status": "ready",
                            "depends_on": [],
                            "required": true,
                            "required_deliverables": [{
                                "id": "result-file",
                                "name": "Result",
                                "description": "",
                                "value_type": "file",
                                "file_constraints": {
                                    "accepted_types": [],
                                    "min_files": 1,
                                    "max_files": 1
                                }
                            }],
                            "delivery_ids": []
                        }]
                    })),
                },
            )
            .unwrap();
        store
            .bind_task(
                &project.id,
                Some(&task.id),
                None,
                RuntimeTaskAddress {
                    device_id: "device-1".to_owned(),
                    task_id: "runtime-1".to_owned(),
                    task_title: Some("Implement".to_owned()),
                    backend_task_id: None,
                    workflow_node_id: Some("implement".to_owned()),
                },
            )
            .unwrap();
        let message_ids = ["first", "second", "third"]
            .into_iter()
            .map(|content| {
                store
                    .create_comment(&LocalCommentCreate {
                        project_id: project.id.clone(),
                        task_id: task.id.clone(),
                        client_message_id: None,
                        sender_type: "user".to_owned(),
                        sender_id: "7".to_owned(),
                        sender_name: "User".to_owned(),
                        content: content.to_owned(),
                        metadata: json!({}),
                        reply_to_message_id: None,
                    })
                    .unwrap()
                    .message_id
            })
            .collect::<Vec<_>>();
        let runtime = TaskRuntime::new(store).unwrap();
        let grant = SpaceContextGrant {
            version: 1,
            task_id: "runtime-1".to_owned(),
            space_id: Some(project.id.clone()),
            item_id: Some(task.id.clone()),
            device_id: Some("device-1".to_owned()),
            automation_run_id: None,
            automation_manager: false,
            expires_at_unix: Local::now().timestamp() + 60,
        };

        let requirements = call_tool_with_grant(
            &runtime,
            "get_delivery_requirements",
            json!({}),
            Some(grant.clone()),
        )
        .await;
        let requirements: Value =
            serde_json::from_str(requirements["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(requirements["workflow_node_id"], "implement");
        assert_eq!(
            requirements["required_deliverables"][0]["id"],
            "result-file"
        );

        let created = call_tool_with_grant(
            &runtime,
            "create_delivery",
            json!({
                "markdown": "# Result",
                "chat_selection": {"mode": "latest", "count": 2}
            }),
            Some(grant.clone()),
        )
        .await;
        assert_eq!(created["isError"], false);
        let delivery: Value =
            serde_json::from_str(created["content"][0]["text"].as_str().unwrap()).unwrap();
        let delivery_id = delivery["id"].as_str().unwrap().to_owned();

        let source = directory.path().join("result.txt");
        fs::write(&source, "delivery content").unwrap();
        let uploaded = call_tool_with_grant(
            &runtime,
            "upload_delivery_asset",
            json!({
                "delivery_id": delivery_id,
                "file_path": source,
                "content_type": "text/plain"
            }),
            Some(grant.clone()),
        )
        .await;
        assert_eq!(uploaded["isError"], false);
        let asset: Value =
            serde_json::from_str(uploaded["content"][0]["text"].as_str().unwrap()).unwrap();
        let asset_id = asset["id"].as_str().unwrap().to_owned();

        let output = directory.path().join("downloaded-result.txt");
        let downloaded = call_tool_with_grant(
            &runtime,
            "download_delivery_asset",
            json!({
                "delivery_id": delivery_id,
                "asset_id": asset_id,
                "output_path": output
            }),
            Some(grant.clone()),
        )
        .await;
        assert_eq!(downloaded["isError"], false);
        assert_eq!(
            fs::read_to_string(directory.path().join("downloaded-result.txt")).unwrap(),
            "delivery content"
        );

        let empty_finalized = call_tool_with_grant(
            &runtime,
            "finalize_delivery",
            json!({"delivery_id": delivery_id, "fulfillments": []}),
            Some(grant.clone()),
        )
        .await;
        assert_eq!(empty_finalized["isError"], true);
        assert_eq!(
            runtime
                .delivery_detail(&delivery_id)
                .unwrap()
                .delivery
                .status,
            "draft"
        );

        let finalized = call_tool_with_grant(
            &runtime,
            "finalize_delivery",
            json!({
                "delivery_id": delivery_id,
                "fulfillments": [{
                    "requirement_id": "result-file",
                    "kind": "file",
                    "asset_ids": [asset_id]
                }]
            }),
            Some(grant.clone()),
        )
        .await;
        assert_eq!(finalized["isError"], false);
        let detail = runtime.delivery_detail(&delivery_id).unwrap();
        assert_eq!(detail.delivery.status, "delivered");
        assert_eq!(
            detail.chat.unwrap()["messages"].as_array().unwrap().len(),
            2
        );
        let updated = runtime.get_task(&project.id, &task.id).await.unwrap();
        assert_eq!(
            updated.metadata["workflow"]["nodes"][0]["delivery_ids"],
            json!([delivery_id])
        );
        assert_eq!(
            updated.metadata["workflow"]["nodes"][0]["fulfilled_deliverable_ids"],
            json!(["result-file"])
        );

        let draft = call_tool_with_grant(
            &runtime,
            "create_delivery",
            json!({
                "markdown": "discard me",
                "chat_selection": {
                    "mode": "message_ids",
                    "message_ids": [message_ids[0]]
                }
            }),
            Some(grant.clone()),
        )
        .await;
        let draft: Value =
            serde_json::from_str(draft["content"][0]["text"].as_str().unwrap()).unwrap();
        let draft_id = draft["id"].as_str().unwrap();
        let discarded = call_tool_with_grant(
            &runtime,
            "discard_delivery_draft",
            json!({"delivery_id": draft_id}),
            Some(grant),
        )
        .await;
        assert_eq!(discarded["isError"], false);
        assert!(runtime.delivery_detail(draft_id).is_err());

        let all = selected_local_delivery_chat(
            &runtime,
            &project.id,
            &task.id,
            &json!({"chat_selection": {"mode": "all"}}),
        )
        .unwrap()
        .unwrap();
        assert_eq!(all["messages"].as_array().unwrap().len(), 3);
    }
}
