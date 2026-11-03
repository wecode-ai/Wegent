// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use serde_json::json;

use super::*;

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
fn workspace_response_preserves_thread_git_info_for_hover_cards() {
    let task = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "cwd": "/workspace/project",
            "gitInfo": {
                "branch": "codex/hover-details",
                "originUrl": "git@github.com:wecode-ai/Wegent.git"
            }
        }),
        None,
        "/workspace/project".to_owned(),
        false,
    );

    let workspaces = workspace_response(vec![task], Vec::new());

    assert_eq!(
        workspaces[0]["tasks"][0]["gitInfo"]["branch"],
        "codex/hover-details"
    );
    assert_eq!(
        workspaces[0]["tasks"][0]["gitInfo"]["originUrl"],
        "git@github.com:wecode-ai/Wegent.git"
    );
    let persisted = serde_json::to_value(RuntimeTaskLink {
        git_info: Some(json!({"branch": "codex/hover-details"})),
        ..RuntimeTaskLink::default()
    })
    .expect("runtime task link serialization");
    assert!(persisted.get("git_info").is_none());
}

#[test]
fn synthesizes_git_info_from_worktree_when_provider_metadata_is_missing() {
    let root = std::env::temp_dir().join(format!(
        "wegent-runtime-hover-branch-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let workspace = root.join("workspace");
    let git_dir = root.join("git-dir");
    fs::create_dir_all(&workspace).expect("workspace directory");
    fs::create_dir_all(&git_dir).expect("git directory");
    fs::write(workspace.join(".git"), "gitdir: ../git-dir\n").expect("git pointer");
    fs::write(
        git_dir.join("HEAD"),
        "ref: refs/heads/codex/hover-details\n",
    )
    .expect("git head");
    fs::write(
        git_dir.join("config"),
        "[remote \"origin\"]\n\turl = git@github.com:wecode-ai/Wegent.git\n",
    )
    .expect("git config");

    assert_eq!(
        git_workspace_info(&workspace.display().to_string()),
        (
            Some("codex/hover-details".to_owned()),
            Some("git@github.com:wecode-ai/Wegent.git".to_owned())
        )
    );
    assert_eq!(
        git_info_for_workspace(None, &workspace.display().to_string()),
        Some(json!({
            "currentBranch": "codex/hover-details",
            "originUrl": "git@github.com:wecode-ai/Wegent.git",
        }))
    );

    fs::remove_dir_all(root).expect("temporary git workspace cleanup");
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
fn completed_thread_preserves_provider_recency_for_sorting() {
    let link = RuntimeTaskLink::from_thread_metadata(
        &json!({
            "id": "thread-1",
            "status": "idle",
            "createdAt": 1_780_000_000_000_i64,
            "updatedAt": 1_780_000_100_000_i64,
            "recencyAt": 1_780_000_050_000_i64,
        }),
        None,
        "/workspace/project".to_owned(),
        false,
    );

    assert_eq!(link.completed_at, Some(1_780_000_100_000));
    assert_eq!(link.recency_at, 1_780_000_050_000);
}

#[test]
fn workspace_response_sorts_by_recency_instead_of_updated_at() {
    let older_recency = RuntimeTaskLink {
        local_task_id: "older-recency".to_owned(),
        workspace_path: "/workspace/project".to_owned(),
        updated_at: 1_780_000_300_000,
        recency_at: 1_780_000_100_000,
        ..RuntimeTaskLink::default()
    };
    let newer_recency = RuntimeTaskLink {
        local_task_id: "newer-recency".to_owned(),
        workspace_path: "/workspace/project".to_owned(),
        updated_at: 1_780_000_200_000,
        recency_at: 1_780_000_150_000,
        ..RuntimeTaskLink::default()
    };

    let workspaces = workspace_response(vec![older_recency, newer_recency], Vec::new());
    let tasks = workspaces[0]["tasks"].as_array().expect("workspace tasks");

    assert_eq!(tasks[0]["taskId"], "newer-recency");
    assert_eq!(tasks[1]["taskId"], "older-recency");
    assert_eq!(tasks[0]["recencyAt"], 1_780_000_150_000_i64);
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

#[test]
fn search_result_address_omits_runtime_handle_messages() {
    let task = RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/tmp/project".to_owned(),
        title: "Large output".to_owned(),
        runtime_handle: json!({
            "messages": [{"content": "large cached transcript"}],
            "executorSession": {"agent": "Codex"},
        }),
        ..RuntimeTaskLink::default()
    };

    let item = search_result_item(
        &task,
        "device-1",
        SearchResultMatch {
            snippet: "Large".to_owned(),
            match_start: 0,
            match_end: 5,
            message_id: String::new(),
            message_role: "title".to_owned(),
            message_created_at: Value::Null,
        },
    );
    let handle = &item["address"]["runtimeHandle"];

    assert_eq!(handle["threadId"], "thread-1");
    assert_eq!(handle["executorSession"]["agent"], "Codex");
    assert!(handle.get("messages").is_none());
}
