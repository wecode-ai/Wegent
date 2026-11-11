// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Read-only access to the direct parent of an Executor-bound Issue.

use super::*;

#[cfg(test)]
mod tests;

fn is_parent_read_tool(name: &str) -> bool {
    matches!(
        name,
        "get_board_item"
            | "list_board_item_comments"
            | "list_deliveries"
            | "read_delivery"
            | "download_delivery_asset"
    )
}

pub(super) async fn authorize_read(
    runtime: &TaskRuntime,
    name: &str,
    arguments: &Value,
    context: &SpaceMcpRequestContext,
) -> Result<bool, String> {
    let Some(grant) = context.grant.as_ref() else {
        return Ok(false);
    };
    if grant.role != Some(SpaceContextRole::Executor) || !is_parent_read_tool(name) {
        return Ok(false);
    }
    let (Some(project_id), Some(child_id), Some(parent_id)) = (
        grant.space_id.as_deref(),
        grant.item_id.as_deref(),
        arguments.get("item_id").and_then(Value::as_str),
    ) else {
        return Ok(false);
    };
    if parent_id.is_empty()
        || parent_id == child_id
        || arguments
            .get("space_id")
            .and_then(Value::as_str)
            .is_some_and(|requested| requested != project_id)
    {
        return Ok(false);
    }
    let child = read_issue(runtime, context, project_id, child_id).await?;
    if child.get("parent_id").and_then(Value::as_str) != Some(parent_id) {
        return Ok(false);
    }
    // Read the parent with the existing provider authorization on every call.
    // A relationship never substitutes for current project/Issue visibility.
    read_issue(runtime, context, project_id, parent_id).await?;
    Ok(true)
}

async fn read_issue(
    runtime: &TaskRuntime,
    context: &SpaceMcpRequestContext,
    project_id: &str,
    item_id: &str,
) -> Result<Value, String> {
    if is_locally_routed_project(runtime, project_id, "get_board_item")
        .map_err(|error| error.to_string())?
    {
        return runtime
            .get_task(project_id, item_id)
            .await
            .map_err(|error| error.to_string())
            .and_then(|item| serde_json::to_value(item).map_err(|error| error.to_string()));
    }
    let (Some(backend_url), Some(auth_token)) = (
        context.backend_url.as_deref(),
        context.auth_token.as_deref(),
    ) else {
        return Err("Parent Issue reads require the existing project connection".to_owned());
    };
    let backend = BackendToolContext {
        backend_url,
        auth_token,
        project_id,
        grant: context.grant.as_ref(),
        collaboration_dispatcher: None,
    };
    let item = call_backend_tool(
        &backend,
        "get_board_item",
        &json!({"space_id": project_id, "item_id": item_id}),
    )
    .await?;
    let actual_project = item.get("cloud_project_id");
    let matches_project = actual_project.is_some_and(|value| {
        value.as_str() == Some(project_id)
            || value
                .as_u64()
                .is_some_and(|id| id.to_string() == project_id)
    });
    if !matches_project {
        return Err("The requested board item is outside this Agent session".to_owned());
    }
    Ok(item)
}
