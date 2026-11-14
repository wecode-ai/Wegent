// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;

use super::*;

#[test]
fn task_projection_reports_thread_routing_from_runtime_capability_not_saved_input() {
    let mut link = RuntimeTaskLink::new_pending(
        "routing-capability".into(),
        "/tmp/routing-capability".into(),
        "Routing capability".into(),
    );
    link.runtime_handle["modelProviderRouting"] = json!("stale");
    let projected = local_task_json(link.clone());
    assert_eq!(projected["runtimeHandle"]["modelProviderRouting"], "thread");
    assert_eq!(link.runtime_handle["modelProviderRouting"], "stale");

    link.runtime = "claude_code".into();
    link.runtime_handle["modelProviderRouting"] = json!("thread");
    let projected = local_task_json(link);
    assert!(projected["runtimeHandle"]
        .get("modelProviderRouting")
        .is_none());
}

#[test]
fn list_summary_projects_only_the_current_turn_source_without_private_content() {
    let mut handle = json!({"lastTurnId":"turn-2","userMessagePresentations":[
        {"turnId":"turn-1","source":{"source":"stand_in_activity"},"content":"old finding"},
        {"turnId":"turn-2","source":{"source":"manual","sender_id":"private"},"content":"private request"}
    ]});
    let summary = runtime_handle_list_summary_map(&handle);
    assert_eq!(
        summary["latestUserMessageSource"],
        json!({"source":"manual","turnId":"turn-2"})
    );
    assert!(!summary.contains_key("userMessagePresentations"));
    assert!(!serde_json::to_string(&summary).unwrap().contains("private"));
    handle["lastTurnId"] = json!("turn-3");
    assert!(!runtime_handle_list_summary_map(&handle).contains_key("latestUserMessageSource"));
}

#[test]
fn lifecycle_snapshot_carries_the_selected_model_without_client_enrichment() {
    let selection = json!({"modelName": "local-model:fixture", "modelType": "runtime",
        "options": {"permissionMode": "read-only"}});
    let task = RuntimeTaskLink {
        runtime_handle: json!({"modelSelection": selection}),
        ..RuntimeTaskLink::new_pending("task".into(), "/tmp/task".into(), "Task".into())
    };
    assert_eq!(local_task_json(task.clone())["modelSelection"], selection);
    assert_eq!(
        local_task_json(task.list_summary())["modelSelection"],
        selection
    );
}

#[test]
fn runtime_task_link_does_not_persist_running_state() {
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );

    let serialized = serde_json::to_value(&link).expect("task link should serialize");
    assert!(serialized.get("running").is_none());

    let restored: RuntimeTaskLink = serde_json::from_value(json!({
        "local_task_id": "task-1",
        "running": true,
    }))
    .expect("task link should deserialize");
    assert!(!restored.running);
}

#[test]
fn pending_runtime_task_link_preserves_selected_runtime() {
    let link = RuntimeTaskLink::new_pending_with_runtime(
        "task-claude".to_owned(),
        "/tmp/project".to_owned(),
        "Claude task".to_owned(),
        "claude_code",
    );

    assert_eq!(link.runtime, "claude_code");
    assert_eq!(link.runtime_handle["runtime"], "claude_code");
}

#[test]
fn workspace_response_omits_runtime_handle_messages_from_task_list() {
    let task = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/tmp/project".to_owned(),
        title: "Large output".to_owned(),
        runtime_handle: json!({
            "threadId": "stale-thread",
            "modelSelection": {"model": "gpt-5.5"},
            "collaborationMemberRuntimeProfiles": [{"credential": "memory-only"}],
            "messages": [
                {
                    "role": "assistant",
                    "blocks": [
                        {
                            "type": "tool_use",
                            "tool_output": "x".repeat(1024),
                        }
                    ],
                }
            ],
            "transcriptSnapshotPagination": {"beforeCursor": "large-native-cursor"},
            "userMessagePresentations": [{
                "clientUserMessageId": "runtime-local-pane-1",
                "references": [{
                    "token": "$plugin:skill",
                    "href": "/tmp/plugin/skill/SKILL.md"
                }]
            }],
        }),
        ..RuntimeTaskLink::default()
    };

    let workspaces = workspace_response(vec![task], Vec::new());
    let handle = &workspaces[0]["tasks"][0]["runtimeHandle"];

    assert_eq!(handle["threadId"], "thread-1");
    assert_eq!(handle["modelSelection"]["model"], "gpt-5.5");
    assert!(handle.get("messages").is_none());
    assert!(handle.get("collaborationMemberRuntimeProfiles").is_none());
    assert!(handle.get("transcriptSnapshotPagination").is_none());
    assert!(handle.get("userMessagePresentations").is_none());
}

