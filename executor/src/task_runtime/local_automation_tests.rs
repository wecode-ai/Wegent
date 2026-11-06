// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn setup() -> (tempfile::TempDir, LocalTaskStore, LoopItem) {
    let directory = tempfile::tempdir().unwrap();
    let store = LocalTaskStore::open(directory.path().join("automations.sqlite")).unwrap();
    let project = store
        .create_project(serde_json::from_value(json!({"name": "Status automation"})).unwrap())
        .unwrap();
    (directory, store, project)
}

fn rule(id: &str, config: Value) -> Value {
    json!({
        "id": id, "name": id, "triggerType": "event", "eventType": "task.status_changed",
        "eventConfig": config, "targetKind": "human", "targetId": "7", "enabled": true,
    })
}

fn set_rules(store: &LocalTaskStore, project: &LoopItem, rules: Value) {
    let current = store.get_project(&project.id).unwrap();
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current.version,
                automatic_processing_rules: Some(rules),
                ..Default::default()
            },
        )
        .unwrap();
}

fn issue(store: &LocalTaskStore, project: &LoopItem, status: &str) -> LoopItem {
    store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title": "Status change", "status": status,
            }))
            .unwrap(),
        )
        .unwrap()
}

fn change_status(
    store: &LocalTaskStore,
    project: &LoopItem,
    task: &LoopItem,
    status: &str,
) -> LoopItem {
    let current = store.get_task(&project.id, &task.id).unwrap();
    store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                version: current.version,
                status: Some(status.into()),
                ..Default::default()
            },
        )
        .unwrap()
}

fn runs(store: &LocalTaskStore, project: &LoopItem, id: &str) -> Vec<Value> {
    store.list_project_automation_runs(&project.id, id).unwrap()
}

#[test]
fn target_status_triggers_only_on_entry_and_survives_restart() {
    let (directory, store, project) = setup();
    set_rules(
        &store,
        &project,
        json!([rule(
            "review",
            json!({
                "statuses": ["in_review"], "transition": "any",
            })
        )]),
    );
    let task = issue(&store, &project, "in_review");
    assert!(runs(&store, &project, "review").is_empty());
    change_status(&store, &project, &task, "completed");
    assert!(runs(&store, &project, "review").is_empty());
    let assigned = change_status(&store, &project, &task, "in_review");
    assert_eq!(assigned.assignee_user_id, Some(7));
    let first = runs(&store, &project, "review");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["status"], "succeeded");
    change_status(&store, &project, &task, "in_review");
    assert_eq!(runs(&store, &project, "review").len(), 1);
    drop(store);
    let store = LocalTaskStore::open(directory.path().join("automations.sqlite")).unwrap();
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "in_review");
    let repeated = runs(&store, &project, "review");
    assert_eq!(repeated.len(), 2);
    assert_ne!(repeated[0]["id"], repeated[1]["id"]);
    let mut disabled = rule(
        "review",
        json!({"statuses": ["in_review"], "transition": "any"}),
    );
    disabled["enabled"] = json!(false);
    set_rules(&store, &project, json!([disabled]));
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "in_review");
    assert_eq!(runs(&store, &project, "review").len(), 2);
}

#[test]
fn custom_status_is_valid_for_creation_updates_and_rule_matching() {
    let (_directory, store, project) = setup();
    let mut board = project.metadata["board_config"].clone();
    board["statuses"].as_array_mut().unwrap().push(json!({
        "id": "acceptance", "name": "Acceptance", "color": "purple",
    }));
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_config: Some(board),
                ..Default::default()
            },
        )
        .unwrap();
    set_rules(
        &store,
        &project,
        json!([rule(
            "acceptance",
            json!({
                "statuses": ["acceptance"], "transition": "any",
            })
        )]),
    );
    let task = issue(&store, &project, "acceptance");
    assert!(runs(&store, &project, "acceptance").is_empty());
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "acceptance");
    assert_eq!(runs(&store, &project, "acceptance").len(), 1);
    assert!(store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title": "Invalid status", "status": "missing",
            }))
            .unwrap()
        )
        .is_err());
    let current = store.get_task(&project.id, &task.id).unwrap();
    assert!(store
        .update_task(
            &project.id,
            &task.id,
            TaskUpdate {
                version: current.version,
                status: Some("missing".into()),
                ..Default::default()
            }
        )
        .is_err());
    assert_eq!(
        store.get_task(&project.id, &task.id).unwrap().version,
        current.version
    );
}

