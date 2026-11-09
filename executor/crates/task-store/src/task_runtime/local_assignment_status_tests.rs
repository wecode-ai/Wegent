// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::task_runtime::{DeliveryCreate, DeliveryFinalize};

fn fixture() -> (tempfile::TempDir, LocalTaskStore, LoopItem, ChatAgent) {
    fixture_with_statuses(json!([
        {"id": "inbox", "name": "Inbox"},
        {"id": "acceptance", "name": "Acceptance"},
        {"id": "completed", "name": "Completed"},
    ]))
}

fn fixture_with_statuses(
    statuses: Value,
) -> (tempfile::TempDir, LocalTaskStore, LoopItem, ChatAgent) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("assignment.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name": "Custom board assignment"})).unwrap())
        .unwrap();
    let agent = store
        .create_chat_agent(
            &project.id,
            serde_json::from_value(json!({
                "name": "Assignment runner", "runtime": "codex", "execution_mode": "auto",
                "execution_policy": {"mode": "project_pool"},
                "model_policy": {"mode": "fixed", "model": {
                    "runtime": "codex", "provider": "test", "model_id": "model-a",
                }},
            }))
            .unwrap(),
        )
        .unwrap();
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_config: Some(json!({"group_by": "status", "statuses": statuses})),
                collaboration_groups: Some(json!([{
                    "id": "group", "name": "Assignment group",
                    "leader": {"kind": "agent", "id": agent.id}, "members": [],
                }])),
                ..Default::default()
            },
        )
        .unwrap();
    (directory, store, project, agent)
}

