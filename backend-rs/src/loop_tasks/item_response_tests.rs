// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the cloud-context `response_values` projection helpers.
use super::*;

fn metadata(value: serde_json::Value) -> ItemMetadata {
    serde_json::from_value(value).expect("metadata decodes")
}

#[test]
fn owner_permissions_match_the_source_hierarchy() {
    let permissions = issue_permissions("Owner", false);
    assert!(permissions.edit_content);
    assert!(permissions.comment);
    assert!(permissions.assign);
    assert!(permissions.execute);
}

#[test]
fn restricted_analyst_permissions_follow_the_role_and_creator() {
    // The role gates every action; with no creator override a RestrictedAnalyst
    // holds none.
    let permissions = issue_permissions("RestrictedAnalyst", false);
    assert!(!permissions.edit_content && !permissions.comment && !permissions.execute);
    assert!(!permissions.assign);
}

#[test]
fn reporter_cannot_edit_or_comment() {
    let permissions = issue_permissions("Reporter", false);
    assert!(!permissions.edit_content);
    assert!(!permissions.comment);
    assert!(!permissions.execute);
    assert!(!permissions.assign);
}

#[test]
fn only_the_creator_grants_assign_to_a_non_developer() {
    // `assign = is_developer or is_creator`: a Reporter keeps assign only when
    // they created the issue.
    assert!(issue_permissions("Reporter", true).assign);
    assert!(!issue_permissions("Reporter", false).assign);
    let developer = issue_permissions("Developer", false);
    assert!(developer.edit_content && developer.comment && developer.execute);
    assert!(developer.assign);
}

#[test]
fn content_revision_defaults_to_one() {
    assert_eq!(content_revision(&metadata(json!({}))), 1);
    assert_eq!(
        content_revision(&metadata(json!({"content_revision": 3}))),
        3
    );
    assert_eq!(
        content_revision(&metadata(json!({"content_revision": 0}))),
        1
    );
    assert_eq!(
        content_revision(&metadata(json!({"content_revision": "3"}))),
        1
    );
}

#[test]
fn is_unread_tracks_the_read_revision() {
    assert!(is_unread(&metadata(json!({})), 14));
    assert!(is_unread(
        &metadata(json!({"read_revisions": {"14": 0}})),
        14
    ));
    assert!(!is_unread(
        &metadata(json!({"content_revision": 2, "read_revisions": {"14": 2}})),
        14
    ));
}

#[test]
fn normalize_tags_trims_dedupes_and_caps() {
    let value = json!([" b ", "b", "a", ""]);
    assert_eq!(normalize_tags(Some(&value)), vec!["b", "a"]);
    assert!(normalize_tags(Some(&json!("not-a-list"))).is_empty());
    let long: Vec<serde_json::Value> = (0..30).map(|i| json!(format!("t{i}"))).collect();
    assert_eq!(normalize_tags(Some(&json!(long))).len(), 20);
}

#[test]
fn isoformat_matches_pydantic_serialization() {
    let value = NaiveDateTime::parse_from_str("2026-08-13 16:23:38", "%Y-%m-%d %H:%M:%S").ok();
    assert_eq!(isoformat(value), Some("2026-08-13T16:23:38".to_string()));
    assert_eq!(
        utc_datetime_string(value),
        Some("2026-08-13T08:23:38Z".to_string())
    );
    assert_eq!(utc_datetime_string(None), None);
    assert_eq!(
        isoformat_unset(
            NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S").ok()
        ),
        None
    );
}

fn execution(status: &str, sync: Option<&str>, observed: Option<&str>) -> ExecutionFullRow {
    ExecutionFullRow {
        id: 1,
        agent_id: None,
        team_id: None,
        status: Some(status.to_string()),
        observed_state: observed.map(str::to_string),
        sync_state: sync.map(str::to_string),
        attempt_no: None,
        last_event_seq: None,
        queued_at: None,
        started_at: None,
        completed_at: None,
        lease_expires_at: None,
        heartbeat_at: None,
        error_message: None,
        execution_note: None,
        approval_status: None,
        approved_by_user_id: None,
        approved_at: None,
        rejected_reason: None,
        runtime_device_id: None,
        runtime_task_id: None,
        updated_at: None,
    }
}

#[test]
fn display_state_follows_the_execution_truth() {
    assert_eq!(
        display_state(&execution("completed", None, None)),
        "succeeded"
    );
    assert_eq!(display_state(&execution("failed", None, None)), "failed");
    assert_eq!(
        display_state(&execution("running", Some("stale"), None)),
        "unknown"
    );
    assert_eq!(
        display_state(&execution("running", None, Some("running"))),
        "running"
    );
    assert_eq!(
        display_state(&execution("claimed", None, Some("unconfirmed"))),
        "starting"
    );
    assert_eq!(display_state(&execution("queued", None, None)), "queued");
}

#[test]
fn approval_view_sets_only_the_active_status_fields() {
    let mut row = execution("running", None, None);
    row.approval_status = Some("pending".to_string());
    let view = approval_view(&row).expect("approval view");
    assert_eq!(view["status"], "pending");
    assert!(view.get("requested_at").is_some());
    assert!(view.get("approved_by_user_id").is_none());

    row.approval_status = Some("rejected".to_string());
    row.rejected_reason = Some("nope".to_string());
    let view = approval_view(&row).expect("approval view");
    assert_eq!(view["rejected_reason"], "nope");
    assert!(view.get("requested_at").is_none());

    row.approval_status = Some(String::new());
    assert!(approval_view(&row).is_none());
}

