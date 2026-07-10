// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn current_codex_model_provider_reads_configured_provider_name() {
    let provider = current_codex_model_provider_from_config(&json!({
        "config": {
            "model_provider": "wecode-openai",
            "model_providers": {
                "wecode-openai": {
                    "name": "wecode openai"
                },
                "wecode-ark": {
                    "name": "wecode ark"
                }
            }
        }
    }));

    assert_eq!(provider.id, "wecode-openai");
    assert_eq!(provider.display_name, "wecode openai");
    assert_eq!(provider.kind, "provider");
    assert!(provider.current);
}

#[test]
fn current_codex_model_provider_defaults_to_official() {
    let provider = current_codex_model_provider_from_config(&json!({"config": {}}));

    assert_eq!(provider.id, "openai");
    assert_eq!(provider.display_name, "CodeX");
    assert_eq!(provider.kind, "official");
    assert!(provider.current);
}

#[test]
fn plugin_app_server_method_allowlist_covers_wework_plugin_runtime_surface() {
    for method in [
        "marketplace/add",
        "marketplace/remove",
        "marketplace/upgrade",
        "plugin/list",
        "plugin/installed",
        "plugin/read",
        "plugin/skill/read",
        "plugin/install",
        "plugin/uninstall",
        "skills/list",
        "skills/config/write",
        "app/list",
    ] {
        assert!(
            is_allowed_plugin_app_server_method(method),
            "{method} should be allowed"
        );
    }

    assert!(!is_allowed_plugin_app_server_method("thread/new"));
    assert!(!is_allowed_plugin_app_server_method("plugin/share/save"));
}

#[test]
fn cached_user_message_uses_explicit_payload_text() {
    let request = ExecutionRequest {
        subtask_id: "42".to_owned(),
        prompt: json!([
            {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"},
            {"type": "input_text", "text": "visible user text"}
        ]),
        ..ExecutionRequest::default()
    };

    let message = cached_user_message(
        "local-task",
        &request,
        &json!({"message": "visible user text"}),
    )
    .expect("payload message should create a cached user message");

    assert_eq!(message["content"], "visible user text");

    let content_message = cached_user_message(
        "local-task",
        &request,
        &json!({"content": "visible content text"}),
    )
    .expect("payload content should create a cached user message");

    assert_eq!(content_message["content"], "visible content text");
}

#[test]
fn cached_user_message_does_not_fallback_to_prompt() {
    let request = ExecutionRequest {
        subtask_id: "42".to_owned(),
        prompt: json!([
            {"type": "input_text", "text": "# AGENTS.md instructions\n\n<environment_context>"}
        ]),
        ..ExecutionRequest::default()
    };

    assert!(cached_user_message("local-task", &request, &json!({})).is_none());
}

#[test]
fn cached_message_merge_preserves_codex_rebuilt_blocks() {
    let codex_messages = vec![json!({
        "id": "assistant-turn-1",
        "role": "assistant",
        "content": "done",
        "status": "cancelled",
        "blocks": [
            {
                "id": "tool-1",
                "type": "tool",
                "tool_name": "exec_command",
                "status": "done"
            }
        ],
        "stoppedNotice": true
    })];
    let cached_messages = vec![json!({
        "id": "cached-assistant",
        "role": "assistant",
        "content": "done",
        "status": "done",
        "source": {"source": "im"},
        "blocks": [
            {
                "id": "thinking-1",
                "type": "thinking",
                "content": "inspect",
                "status": "done"
            },
            {
                "id": "tool-1",
                "type": "tool",
                "tool_name": "stale_tool",
                "status": "pending"
            }
        ]
    })];

    let merged = merge_cached_messages(codex_messages, cached_messages);

    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["status"], "cancelled");
    assert_eq!(merged[0]["stoppedNotice"], true);
    assert_eq!(merged[0]["blocks"][0]["type"], "thinking");
    assert_eq!(merged[0]["blocks"][1]["tool_name"], "exec_command");
    assert_eq!(merged[0]["blocks"][1]["status"], "done");
    assert_eq!(merged[0]["source"]["source"], "im");
}

