// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::protocol::ExecutionRequest;

use super::{BinaryInput, ProjectCreate, TaskRuntime, TaskSearch};

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
    let mut server = json!({
        "name": TASK_MCP_SERVER_NAME,
        "type": "stdio",
        "command": executable,
        "args": ["task-mcp-server"],
    });
    if let Some(project_id) = request
        .extra
        .get("cloudProjectId")
        .or_else(|| request.extra.get("cloud_project_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        server["env"] = json!({"WEGENT_TASK_PROJECT_ID": project_id});
    }
    if let Some(backend_url) = request
        .backend_url
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        server["env"]["WEGENT_TASK_BACKEND_URL"] = json!(backend_url);
    }
    if let Some(auth_token) = request
        .auth_token
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        server["env"]["WEGENT_TASK_AUTH_TOKEN"] = json!(auth_token);
    }
    request.mcp_servers.push(server);
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
    let scoped_project_id = env::var("WEGENT_TASK_PROJECT_ID").ok();
    if let (Some(scoped), Some(requested)) = (
        scoped_project_id.as_deref(),
        arguments.get("project_id").and_then(Value::as_str),
    ) {
        if requested != scoped {
            return text_result(
                "Task MCP access is limited to the current project".to_owned(),
                true,
            );
        }
    }
    let is_local_project = scoped_project_id
        .as_deref()
        .is_some_and(|project_id| is_local_scoped_project(runtime, project_id));
    if let (Ok(backend_url), Ok(auth_token), Some(project_id)) = (
        env::var("WEGENT_TASK_BACKEND_URL"),
        env::var("WEGENT_TASK_AUTH_TOKEN"),
        scoped_project_id.as_deref(),
    ) {
        if !is_local_project {
            return match call_backend_tool(&backend_url, &auth_token, project_id, name, &arguments)
                .await
            {
                Ok(value) => text_result(value.to_string(), false),
                Err(error) => text_result(error, true),
            };
        }
    }
    let result = match name {
        "list_projects" => runtime.list_projects().and_then(|mut value| {
            if let Some(project_id) = scoped_project_id.as_deref() {
                value.retain(|project| project.id == project_id);
            }
            serde_json::to_value(value).map_err(invalid_json)
        }),
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
        "search_todos" => match parse::<TaskSearch>(arguments) {
            Ok(mut input) => {
                if input.project_id.is_none() {
                    input.project_id = scoped_project_id;
                }
                runtime
                    .search_tasks(input)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json))
            }
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
        "list_todo_attachments" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
            match (project_id, task_id) {
                (Ok(project_id), Ok(task_id)) => runtime
                    .list_task_attachments(project_id, task_id)
                    .await
                    .and_then(|value| serde_json::to_value(value).map_err(invalid_json)),
                (Err(error), _) | (_, Err(error)) => Err(error),
            }
        }
        "upload_todo_attachment" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
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
        "download_todo_attachment" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
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
        "delete_todo_attachment" => {
            let project_id = string_argument(&arguments, "project_id");
            let task_id = string_argument(&arguments, "task_id");
            let attachment_id = string_argument(&arguments, "attachment_id");
            match (project_id, task_id, attachment_id) {
                (Ok(project_id), Ok(task_id), Ok(attachment_id)) => runtime
                    .delete_task_attachment(project_id, task_id, attachment_id)
                    .await
                    .map(|_| json!({"deleted": true})),
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

fn is_local_scoped_project(runtime: &TaskRuntime, project_id: &str) -> bool {
    runtime
        .list_projects()
        .unwrap_or_default()
        .into_iter()
        .find(|project| project.id == project_id)
        .and_then(|project| {
            project.metadata["project_store"]
                .as_str()
                .map(|store| store == "local")
        })
        .unwrap_or(false)
}

async fn call_backend_tool(
    backend_url: &str,
    auth_token: &str,
    project_id: &str,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let base = format!("{}/api/v1", backend_url.trim_end_matches('/'));
    let task_id = || {
        arguments
            .get("task_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "task_id is required".to_owned())
    };
    let request = match name {
        "list_projects" => client.get(format!("{base}/cloud-projects")),
        "list_todos" => client.get(format!("{base}/cloud-projects/{project_id}/loop-items")),
        "search_todos" => {
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
        "get_todo" => client.get(format!("{base}/loop-items/{}", encode_segment(task_id()?))),
        "create_todo" => client
            .post(format!("{base}/cloud-projects/{project_id}/loop-items"))
            .json(arguments.get("todo").unwrap_or(arguments)),
        "update_todo" => client
            .patch(format!("{base}/loop-items/{}", encode_segment(task_id()?)))
            .json(arguments.get("todo").unwrap_or(arguments)),
        "add_todo_comment" => client
            .post(format!(
                "{base}/loop-items/{}/comments",
                encode_segment(task_id()?)
            ))
            .json(&json!({
                "body": arguments.get("body").and_then(Value::as_str).unwrap_or_default()
            })),
        "list_todo_attachments" => client.get(format!(
            "{base}/loop-items/{}/attachments",
            encode_segment(task_id()?)
        )),
        "reorder_todos" => client
            .post(format!(
                "{base}/cloud-projects/{project_id}/loop-items/reorder"
            ))
            .json(arguments.get("reorder").unwrap_or(arguments)),
        "create_project" | "update_project" => {
            return Err("Cloud project management is not available through task MCP".to_owned())
        }
        "upload_todo_attachment" => {
            let file_path =
                string_argument(arguments, "file_path").map_err(|error| error.to_string())?;
            let bytes = fs::read(&file_path).map_err(|error| error.to_string())?;
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
        "download_todo_attachment" => {
            let attachment_id =
                string_argument(arguments, "attachment_id").map_err(|error| error.to_string())?;
            let output_path = attachment_output_path(arguments, &attachment_id)
                .map_err(|error| error.to_string())?;
            let access = backend_json(
                client
                    .get(format!(
                        "{base}/loop-item-attachments/{}/access",
                        encode_segment(&attachment_id)
                    ))
                    .bearer_auth(auth_token)
                    .send()
                    .await
                    .map_err(|error| error.to_string())?,
            )
            .await?;
            let url = access["url"]
                .as_str()
                .ok_or_else(|| "attachment access URL is missing".to_owned())?;
            let bytes = client
                .get(url)
                .send()
                .await
                .map_err(|error| error.to_string())?
                .bytes()
                .await
                .map_err(|error| error.to_string())?;
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&output_path, bytes).map_err(|error| error.to_string())?;
            return Ok(json!({"path": output_path}));
        }
        "delete_todo_attachment" => {
            let attachment_id =
                string_argument(arguments, "attachment_id").map_err(|error| error.to_string())?;
            let response = client
                .delete(format!(
                    "{base}/loop-item-attachments/{}",
                    encode_segment(&attachment_id)
                ))
                .bearer_auth(auth_token)
                .send()
                .await
                .map_err(|error| error.to_string())?;
            return backend_json(response).await;
        }
        _ => return Err(format!("Unknown task tool: {name}")),
    };
    let response = request
        .bearer_auth(auth_token)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let value = backend_json(response).await?;
    if name == "list_projects" {
        return Ok(Value::Array(
            value
                .get("items")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|project| project["id"].as_str() == Some(project_id))
                .cloned()
                .collect(),
        ));
    }
    if name == "list_todos" {
        return Ok(value.get("items").cloned().unwrap_or_else(|| json!([])));
    }
    Ok(value)
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
                        .is_none_or(|tag| {
                            task["tags"]
                                .as_array()
                                .is_some_and(|tags| tags.iter().any(|value| value == tag))
                        })
                    && arguments
                        .get("creator_user_id")
                        .and_then(Value::as_i64)
                        .is_none_or(|id| task["created_by_user_id"] == id)
            })
            .take(limit)
            .collect(),
    )
}

