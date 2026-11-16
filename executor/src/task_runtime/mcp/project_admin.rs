// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Project administration uses the Backend's typed contracts and transaction.

use serde_json::{json, Value};
use std::time::Duration;

use super::{BackendToolContext, SpaceMcpRequestContext, TaskRuntime, WeworkMcpSurface};

mod schema_guard;

pub(super) fn is_read_tool(name: &str) -> bool {
    matches!(
        name,
        "get_project_admin_capabilities"
            | "get_project_config"
            | "get_project_members"
            | "get_project_assistant_roster"
    )
}

pub(super) fn is_write_tool(name: &str) -> bool {
    matches!(
        name,
        "update_project_details"
            | "update_project_tags"
            | "change_project_tag"
            | "update_project_board_views"
            | "update_project_strategy"
            | "update_project_statuses"
            | "update_project_workflow"
            | "update_project_automation"
            | "update_project_members"
            | "update_project_assistant_roster"
    )
}

pub(super) fn is_admin_tool(name: &str) -> bool {
    is_read_tool(name) || is_write_tool(name) || name == "update_space"
}

pub(super) fn discovery_tools() -> Vec<Value> {
    [
        (
            "get_project_admin_capabilities",
            "Discover project configuration tools, exact schemas, permissions and availability.",
        ),
        (
            "get_project_config",
            "Read project configuration, projectVersion and current revision.",
        ),
    ]
    .into_iter()
    .map(|(name, description)| {
        super::tool(
            name,
            description,
            json!({
                "type": "object",
                "properties": {"space_id": {"type": "string", "default": ""}},
                "additionalProperties": false
            }),
        )
    })
    .collect()
}

fn failure(reason_code: &str, message: &str) -> String {
    let status_code = match reason_code {
        "permission_denied" => 403,
        "feature_disabled" => 409,
        "connection_unavailable" => 503,
        "invalid_response" => 502,
        _ => 422,
    };
    json!({"error": {
        "reason_code": reason_code,
        "message": message,
        "status_code": status_code,
        "fields": []
    }})
    .to_string()
}

pub(super) fn tool_error(error: String) -> Value {
    let structured = serde_json::from_str::<Value>(&error).ok();
    let mut result = super::text_result(error, true);
    if let Some(value) = structured {
        result["structuredContent"] = value;
    }
    result
}

pub(super) fn permission_denied(message: &str) -> Value {
    tool_error(failure("permission_denied", message))
}

pub(super) fn disconnected() -> Value {
    tool_error(failure(
        "connection_unavailable",
        "Project administration requires an authenticated Backend connection.",
    ))
}

pub(super) fn unavailable() -> String {
    failure(
        "unsupported_capability",
        "Project administration requires a connected Backend project.",
    )
}

fn field_failure(reason_code: &str, path: &str, message: &str) -> String {
    json!({"error": {
        "reason_code": reason_code,
        "message": message,
        "status_code": 422,
        "fields": [{"path": path, "message": message}]
    }})
    .to_string()
}

fn validate_outer_arguments(arguments: &Value, write: bool) -> Result<(), String> {
    let object = arguments.as_object().ok_or_else(|| {
        field_failure(
            "invalid_config",
            "arguments",
            "arguments must be an object.",
        )
    })?;
    for key in object.keys() {
        // The Runtime adds the bound Issue before dispatching every project tool.
        if !matches!(key.as_str(), "space_id" | "item_id") && !(write && key == "request") {
            return Err(field_failure(
                "unsupported_field",
                key,
                &format!("Unsupported project administration argument: {key}."),
            ));
        }
    }
    Ok(())
}