#[test]
fn cached_message_merge_matches_assistant_by_subtask_id() {
    let codex_messages = vec![json!({
        "id": "assistant-server",
        "role": "assistant",
        "content": "server snapshot",
        "subtaskId": 42,
    })];
    let cached_messages = vec![json!({
        "id": "assistant-live",
        "role": "assistant",
        "content": "live delta",
        "subtaskId": 42,
        "source": {"source": "im"},
    })];

    let merged = merge_cached_messages(codex_messages, cached_messages);

    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["id"], "assistant-server");
    assert_eq!(merged[0]["content"], "server snapshot");
    assert_eq!(merged[0]["source"]["source"], "im");
}

#[test]
fn cached_message_merge_preserves_live_block_fields() {
    let codex_messages = vec![json!({
        "id": "assistant-turn-1",
        "role": "assistant",
        "content": "",
        "subtaskId": 42,
        "blocks": [
            {
                "id": "tool-1",
                "type": "tool",
                "tool_name": "exec_command",
                "status": "pending"
            }
        ],
    })];
    let cached_messages = vec![json!({
        "id": "assistant-live",
        "role": "assistant",
        "content": "",
        "subtaskId": 42,
        "blocks": [
            {
                "id": "tool-1",
                "type": "tool",
                "tool_name": "exec_command",
                "status": "done",
                "tool_output": "ok"
            }
        ],
    })];

    let merged = merge_cached_messages(codex_messages, cached_messages);

    assert_eq!(merged.len(), 1);
    assert_eq!(merged[0]["blocks"][0]["status"], "done");
    assert_eq!(merged[0]["blocks"][0]["tool_output"], "ok");
}

#[tokio::test]
async fn cached_transcript_response_uses_requested_local_task_id() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let mut link = RuntimeTaskLink::new_pending(
        "local-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Mapped task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    link.running = false;
    link.status = "active".to_owned();
    handler.upsert_local_task(link);
    handler.transcript_cache.insert(
        "thread-1",
        CachedTranscript::new(
            "/tmp/project".to_owned(),
            "codex".to_owned(),
            vec![json!({"id":"assistant-1","role":"assistant","content":"cached"})],
            false,
            None,
        ),
    );

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {"taskId": "local-task-1"}
        }))
        .await
        .expect("cached transcript should return");

    assert_eq!(result["taskId"], "local-task-1");
    assert_eq!(result["messages"][0]["content"], "cached");
}

#[tokio::test]
async fn codex_stream_debug_rpc_toggles_runtime_flag() {
    set_codex_stream_debug_enabled(false);
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let initial = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.stream_debug.get",
            "payload": {}
        }))
        .await
        .expect("debug state should return");
    assert_eq!(initial["enabled"], false);

    let updated = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.stream_debug.set",
            "payload": {"enabled": true}
        }))
        .await
        .expect("debug state should update");
    assert_eq!(updated["enabled"], true);
    assert!(codex_stream_debug_enabled());

    set_codex_stream_debug_enabled(false);
}

#[tokio::test]
async fn codex_app_server_restart_rpc_returns_success() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.app_server.restart",
            "payload": {}
        }))
        .await
        .expect("restart should return success");

    assert_eq!(result["restarted"], true);
}

#[tokio::test]
async fn codex_instructions_write_rejects_non_string_payload() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.instructions.write",
            "payload": {"instructions": 1}
        }))
        .await;

    let error = result.expect_err("non-string instructions should be rejected");
    assert_eq!(error.code, "invalid_request");
}

#[tokio::test]
async fn codex_personality_write_rejects_unsupported_value() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.personality.write",
            "payload": {"personality": "default"}
        }))
        .await;

    let error = result.expect_err("unsupported personality should be rejected");
    assert_eq!(error.code, "invalid_request");
}