fn matches_filter(task: &Value, arguments: &Value, key: &str) -> bool {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .is_none_or(|value| task[key] == value)
}

fn encode_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
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
            "search_todos",
            "Search tasks across one project or all configured projects using text and structured filters",
            json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Matches task id, title, description, or tags"},
                    "project_id": {"type": "string"},
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
            "list_todo_attachments",
            "List attachments stored for a task. GitLab Issue attachments are read from GitLab.",
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
            "upload_todo_attachment",
            "Upload a local file as a task attachment. GitLab Issue files are stored in GitLab Project Uploads.",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "task_id": {"type": "string"},
                    "file_path": {"type": "string"},
                    "display_name": {"type": "string"},
                    "content_type": {"type": "string"}
                },
                "required": ["project_id", "task_id", "file_path"]
            }),
        ),
        tool(
            "download_todo_attachment",
            "Download a task attachment and return its local path for inspection.",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "task_id": {"type": "string"},
                    "attachment_id": {"type": "string"},
                    "output_path": {"type": "string"}
                },
                "required": ["project_id", "task_id", "attachment_id"]
            }),
        ),
        tool(
            "delete_todo_attachment",
            "Delete a task attachment from its authoritative task storage.",
            json!({
                "type": "object",
                "properties": {
                    "project_id": {"type": "string"},
                    "task_id": {"type": "string"},
                    "attachment_id": {"type": "string"}
                },
                "required": ["project_id", "task_id", "attachment_id"]
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
    use crate::task_runtime::{LocalTaskStore, TaskCreate, TaskProviderKind};

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

    #[test]
    fn scopes_task_mcp_to_the_bound_cloud_project() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!("cloud-42"));

        ensure_task_mcp_server(&mut request);

        assert_eq!(
            request.mcp_servers[0]["env"]["WEGENT_TASK_PROJECT_ID"],
            "cloud-42"
        );
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

        assert!(is_local_scoped_project(&runtime, &project.id));
        assert!(!is_local_scoped_project(&runtime, "cloud-project"));
    }

    #[test]
    fn exposes_task_attachment_tools() {
        let names = tools()
            .into_iter()
            .filter_map(|tool| tool["name"].as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>();

        for name in [
            "list_todo_attachments",
            "upload_todo_attachment",
            "download_todo_attachment",
            "delete_todo_attachment",
        ] {
            assert!(names.iter().any(|candidate| candidate == name));
        }
    }

    #[test]
    fn exposes_task_search_tool() {
        let search = tools()
            .into_iter()
            .find(|tool| tool["name"] == "search_todos")
            .expect("search_todos tool");

        assert_eq!(
            search["inputSchema"]["properties"]["status"]["enum"],
            json!(["inbox", "pending", "in_progress", "in_review", "completed"])
        );
        assert_eq!(
            search["inputSchema"]["properties"]["creator_user_id"]["type"],
            "integer"
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
                },
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        let result = call_tool(
            &runtime,
            "search_todos",
            json!({
                "project_id": project.id,
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
                },
            )
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();
        let source = directory.path().join("source.txt");
        fs::write(&source, "attachment content").unwrap();

        let upload = call_tool(
            &runtime,
            "upload_todo_attachment",
            json!({
                "project_id": project.id,
                "task_id": task.id,
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
            "list_todo_attachments",
            json!({"project_id": project.id, "task_id": task.id}),
        )
        .await;
        let listed: Value =
            serde_json::from_str(list["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(listed.as_array().unwrap().len(), 1);

        let output = directory.path().join("downloaded.txt");
        let download = call_tool(
            &runtime,
            "download_todo_attachment",
            json!({
                "project_id": project.id,
                "task_id": task.id,
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
            "delete_todo_attachment",
            json!({
                "project_id": project.id,
                "task_id": task.id,
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
}