fn validate_request<'a>(name: &str, arguments: &'a Value) -> Result<&'a Value, String> {
    validate_outer_arguments(arguments, true)?;
    let request = arguments
        .get("request")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            field_failure(
                "invalid_config",
                "request",
                "request must be a typed configuration object.",
            )
        })?;
    let fields: &[&str] = match name {
        "update_project_details" => &["name", "description"],
        "update_project_tags" => &["tags"],
        "change_project_tag" => &["tag_change"],
        "update_project_board_views" => &["board_views"],
        "update_project_strategy" => &["collaboration_policy"],
        "update_project_statuses" => &["board_config"],
        "update_project_workflow" => &["workflow_definition"],
        "update_project_automation" => &["ai_automation", "pull_request_automation"],
        "update_project_members" => &["member_changes"],
        "update_project_assistant_roster" => &["assistant_roster_changes"],
        _ => return Err(unavailable()),
    };
    let controls = ["version", "operation_id", "idempotency_key", "dry_run"];
    for key in request
        .as_object()
        .into_iter()
        .flat_map(|object| object.keys())
    {
        if !fields.contains(&key.as_str()) && !controls.contains(&key.as_str()) {
            return Err(field_failure(
                "unsupported_field",
                &format!("request.{key}"),
                &format!("request.{key} is unsupported by {name}."),
            ));
        }
    }
    // Match dedicated request schemas: only details has no single required field.
    let has_change = if name == "update_project_details" {
        fields
            .iter()
            .any(|field| request.get(*field).is_some_and(|value| !value.is_null()))
    } else {
        request.get(fields[0]).is_some_and(|value| !value.is_null())
    };
    if !has_change {
        return Err(field_failure(
            "invalid_config",
            &format!("request.{}", fields[0]),
            &format!("request.{} is required.", fields[0]),
        ));
    }
    Ok(request)
}

async fn project_detail(context: &BackendToolContext<'_>) -> Result<Value, String> {
    let response = client()?
        .get(format!(
            "{}/api/v1/projects/{}",
            context.backend_url.trim_end_matches('/'),
            super::encode_segment(context.project_id),
        ))
        .bearer_auth(context.auth_token)
        .send()
        .await
        .map_err(|error| failure("connection_unavailable", &error.to_string()))?;
    response_json(response).await
}

async fn response_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body: Value = response.json().await.map_err(|_| {
        failure(
            "invalid_response",
            "The Backend returned an invalid configuration response.",
        )
    })?;
    if status.is_success() {
        return Ok(body);
    }
    let detail = body.get("detail").unwrap_or(&body);
    let structured = if body.get("reason_code").is_some() {
        &body
    } else {
        detail
    };
    if structured.get("reason_code").is_some() {
        return Err(json!({"error": {
            "reason_code": structured["reason_code"],
            "message": structured["message"].as_str().or_else(|| detail.as_str()).unwrap_or("Project configuration validation failed."),
            "status_code": status.as_u16(),
            "fields": structured.get("fields").cloned().unwrap_or_else(|| json!([])),
        }}).to_string());
    }
    let reason_code = match status.as_u16() {
        401 | 403 => "permission_denied",
        404 => "not_found",
        409 => "version_conflict",
        422 => "invalid_config",
        _ => "connection_unavailable",
    };
    Err(json!({"error": {
        "reason_code": reason_code,
        "message": detail.as_str().unwrap_or("Project configuration validation failed."),
        "status_code": status.as_u16(),
        "fields": detail.as_array().cloned().unwrap_or_default()
    }})
    .to_string())
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| failure("connection_unavailable", &error.to_string()))
}

fn catalog_from_detail(detail: &Value) -> Result<Value, String> {
    detail
        .get("project_admin_capabilities")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| {
            failure(
                "unsupported_capability",
                "The Backend does not expose a project administration catalog.",
            )
        })
}