#[test]
fn codex_developer_instructions_preserve_user_copy_and_browser_routing() {
    let combined = combined_codex_developer_instructions("用中文回复");

    assert!(combined.contains("用中文回复"));
    assert!(combined.contains("browser_navigate"));
    assert_eq!(strip_wework_browser_instructions(&combined), "用中文回复");
}

#[tokio::test]
async fn transcript_without_runtime_link_returns_empty_local_transcript() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "optimistic-local-task",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("missing runtime link should not read provider session");

    assert_eq!(result["success"], true);
    assert_eq!(result["taskId"], "optimistic-local-task");
    assert_eq!(result["workspacePath"], "/tmp/project");
    assert_eq!(result["messages"].as_array().unwrap().len(), 0);
}

#[test]
fn first_message_search_result_returns_bounded_snippet() {
    let link = RuntimeTaskLink::new_pending(
        "local-task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Long message task".to_owned(),
    );
    let content = format!("{}needle{}", "a".repeat(300), "b".repeat(300));

    let result = first_message_search_result(
        &link,
        "device-1",
        vec![json!({
            "id": "message-1",
            "role": "user",
            "content": content,
            "createdAt": 1780000000,
        })],
        "needle",
    )
    .expect("long matching message should produce a result");
    let snippet = result["snippet"].as_str().unwrap();
    let match_start = result["matchStart"].as_u64().unwrap() as usize;
    let match_end = result["matchEnd"].as_u64().unwrap() as usize;

    assert!(snippet.len() < 300);
    assert!(snippet.contains("needle"));
    assert_eq!(&snippet[match_start..match_end], "needle");
}

#[test]
fn pending_thread_event_route_promotes_on_thread_started() {
    let index_path = temp_runtime_work_index_path("pending-thread-event-route");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "local-task-1".to_owned();
    let request = ExecutionRequest {
        task_id: "1".to_owned(),
        subtask_id: "42".to_owned(),
        ..ExecutionRequest::default()
    };
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        local_task_id.clone(),
        "/tmp/project".to_owned(),
        "Pending route".to_owned(),
    ));

    handler.register_pending_thread_event_route(local_task_id.clone(), request);

    assert!(!handler.thread_event_route_exists("thread-1"));
    assert!(handler.promote_pending_thread_event_route("thread-1"));
    assert!(handler.thread_event_route_exists("thread-1"));
    let link = handler
        .local_task_link(&local_task_id)
        .expect("local task should be stored");
    assert_eq!(link.thread_id.as_deref(), Some("thread-1"));

    let _ = fs::remove_file(index_path);
}