#[test]
fn status_rule_rejects_invalid_filters_and_transitions() {
    let (_directory, store, project) = setup();
    for config in [
        json!({"statuses": []}),
        json!({"statuses": "in_review"}),
        json!({"statuses": [42]}),
        json!({"statuses": ["missing"]}),
        json!({"transition": "unsupported"}),
    ] {
        assert!(store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: project.version,
                    automatic_processing_rules: Some(json!([rule("invalid", config)])),
                    ..Default::default()
                }
            )
            .is_err());
    }
    assert_eq!(
        store.get_project(&project.id).unwrap().version,
        project.version
    );
}

#[test]
fn entered_processing_obeys_the_configured_board_boundary() {
    let (_directory, store, project) = setup();
    let mut board = project.metadata["board_config"].clone();
    board["processing_start_status_id"] = json!("in_progress");
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_config: Some(board),
                ..Default::default()
            },
        )
        .unwrap();
    set_rules(
        &store,
        &project,
        json!([rule(
            "processing",
            json!({"transition": "entered_processing"})
        )]),
    );
    let task = issue(&store, &project, "inbox");
    change_status(&store, &project, &task, "pending");
    assert!(runs(&store, &project, "processing").is_empty());
    change_status(&store, &project, &task, "in_progress");
    assert_eq!(runs(&store, &project, "processing").len(), 1);
    change_status(&store, &project, &task, "in_review");
    change_status(&store, &project, &task, "in_progress");
    assert_eq!(runs(&store, &project, "processing").len(), 1);
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "in_review");
    assert_eq!(runs(&store, &project, "processing").len(), 2);
}

fn agent(store: &LocalTaskStore, project: &LoopItem) -> ChatAgent {
    store.create_chat_agent(&project.id, serde_json::from_value(json!({
        "name": "Status runner", "runtime": "codex", "execution_mode": "auto",
        "execution_policy": {"mode": "project_pool"},
        "model_policy": {"mode": "fixed", "model": {"runtime": "codex", "provider": "test", "model_id": "model-a"}},
    })).unwrap()).unwrap()
}

#[test]
fn execution_completion_excludes_its_origin_rule_but_runs_other_rules() {
    let (_directory, store, project) = setup();
    let agent = agent(&store, &project);
    let mut origin = rule(
        "origin",
        json!({"statuses": ["in_review"], "transition": "any"}),
    );
    origin["targetKind"] = json!("agent");
    origin["targetId"] = json!(agent.id);
    set_rules(&store, &project, json!([origin]));
    let task = issue(&store, &project, "inbox");
    change_status(&store, &project, &task, "in_review");
    let catalog = json!({"models": [{"runtime": "codex", "provider": "test", "model_id": "model-a", "local_model_id": "native-model"}]});
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    assert_eq!(runs(&store, &project, "origin").len(), 1);
    set_rules(
        &store,
        &project,
        json!([
            origin,
            rule(
                "other",
                json!({
                    "statuses": ["in_review"], "transition": "any",
                })
            )
        ]),
    );
    store.complete_execution(claimed.id, Some("Done")).unwrap();
    assert_eq!(runs(&store, &project, "origin").len(), 1);
    let other = runs(&store, &project, "other");
    assert_eq!(other.len(), 1);
    assert_eq!(other[0]["status"], "succeeded");
    assert!(!store.has_queued_executions().unwrap());
    store
        .complete_execution(claimed.id, Some("Duplicate"))
        .unwrap();
    assert_eq!(runs(&store, &project, "other").len(), 1);
    set_rules(&store, &project, json!([origin]));
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "in_review");
    assert_eq!(runs(&store, &project, "origin").len(), 2);
}