fn response_fixture() -> LoopItemResponse {
    LoopItemResponse {
        id: "REMOTEHI2E7B57-2".to_string(),
        cloud_project_id: "4132140824159326414".to_string(),
        sequence_number: 2,
        parent_id: None,
        title: "t".to_string(),
        description: "d".to_string(),
        status: "in_review".to_string(),
        assignee_user_id: Some(14),
        assignee_group_id: None,
        assignee_group_name: None,
        assignee_name: Some("xiaozhou5".to_string()),
        assignee_agent_id: None,
        assignee_agent_name: None,
        assignee_team_id: None,
        assignee_team_name: None,
        ai_state: None,
        execution_id: None,
        execution_state: None,
        execution_control_state: None,
        execution_observed_state: None,
        execution_sync_state: None,
        execution_attempt_no: None,
        execution_last_event_seq: None,
        can_approve: false,
        assignment_history: Vec::new(),
        status_history: Vec::new(),
        approval: None,
        human_task_binding: None,
        queued_at: None,
        execution_note: None,
        execution_error: None,
        automation: None,
        workflow: None,
        execution_config: None,
        priority: "none".to_string(),
        start_at: None,
        due_at: None,
        sort_order: 0,
        tags: Vec::new(),
        created_by_user_id: 14,
        created_by_user_name: None,
        can_view_detail: true,
        security_level: "open",
        can_edit: true,
        permissions: Permissions {
            edit_content: true,
            comment: true,
            assign: true,
            execute: true,
        },
        detail_loaded: true,
        content_revision: 1,
        activity_read_sequence: 0,
        is_unread: true,
        current_delivery_id: None,
        version: 2,
        created_at: "2026-08-13T16:23:38".to_string(),
        updated_at: "2026-08-13T17:56:14".to_string(),
        completed_at: None,
    }
}

#[test]
fn response_serializes_all_fields_with_nulls() {
    let value = serde_json::to_value(response_fixture()).expect("serializes");
    assert_eq!(value["assignee_user_id"], 14);
    assert_eq!(value["assignee_name"], "xiaozhou5");
    assert_eq!(value["detail_loaded"], true);
    assert_eq!(value["permissions"]["assign"], true);
    assert_eq!(value["human_task_binding"], Value::Null);
    assert!(value.get("human_work").is_none());
    // 54 declared fields, matching the recorded source schema.
    assert_eq!(value.as_object().expect("object").len(), 54);
}

#[test]
fn workflow_view_aliases_workspace_binding_and_defaults_execution_error() {
    // The stored metadata keeps snake_case `workspace_binding` keys and omits
    // the defaulted node `execution_error`; the schema re-serialization emits
    // the `ProjectChatWorkspaceBinding` camel-case aliases and the null.
    let workflow = json!({
        "version": 7,
        "nodes": [{
            "id": "step-1",
            "collectors": {},
            "execution_config": {
                "model": "deepseek",
                "workspace_binding": {
                    "type": "standalone",
                    "device_id": null,
                    "project_id": null,
                    "device_workspace_id": null,
                    "runtime_project_key": null
                }
            }
        }]
    });
    let view = workflow_view(&workflow);
    let node = &view["nodes"][0];
    let binding = &node["execution_config"]["workspace_binding"];
    assert_eq!(binding["type"], json!("standalone"));
    for key in [
        "projectId",
        "deviceWorkspaceId",
        "deviceId",
        "runtimeProjectKey",
    ] {
        assert!(binding.get(key).is_some(), "{key} must be present");
        assert!(binding[key].is_null(), "{key} must be null");
    }
    assert!(binding.get("device_id").is_none());
    assert!(node.get("execution_error").is_some());
    assert!(node["execution_error"].is_null());
}

#[test]
fn workflow_view_preserves_alias_keys_and_stored_execution_error() {
    let workflow = json!({
        "execution_config": {
            "workspace_binding": {"type": "backend_project", "projectId": 5}
        },
        "nodes": [{
            "id": "step-1",
            "execution_error": "boom",
            "execution_config": {
                "workspace_binding": {"type": "device_project", "deviceId": "d"}
            }
        }]
    });
    let view = workflow_view(&workflow);
    assert_eq!(
        view["execution_config"]["workspace_binding"]["projectId"],
        json!(5)
    );
    assert_eq!(
        view["nodes"][0]["execution_config"]["workspace_binding"]["deviceId"],
        json!("d")
    );
    assert_eq!(view["nodes"][0]["execution_error"], json!("boom"));
}

#[test]
fn response_exposes_the_new_binding_contract_in_every_issue_status() {
    let identity = json!({
        "humanAssignmentId": "0cc4f520-a9bf-560e-a89a-422ae4dc4b05",
        "dispatchId": "direct-human:1000000000000000003",
        "dispatchRoundId": "direct",
        "assignmentId": "1000000000000000003",
    });
    for status in ["inbox", "pending", "in_progress", "in_review", "completed"] {
        let mut response = response_fixture();
        response.status = status.to_string();
        response.human_task_binding = Some(identity.clone());
        let value = serde_json::to_value(response).expect("serializes");
        assert_eq!(value["human_task_binding"], identity);
        assert_eq!(value["status"], status);
        assert!(value.get("human_work").is_none());
    }
}