#[test]
fn cached_codex_link_stays_visible_until_provider_thread_is_discovered() {
    let mut link = RuntimeTaskLink::new_pending(
        "local-task-1".to_owned(),
        "/Users/test/Documents/Codex/2026-07-07/hi".to_owned(),
        "hi".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    link.running = false;
    link.status = "active".to_owned();

    assert!(!is_cached_codex_link_hidden(&link, &HashSet::new()));

    let discovered_thread_ids = HashSet::from(["thread-1".to_owned()]);
    assert!(is_cached_codex_link_hidden(&link, &discovered_thread_ids));
}

#[tokio::test]
async fn create_task_stores_model_selection_in_runtime_handle() {
    let index_path = temp_runtime_work_index_path("create-task-model-selection");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());

    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-1",
                "workspacePath": "/tmp/project",
                "title": "Use mimo",
                "modelId": "local-model:mimo",
                "modelType": "runtime",
                "modelOptions": {
                    "collaborationMode": "plan"
                },
                "executionRequest": serde_json::to_value(ExecutionRequest::default()).unwrap()
            }
        }))
        .await
        .expect("runtime task should be created");
    assert_eq!(
        response["runtimeHandle"]["modelSelection"],
        json!({
            "modelName": "local-model:mimo",
            "modelType": "runtime",
            "options": {
                "collaborationMode": "plan"
            }
        })
    );

    let link = handler
        .local_task_link("local-task-1")
        .expect("created task should be stored");
    assert_eq!(
        link.runtime_handle["modelSelection"],
        json!({
            "modelName": "local-model:mimo",
            "modelType": "runtime",
            "options": {
                "collaborationMode": "plan"
            }
        })
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn active_local_task_skips_global_notification_route() {
    let (event_tx, mut event_rx) = broadcast::channel(8);
    let index_path = temp_runtime_work_index_path("active-local-task-route");
    let mut handler = RuntimeWorkRpcHandler::with_event_sender("device-1", "/bin/false", event_tx);
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let request = ExecutionRequest {
        task_id: local_task_id.to_owned(),
        subtask_id: "runtime-subtask-1".to_owned(),
        ..ExecutionRequest::default()
    };
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some("thread-1".to_owned());
    handler.upsert_local_task(link);
    handler.mark_active_local_task(local_task_id);
    handler.register_thread_event_route("thread-1", local_task_id.to_owned(), request, true);

    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "Hi",
            "itemId": "msg-1",
            "threadId": "thread-1",
            "turnId": "turn-1"
        }
    }));

    assert!(event_rx.try_recv().is_err());

    handler.unmark_active_local_task(local_task_id);
    handler.route_codex_notification(json!({
        "method": "item/agentMessage/delta",
        "params": {
            "delta": "Hi",
            "itemId": "msg-1",
            "threadId": "thread-1",
            "turnId": "turn-1"
        }
    }));

    let event = event_rx
        .try_recv()
        .expect("idle route should emit notification");
    assert_eq!(event["event"], "response.output_text.delta");
    assert_eq!(event["payload"]["taskId"], local_task_id);
    assert_eq!(event["payload"]["subtaskId"], "runtime-subtask-1");
    assert_eq!(event["payload"]["data"]["delta"], "Hi");

    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn transcript_uses_explicit_runtime_handle_session_without_rewriting_local_task_id() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.transcript_cache.insert(
        "provider-session-1",
        CachedTranscript::new(
            "/tmp/project".to_owned(),
            "codex".to_owned(),
            vec![json!({"id":"assistant-1","role":"assistant","content":"cached"})],
            false,
            None,
        ),
    );

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "local-visible-task",
                "workspacePath": "/tmp/project",
                "runtimeHandle": {
                    "threadId": "provider-session-1"
                }
            }
        }))
        .await
        .expect("explicit runtime handle should read cached provider session");

    assert_eq!(result["taskId"], "local-visible-task");
    assert_eq!(result["messages"][0]["content"], "cached");
}

#[test]
fn changed_transcript_messages_replace_tail_from_changed_turn() {
    let cached_messages = vec![
        json!({
            "id": "user-1",
            "role": "user",
            "content": "old",
            "turnId": "turn-1",
        }),
        json!({
            "id": "assistant-turn-2",
            "role": "assistant",
            "content": "stale",
            "turnId": "turn-2",
        }),
    ];
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/workspace",
    });
    let turns = vec![
        json!({
            "id": "turn-1",
            "createdAt": 1,
            "status": "completed",
            "items": [],
        }),
        json!({
            "id": "turn-2",
            "createdAt": 2,
            "status": "completed",
            "items": [
                {"id":"item-2","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"fresh"}]}}
            ],
        }),
    ];

    let messages =
        append_changed_transcript_messages(cached_messages, &thread, &turns, Some(1), "device");

    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["id"], "user-1");
    assert_eq!(messages[1]["id"], "assistant-turn-2");
    assert_eq!(messages[1]["content"], "fresh");
    assert_eq!(messages[1]["subtaskId"], "turn-2");
}