#[test]
fn runtime_comment_completion_triggers_once_after_the_final_comment() {
    let (_directory, store, project) = setup();
    let agent = agent(&store, &project);
    let task = issue(&store, &project, "in_progress");
    set_rules(
        &store,
        &project,
        json!([rule(
            "review",
            json!({
                "statuses": ["in_review"], "transition": "any",
            })
        )]),
    );
    let comment = store
        .create_comment(&LocalCommentCreate {
            project_id: project.id.clone(),
            task_id: task.id.clone(),
            client_message_id: None,
            sender_type: "user".into(),
            sender_id: "7".into(),
            sender_name: "Tester".into(),
            content: "Review this".into(),
            metadata: json!({}),
            reply_to_message_id: None,
        })
        .unwrap();
    store
        .start_runtime_comment(&LocalRuntimeCommentStart {
            project_id: &project.id,
            task_id: &task.id,
            agent_id: &agent.id,
            trigger_message_id: &comment.message_id,
            runtime_device_id: "device",
            runtime_task_id: "runtime-comment",
            prompt: None,
            model: None,
        })
        .unwrap();
    store
        .finish_runtime_comment("runtime-comment", "completed", "Done")
        .unwrap();
    assert_eq!(runs(&store, &project, "review").len(), 1);
    store
        .finish_runtime_comment("runtime-comment", "completed", "Duplicate")
        .unwrap();
    assert_eq!(runs(&store, &project, "review").len(), 1);
}

#[test]
fn bound_runtime_projection_triggers_only_for_a_new_persisted_transition() {
    let (_directory, store, project) = setup();
    let task = issue(&store, &project, "in_progress");
    set_rules(
        &store,
        &project,
        json!([rule(
            "review",
            json!({
                "statuses": ["in_review"], "transition": "any",
            })
        )]),
    );
    store
        .bind_task(
            &project.id,
            Some(&task.id),
            None,
            RuntimeTaskAddress {
                device_id: "device".into(),
                task_id: "runtime-bound".into(),
                task_title: task.title.clone(),
                backend_task_id: None,
                model_selection: None,
                execution_context: None,
                workflow_node_id: None,
            },
            None,
        )
        .unwrap();
    assert_eq!(
        store
            .project_bound_task_status("device", "runtime-bound", "completed", 100)
            .unwrap(),
        1
    );
    assert_eq!(runs(&store, &project, "review").len(), 1);
    assert_eq!(
        store
            .project_bound_task_status("device", "runtime-bound", "completed", 200)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .project_bound_task_status("device", "runtime-bound", "running", 50)
            .unwrap(),
        0
    );
    assert_eq!(runs(&store, &project, "review").len(), 1);
}

#[test]
fn a_project_without_board_config_keeps_standard_statuses_and_processing_defaults() {
    let (_directory, store, project) = setup();
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE loop_items SET metadata=json_remove(metadata, '$.board_config') WHERE id=?1",
            [&project.id],
        )
        .unwrap();
    set_rules(
        &store,
        &project,
        json!([rule("legacy", json!({"transition": "entered_processing"}))]),
    );
    let task = issue(&store, &project, "inbox");
    change_status(&store, &project, &task, "pending");
    assert_eq!(runs(&store, &project, "legacy").len(), 1);
    let mut board = project_status::default_board_config();
    board["processing_start_status_id"] = Value::Null;
    let current = store.get_project(&project.id).unwrap();
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current.version,
                board_config: Some(board),
                ..Default::default()
            },
        )
        .unwrap();
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "pending");
    assert_eq!(runs(&store, &project, "legacy").len(), 2);
    let current = store.get_project(&project.id).unwrap();
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current.version,
                board_config: Some(json!({"statuses": []})),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(store
        .create_task(
            &project.id,
            serde_json::from_value(json!({
                "title": "Empty board", "status": "pending",
            }))
            .unwrap()
        )
        .is_err());
}