#[test]
fn executor_execution_state_drives_task_running() {
    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active", "activeFlags": []},
            "cwd": "/workspace/project",
        }),
        None,
        "/workspace/project".to_owned(),
        true,
    );

    assert_eq!(link.status, "running");
    assert!(link.running);
}

#[test]
fn provider_in_progress_turn_keeps_task_running_after_local_execution_settles() {
    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active", "activeFlags": []},
            "cwd": "/workspace/project",
            "turns": [{"id": "turn-1", "status": "inProgress"}],
        }),
        None,
        "/workspace/project".to_owned(),
        false,
    );

    assert_eq!(link.status, "running");
    assert!(link.running);
    assert_eq!(link.thread_status, "active");
    assert_eq!(link.turn_status.as_deref(), Some("inProgress"));
}

#[test]
fn active_thread_keeps_previous_completion_time_for_sorting() {
    let local_link = RuntimeTaskLink {
        completed_at: Some(1_780_000_000_000),
        ..RuntimeTaskLink::default()
    };
    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active", "activeFlags": []},
            "updatedAt": 1_780_000_100_000_i64,
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        true,
    );

    assert_eq!(link.completed_at, Some(1_780_000_000_000));
}

#[test]
fn running_task_wire_summary_clears_previous_completion_but_retains_internal_ordering() {
    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active"},
            "updatedAt": 1_792_773_818_072_i64,
            "recencyAt": 1_792_773_818_000_i64,
            "turns": [{"id": "correction", "status": "inProgress"}],
        }),
        Some(RuntimeTaskLink {
            completed_at: Some(1_792_773_817_910),
            updated_at: 1_792_773_817_910,
            ..RuntimeTaskLink::default()
        }),
        "/workspace/project".to_owned(),
        true,
    );
    assert!(link.running);
    assert_eq!(link.completed_at, Some(1_792_773_817_910));

    for task in [link.clone(), link.list_summary()] {
        let payload = local_task_json(task);
        assert_eq!(payload["running"], true);
        assert_eq!(payload["updatedAt"], 1_792_773_818_072_i64);
        assert_eq!(payload["recencyAt"], 1_792_773_818_000_i64);
        assert_eq!(payload.get("completedAt"), Some(&Value::Null));
        let mut cached_task = json!({"completedAt": 1_792_773_817_910_i64});
        cached_task
            .as_object_mut()
            .unwrap()
            .extend(payload.as_object().unwrap().clone());
        assert_eq!(cached_task["completedAt"], Value::Null);
    }
}

#[test]
fn settled_task_wire_summary_retains_completion() {
    for status in ["done", "failed", "cancelled"] {
        let payload = local_task_json(RuntimeTaskLink {
            status: status.to_owned(),
            running: false,
            completed_at: Some(1_792_773_817_910),
            ..RuntimeTaskLink::default()
        });
        assert_eq!(payload["completedAt"], 1_792_773_817_910_i64);
        assert_eq!(payload["status"], status);
    }
}

#[test]
fn completed_wework_task_keeps_its_persisted_activity_time() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        status: "done".to_owned(),
        completed_at: Some(1_780_000_100_000),
        ..RuntimeTaskLink::default()
    };
    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": "idle",
            "createdAt": 1_780_000_000,
            "updatedAt": 1_780_086_400,
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert_eq!(link.updated_at, 1_780_000_100_000);
    assert_eq!(link.completed_at, Some(1_780_000_100_000));
}

#[test]
fn active_goal_does_not_keep_task_running_when_thread_list_is_idle() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        goal_status: Some("active".to_owned()),
        ..RuntimeTaskLink::default()
    };

    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": "idle",
            "cwd": "/workspace/project",
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert_eq!(link.status, "active");
    assert!(!link.running);
    assert_eq!(link.goal_status.as_deref(), Some("active"));
}

#[test]
fn idle_thread_uses_provider_turn_status() {
    for (provider_status, turn_status) in [
        ("completed", "completed"),
        ("interrupted", "interrupted"),
        ("failed", "failed"),
    ] {
        let link = RuntimeTaskLink::from_thread_metadata(
            &json!({
                "id": "thread-1",
                "status": "idle",
                "cwd": "/workspace/project",
                "turns": [{"status": provider_status}],
            }),
            None,
            "/workspace/project".to_owned(),
            false,
        );

        assert_eq!(link.status, "active");
        assert!(!link.running);
        assert!(link.continuable);
        assert_eq!(link.thread_status, "idle");
        assert_eq!(link.turn_status.as_deref(), Some(turn_status));
    }
}

