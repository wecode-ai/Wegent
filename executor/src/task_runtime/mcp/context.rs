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
    let has_role = role_value.is_some_and(|value| !value.is_null());
    let role = role_value
        .and_then(Value::as_str)
        .and_then(space_context_role);
    let dispatch_id = origin_value("dispatchId", "dispatch_id").and_then(id_value);
    // Stand-in identity is checked against the owned conversation before execution.
    // Assignment and dispatch IDs correlate work without defining its authority.
    let human_assignment = origin_value("humanAssignmentId", "human_assignment_id")
        .and_then(id_value)
        .is_some();
    // Match the canonical identity fields validated by the conversation handler.
    let stand_in_conversation = origin
        .and_then(|value| value.get("initiatedBy"))
        .and_then(Value::as_str)
        == Some("stand_in")
        && origin.and_then(|value| value.get("publicConversation")) == Some(&Value::Bool(true))
        && origin
            .and_then(|value| value.get("standInId"))
            .and_then(id_value)
            .is_some()
        && origin
            .and_then(|value| value.get("userId"))
            .and_then(Value::as_i64)
            .is_some()
        && origin.is_some_and(|value| {
            value.get("type").and_then(Value::as_str) == Some("issue_dispatch")
        });
    let dispatched = has_role
        || (!human_assignment
            && !stand_in_conversation
            && (dispatch_id.is_some()
                || origin.is_some_and(|value| {
                    value.get("type").and_then(Value::as_str) == Some("issue_dispatch")
                })));
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
    if (dispatched || stand_in_conversation) && (space_id.is_none() || item_id.is_none()) {
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
        assignment_id: origin_value("assignmentId", "assignment_id").and_then(id_value),
        human_assignment_id: origin_value("humanAssignmentId", "human_assignment_id")
            .and_then(id_value),
        human_automation: origin
            .and_then(|origin| origin.get("human_automation"))
            .filter(|context| context.is_object())
            .cloned(),
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
    fn delivery_identity_is_frozen_in_the_execution_grant() {
        let context = json!({"automation_run_id":"run-a","human_assignment_id":"human-a",
            "assignment_id":"assignment-a","idempotency_key":"run-a:human-a"});
        let mut request = ExecutionRequest {
            task_id: "reused-personal-task".into(),
            device_id: Some("device".into()),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "origin".into(),
            json!({"cloudProjectId":"project",
            "loopItemId":"issue","humanAssignmentId":"human-a","assignmentId":"assignment-a",
            "human_automation":context}),
        );
        let grant = space_context_grant(&request).unwrap().unwrap();
        let mut next_request = request.clone();
        next_request.extra.get_mut("origin").unwrap()["human_automation"] = json!({
            "automation_run_id":"run-b","idempotency_key":"run-b:human-b"});
        let next_grant = space_context_grant(&next_request).unwrap().unwrap();
        assert_ne!(grant.human_automation, next_grant.human_automation);
        let address = delivery_address(Some(&grant)).unwrap();
        let source = delivery_source_task(Some(&grant), &address);
        assert_eq!(source["deviceId"], "device");
        assert_eq!(source["taskId"], "reused-personal-task");
        assert_eq!(source["assignmentId"], "assignment-a");
        assert_eq!(source["humanAssignmentId"], "human-a");
        assert_eq!(source["executionContext"]["human_automation"], context);
        assert_eq!(
            address.execution_context.unwrap()["human_automation"],
            context
        );
    }

    #[test]
    fn stale_execution_identity_cannot_mutate_a_draft_after_task_reuse() {
        let context = json!({"automation_run_id":"run-a","human_assignment_id":"human-a",
            "assignment_id":"assignment-a","idempotency_key":"run-a:human-a"});
        let grant = SpaceContextGrant {
            task_id: "reused-task".into(),
            device_id: Some("device".into()),
            human_automation: Some(context.clone()),
            ..SpaceContextGrant::default()
        };
        let mut address = delivery_address(Some(&grant)).unwrap();
        let mut draft = json!({"loop_item_id":"issue","status":"draft",
            "source_task_snapshot":{"deviceId":"device","taskId":"reused-task",
                "humanAutomation":context}});
        assert!(delivery_scope_error(&draft, &address, "issue").is_none());
        for key in [
            "automation_run_id",
            "human_assignment_id",
            "assignment_id",
            "idempotency_key",
        ] {
            let mut newer = draft.clone();
            newer["source_task_snapshot"]["humanAutomation"][key] = json!("new-assignment");
            assert!(delivery_scope_error(&newer, &address, "issue").is_some());
        }
        address.execution_context = None;
        assert!(delivery_scope_error(&draft, &address, "issue").is_some());
        draft["source_task_snapshot"]
            .as_object_mut()
            .unwrap()
            .remove("humanAutomation");
        assert!(delivery_scope_error(&draft, &address, "issue").is_none());
        address.execution_context = Some(json!({"human_automation":context}));
        assert!(delivery_scope_error(&draft, &address, "issue").is_some());
    }

    #[test]
    fn automation_requirements_use_the_grant_snapshot_and_reject_reused_bindings() {
        let context = json!({"automation_run_id":"run","human_assignment_id":"human",
            "assignment_id":"assignment","idempotency_key":"run:human","workflow_stage_id":"ux_spec",
            "required_deliverables":[{"id":"frozen-file","value_type":"file"}],"non_workflow":false});
        let grant = SpaceContextGrant {
            task_id: "task".into(),
            device_id: Some("device".into()),
            human_automation: Some(context.clone()),
            ..SpaceContextGrant::default()
        };
        let address = delivery_address(Some(&grant)).unwrap();
        let binding = json!({"human_automation":context});
        let requirements = automation_delivery_requirements(&address, Some(&binding))
            .unwrap()
            .unwrap();
        assert_eq!(requirements["workflow_stage_id"], "ux_spec");
        assert_eq!(
            requirements["required_deliverables"],
            context["required_deliverables"]
        );
        let mut changed_binding = binding.clone();
        changed_binding["human_automation"]["workflow_stage_id"] = json!("implementation");
        changed_binding["human_automation"]["required_deliverables"] = json!([]);
        assert_eq!(
            automation_delivery_requirements(&address, Some(&changed_binding)).unwrap(),
            Some(requirements)
        );
        changed_binding["human_automation"]["idempotency_key"] = json!("new-run:human");
        assert!(automation_delivery_requirements(&address, Some(&changed_binding)).is_err());
    }

    #[test]
    fn project_automation_null_dispatch_fields_do_not_declare_an_agent_role() {
        let mut request = ExecutionRequest::default();
        request.extra.insert(
            "origin".into(),
            json!({
                "type":"project_automation", "cloudProjectId":"space-1", "loopItemId":"issue-1",
                "dispatchId":null, "dispatchRole":null
            }),
        );
        let grant = space_context_grant(&request).unwrap().unwrap();
        assert_eq!(grant.space_id.as_deref(), Some("space-1"));
        assert_eq!(grant.item_id.as_deref(), Some("issue-1"));
        assert!(grant.role.is_none());
        assert!(grant.categories.is_empty());
    }

    #[test]
    fn human_assignments_keep_personal_authority_without_masking_agent_roles() {
        for role_key in ["dispatchRole", "dispatch_role"] {
            for human_key in ["humanAssignmentId", "human_assignment_id"] {
                let mut origin = json!({
                    "type":"issue_dispatch", "cloudProjectId":"space-1",
                    "loopItemId":"issue-1", "dispatchId":"dispatch-1",
                    human_key:"human-1"
                });
                for role in [
                    None,
                    Some(Value::Null),
                    Some(json!("executor")),
                    Some(json!("unknown")),
                ] {
                    origin.as_object_mut().unwrap().remove(role_key);
                    if let Some(role) = role {
                        origin[role_key] = role;
                    }
                    let mut request = ExecutionRequest::default();
                    request.extra.insert("origin".into(), origin.clone());
                    let grant = space_context_grant(&request);
                    if origin[role_key] == "unknown" {
                        assert!(grant.is_err());
                    } else {
                        let grant = grant.unwrap().unwrap();
                        assert_eq!(grant.space_id.as_deref(), Some("space-1"));
                        assert_eq!(grant.item_id.as_deref(), Some("issue-1"));
                        assert_eq!(
                            grant.role,
                            if origin[role_key] == "executor" {
                                Some(SpaceContextRole::Executor)
                            } else {
                                None
                            }
                        );
                        assert_eq!(grant.categories.is_empty(), grant.role.is_none());
                    }
                }
            }
        }
    }

    #[test]
    fn stand_in_conversations_keep_personal_scope_without_assignment() {
        let origin = json!({
            "type":"issue_dispatch", "initiatedBy":"stand_in", "publicConversation":true,
            "standInId":"review", "userId":7, "cloudProjectId":"space-1",
            "loopItemId":"issue-1", "dispatchId":"historical-dispatch"
        });
        for role in [
            Value::Null,
            json!("executor"),
            json!("manager"),
            json!("unknown"),
        ] {
            let mut request = ExecutionRequest::default();
            request.extra.insert("origin".into(), origin.clone());
            request.extra.get_mut("origin").unwrap()["dispatchRole"] = role.clone();
            let grant = space_context_grant(&request);
            if role == "unknown" {
                assert!(grant.is_err());
            } else {
                let grant = grant.unwrap().unwrap();
                assert_eq!(grant.space_id.as_deref(), Some("space-1"));
                assert_eq!(grant.item_id.as_deref(), Some("issue-1"));
                assert_eq!(grant.dispatch_id.as_deref(), Some("historical-dispatch"));
                assert_eq!(grant.role, role.as_str().and_then(space_context_role));
                assert_eq!(grant.categories.is_empty(), role.is_null());
                assert!(space_mcp_client_config(&request).is_ok());
            }
        }
        for field in [
            "publicConversation",
            "standInId",
            "userId",
            "cloudProjectId",
            "loopItemId",
        ] {
            let mut request = ExecutionRequest::default();
            let mut missing = origin.clone();
            missing.as_object_mut().unwrap().remove(field);
            request.extra.insert("origin".into(), missing);
            assert!(space_context_grant(&request).is_err(), "{field}");
        }
    }

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

    #[test]
    fn stand_in_identity_aliases_cannot_bypass_conversation_authorization() {
        for (canonical, alias) in [
            ("initiatedBy", "initiated_by"),
            ("publicConversation", "public_conversation"),
            ("standInId", "stand_in_id"),
            ("userId", "user_id"),
        ] {
            let mut origin = json!({
                "type":"issue_dispatch", "initiatedBy":"stand_in", "publicConversation":true,
                "standInId":"review", "userId":7, "cloudProjectId":"space-1", "loopItemId":"issue-1"
            });
            let value = origin.as_object_mut().unwrap().remove(canonical).unwrap();
            origin[alias] = value;
            let mut request = ExecutionRequest::default();
            request.extra.insert("origin".into(), origin);
            assert!(space_context_grant(&request).is_err(), "{alias}");
            assert!(space_mcp_client_config(&request).is_err(), "{alias}");
        }
    }
}