#[test]
fn completed_target_creates_new_executions_and_activity_for_the_same_assignee() {
    let (_directory, store, project) = setup();
    let agent = agent(&store, &project);
    let mut completed = rule(
        "completed",
        json!({"statuses": ["completed"], "transition": "any"}),
    );
    completed["targetKind"] = json!("agent");
    completed["targetId"] = json!(agent.id);
    set_rules(&store, &project, json!([completed]));
    let task = issue(&store, &project, "inbox");
    let completed_task = change_status(&store, &project, &task, "completed");
    assert_eq!(completed_task.status.as_deref(), Some("completed"));
    let first = store
        .list_executions(&project.id, None, None, true)
        .unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].status, "queued");
    assert_eq!(
        store.list_comments(&project.id, &task.id, 0).unwrap().len(),
        1
    );
    let catalog = json!({"models": [{"runtime": "codex", "provider": "test", "model_id": "model-a", "local_model_id": "native-model"}]});
    let claimed = store
        .claim_next_execution_with_catalog(Some("runner-a"), "instance", 300, Some(&catalog))
        .unwrap()
        .unwrap();
    store.complete_execution(claimed.id, Some("Done")).unwrap();
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .status
            .as_deref(),
        Some("completed")
    );
    assert_eq!(
        store
            .get_task(&project.id, &task.id)
            .unwrap()
            .assignee_agent_id,
        Some(agent.id)
    );
    change_status(&store, &project, &task, "inbox");
    change_status(&store, &project, &task, "completed");
    let repeated = store
        .list_executions(&project.id, None, None, true)
        .unwrap();
    assert_eq!(repeated.len(), 2);
    assert_eq!(
        repeated
            .iter()
            .filter(|execution| execution.status == "queued")
            .count(),
        1
    );
    assert_eq!(
        store.list_comments(&project.id, &task.id, 0).unwrap().len(),
        2
    );
    let runs = runs(&store, &project, "completed");
    assert_eq!(runs.len(), 2);
    assert!(runs.iter().all(|run| run["status"] != "failed"));
    assert_ne!(
        repeated[0].execution_payload.as_ref().unwrap()["automation_run_id"],
        repeated[1].execution_payload.as_ref().unwrap()["automation_run_id"]
    );
}

#[test]
fn creation_and_tag_events_keep_their_existing_matching_behavior() {
    let (_directory, store, project) = setup();
    let mut created = rule("created", json!({}));
    created["eventType"] = json!("task.created");
    set_rules(&store, &project, json!([created]));
    let task = issue(&store, &project, "inbox");
    assert_eq!(task.assignee_user_id, Some(7));
    assert_eq!(runs(&store, &project, "created").len(), 1);
    let mut tagged = rule("tagged", json!({"tags": ["review"]}));
    tagged["eventType"] = json!("task.tag_added");
    set_rules(&store, &project, json!([tagged]));
    for (tags, expected) in [(vec!["other"], 0), (vec!["other", "review"], 1)] {
        let current = store.get_task(&project.id, &task.id).unwrap();
        store
            .update_task(
                &project.id,
                &task.id,
                TaskUpdate {
                    version: current.version,
                    tags: Some(tags.iter().map(|tag| (*tag).to_owned()).collect()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(runs(&store, &project, "tagged").len(), expected);
    }
}

fn install_group(store: &LocalTaskStore, project: &LoopItem, leader: Value) -> Value {
    let current = store.get_project(&project.id).unwrap();
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current.version,
                collaboration_groups: Some(json!([{
                    "id": "group", "name": "Status group", "leader": leader, "members": [],
                }])),
                ..Default::default()
            },
        )
        .unwrap();
    let mut group_rule = rule(
        "group",
        json!({"statuses": ["completed"], "transition": "any"}),
    );
    group_rule["targetKind"] = json!("collaboration_group");
    group_rule["targetId"] = json!("group");
    group_rule
}

#[test]
fn completed_target_group_queues_a_real_manager_execution_without_reopening_issue() {
    let (_directory, store, project) = setup();
    let agent = agent(&store, &project);
    let group_rule = install_group(&store, &project, json!({"kind": "agent", "id": agent.id}));
    set_rules(&store, &project, json!([group_rule]));
    let task = issue(&store, &project, "inbox");
    let assigned = change_status(&store, &project, &task, "completed");
    assert_eq!(assigned.status.as_deref(), Some("completed"));
    let executions = store
        .list_executions(&project.id, None, None, true)
        .unwrap();
    assert_eq!(executions.len(), 1);
    assert_eq!(executions[0].status, "queued");
    assert_eq!(executions[0].agent_id, agent.id);
    assert_eq!(
        executions[0].execution_payload.as_ref().unwrap()["dispatch_role"],
        "manager"
    );
    assert_eq!(
        store.list_comments(&project.id, &task.id, 0).unwrap().len(),
        1
    );
    assert_eq!(runs(&store, &project, "group")[0]["status"], "queued");
}

#[test]
fn human_led_group_keeps_the_target_status_and_finishes_without_an_execution() {
    let (_directory, store, project) = setup();
    let mut group_rule = install_group(&store, &project, json!({"kind": "human", "id": "7"}));
    group_rule["eventConfig"]["statuses"] = json!(["in_review"]);
    set_rules(&store, &project, json!([group_rule]));
    let task = issue(&store, &project, "inbox");
    let assigned = change_status(&store, &project, &task, "in_review");
    assert_eq!(assigned.status.as_deref(), Some("in_review"));
    assert_eq!(assigned.metadata["collaboration_group"]["id"], "group");
    assert!(store
        .list_executions(&project.id, None, None, true)
        .unwrap()
        .is_empty());
    let runs = runs(&store, &project, "group");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0]["status"], "succeeded");
    assert!(runs[0]["completedAt"].is_string());
}

