// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Contract tests for status-independent human task identities.

use super::*;
use crate::loop_tasks::loop_repository::CommentRow;
use brz_json::JsonProjection;
use brz_mysql::Json;
use serde_json::json;

fn comment(id: &str, created_by_user_id: Option<i32>, metadata: serde_json::Value) -> CommentRow {
    CommentRow {
        id: id.to_string(),
        loop_item_id: Some("EXAMPLE-10".to_string()),
        description: Some(String::new()),
        created_by_user_id,
        created_at: None,
        updated_at: None,
        metadata: Some(Json(JsonProjection::from(metadata))),
    }
}

fn human_assign(id: &str, target_id: &str) -> CommentRow {
    comment(
        id,
        Some(86),
        json!({
            "event_type": "assignment",
            "action": "assign",
            "target_type": "human",
            "target_id": target_id,
            "workflow_step": "",
            "trigger": "manual",
        }),
    )
}

#[test]
fn accepts_a_single_direct_human_assignment() {
    let comments = vec![human_assign("1000000000000000003", "52")];
    let events = active_events(&comments);
    assert_eq!(events.len(), 1);
    assert!(direct_human_assignment(&events[0], Some(52)));
}

#[test]
fn rejects_a_non_human_target_type() {
    let comments = vec![comment(
        "1",
        Some(86),
        json!({
            "event_type": "assignment",
            "action": "assign",
            "target_type": "user",
            "target_id": "52",
            "trigger": "manual",
        }),
    )];
    let events = active_events(&comments);
    assert!(!direct_human_assignment(&events[0], Some(52)));
}

#[test]
fn rejects_a_default_trigger_or_a_workflow_step() {
    let defaulted = vec![comment(
        "1",
        Some(86),
        json!({
            "event_type": "assignment",
            "action": "assign",
            "target_type": "human",
            "target_id": "52",
            "trigger": "default",
        }),
    )];
    assert!(!direct_human_assignment(
        &active_events(&defaulted)[0],
        Some(52)
    ));

    let stepped = vec![comment(
        "1",
        Some(86),
        json!({
            "event_type": "assignment",
            "action": "assign",
            "target_type": "human",
            "target_id": "52",
            "workflow_step": "review",
            "trigger": "manual",
        }),
    )];
    assert!(!direct_human_assignment(
        &active_events(&stepped)[0],
        Some(52)
    ));
}

#[test]
fn rejects_a_mismatched_assignee() {
    let comments = vec![human_assign("1", "52")];
    assert!(!direct_human_assignment(
        &active_events(&comments)[0],
        Some(53)
    ));
    assert!(!direct_human_assignment(&active_events(&comments)[0], None));
}

#[test]
fn uuid5_matches_python_namespace_url() {
    assert_eq!(
        direct_human_assignment_id("EXAMPLE-10", "1000000000000000003"),
        "0cc4f520-a9bf-560e-a89a-422ae4dc4b05"
    );
    assert_eq!(
        direct_human_assignment_id("x", "1"),
        "6929f305-63fe-5dce-8f52-375a868b2449"
    );
}

#[test]
fn direct_task_binding_uses_the_direct_human_identity() {
    let binding = direct_task_binding("EXAMPLE-10", "1000000000000000003");
    assert_eq!(
        binding["humanAssignmentId"],
        "0cc4f520-a9bf-560e-a89a-422ae4dc4b05"
    );
    assert_eq!(binding["dispatchId"], "direct-human:1000000000000000003");
    assert_eq!(binding["dispatchRoundId"], "direct");
    assert_eq!(binding["assignmentId"], "1000000000000000003");
}

fn round_metadata() -> Value {
    json!({
        "activity_type": "manager_assignment",
        "dispatch_id": "dispatch-1",
        "coordination_round_id": "round-1",
        "dispatch_assignments": [null, "invalid", {
            "assignee_type": "human",
            "human_user_id": "52",
            "human_assignment_id": "human-1",
            "assignment_id": "member-1",
        }],
    })
}

#[test]
fn round_binding_preserves_the_complete_manager_identity() {
    for user_id in [json!("52"), json!(52)] {
        let mut metadata = round_metadata();
        metadata["dispatch_assignments"][2]["human_user_id"] = user_id;
        assert_eq!(
            round_task_binding([&metadata].into_iter(), 52),
            Some(json!({
                "humanAssignmentId": "human-1",
                "assignmentId": "member-1",
                "dispatchId": "dispatch-1",
                "dispatchRoundId": "round-1",
            }))
        );
        assert_eq!(round_task_binding([&metadata].into_iter(), 53), None);
    }
}

#[test]
fn round_binding_requires_all_four_identity_fields() {
    for key in [
        "human_assignment_id",
        "assignment_id",
        "dispatch_id",
        "coordination_round_id",
    ] {
        for invalid in [Value::Null, json!(""), json!(false)] {
            let mut metadata = round_metadata();
            if matches!(key, "human_assignment_id" | "assignment_id") {
                metadata["dispatch_assignments"][2][key] = invalid;
            } else {
                metadata[key] = invalid;
            }
            assert_eq!(round_task_binding([&metadata].into_iter(), 52), None);
        }
    }
}

#[test]
fn incomplete_or_unrelated_latest_round_never_uses_an_older_identity() {
    let older = round_metadata();
    for members in [
        Value::Null,
        json!({}),
        json!([]),
        json!([{
            "assignee_type": "human", "human_user_id": "53",
            "human_assignment_id": "other", "assignment_id": "other",
        }]),
    ] {
        let mut latest = round_metadata();
        latest["dispatch_assignments"] = members;
        assert_eq!(round_task_binding([&latest, &older].into_iter(), 52), None);
    }
}

#[test]
fn round_binding_skips_non_manager_activity_and_unstructured_metadata() {
    let manager = round_metadata();
    let values = [
        Value::Null,
        json!([]),
        json!("legacy"),
        json!({}),
        json!({"activity_type": "comment"}),
        manager.clone(),
    ];
    assert_eq!(
        round_task_binding(values.iter(), 52),
        round_task_binding([&manager].into_iter(), 52)
    );
}