fn assert_manual_assignment_preserves_board_status(group: bool, assign_on_create: bool) {
    for status in ["inbox", "acceptance", "completed"] {
        let (_directory, store, project, agent) = fixture();
        let mut input = json!({"title": "Assigned Issue", "status": status});
        if assign_on_create {
            input[if group {
                "assignee_group_id"
            } else {
                "assignee_agent_id"
            }] = json!(if group { "group" } else { &agent.id });
        }
        let mut task = store
            .create_task(&project.id, serde_json::from_value(input).unwrap())
            .unwrap();
        if !assign_on_create {
            task = store
                .update_task(
                    &project.id,
                    &task.id,
                    TaskUpdate {
                        version: task.version,
                        status: (status != "inbox").then(|| status.to_owned()),
                        assignee_agent_id: (!group).then(|| Some(agent.id.clone())),
                        assignee_group_id: group.then(|| Some("group".to_owned())),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        let persisted = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(persisted.status.as_deref(), Some(status));
        if group {
            assert_eq!(persisted.metadata["collaboration_group"]["id"], "group");
        } else {
            assert_eq!(
                persisted.assignee_agent_id.as_deref(),
                Some(agent.id.as_str())
            );
        }
        let executions = store
            .list_executions(&project.id, None, None, true)
            .unwrap();
        assert_eq!(executions.len(), 1);
        assert_eq!(executions[0].loop_item_id, task.id);
        assert_eq!(executions[0].agent_id, agent.id);
        assert_eq!(executions[0].status, "queued");
        if group {
            assert_eq!(
                executions[0].execution_payload.as_ref().unwrap()["dispatch_role"],
                "manager"
            );
        }
        finish_execution(&store, &project, executions[0].id, status);
        let persisted = store.get_task(&project.id, &task.id).unwrap();
        let saved = store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: persisted.version,
                    title: Some("Edited assigned Issue".to_owned()),
                    status: persisted.status,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(saved.status.as_deref(), Some(status));
        assert_eq!(saved.title.as_deref(), Some("Edited assigned Issue"));
        assert_eq!(
            store
                .list_executions(&project.id, None, None, true)
                .unwrap()
                .len(),
            1
        );
        let listed = store.list_tasks(&project.id).unwrap();
        let card = listed.iter().find(|item| item.id == task.id).unwrap();
        let column = project.metadata["board_config"]["statuses"]
            .as_array()
            .unwrap()
            .iter()
            .find(|column| column["id"].as_str() == card.status.as_deref())
            .expect("The persisted Issue must match a configured board column");
        assert_eq!(column["id"], status);
    }
}

fn finish_execution(store: &LocalTaskStore, project: &LoopItem, execution_id: i64, status: &str) {
    let catalog = json!({"models": [{
        "runtime": "codex", "provider": "test", "model_id": "model-a",
        "local_model_id": "native-model",
    }]});
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(claimed.id, execution_id);
    let device_id = claimed.runtime_device_id.as_deref().unwrap();
    let task_id = claimed.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(claimed.id, device_id, task_id, 300)
        .unwrap()
        .unwrap();
    store
        .confirm_runtime_accepted(claimed.id, device_id, task_id, 300)
        .unwrap()
        .unwrap();
    assert_eq!(
        store.mark_runtime_running(task_id).unwrap().unwrap().status,
        "running"
    );
    assert_eq!(
        store
            .get_task(&project.id, &claimed.loop_item_id)
            .unwrap()
            .status
            .as_deref(),
        Some(status)
    );
    assert_eq!(
        store
            .complete_execution(claimed.id, Some("Done"))
            .unwrap()
            .unwrap()
            .status,
        "completed"
    );
    assert_eq!(
        store
            .get_task(&project.id, &claimed.loop_item_id)
            .unwrap()
            .status
            .as_deref(),
        Some(status)
    );
}

#[test]
fn create_with_agent_preserves_custom_board_status_without_in_progress() {
    assert_manual_assignment_preserves_board_status(false, true);
}

#[test]
fn create_with_group_preserves_custom_board_status_without_in_progress() {
    assert_manual_assignment_preserves_board_status(true, true);
}

#[test]
fn update_with_agent_preserves_custom_board_status_without_in_progress() {
    assert_manual_assignment_preserves_board_status(false, false);
}

#[test]
fn update_with_group_preserves_custom_board_status_without_in_progress() {
    assert_manual_assignment_preserves_board_status(true, false);
}

#[test]
fn runtime_completion_preserves_in_progress_when_the_board_has_no_review_column() {
    let (_directory, store, project, agent) = fixture_with_statuses(json!([
        {"id": "inbox", "name": "Inbox"},
        {"id": "in_progress", "name": "Running"},
        {"id": "completed", "name": "Completed"},
    ]));
    let task = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title": "No review column", "status": "inbox", "assignee_agent_id": agent.id,
            }))
            .unwrap(),
        )
        .unwrap();
    let execution = store
        .list_executions(&project.id, None, None, true)
        .unwrap()
        .remove(0);
    finish_execution(&store, &project, execution.id, "in_progress");
    let task = store.get_task(&project.id, &task.id).unwrap();
    store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                version: task.version,
                status: task.status,
                title: Some("Still editable".into()),
                ..Default::default()
            },
        )
        .unwrap();
}