#[test]
fn robot_targets_preserve_a_custom_status_when_the_board_has_no_in_progress_column() {
    for target in ["agent", "collaboration_group"] {
        let (_directory, store, project) = setup();
        let agent = agent(&store, &project);
        let current = store.get_project(&project.id).unwrap();
        store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: current.version,
                    board_config: Some(json!({"statuses": [
                        {"id": "inbox", "name": "Inbox"},
                        {"id": "acceptance", "name": "Acceptance"},
                        {"id": "completed", "name": "Completed"},
                    ]})),
                    ..Default::default()
                },
            )
            .unwrap();
        let mut target_rule = if target == "collaboration_group" {
            install_group(&store, &project, json!({"kind": "agent", "id": agent.id}))
        } else {
            let mut target_rule = rule("agent", json!({}));
            target_rule["targetKind"] = json!("agent");
            target_rule["targetId"] = json!(agent.id);
            target_rule
        };
        target_rule["eventConfig"] = json!({"statuses": ["acceptance"], "transition": "any"});
        set_rules(&store, &project, json!([target_rule]));
        let task = issue(&store, &project, "inbox");
        let assigned = change_status(&store, &project, &task, "acceptance");
        assert_eq!(assigned.status.as_deref(), Some("acceptance"));
        assert_eq!(
            store
                .list_executions(&project.id, None, None, true)
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn a_deleted_status_rule_can_be_disabled_but_not_reenabled_until_repaired() {
    let (_directory, store, project) = setup();
    let mut board = project.metadata["board_config"].clone();
    board["statuses"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id": "removed", "name": "Removed"}));
    let project = store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: project.version,
                board_config: Some(board),
                ..Default::default()
            },
        )
        .unwrap();
    let mut status_rule = rule(
        "removed",
        json!({"statuses": ["removed"], "transition": "any"}),
    );
    set_rules(&store, &project, json!([status_rule]));
    let current = store.get_project(&project.id).unwrap();
    store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current.version,
                board_config: Some(project_status::default_board_config()),
                ..Default::default()
            },
        )
        .unwrap();
    status_rule["enabled"] = json!(false);
    set_rules(&store, &project, json!([status_rule]));
    let current = store.get_project(&project.id).unwrap();
    assert_eq!(
        current.metadata["automatic_processing_rules"][0]["eventConfig"]["statuses"],
        json!(["removed"])
    );
    status_rule["enabled"] = json!(true);
    assert!(store
        .update_project(
            &project.id,
            ProjectUpdate {
                version: current.version,
                automatic_processing_rules: Some(json!([status_rule])),
                ..Default::default()
            }
        )
        .is_err());
    status_rule["enabled"] = json!(false);
    for invalid in [
        json!({"statuses": []}),
        json!({"statuses": [""]}),
        json!({"transition": "invalid"}),
    ] {
        status_rule["eventConfig"] = invalid;
        assert!(store
            .update_project(
                &project.id,
                ProjectUpdate {
                    version: current.version,
                    automatic_processing_rules: Some(json!([status_rule])),
                    ..Default::default()
                }
            )
            .is_err());
    }
    let restored = store.get_project(&project.id).unwrap();
    assert_eq!(
        restored.metadata["automatic_processing_rules"][0]["enabled"],
        false
    );
}

