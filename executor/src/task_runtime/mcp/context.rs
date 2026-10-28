// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

pub(super) fn space_context_grant(
    request: &ExecutionRequest,
) -> Result<Option<SpaceContextGrant>, String> {
    let origin = request.extra.get("origin").and_then(Value::as_object);
    let origin_value = |camel: &str, snake: &str| {
        origin.and_then(|value| value.get(camel).or_else(|| value.get(snake)))
    };
    let role_value = origin_value("dispatchRole", "dispatch_role");
    let role = role_value
        .and_then(Value::as_str)
        .and_then(space_context_role);
    let dispatch_id = origin_value("dispatchId", "dispatch_id").and_then(id_value);
    let dispatched = role_value.is_some()
        || dispatch_id.is_some()
        || origin.is_some_and(|value| {
            value.get("type").and_then(Value::as_str) == Some("issue_dispatch")
        });
    if dispatched && role.is_none() {
        return Err("Issue dispatch requires a valid manager or executor role".to_owned());
    }
    let space_id = request
        .extra
        .get("cloudProjectId")
        .or_else(|| request.extra.get("cloud_project_id"))
        .and_then(id_value)
        .or_else(|| origin_value("cloudProjectId", "cloud_project_id").and_then(id_value));
    let item_id = origin_value("loopItemId", "loop_item_id").and_then(id_value);
    if dispatched && (space_id.is_none() || item_id.is_none()) {
        return Err("Issue dispatch requires a bound project space and board item".to_owned());
    }
    let Some(space_id) = space_id else {
        return Ok(None);
    };
    let device_id = request
        .extra
        .get("executionDeviceId")
        .or_else(|| request.extra.get("execution_device_id"))
        .and_then(id_value)
        .or_else(|| {
            request
                .device_id
                .clone()
                .filter(|value| !value.trim().is_empty())
        });
    Ok(Some(SpaceContextGrant {
        version: 1,
        task_id: request.task_id.clone(),
        space_id: Some(space_id),
        item_id,
        device_id,
        dispatch_id,
        manager_agent_id: origin_value("managerAgentId", "manager_agent_id").and_then(id_value),
        automation_run_id: None,
        role,
        categories: role
            .map(role_categories)
            .unwrap_or_default()
            .iter()
            .copied()
            .collect(),
        expires_at_unix: Local::now().timestamp() + SPACE_CONTEXT_GRANT_TTL_SECONDS,
    }))
}

fn space_context_role(value: &str) -> Option<SpaceContextRole> {
    match value.trim() {
        "manager" | "leader" | "manager_review" => Some(SpaceContextRole::Manager),
        "executor" | "member" | "worker" => Some(SpaceContextRole::Executor),
        _ => None,
    }
}

pub(super) fn role_categories(role: SpaceContextRole) -> &'static [BoardToolCategory] {
    match role {
        SpaceContextRole::Manager => &[BoardToolCategory::Management, BoardToolCategory::Execution],
        SpaceContextRole::Executor => &[BoardToolCategory::Execution],
    }
}

fn id_value(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.trim().to_owned()).filter(|value| !value.is_empty()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_dispatch_context_never_becomes_a_personal_context() {
        for role in [
            json!("executor"),
            json!("manager"),
            json!("unknown"),
            Value::Null,
        ] {
            for (space, item) in [
                (None, None),
                (Some("space-1"), None),
                (None, Some("issue-1")),
            ] {
                let mut request = ExecutionRequest::default();
                request.extra.insert(
                    "origin".into(),
                    json!({
                        "type": "issue_dispatch", "dispatchRole": role,
                        "cloudProjectId": space, "loopItemId": item,
                    }),
                );
                assert!(
                    space_context_grant(&request).is_err(),
                    "{}",
                    request.extra["origin"]
                );
                assert!(space_mcp_client_config(&request).is_err());
            }
        }
        for origin in [
            json!({"type":"issue_dispatch", "cloudProjectId":"space-1", "loopItemId":"issue-1"}),
            json!({"dispatch_role":"unknown", "cloudProjectId":"space-1", "loopItemId":"issue-1"}),
            json!({"dispatch_id":"dispatch-1", "cloudProjectId":"space-1", "loopItemId":"issue-1"}),
        ] {
            let mut request = ExecutionRequest::default();
            request.extra.insert("origin".into(), origin);
            assert!(space_context_grant(&request).is_err());
        }
    }
}
