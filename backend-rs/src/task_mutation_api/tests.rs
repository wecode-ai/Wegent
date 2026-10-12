// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Focused tests for the task mutation endpoints.
//!
//! Test fixtures build request and stored documents from JSON literals, the
//! same way the existing endpoint tests do.
use serde_json::{Value, json};

use super::delete_task;
use super::models::{TaskBulkDeleteRequest, TaskUpdateBody};
use super::socketio;
use super::task_crd;

fn update_body(value: Value) -> TaskUpdateBody {
    serde_json::from_value(value).expect("valid update body")
}

#[test]
fn bulk_request_rejects_empty_and_oversized_lists() {
    let empty = TaskBulkDeleteRequest { task_ids: vec![] };
    assert!(empty.validate().is_err());

    let too_many = TaskBulkDeleteRequest {
        task_ids: (0..51).collect(),
    };
    assert!(too_many.validate().is_err());

    let ok = TaskBulkDeleteRequest {
        task_ids: vec![1, 2],
    };
    assert!(ok.validate().is_ok());
}

#[test]
fn update_body_distinguishes_absent_from_null() {
    let body = update_body(json!({ "title": "t", "prompt": null }));
    assert!(body.title.is_present());
    assert_eq!(body.title.value().map(String::as_str), Some("t"));
    assert!(body.prompt.is_present());
    assert!(body.prompt.value().is_none());
    assert!(!body.status.is_present());
    assert!(!body.git_url.is_present());
}

#[test]
fn apply_update_sets_title_and_status_timestamp() {
    let mut task = json!({
        "kind": "Task",
        "spec": {"title": "old", "prompt": "p"},
        "status": {"state": "Available", "status": "COMPLETED", "progress": 100}
    });
    let body = update_body(json!({ "title": "new" }));
    task_crd::apply_update(&mut task, &body, "2026-10-07T15:17:15.255151");

    assert_eq!(task["spec"]["title"], json!("new"));
    assert_eq!(task["status"]["status"], json!("COMPLETED"));
    assert_eq!(
        task["status"]["updatedAt"],
        json!("2026-10-07T15:17:15.255151")
    );
    assert!(task["status"].get("completedAt").is_none());
}

#[test]
fn apply_update_blocks_final_to_non_final_transition() {
    let mut task = json!({
        "spec": {"title": "t", "prompt": "p"},
        "status": {"state": "Available", "status": "COMPLETED"}
    });
    let body = update_body(json!({ "status": "RUNNING" }));
    task_crd::apply_update(&mut task, &body, "2026-10-07T00:00:00.000000");
    assert_eq!(task["status"]["status"], json!("COMPLETED"));
}

#[test]
fn apply_update_records_completed_at_for_terminal_status() {
    let mut task = json!({
        "spec": {"title": "t", "prompt": "p"},
        "status": {"state": "Available", "status": "RUNNING"}
    });
    let body = update_body(json!({ "status": "COMPLETED" }));
    task_crd::apply_update(&mut task, &body, "2026-10-07T00:00:00.000000");
    assert_eq!(task["status"]["status"], json!("COMPLETED"));
    assert_eq!(
        task["status"]["completedAt"],
        json!("2026-10-07T00:00:00.000000")
    );
}

#[test]
fn dump_reorders_fields_and_drops_nulls() {
    let task = json!({
        "kind": "Task",
        "spec": {"title": "t", "prompt": "p", "teamRef": {"name": "t", "namespace": "d"},
                 "workspaceRef": {"name": "w", "namespace": "d"}, "is_group_chat": false},
        "metadata": {"name": "task-1", "labels": {"type": "online"}, "namespace": "default",
                     "displayName": null},
        "apiVersion": "agent.wecode.io/v1",
        "status": {"state": "Available", "status": "COMPLETED", "progress": 100,
                   "result": {"value": "x"}, "message": null, "subTasks": null,
                   "createdAt": "2026-01-01T00:00:00.000000",
                   "updatedAt": "2026-01-01T00:00:00.000000",
                   "completedAt": "2026-01-01T00:00:00.000000", "errorMessage": null}
    });
    let dumped: Value = serde_json::from_str(&task_crd::dump(&task)).expect("valid json");

    assert_eq!(
        dumped
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>()),
        Some(vec![
            "apiVersion".to_owned(),
            "kind".to_owned(),
            "metadata".to_owned(),
            "spec".to_owned(),
            "status".to_owned(),
        ])
    );
    assert!(
        !dumped["metadata"]
            .as_object()
            .is_some_and(|object| object.contains_key("displayName"))
    );
    assert_eq!(dumped["spec"]["externalKnowledgeRefs"], json!([]));
    assert_eq!(
        dumped["status"]
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>()),
        Some(vec![
            "state".to_owned(),
            "status".to_owned(),
            "progress".to_owned(),
            "result".to_owned(),
            "createdAt".to_owned(),
            "updatedAt".to_owned(),
            "completedAt".to_owned(),
        ])
    );
}

#[test]
fn delete_payload_sets_delete_status() {
    let task = json!({
        "kind": "Task",
        "spec": {"title": "t"},
        "status": {"state": "Available", "status": "RUNNING"}
    });
    let payload: Value =
        serde_json::from_str(&delete_task::mark_task_deleted_payload(&task)).expect("valid json");
    assert_eq!(payload["status"]["status"], json!("DELETE"));
    assert!(payload["status"]["updatedAt"].is_string());
}

#[test]
fn close_session_message_matches_socketio_emit_shape() {
    let message = socketio::close_session_message(157, "device-uuid", 42);
    let expected_prefix = "{\"method\": \"emit\", \"event\": \"task:close-session\", \
         \"data\": [{\"task_id\": 42}], \"binary\": false, \
         \"namespace\": \"/local-executor\", \"room\": \"device:157:device-uuid\", \
         \"skip_sid\": null, \"callback\": null, \"host_id\": \"";
    assert!(message.starts_with(expected_prefix), "{message}");
    let host_id = message
        .strip_prefix(expected_prefix)
        .and_then(|rest| rest.strip_suffix("\"}"))
        .expect("host_id suffix");
    assert_eq!(host_id.len(), 32);
    assert!(host_id.chars().all(|c| c.is_ascii_hexdigit()));
}

#[test]
fn cleanup_targets_deduplicate_repeated_executors() {
    use super::delete_task::{SubtaskExecutorRow, collect_cleanup_targets};

    let row = |namespace: Option<&str>, name: Option<&str>| SubtaskExecutorRow {
        executor_namespace: namespace.map(str::to_owned),
        executor_name: name.map(str::to_owned),
        executor_deleted_at: 0,
    };
    let (executors, devices) = collect_cleanup_targets(vec![
        row(None, Some("device-abc")),
        row(None, Some("device-abc")),
        row(Some("default"), Some("exec-1")),
        row(Some("default"), Some("exec-1")),
        row(Some("default"), Some("exec-2")),
        row(None, None),
    ]);

    assert_eq!(devices, vec!["abc".to_owned()]);
    assert_eq!(
        executors,
        vec![
            ("default".to_owned(), "exec-1".to_owned()),
            ("default".to_owned(), "exec-2".to_owned()),
        ]
    );
}
