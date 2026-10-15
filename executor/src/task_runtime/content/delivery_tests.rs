// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{RuntimeTaskAddress, TaskCreate};

const DEFAULT_WORK_ITEM_PROJECT_ID: &str = "default-work-items";

fn task(store: &LocalTaskStore, parent_id: Option<&str>) -> String {
    store
        .create_task(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            TaskCreate {
                title: "Delivery target".to_owned(),
                description: String::new(),
                status: "pending".to_owned(),
                priority: "none".to_owned(),
                parent_id: parent_id.map(ToOwned::to_owned),
                tags: Vec::new(),
                assignee_user_id: None,
                assignee_agent_id: None,
                assignee_group_id: None,
                workflow: None,
            },
        )
        .unwrap()
        .id
}

fn human_assignment(store: &LocalTaskStore, issue_id: &str) -> String {
    let id = task(store, Some(issue_id));
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET metadata = ?1 WHERE id = ?2",
            params![
                json!({"collaboration_assignment": {"assignee_type": "human"}}).to_string(),
                id
            ],
        )
        .unwrap();
    id
}

fn finalize_from_issue(
    store: &LocalTaskStore,
    issue_id: &str,
    bound: bool,
    payload: Option<&str>,
    explicit_assignment: Option<&str>,
) -> Delivery {
    let source_task = bound.then(|| RuntimeTaskAddress {
        device_id: "device-1".to_owned(),
        task_id: "runtime-1".to_owned(),
        task_title: None,
        backend_task_id: None,
        model_selection: None,
        execution_context: None,
        workflow_node_id: None,
    });
    if let Some(address) = source_task.as_ref() {
        let context = explicit_assignment.map(|id| json!({"humanAssignmentId": id}));
        store
            .bind_task(
                DEFAULT_WORK_ITEM_PROJECT_ID,
                Some(issue_id),
                None,
                address.clone(),
                context.as_ref(),
            )
            .unwrap();
    }
    if let Some(payload) = payload {
        store
            .connection()
            .unwrap()
            .execute(
                "INSERT INTO loop_item_executions (
                    loop_item_id, cloud_project_id, agent_id, runtime_device_id,
                    runtime_task_id, execution_payload, created_at, updated_at
                 ) VALUES (?1, ?2, 'agent-1', 'device-1', 'runtime-1', ?3, ?4, ?4)",
                params![issue_id, DEFAULT_WORK_ITEM_PROJECT_ID, payload, now()],
            )
            .unwrap();
    }
    let delivery = store
        .create_delivery(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            issue_id,
            true,
            DeliveryCreate {
                markdown: "Delivery evidence".to_owned(),
                chat: None,
                source_task,
            },
        )
        .unwrap();
    store
        .finalize_delivery(issue_id, &delivery.id, DeliveryFinalize::default())
        .unwrap()
}

#[test]
fn unrelated_deliveries_do_not_complete_the_open_human_assignment() {
    for (bound, payload) in [
        (false, None),
        (true, Some(r#"{"message":"Ordinary AI work"}"#)),
        (true, Some(r#"{"dispatch_role":"member"}"#)),
        (true, Some("null")),
        (true, Some("invalid JSON")),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
        let issue_id = task(&store, None);
        let human_id = human_assignment(&store, &issue_id);

        let delivery = finalize_from_issue(&store, &issue_id, bound, payload, None);

        let human = store.get_item(&human_id, "task").unwrap();
        assert_eq!(delivery.status, "delivered");
        assert_eq!(human.status.as_deref(), Some("pending"), "{payload:?}");
        assert!(human.current_delivery_id.is_none(), "{payload:?}");
    }
}

#[test]
fn personal_task_without_execution_payload_completes_the_only_human_assignment() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let human_id = human_assignment(&store, &issue_id);

    let delivery = finalize_from_issue(&store, &issue_id, true, None, None);

    let human = store.get_item(&human_id, "task").unwrap();
    assert_eq!(human.status.as_deref(), Some("completed"));
    assert_eq!(
        human.current_delivery_id.as_deref(),
        Some(delivery.id.as_str())
    );
}

#[test]
fn explicit_human_assignment_identity_takes_priority_over_execution_payload() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let human_id = human_assignment(&store, &issue_id);
    let other_human_id = human_assignment(&store, &issue_id);

    let delivery = finalize_from_issue(&store, &issue_id, true, Some("{}"), Some(&human_id));

    let human = store.get_item(&human_id, "task").unwrap();
    assert_eq!(
        human.current_delivery_id.as_deref(),
        Some(delivery.id.as_str())
    );
    assert_eq!(human.status.as_deref(), Some("completed"));
    assert_eq!(
        store
            .get_item(&other_human_id, "task")
            .unwrap()
            .status
            .as_deref(),
        Some("pending")
    );
}

#[test]
fn personal_task_does_not_guess_between_multiple_open_human_assignments() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let human_ids = [
        human_assignment(&store, &issue_id),
        human_assignment(&store, &issue_id),
    ];

    finalize_from_issue(&store, &issue_id, true, None, None);

    for id in human_ids {
        assert_eq!(
            store.get_item(&id, "task").unwrap().status.as_deref(),
            Some("pending")
        );
    }
}

#[test]
fn later_delivery_does_not_replace_a_completed_assignment_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let human_id = human_assignment(&store, &issue_id);
    let first = finalize_from_issue(&store, &issue_id, true, None, Some(&human_id));
    let before = store.get_item(&human_id, "task").unwrap();

    let second = finalize_from_issue(&store, &issue_id, true, None, Some(&human_id));

    let after = store.get_item(&human_id, "task").unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(
        after.current_delivery_id.as_deref(),
        Some(first.id.as_str())
    );
    assert_eq!(after.version, before.version);
    assert_eq!(after.completed_at, before.completed_at);
}

#[test]
fn delivery_cannot_settle_another_issues_human_assignment() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let other_issue = task(&store, None);
    let human_id = human_assignment(&store, &other_issue);

    finalize_from_issue(&store, &issue_id, true, None, Some(&human_id));

    let human = store.get_item(&human_id, "task").unwrap();
    assert_eq!(human.status.as_deref(), Some("pending"));
    assert!(human.current_delivery_id.is_none());
}

#[test]
fn repeated_delivery_directly_to_a_completed_human_assignment_is_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let human_id = human_assignment(&store, &issue_id);
    let first = finalize_from_issue(&store, &human_id, false, None, None);
    let next = store
        .create_delivery(
            DEFAULT_WORK_ITEM_PROJECT_ID,
            &human_id,
            true,
            DeliveryCreate {
                markdown: "Another delivery".to_owned(),
                chat: None,
                source_task: None,
            },
        )
        .unwrap();

    assert!(store
        .finalize_delivery(&human_id, &next.id, DeliveryFinalize::default())
        .is_err());
    assert_eq!(
        store.get_delivery(&human_id, &next.id).unwrap().status,
        "draft"
    );
    assert_eq!(
        store
            .get_item(&human_id, "task")
            .unwrap()
            .current_delivery_id
            .as_deref(),
        Some(first.id.as_str())
    );
}

#[test]
fn delivery_on_human_assignment_needs_no_source_binding() {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("tasks.sqlite")).unwrap();
    let issue_id = task(&store, None);
    let human_id = human_assignment(&store, &issue_id);

    let delivery = finalize_from_issue(&store, &human_id, false, None, None);

    let human = store.get_item(&human_id, "task").unwrap();
    assert_eq!(human.status.as_deref(), Some("completed"));
    assert_eq!(
        human.current_delivery_id.as_deref(),
        Some(delivery.id.as_str())
    );
}