fn assignment_rule(store: &LocalTaskStore, project: &LoopItem, target: &str, event: &str) -> Value {
    let mut source = match target {
        "agent_group" => {
            let agent = agent(store, project);
            install_group(store, project, json!({"kind": "agent", "id": agent.id}))
        }
        "human_group" => install_group(store, project, json!({"kind": "human", "id": "7"})),
        "agent" => {
            let agent = agent(store, project);
            let mut source = rule("source", json!({}));
            source["targetKind"] = json!("agent");
            source["targetId"] = json!(agent.id);
            source
        }
        _ => rule("source", json!({})),
    };
    source["id"] = json!("source");
    source["eventType"] = json!(event);
    source["eventConfig"] = json!({"tags": ["review"]});
    source
}

#[test]
fn created_and_tag_assignments_emit_their_real_in_progress_transition() {
    for event in ["task.created", "task.tag_added"] {
        for target in ["agent", "agent_group"] {
            let (_directory, store, project) = setup();
            let source = assignment_rule(&store, &project, target, event);
            let watcher = rule(
                "watcher",
                json!({"statuses": ["in_progress"], "transition": "any"}),
            );
            let task = if event == "task.tag_added" {
                Some(issue(&store, &project, "inbox"))
            } else {
                None
            };
            set_rules(&store, &project, json!([source, watcher]));
            let task = if let Some(task) = task {
                store
                    .update_task(
                        &project.id,
                        &task.id,
                        TaskUpdate {
                            version: task.version,
                            tags: Some(vec!["review".into()]),
                            ..Default::default()
                        },
                    )
                    .unwrap()
            } else {
                issue(&store, &project, "inbox")
            };
            assert_eq!(task.status.as_deref(), Some("in_progress"));
            assert_eq!(runs(&store, &project, "source").len(), 1);
            let matched = runs(&store, &project, "watcher");
            assert_eq!(matched.len(), 1);
            // Matching must remain visible while the existing active-run guard
            // prevents a second assignment from replacing the running Agent.
            assert_eq!(matched[0]["status"], "failed");
            assert_eq!(matched[0]["error"], "Issue already has an active execution");
            assert_eq!(
                store
                    .list_executions(&project.id, None, None, true)
                    .unwrap()
                    .len(),
                1
            );
        }
    }
}

#[test]
fn assignment_transition_excludes_its_origin_before_the_origin_run_is_persisted() {
    let (_directory, store, project) = setup();
    let mut source = assignment_rule(&store, &project, "agent", "task.status_changed");
    source["eventConfig"] = json!({"statuses": ["in_review", "in_progress"], "transition": "any"});
    set_rules(&store, &project, json!([source]));
    let task = issue(&store, &project, "inbox");
    let assigned = change_status(&store, &project, &task, "in_review");
    assert_eq!(assigned.status.as_deref(), Some("in_progress"));
    let origin_runs = runs(&store, &project, "source");
    assert_eq!(origin_runs.len(), 1);
    assert_eq!(origin_runs[0]["status"], "queued");
}

#[test]
fn human_and_unchanged_robot_assignments_do_not_emit_a_status_transition() {
    for target in ["human", "human_group", "agent", "agent_group"] {
        let (_directory, store, project) = setup();
        let source = assignment_rule(&store, &project, target, "task.created");
        let watcher = rule(
            "watcher",
            json!({"statuses": ["completed"], "transition": "any"}),
        );
        set_rules(&store, &project, json!([source, watcher]));
        let task = issue(&store, &project, "completed");
        assert_eq!(task.status.as_deref(), Some("completed"));
        assert_eq!(runs(&store, &project, "source").len(), 1);
        assert!(runs(&store, &project, "watcher").is_empty());
    }
}
