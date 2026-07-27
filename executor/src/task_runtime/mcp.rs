// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::protocol::ExecutionRequest;

use super::{ProjectCreate, TaskRuntime};

const TASK_MCP_SERVER_NAME: &str = "wegent_tasks";

pub fn is_task_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("task-mcp-server")
}

pub fn ensure_task_mcp_server(request: &mut ExecutionRequest) {
    if request
        .mcp_servers
        .iter()
        .any(|server| server.get("name").and_then(Value::as_str) == Some(TASK_MCP_SERVER_NAME))
    {
        return;
    }
    let Ok(executable) = env::current_exe() else {
        return;
    };
    request.mcp_servers.push(json!({
        "name": TASK_MCP_SERVER_NAME,
        "type": "stdio",
        "command": executable,
        "args": ["task-mcp-server"],
    }));
}

pub async fn run() -> Result<(), String> {
    let runtime = TaskRuntime::from_env().map_err(|error| error.to_string())?;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle_request(&runtime, &request).await,
            Err(error) => Some(error_response(Value::Null, -32700, &error.to_string())),
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
    Ok(())
}

async fn handle_request(runtime: &TaskRuntime, request: &Value) -> Option<Value> {
    let id = request.get("id").cloned();
    match request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "notifications/initialized" => None,
        "initialize" => id.map(|id| {
            result_response(
                id,
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {
                        "name": TASK_MCP_SERVER_NAME,
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }),
            )
        }),
        "ping" => id.map(|id| result_response(id, json!({}))),
        "tools/list" => id.map(|id| result_response(id, json!({"tools": tools()}))),
        "tools/call" => {
            let id = id?;
            let name = request.pointer("/params/name").and_then(Value::as_str)?;
            let arguments = request
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            Some(result_response(
                id,
                call_tool(runtime, name, arguments).await,
            ))
        }
        method => id.map(|id| error_response(id, -32601, &format!("Unknown method: {method}"))),
    }
}

async fn call_tool(runtime: &TaskRuntime, name: &str, arguments: Value) -> Value {
    let result = match name {
        "list_projects" => runtime
            .list_projects()
            .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
        "create_project" => parse(arguments)
            .and_then(|input: ProjectCreate| runtime.create_project(input))
            .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
        "update_project" => {
            let project_id = string_argument(&arguments, "project_id");
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
        "list_todos" => match string_argument(&arguments, "project_id") {
            Ok(project_id) => runtime
                .list_tasks(project_id)
                .await
                .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
            Err(error) => Err(error),
        },
        "get_todo" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
            match (project_id, task_id) {
                (Ok(project_id), Ok(task_id)) => runtime
                    .get_task(project_id, task_id)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "create_todo" => {
            let project_id = string_argument(&arguments, "project_id");
            let input = parse(
                arguments
                    .get("todo")
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
        "update_todo" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
            let input = parse(
                arguments
                    .get("todo")
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
        "add_todo_comment" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
            let body = string_argument(&arguments, "body");
            match (project_id, task_id, body) {
                (Ok(project_id), Ok(task_id), Ok(body)) => runtime
                    .add_comment(project_id, task_id, body)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _, _) | (_, Err(error), _) | (_, _, Err(error)) => Err(error),
            }
        }
        "reorder_todos" => {
            let project_id = string_argument(&arguments, "project_id");
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
        _ => return text_result(format!("Unknown task tool: {name}"), true),
    };
    match result {
        Ok(value) => text_result(value.to_string(), false),
        Err(error) => text_result(error.to_string(), true),
    }
}

fn tools() -> Vec<Value> {
    vec![
        tool(
            "list_projects",
            concat!(
                "List project spaces available to this local Executor, including ",
                "local spaces and configured cloud GitHub or GitLab spaces"
            ),
            json!({"type": "object", "properties": {}}),
        ),
        tool(
            "create_project",
            "Create a local project space; never use this to copy an existing cloud project",
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "project_key": {"type": "string"},
                    "description": {"type": "string"},
                    "task_provider": {"enum": ["local", "github", "gitlab"]},
                    "provider_config": {"type": "object"}
                },
                "required": ["name", "task_provider"]
            }),
        ),
        tool(
            "update_project",
            "Update a local project or rotate its encrypted provider credential",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "project": {
                        "type": "object",
                        "properties": {
                            "version": {"type": "integer"},
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                            "provider_config": {
                                "type": "object",
                                "description": "Provider settings. token is transient and is stored only as ciphertext."
                            }
                        },
                        "required": ["version"]
                    }
                },
                "required": ["project_id", "project"]
            }),
        ),
        tool(
            "list_todos",
            "List tasks in a project",
            json!({
                "type": "object",
                "properties": {"project_id": {"type": "string"}},
                "required": ["project_id"]
            }),
        ),
        tool(
            "create_todo",
            "Create a local task or external Issue",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "todo": {"type": "object"}
                },
                "required": ["project_id", "todo"]
            }),
        ),
        tool(
            "get_todo",
            "Get one task in a project",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "task_id": {"type": "string"}
                },
                "required": ["project_id", "task_id"]
            }),
        ),
        tool(
            "update_todo",
            "Update a local task or external Issue",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "task_id": {"type": "string"},
                    "todo": {"type": "object"}
                },
                "required": ["project_id", "task_id", "todo"]
            }),
        ),
        tool(
            "add_todo_comment",
            "Add a comment to a GitHub or GitLab Issue",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "task_id": {"type": "string"},
                    "body": {"type": "string"}
                },
                "required": ["project_id", "task_id", "body"]
            }),
        ),
        tool(
            "reorder_todos",
            "Persist the order of tasks in one board lane",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
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
                "required": ["project_id", "reorder"]
            }),
        ),
    ]
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

    #[test]
    fn injects_the_local_task_mcp_once() {
        let mut request = ExecutionRequest::default();

        ensure_task_mcp_server(&mut request);
        ensure_task_mcp_server(&mut request);

        assert_eq!(request.mcp_servers.len(), 1);
        assert_eq!(request.mcp_servers[0]["name"], TASK_MCP_SERVER_NAME);
        assert_eq!(request.mcp_servers[0]["type"], "stdio");
        assert_eq!(request.mcp_servers[0]["args"], json!(["task-mcp-server"]));
    }
}