#[test]
fn bound_runtime_projection_only_uses_existing_board_columns() {
    for (statuses, initial, running, reviewed, archived) in [
        (
            json!([{"id":"inbox"},{"id":"acceptance"},{"id":"completed"}]),
            "acceptance",
            "acceptance",
            "acceptance",
            "completed",
        ),
        (
            json!([{"id":"inbox"},{"id":"in_progress"},{"id":"completed"}]),
            "inbox",
            "in_progress",
            "in_progress",
            "completed",
        ),
        (
            json!([{"id":"inbox"},{"id":"in_progress"},{"id":"in_review"}]),
            "inbox",
            "in_progress",
            "in_review",
            "in_review",
        ),
    ] {
        let (_directory, store, project, _agent) = fixture_with_statuses(statuses);
        let task = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({
                    "title": "Bound task", "status": initial,
                }))
                .unwrap(),
            )
            .unwrap();
        store
            .bind_task(
                &project.id,
                Some(&task.id),
                None,
                RuntimeTaskAddress {
                    device_id: "device".into(),
                    task_id: "bound".into(),
                    task_title: None,
                    backend_task_id: None,
                    model_selection: None,
                    execution_context: None,
                    workflow_node_id: None,
                },
                None,
            )
            .unwrap();
        for (index, (runtime, expected)) in [
            ("pending", initial),
            ("running", running),
            ("succeeded", reviewed),
            ("archived", archived),
        ]
        .into_iter()
        .enumerate()
        {
            store
                .project_bound_task_status("device", "bound", runtime, (index as i64 + 1) * 100)
                .unwrap();
            let current = store.get_task(&project.id, &task.id).unwrap();
            assert_eq!(current.status.as_deref(), Some(expected));
            store
                .update_task(
                    &project.id,
                    &task.id,
                    TaskUpdate {
                        version: current.version,
                        status: current.status,
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        assert_eq!(
            store
                .project_bound_task_status("device", "bound", "running", 50)
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .get_task(&project.id, &task.id)
                .unwrap()
                .status
                .as_deref(),
            Some(archived)
        );
    }
}

#[test]
fn runtime_comment_preserves_status_when_standard_lifecycle_columns_are_missing() {
    for (statuses, initial, expected) in [
        (
            json!([{"id":"inbox"},{"id":"acceptance"},{"id":"completed"}]),
            "acceptance",
            "acceptance",
        ),
        (
            json!([{"id":"inbox"},{"id":"in_progress"},{"id":"completed"}]),
            "in_progress",
            "in_progress",
        ),
    ] {
        let (_directory, store, project, agent) = fixture_with_statuses(statuses);
        let task = store
            .create_task(
                &project.id,
                serde_json::from_value(json!({
                    "title": "Comment task", "status": initial,
                }))
                .unwrap(),
            )
            .unwrap();
        store
            .start_runtime_comment(&LocalRuntimeCommentStart {
                project_id: &project.id,
                task_id: &task.id,
                agent_id: &agent.id,
                trigger_message_id: "user-message",
                runtime_device_id: "device",
                runtime_task_id: "comment",
                prompt: Some("Work"),
                model: None,
            })
            .unwrap();
        assert_eq!(
            store
                .get_task(&project.id, &task.id)
                .unwrap()
                .status
                .as_deref(),
            Some(expected)
        );
        store
            .finish_runtime_comment("comment", "completed", "Done")
            .unwrap();
        let current = store.get_task(&project.id, &task.id).unwrap();
        assert_eq!(current.status.as_deref(), Some(expected));
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: current.version,
                    status: current.status,
                    ..Default::default()
                },
            )
            .unwrap();
    }
}

#[test]
fn human_delivery_emits_completion_once_without_excluding_its_manager_ancestor() {
    assert_human_delivery_completion(true, "manual");
}

#[test]
fn human_delivery_preserves_a_legal_column_when_the_board_has_no_completed_column() {
    assert_human_delivery_completion(false, "manual");
}

#[test]
fn runtime_delivery_excludes_only_its_actual_execution_rule() {
    assert_human_delivery_completion(true, "runtime");
}

#[test]
fn delivery_does_not_treat_another_issues_execution_as_its_origin() {
    assert_human_delivery_completion(true, "other_issue");
}

#[test]
fn runtime_start_excludes_its_origin_when_a_running_column_is_added_after_dispatch() {
    let (_directory, store, project, agent) = fixture();
    let mut origin = json!({
        "id":"origin", "name":"Origin", "triggerType":"event", "eventType":"task.status_changed",
        "eventConfig":{"statuses":["acceptance"], "transition":"any"},
        "targetKind":"agent", "targetId":agent.id, "enabled":true,
    });
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                automatic_processing_rules: Some(json!([origin])),
                ..Default::default()
            },
        )
        .unwrap();
    let task = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({"title":"Delayed running", "status":"inbox"})).unwrap(),
        )
        .unwrap();
    store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                version: task.version,
                status: Some("acceptance".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let mut board = project.metadata["board_config"].clone();
    board["statuses"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"in_progress", "name":"Running"}));
    origin["eventConfig"]["statuses"] = json!(["acceptance", "in_progress"]);
    store.update_project(&project.id, ProjectUpdate {
        version:project.version, board_config:Some(board), automatic_processing_rules:Some(json!([
            origin,
            {"id":"watcher", "name":"Watcher", "triggerType":"event", "eventType":"task.status_changed",
             "eventConfig":{"statuses":["in_progress"], "transition":"any"},
             "targetKind":"human", "targetId":"7", "enabled":true},
        ])), ..Default::default()
    }).unwrap();
    let execution = store
        .list_executions(&project.id, None, None, true)
        .unwrap()
        .remove(0);
    finish_execution(&store, &project, execution.id, "in_progress");
    assert_eq!(
        store
            .list_project_automation_runs(&project.id, "origin")
            .unwrap()
            .len(),
        1
    );
    let watcher = store
        .list_project_automation_runs(&project.id, "watcher")
        .unwrap();
    assert_eq!(watcher.len(), 1);
    assert_eq!(watcher[0]["status"], "failed");
    assert!(watcher[0]["error"]
        .as_str()
        .unwrap()
        .contains("active execution"));
}

