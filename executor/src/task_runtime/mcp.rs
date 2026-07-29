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

const SPACE_MCP_SERVER_NAME: &str = "wework_space";

pub fn is_space_mcp_command() -> bool {
    env::args().nth(1).as_deref() == Some("space-mcp-server")
}

pub fn ensure_space_mcp_server(request: &mut ExecutionRequest) {
    let Ok(executable) = env::current_exe() else {
        return;
    };
    let mut server = json!({
        "name": SPACE_MCP_SERVER_NAME,
        "type": "stdio",
        "command": executable,
        "args": ["space-mcp-server"],
    });
    if let Some(project_id) = request
        .extra
        .get("cloudProjectId")
        .or_else(|| request.extra.get("cloud_project_id"))
        .and_then(id_value)
        .filter(|value| !value.is_empty())
    {
        server["env"] = json!({"WEWORK_SPACE_ID": project_id});
    }
    if let Some(backend_url) = request
        .backend_url
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        server["env"]["WEWORK_SPACE_BACKEND_URL"] = json!(backend_url);
    }
    if let Some(auth_token) = request
        .auth_token
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        server["env"]["WEWORK_SPACE_AUTH_TOKEN"] = json!(auth_token);
    }
    if let Some(existing) = request.mcp_servers.iter_mut().find(|candidate| {
        candidate.get("name").and_then(Value::as_str) == Some(SPACE_MCP_SERVER_NAME)
    }) {
        *existing = server;
    } else {
        request.mcp_servers.push(server);
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
                        "name": SPACE_MCP_SERVER_NAME,
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
    let default_project_id = env::var("WEWORK_SPACE_ID").ok();
    let requested_project_id = arguments
        .get("space_id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| default_project_id.clone());
    let is_locally_routed = requested_project_id
        .as_deref()
        .is_some_and(|project_id| is_locally_routed_project(runtime, project_id, name));
    let backend_url = env::var("WEWORK_SPACE_BACKEND_URL").ok();
    let auth_token = env::var("WEWORK_SPACE_AUTH_TOKEN").ok();
    if name == "list_spaces" {
        let local_projects = match runtime.list_projects().and_then(|mut projects| {
            projects.retain(|project| project.metadata["project_store"] != "backend");
            serde_json::to_value(projects).map_err(invalid_json)
        }) {
            Ok(Value::Array(projects)) => projects,
            Ok(_) => Vec::new(),
            Err(error) => return text_result(error.to_string(), true),
        };
        let Some((backend_url, auth_token)) = backend_url.as_deref().zip(auth_token.as_deref())
        else {
            return text_result(Value::Array(local_projects).to_string(), false);
        };
        return match call_backend_tool(backend_url, auth_token, "", name, &arguments).await {
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
            backend_url.as_deref().unwrap_or_default(),
            auth_token.as_deref().unwrap_or_default(),
            project_id,
            name,
            &arguments,
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
                    .aitable_list_records(project_id, query.as_deref(), limit, cursor.as_deref())
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
        Ok(value) => text_result(value.to_string(), false),
        Err(error) => text_result(error.to_string(), true),
    }
}

fn is_locally_routed_project(runtime: &TaskRuntime, project_id: &str, tool_name: &str) -> bool {
    runtime
        .list_projects()
        .unwrap_or_default()
        .into_iter()
        .find(|project| project.id == project_id)
        .is_some_and(|project| {
            project.metadata["project_store"].as_str() == Some("local")
                || (project.metadata["task_provider"].as_str() == Some("dingtalk_aitable")
                    && is_task_provider_tool(tool_name))
        })
}

fn is_task_provider_tool(name: &str) -> bool {
    matches!(
        name,
        "list_board_items"
            | "search_board_items"
            | "get_board_item"
            | "create_board_item"
            | "update_board_item"
            | "add_board_item_comment"
            | "list_item_attachments"
            | "upload_item_attachment"
            | "read_item_attachment"
            | "delete_item_attachment"
            | "reorder_board_items"
            | "describe_space_table"
            | "list_table_records"
            | "create_table_record"
            | "update_table_record"
            | "delete_table_record"
            | "create_table_field"
            | "update_table_field"
            | "delete_table_field"
    )
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
        "get_board_item" => client.get(format!("{base}/loop-items/{}", encode_segment(task_id()?))),
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
        "list_deliveries" => client.get(format!(
            "{base}/loop-items/{}/deliveries",
            encode_segment(task_id()?)
        )),
        "read_delivery" => {
            let delivery_id = string_argument(arguments, "delivery_id")
                .map_err(|error| error.to_string())?;
            client.get(format!(
                "{base}/deliveries/{}",
                encode_segment(delivery_id)
            ))
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
    if name == "list_board_items" {
        return Ok(value.get("items").cloned().unwrap_or_else(|| json!([])));
    }
    Ok(value)
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
                        .map_or(true, |tag| {
                            task["tags"]
                                .as_array()
                                .is_some_and(|tags| tags.iter().any(|value| value == tag))
                        })
                    && arguments
                        .get("creator_user_id")
                        .and_then(Value::as_i64)
                        .map_or(true, |id| task["created_by_user_id"] == id)
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

fn tools() -> Vec<Value> {
    vec![
        tool(
            "list_spaces",
            "List WeWork project spaces available to the current user",
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
            "Read a delivery and its Markdown handoff content",
            json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "delivery_id": {"type": "string"}
                },
                "required": ["space_id", "delivery_id"]
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
        LocalTaskStore, ProjectDescriptor, ProjectStoreKind, TaskCreate, TaskProviderKind,
    };

    #[test]
    fn injects_wework_space_once() {
        let mut request = ExecutionRequest::default();

        ensure_space_mcp_server(&mut request);
        ensure_space_mcp_server(&mut request);

        assert_eq!(request.mcp_servers.len(), 1);
        assert_eq!(request.mcp_servers[0]["name"], SPACE_MCP_SERVER_NAME);
        assert_eq!(request.mcp_servers[0]["type"], "stdio");
        assert_eq!(request.mcp_servers[0]["args"], json!(["space-mcp-server"]));
    }

    #[test]
    fn refreshes_stale_wework_space_config_for_a_follow_up_turn() {
        let mut request = ExecutionRequest::default();
        request.mcp_servers.push(json!({
            "name": "wework_space",
            "type": "stdio",
            "command": "stale-executor",
            "args": ["space-mcp-server"]
        }));
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!(841738010351776815_i64));
        request.backend_url = Some("https://wework.example.com".to_owned());
        request.auth_token = Some("runtime-token".to_owned());

        ensure_space_mcp_server(&mut request);

        assert_eq!(request.mcp_servers.len(), 1);
        assert_ne!(request.mcp_servers[0]["command"], "stale-executor");
        assert_eq!(
            request.mcp_servers[0]["env"]["WEWORK_SPACE_ID"],
            "841738010351776815"
        );
        assert_eq!(
            request.mcp_servers[0]["env"]["WEWORK_SPACE_BACKEND_URL"],
            "https://wework.example.com"
        );
        assert_eq!(
            request.mcp_servers[0]["env"]["WEWORK_SPACE_AUTH_TOKEN"],
            "runtime-token"
        );
    }

    #[test]
    fn provides_the_bound_project_as_the_default_space() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!("cloud-42"));

        ensure_space_mcp_server(&mut request);

        assert_eq!(request.mcp_servers[0]["env"]["WEWORK_SPACE_ID"], "cloud-42");
    }

    #[test]
    fn provides_a_numeric_bound_project_as_the_default_space() {
        let mut request = ExecutionRequest::default();
        request
            .extra
            .insert("cloudProjectId".to_owned(), json!(9001));

        ensure_space_mcp_server(&mut request);

        assert_eq!(request.mcp_servers[0]["env"]["WEWORK_SPACE_ID"], "9001");
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

    #[test]
    fn routes_backend_dingtalk_table_operations_to_the_local_provider() {
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
                    "table_id": "table-1"
                }),
                version: 1,
            })
            .unwrap();
        let runtime = TaskRuntime::new(store).unwrap();

        for tool_name in [
            "list_board_items",
            "search_board_items",
            "describe_space_table",
            "list_table_records",
        ] {
            assert!(is_locally_routed_project(
                &runtime,
                "cloud-aitable",
                tool_name
            ));
        }
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
    fn exposes_only_wework_space_business_vocabulary() {
        let serialized = serde_json::to_string(&tools()).unwrap().to_lowercase();

        for forbidden in [
            "wegent_tasks",
            "wegent_delivery",
            "github",
            "gitlab",
            "project_id",
            "task_id",
            "\"todo\"",
        ] {
            assert!(!serialized.contains(forbidden), "found {forbidden}");
        }
        for required in [
            "list_spaces",
            "get_board_item",
            "list_item_attachments",
            "read_item_attachment",
            "list_space_files",
            "list_deliveries",
        ] {
            assert!(serialized.contains(required), "missing {required}");
        }
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
}