#[test]
fn current_turn_state_is_exposed_separately_from_conversation_lifecycle() {
    let mut link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active", "activeFlags": []},
            "cwd": "/workspace/project",
            "turns": [{"status": "inProgress"}],
        }),
        None,
        "/workspace/project".to_owned(),
        true,
    );
    link.goal_status = Some("active".to_owned());
    let payload = local_task_json(link);

    assert_eq!(payload["status"], "running");
    assert_eq!(payload["running"], true);
    assert_eq!(payload["continuable"], true);
    assert_eq!(payload["threadStatus"], "active");
    assert_eq!(payload["turnStatus"], "inProgress");
    assert_eq!(payload["goalStatus"], "active");
}

#[test]
fn goal_execution_state_survives_task_list_serialization_between_turns() {
    for status in ["running", "recovering", "needsAttention"] {
        let payload = local_task_json(RuntimeTaskLink {
            running: false,
            status: "done".to_owned(),
            goal_status: Some("active".to_owned()),
            goal_execution_status: Some(status.to_owned()),
            ..RuntimeTaskLink::default()
        });

        assert_eq!(payload["goalExecutionStatus"], status);
        assert_eq!(payload["running"], false);
    }
    assert!(local_task_json(RuntimeTaskLink::default())
        .get("goalExecutionStatus")
        .is_none());
}

#[test]
fn stale_provider_turn_does_not_revive_a_completed_local_task() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        status: "done".to_owned(),
        completed_at: Some(1_780_000_002_000),
        ..RuntimeTaskLink::default()
    };

    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active"},
            "cwd": "/workspace/project",
            "updatedAt": 1_780_000_003,
            "turns": [{
                "id": "turn-1",
                "status": "inProgress",
                "startedAt": 1_780_000_001,
            }],
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert!(!link.running);
    assert_eq!(link.status, "done");
    assert_eq!(link.thread_status, "idle");
    assert_eq!(link.turn_status.as_deref(), Some("completed"));
}

#[test]
fn active_provider_thread_does_not_erase_a_completed_local_task() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        status: "done".to_owned(),
        completed_at: Some(1_780_000_002_000),
        ..RuntimeTaskLink::default()
    };

    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active"},
            "cwd": "/workspace/project",
            "updatedAt": 1_780_000_003,
            "turns": [],
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert!(!link.running);
    assert_eq!(link.status, "done");
    assert_eq!(link.thread_status, "idle");
    assert_eq!(link.completed_at, Some(1_780_000_002_000));
}

#[test]
fn newer_provider_turn_can_restart_a_completed_local_task() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        status: "done".to_owned(),
        completed_at: Some(1_780_000_002_000),
        ..RuntimeTaskLink::default()
    };

    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active"},
            "cwd": "/workspace/project",
            "turns": [{
                "id": "turn-2",
                "status": "inProgress",
                "startedAt": 1_780_000_003,
            }],
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert!(link.running);
    assert_eq!(link.status, "running");
    assert_eq!(link.thread_status, "active");
    assert_eq!(link.turn_status.as_deref(), Some("inProgress"));
}

#[test]
fn stale_provider_metadata_does_not_revive_a_failed_local_task() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        status: "failed".to_owned(),
        completed_at: Some(1_780_000_002_000),
        runtime_handle: json!({
            "lastError": "Executor restarted while the Worktree task was active",
        }),
        ..RuntimeTaskLink::default()
    };

    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active"},
            "cwd": "/workspace/project",
            "updatedAt": 1_780_000_003,
            "turns": [{
                "id": "turn-1",
                "status": "inProgress",
                "startedAt": 1_780_000_001,
            }],
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert!(!link.running);
    assert_eq!(link.status, "failed");
    assert_eq!(link.thread_status, "failed");
    assert_eq!(link.turn_status.as_deref(), Some("failed"));
    assert_eq!(link.completed_at, Some(1_780_000_002_000));
    assert_eq!(
        link.runtime_handle["lastError"],
        "Executor restarted while the Worktree task was active"
    );
}

#[test]
fn local_cancellation_uses_runtime_summary_status_vocabulary() {
    let local_link = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/workspace/project".to_owned(),
        status: "cancelled".to_owned(),
        completed_at: Some(1_780_000_002_000),
        ..RuntimeTaskLink::default()
    };

    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": {"type": "active"},
            "cwd": "/workspace/project",
            "turns": [{"status": "inProgress", "startedAt": 1_780_000_001}],
        }),
        Some(local_link),
        "/workspace/project".to_owned(),
        false,
    );

    assert!(!link.running);
    assert_eq!(link.status, "cancelled");
    assert_eq!(link.thread_status, "idle");
    assert_eq!(link.turn_status.as_deref(), Some("interrupted"));
}