fn assert_human_delivery_completion(has_completed_column: bool, caller: &str) {
    let mut statuses = json!([
        {"id":"acceptance", "name":"Acceptance"}, {"id":"waiting", "name":"Waiting"},
    ]);
    if has_completed_column {
        statuses
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"completed", "name":"Completed"}));
    }
    let (_directory, store, project, agent) = fixture_with_statuses(statuses);
    let origin_statuses = if has_completed_column {
        json!(["acceptance", "completed"])
    } else {
        json!(["acceptance"])
    };
    let project = store.update_project(&project.id, ProjectUpdate {
        version: project.version,
        collaboration_groups: Some(json!([{
            "id":"group", "name":"Mixed group", "leader":{"kind":"agent", "id":agent.id},
            "members":[{"kind":"human", "id":"7", "name":"Reviewer"}],
        }])),
        automatic_processing_rules: Some(json!([
            {"id":"origin", "name":"Origin", "triggerType":"event", "eventType":"task.status_changed",
             "eventConfig":{"statuses":origin_statuses, "transition":"any"},
             "targetKind":"collaboration_group", "targetId":"group", "enabled":true},
            {"id":"completed", "name":"Completed", "triggerType":"event", "eventType":"task.status_changed",
             "eventConfig":{"statuses":["completed"], "transition":"any"},
             "targetKind":"human", "targetId":"8", "enabled":has_completed_column},
        ])),
        ..Default::default()
    }).unwrap();
    let task = store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title":"Human work", "status":"waiting",
            }))
            .unwrap(),
        )
        .unwrap();
    store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                version: task.version,
                status: Some("acceptance".into()),
                ..Default::default()
            },
        )
        .unwrap();
    let catalog = json!({"models":[{"runtime":"codex", "provider":"test", "model_id":"model-a", "local_model_id":"native"}]});
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    let runtime_id = claimed.runtime_task_id.as_deref().unwrap();
    store
        .request_runtime_start(claimed.id, "runner-a", runtime_id, 300)
        .unwrap()
        .unwrap();
    store
        .confirm_runtime_accepted(claimed.id, "runner-a", runtime_id, 300)
        .unwrap()
        .unwrap();
    store.mark_runtime_running(runtime_id).unwrap().unwrap();
    let round = store.submit_collaboration_round(runtime_id, &json!({
        "round_id":"human-round", "items":[{"assignment_id":"human", "assignee_type":"human",
            "assignee_id":"7", "title":"Review", "instructions":"Submit evidence"}],
    })).unwrap();
    let human_id = round["assignments"][0]["human_assignment_id"]
        .as_str()
        .unwrap();
    let human = store.get_task(&project.id, human_id).unwrap();
    assert_eq!(human.status.as_deref(), Some("acceptance"));
    let mut rules = project.metadata["automatic_processing_rules"].clone();
    rules[0]["targetKind"] = json!(if caller == "runtime" {
        "agent"
    } else {
        "human"
    });
    rules[0]["targetId"] = json!(if caller == "runtime" { &agent.id } else { "9" });
    let current_project = store.get_project(&project.id).unwrap();
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current_project.version,
                automatic_processing_rules: Some(rules),
                ..Default::default()
            },
        )
        .unwrap();
    let runtime_origin = if caller == "runtime" {
        let waiting = store
            .update_task(
                &project.id,
                human_id,
                TaskUpdate {
                    version: human.version,
                    status: Some("waiting".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        store
            .update_task(
                &project.id,
                human_id,
                TaskUpdate {
                    version: waiting.version,
                    status: Some("acceptance".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let claimed = store
            .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
            .unwrap()
            .unwrap();
        let runtime_id = claimed.runtime_task_id.as_deref().unwrap();
        store
            .request_runtime_start(claimed.id, "runner-a", runtime_id, 300)
            .unwrap()
            .unwrap();
        store
            .confirm_runtime_accepted(claimed.id, "runner-a", runtime_id, 300)
            .unwrap()
            .unwrap();
        store.mark_runtime_running(runtime_id).unwrap().unwrap();
        Some(RuntimeTaskAddress {
            device_id: "runner-a".into(),
            task_id: runtime_id.into(),
            task_title: None,
            backend_task_id: None,
            model_selection: None,
            execution_context: None,
            workflow_node_id: None,
        })
    } else if caller == "other_issue" {
        Some(RuntimeTaskAddress {
            device_id: "runner-a".into(),
            task_id: runtime_id.into(),
            task_title: None,
            backend_task_id: None,
            model_selection: None,
            execution_context: None,
            workflow_node_id: None,
        })
    } else {
        None
    };
    let untrusted: DeliveryFinalize =
        serde_json::from_value(json!({"runtime_origin": runtime_origin})).unwrap();
    assert!(untrusted.runtime_origin.is_none());
    let draft = store
        .create_delivery(
            &project.id,
            human_id,
            true,
            DeliveryCreate {
                title: "Evidence".into(),
                markdown: "Reviewed".into(),
                chat: None,
                source_task: (caller == "runtime")
                    .then(|| runtime_origin.clone())
                    .flatten(),
            },
        )
        .unwrap();
    store
        .finalize_delivery(
            human_id,
            &draft.id,
            DeliveryFinalize {
                runtime_origin,
                ..Default::default()
            },
        )
        .unwrap();
    let completed = store.get_task(&project.id, human_id).unwrap();
    assert_eq!(
        completed.status.as_deref(),
        Some(if has_completed_column {
            "completed"
        } else {
            "acceptance"
        })
    );
    assert_eq!(
        completed.assignee_user_id,
        if caller == "runtime" {
            None
        } else {
            Some(if has_completed_column { 8 } else { 7 })
        }
    );
    assert_eq!(
        store
            .list_project_automation_runs(&project.id, "origin")
            .unwrap()
            .len(),
        if has_completed_column { 2 } else { 1 }
    );
    let runs = store
        .list_project_automation_runs(&project.id, "completed")
        .unwrap();
    let expected_runs = usize::from(has_completed_column);
    assert_eq!(runs.len(), expected_runs);
    if has_completed_column {
        assert_eq!(
            runs[0]["status"],
            if caller == "runtime" {
                "failed"
            } else {
                "succeeded"
            }
        );
        if caller == "runtime" {
            assert!(runs[0]["error"]
                .as_str()
                .unwrap()
                .contains("active execution"));
        }
    }
    assert!(store
        .finalize_delivery(human_id, &draft.id, DeliveryFinalize::default())
        .is_err());
    let later = store
        .create_delivery(
            &project.id,
            &task.id,
            true,
            DeliveryCreate {
                title: "Later evidence".into(),
                markdown: "Unrelated".into(),
                chat: None,
                source_task: None,
            },
        )
        .unwrap();
    store
        .finalize_delivery(&task.id, &later.id, DeliveryFinalize::default())
        .unwrap();
    assert_eq!(
        store
            .list_project_automation_runs(&project.id, "completed")
            .unwrap()
            .len(),
        expected_runs
    );
    store
        .update_task(
            &project.id,
            human_id,
            TaskUpdate {
                version: completed.version,
                status: completed.status,
                ..Default::default()
            },
        )
        .unwrap();
}