fn scoped_catalog(mut catalog: Value, context: &BackendToolContext<'_>) -> Value {
    let operations = catalog["operations"]
        .as_array_mut()
        .map(std::mem::take)
        .unwrap_or_default();
    let mut available = Vec::new();
    let mut unavailable = Vec::new();
    for mut operation in operations {
        let allowed = operation["toolName"]
            .as_str()
            .and_then(super::board_tool_category)
            .is_some_and(|category| super::grant_allows(context.grant, category));
        if allowed {
            available.push(operation);
        } else {
            operation["availability"] = json!({
                "available": false,
                "reason_code": "permission_denied"
            });
            unavailable.push(operation);
        }
    }
    catalog["operations"] = json!(available);
    if let Some(values) = catalog["unavailableCapabilities"].as_array_mut() {
        values.extend(unavailable);
    } else {
        catalog["unavailableCapabilities"] = json!(unavailable);
    }
    catalog
}

fn extend_tools(tools: &mut Vec<Value>, catalog: &Value, context: &SpaceMcpRequestContext) {
    for descriptor in catalog["operations"].as_array().into_iter().flatten() {
        let Some(name) = descriptor["toolName"].as_str() else {
            continue;
        };
        if !(is_read_tool(name) || is_write_tool(name))
            || descriptor.pointer("/availability/available") != Some(&json!(true))
            || !super::board_tool_category(name)
                .is_some_and(|category| super::grant_allows(context.grant(), category))
        {
            continue;
        }
        let tool = json!({
            "name": name,
            "description": descriptor["description"],
            "inputSchema": descriptor["inputSchema"],
            "outputSchema": descriptor["outputSchema"],
        });
        tools.retain(|value| value["name"] != name);
        tools.push(tool);
    }
    if let Some(schema) = catalog
        .get("updateSpaceInputSchema")
        .filter(|v| v.is_object())
    {
        if let Some(tool) = tools.iter_mut().find(|tool| tool["name"] == "update_space") {
            tool["inputSchema"] = schema.clone();
            if let Some(output) = catalog.get("updateSpaceOutputSchema") {
                tool["outputSchema"] = output.clone();
            }
        }
    }
}

pub(super) async fn extend_visible_tools(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    tools: &mut Vec<Value>,
) -> Result<(), String> {
    if context.surface != WeworkMcpSurface::ProjectSpace {
        return Ok(());
    }
    let Some(project_id) = context.grant().and_then(|grant| grant.space_id.as_deref()) else {
        return Ok(());
    };
    if super::is_locally_routed_project(runtime, project_id, "get_project_config") {
        return Ok(());
    }
    let Some((backend_url, auth_token)) = context
        .backend_url
        .as_deref()
        .zip(context.auth_token.as_deref())
    else {
        return Ok(());
    };
    let backend = BackendToolContext {
        backend_url,
        auth_token,
        project_id,
        grant: context.grant(),
        collaboration_dispatcher: None,
    };
    let detail = project_detail(&backend).await?;
    extend_tools(tools, &catalog_from_detail(&detail)?, context);
    Ok(())
}

pub(super) async fn call(
    context: &BackendToolContext<'_>,
    name: &str,
    arguments: &Value,
) -> Result<Value, String> {
    if name == "update_space" {
        return apply_space_update(context, arguments).await;
    }
    if is_read_tool(name) {
        validate_outer_arguments(arguments, false)?;
    }
    let detail = project_detail(context).await?;
    if matches!(
        name,
        "get_project_config" | "get_project_members" | "get_project_assistant_roster"
    ) {
        let mut config = detail
            .get("project_admin_config")
            .filter(|value| value.is_object())
            .cloned()
            .ok_or_else(unavailable)?;
        if name != "get_project_config" {
            let key = if name == "get_project_members" {
                "members"
            } else {
                "assistant_roster"
            };
            let value = config["configuration"]
                .get(key)
                .cloned()
                .ok_or_else(unavailable)?;
            config["configuration"] = json!({key: value});
        }
        return Ok(config);
    }
    let catalog = scoped_catalog(catalog_from_detail(&detail)?, context);
    if name == "get_project_admin_capabilities" {
        return Ok(catalog);
    }
    let operation = require_operation(&catalog, name)?;
    apply_write(context, name, arguments, &operation["inputSchema"]).await
}

