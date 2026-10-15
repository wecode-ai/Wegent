// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shape guards for the `human_issue_work_service.view` projection.

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
fn can_start_matches_the_source_branches() {
    let work = json!({"assignment_id": "a", "state": "none"});
    let work = work.as_object();
    assert!(can_start(Some("inbox"), "a", work));
    assert!(can_start(Some("pending"), "a", work));
    assert!(!can_start(Some("in_progress"), "a", work));
    // A reassignment that has not been started under the current assignment.
    assert!(can_start(Some("in_review"), "b", work));
    assert!(can_start(Some("in_review"), "a", None));
    // Same assignment already has a non-`none` state.
    let started = json!({"assignment_id": "a", "state": "submitted"});
    assert!(!can_start(Some("completed"), "a", started.as_object()));
}

#[test]
fn work_value_preserves_present_nulls() {
    let work = json!({"result": "", "submission_message_id": null, "state": "accepted"});
    let work = work.as_object();
    assert_eq!(work_value(work, "result"), Some(json!("")));
    assert_eq!(work_value(work, "submission_message_id"), Some(Value::Null));
    assert_eq!(work_value(work, "missing"), None);
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
fn ai_task_binding_uses_the_direct_human_identity() {
    let binding = ai_task_binding("EXAMPLE-10", "1000000000000000003");
    assert_eq!(
        binding["humanAssignmentId"],
        "0cc4f520-a9bf-560e-a89a-422ae4dc4b05"
    );
    assert_eq!(binding["dispatchId"], "direct-human:1000000000000000003");
    assert_eq!(binding["dispatchRoundId"], "direct");
    assert_eq!(binding["assignmentId"], "1000000000000000003");
}