#[test]
fn terminal_local_task_prevents_transcript_running_state() {
    let mut link = RuntimeTaskLink::new_pending(
        "local-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.status = "done".to_owned();
    link.running = false;
    let messages = vec![json!({
        "id": "assistant-1",
        "role": "assistant",
        "status": "streaming",
        "blocks": [
            {
                "id": "tool-1",
                "type": "tool",
                "status": "pending"
            }
        ]
    })];

    assert!(!transcript_running(Some(&link), true, &messages));
}

#[test]
fn incremental_transcript_rejects_changed_rollout_path() {
    let old_path = std::env::temp_dir().join(format!(
        "wegent-old-rollout-{}-{}.jsonl",
        std::process::id(),
        now_ms()
    ));
    let new_path = std::env::temp_dir().join(format!(
        "wegent-new-rollout-{}-{}.jsonl",
        std::process::id(),
        now_ms()
    ));
    std::fs::write(&old_path, "{}\n").unwrap();
    std::fs::write(&new_path, "{}\n").unwrap();
    let cached = CachedTranscript::new(
        "/tmp/project".to_owned(),
        "codex".to_owned(),
        Vec::new(),
        false,
        TranscriptSourceSignature::from_path(&old_path.display().to_string()),
    )
    .with_rollout_turns(Some(vec![json!({
        "id": "turn-1",
        "status": "completed",
        "items": [],
    })]));
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    let thread = json!({
        "id": "thread-1",
        "path": new_path.display().to_string(),
        "cwd": "/tmp/project",
    });

    let result =
        handler.incremental_cached_transcript(cached, &thread, None, false, "/tmp/project");

    assert!(result.is_none());
    let _ = std::fs::remove_file(old_path);
    let _ = std::fs::remove_file(new_path);
}

#[test]
fn archived_cleanup_targets_include_managed_worktree_and_local_attachment() {
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/Users/me/.wegent-executor/workspace/worktrees/task-1/Wegent".to_owned(),
        "Task".to_owned(),
    );
    link.runtime_handle = json!({
        "messages": [
            {
                "attachments": [
                    {
                        "local_path": "/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png"
                    }
                ]
            }
        ]
    });

    let targets = cleanup_targets_for_task(&link);
    let target_paths = targets
        .iter()
        .map(|target| target.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(target_paths
        .contains(&"/Users/me/.wegent-executor/workspace/worktrees/task-1/Wegent".to_owned()));
    assert!(target_paths.contains(
        &"/Users/me/.wegent-executor/workspace/attachments/draft/1/photo.png".to_owned()
    ));
}

#[test]
fn archived_cleanup_targets_do_not_delete_regular_project_root() {
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/Users/me/project".to_owned(),
        "Task".to_owned(),
    );

    let targets = cleanup_targets_for_task(&link);
    let target_paths = targets
        .iter()
        .map(|target| target.path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    assert!(!target_paths.contains(&"/Users/me/project".to_owned()));
    assert!(target_paths.contains(&"/Users/me/project/.wegent/attachments/task-1".to_owned()));
    assert!(target_paths.contains(&"/Users/me/project/task-1:executor:attachments".to_owned()));
}

#[test]
fn orphaned_managed_worktree_links_exclude_known_task_directories() {
    let root = std::env::temp_dir().join(format!(
        "wegent-orphaned-worktrees-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let protected = root.join("runtime-1");
    let orphaned = root.join("runtime-2");
    let ignored = root.join("manual-worktree");
    std::fs::create_dir_all(&protected).unwrap();
    std::fs::create_dir_all(&orphaned).unwrap();
    std::fs::create_dir_all(&ignored).unwrap();

    let links =
        orphaned_managed_worktree_links(&HashSet::from([protected]), std::slice::from_ref(&root));

    assert_eq!(links.len(), 1);
    assert_eq!(links[0].workspace_path, orphaned.to_string_lossy());
    let _ = std::fs::remove_dir_all(root);
}

fn temp_runtime_work_index_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-runtime-work-{label}-{}-{}.json",
        std::process::id(),
        now_ms()
    ))
}