async fn patch_project(context: &BackendToolContext<'_>, request: &Value) -> Result<Value, String> {
    let response = client()?
        .patch(format!(
            "{}/api/v1/cloud-projects/{}",
            context.backend_url.trim_end_matches('/'),
            super::encode_segment(context.project_id),
        ))
        .bearer_auth(context.auth_token)
        .json(request)
        .send()
        .await
        .map_err(|error| failure("connection_unavailable", &error.to_string()))?;
    response_json(response).await
}

async fn apply_space_update(
    context: &BackendToolContext<'_>,
    arguments: &Value,
) -> Result<Value, String> {
    let object = arguments.as_object().ok_or_else(|| {
        field_failure(
            "invalid_config",
            "arguments",
            "arguments must be an object.",
        )
    })?;
    for key in object.keys() {
        if !matches!(key.as_str(), "space_id" | "item_id" | "project") {
            return Err(field_failure(
                "unsupported_field",
                key,
                "Unsupported project update argument.",
            ));
        }
    }
    let request = object
        .get("project")
        .filter(|value| value.is_object())
        .ok_or_else(|| {
            field_failure(
                "invalid_config",
                "project",
                "project must be a typed configuration object.",
            )
        })?;
    let fields = [
        "name",
        "description",
        "tags",
        "tag_change",
        "board_config",
        "board_views",
        "collaboration_policy",
        "workflow_definition",
        "ai_automation",
        "pull_request_automation",
        "member_changes",
        "assistant_roster_changes",
        "version",
        "operation_id",
        "idempotency_key",
        "dry_run",
    ];
    for field in request
        .as_object()
        .into_iter()
        .flat_map(|value| value.keys())
    {
        if !fields.contains(&field.as_str()) {
            return Err(field_failure(
                "unsupported_field",
                &format!("project.{field}"),
                "Unsupported project configuration field.",
            ));
        }
    }
    // Existing generic writes also require the Backend's audited configuration contract.
    // A disabled flag hides dedicated writes without disabling this existing entry point.
    let catalog = catalog_from_detail(&project_detail(context).await?)?;
    schema_guard::validate(arguments, &catalog["updateSpaceInputSchema"])?;
    let updated = patch_project(context, request).await?;
    let mut result = serde_json::Map::new();
    for field in [
        "id",
        "project_key",
        "name",
        "description",
        "task_provider",
        "tags",
        "version",
        "project_admin_result",
    ] {
        let value = updated.get(field).cloned().ok_or_else(|| {
            failure(
                "invalid_response",
                "The Backend omitted the project update result.",
            )
        })?;
        result.insert(field.to_owned(), value);
    }
    Ok(Value::Object(result))
}

fn require_operation<'a>(catalog: &'a Value, name: &str) -> Result<&'a Value, String> {
    let available = catalog["operations"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|operation| {
            operation["toolName"] == name
                && operation.pointer("/availability/available") == Some(&json!(true))
        });
    if let Some(operation) = available {
        return Ok(operation);
    }
    let reason = catalog["unavailableCapabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|operation| operation["toolName"] == name)
        .and_then(|operation| operation.pointer("/availability/reason_code"))
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            if catalog.get("enabled") == Some(&json!(false)) {
                "feature_disabled"
            } else {
                "unsupported_capability"
            }
        });
    Err(failure(
        reason,
        "This project configuration operation is unavailable.",
    ))
}

async fn apply_write(
    context: &BackendToolContext<'_>,
    name: &str,
    arguments: &Value,
    schema: &Value,
) -> Result<Value, String> {
    let request = validate_request(name, arguments)?;
    schema_guard::validate(arguments, schema)?;
    patch_project(context, request)
        .await?
        .get("project_admin_result")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or_else(|| {
            failure(
                "invalid_response",
                "The Backend omitted the project administration result.",
            )
        })
}

#[cfg(test)]
mod tests;
