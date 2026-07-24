// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn finishing_an_active_goal_keeps_the_task_idle() {
    let index_path = temp_runtime_work_index_path("finish-active-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.goal_status = Some("active".to_owned());
    handler.upsert_local_task(link);

    handler.finish_local_task("task-1", Some("thread-1".to_owned()), "done");

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.status, "done");
    assert!(!task.running);
    assert_eq!(task.goal_status.as_deref(), Some("active"));

    let _ = fs::remove_file(index_path);
}

#[test]
fn syncing_an_active_goal_does_not_start_an_idle_task() {
    let index_path = temp_runtime_work_index_path("sync-active-goal");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let mut link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.status = "done".to_owned();
    link.running = false;
    handler.upsert_local_task(link);

    handler.sync_runtime_task_goal_status("task-1", Some("active".to_owned()));

    let task = handler
        .local_task_link("task-1")
        .expect("task should remain stored");
    assert_eq!(task.status, "done");
    assert!(!task.running);
    assert_eq!(task.goal_status.as_deref(), Some("active"));

    let _ = fs::remove_file(index_path);
}

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
fn current_codex_model_provider_hides_internal_catalog_provider() {
    let provider = current_codex_model_provider_from_config(&json!({
        "config": {
            "model_provider": "wework-catalog",
            "model_providers": {
                "wework-catalog": {"name": "Wework model catalog"}
            }
        }
    }));

    assert_eq!(provider.id, "openai");
    assert_eq!(provider.display_name, "CodeX");
    assert_eq!(provider.kind, "official");
}

#[test]
fn runtime_session_ids_only_accept_codex_uuid_thread_ids() {
    assert!(is_codex_thread_id("019f4c0d-b036-78f3-b879-7e5ed203ad61"));
    assert!(is_codex_thread_id(
        "urn:uuid:019f4c0d-b036-78f3-b879-7e5ed203ad61"
    ));
    assert!(!is_codex_thread_id("runtime-481327491"));
    assert!(!is_codex_thread_id("thread-1"));

    let mut link = RuntimeTaskLink::new_pending(
        "runtime-481327491".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.thread_id = Some(link.local_task_id.clone());
    assert_eq!(
        runtime_session_id_from_link(&link).as_deref(),
        Some("runtime-481327491")
    );
    assert_eq!(codex_thread_id_from_link(&link), None);
}

#[test]
fn imported_runtime_task_ids_are_unique() {
    let first = fork_transfer::next_imported_task_id();
    let second = fork_transfer::next_imported_task_id();

    assert_ne!(first, second);
    assert!(first.starts_with("runtime-fork-"));
    assert!(second.starts_with("runtime-fork-"));
}

#[test]
fn runtime_turn_ids_are_persisted_by_subtask() {
    let index_path = temp_runtime_work_index_path("runtime-turn-id");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    handler.upsert_local_task(RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    ));

    handler.record_runtime_turn_id("task-1", "subtask-1", "turn-1");

    let link = handler
        .local_task_link("task-1")
        .expect("task should exist");
    assert_eq!(
        tasks::runtime_turn_id_from_link(&link, "subtask-1").as_deref(),
        Some("turn-1")
    );
    assert_eq!(
        tasks::resolve_codex_turn_id(&link, "subtask-1").as_deref(),
        Some("turn-1")
    );
    assert_eq!(
        tasks::resolve_codex_turn_id(&link, "turn-1").as_deref(),
        Some("turn-1")
    );
    assert_eq!(
        tasks::resolve_codex_turn_id(&link, "019f933f-bf0d-72e3-b366-a6539ab00bcf").as_deref(),
        Some("019f933f-bf0d-72e3-b366-a6539ab00bcf")
    );
    assert_eq!(tasks::resolve_codex_turn_id(&link, "missing-turn"), None);
    let _ = fs::remove_file(index_path);
}

#[tokio::test]
async fn archived_delete_falls_back_inline_when_enqueue_fails() {
    let index_path = temp_runtime_work_index_path("delete-enqueue-fallback");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let (archived_delete_tx, archived_delete_rx) = mpsc::unbounded_channel();
    drop(archived_delete_rx);
    handler.archived_delete_tx = archived_delete_tx;
    let link = RuntimeTaskLink::new_pending(
        "task-1".to_owned(),
        "/tmp/runtime-work-delete-enqueue-fallback".to_owned(),
        "Task".to_owned(),
    );
    handler.upsert_local_task(link.clone());

    let response = handler.delete_archived_link(link).await;

    assert_eq!(response["deleted"], true);
    assert_eq!(response["cleanup"]["background"], false);
    assert!(handler.local_task_link("task-1").is_none());
    let _ = fs::remove_file(index_path);
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
        &json!({
            "message": "visible user text",
            "clientMessageId": "runtime-local-pane-1"
        }),
    )
    .expect("payload message should create a cached user message");

    assert_eq!(message["content"], "visible user text");
    assert_eq!(message["clientMessageId"], "runtime-local-pane-1");

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
fn transcript_appends_cached_user_message_missing_from_failed_provider_turn() {
    let mut provider_messages = vec![
        json!({"id": "user-1", "role": "user", "content": "first"}),
        json!({"id": "assistant-1", "role": "assistant", "content": "done"}),
    ];
    let cached_messages = vec![
        json!({"id": "cached-user-1", "role": "user", "content": "first"}),
        json!({"id": "cached-user-2", "role": "user", "content": "retry this"}),
    ];

    append_missing_cached_user_messages(&mut provider_messages, cached_messages);

    assert_eq!(provider_messages.len(), 3);
    assert_eq!(provider_messages[2]["id"], "cached-user-2");
    assert_eq!(provider_messages[2]["content"], "retry this");
}

#[test]
fn transcript_does_not_duplicate_cached_user_messages_already_from_provider() {
    let mut provider_messages = vec![
        json!({"id": "user-1", "role": "user", "content": "same"}),
        json!({"id": "user-2", "role": "user", "content": "same"}),
    ];
    let cached_messages = vec![
        json!({"id": "cached-user-1", "role": "user", "content": "same"}),
        json!({"id": "cached-user-2", "role": "user", "content": "same"}),
    ];

    append_missing_cached_user_messages(&mut provider_messages, cached_messages);

    assert_eq!(provider_messages.len(), 2);
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
    let handler = RuntimeWorkRpcHandler::new("device-1", "unused-codex-binary");

    let result = handler
        .restart_codex_app_server_with_expected_models(json!({"ifIdle": true}), Vec::new())
        .await
        .expect("restart should return success");

    assert_eq!(result["restarted"], true);
    assert_eq!(result["requiresConfirmation"], false);
    assert_eq!(result["activeTaskCount"], 0);
}

#[tokio::test]
async fn codex_app_server_restart_requires_confirmation_for_active_turns() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler
        .active_codex_turns
        .lock()
        .expect("active Codex turn registry should not be poisoned")
        .insert(
            "thread-1".to_owned(),
            ActiveCodexTurn {
                thread_id: "thread-1".to_owned(),
                turn_id: "turn-1".to_owned(),
            },
        );

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.codex.app_server.restart",
            "payload": {"ifIdle": true}
        }))
        .await
        .expect("active restart check should return success");

    assert_eq!(result["restarted"], false);
    assert_eq!(result["requiresConfirmation"], true);
    assert_eq!(result["activeTaskCount"], 1);
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
    assert!(combined.contains("Wework built-in browser"));
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
                "modelSelection": {
                    "modelName": "shared-model",
                    "modelType": "user",
                    "options": {
                        "collaborationMode": "plan",
                        "reasoningEffort": "high"
                    }
                },
                "executionRequest": serde_json::to_value(ExecutionRequest::default()).unwrap()
            }
        }))
        .await
        .expect("runtime task should be created");
    assert_eq!(
        response["runtimeHandle"]["modelSelection"],
        json!({
            "modelName": "shared-model",
            "modelType": "user",
            "options": {
                "collaborationMode": "plan",
                "reasoningEffort": "high"
            }
        })
    );

    let link = handler
        .local_task_link("local-task-1")
        .expect("created task should be stored");
    assert_eq!(
        link.runtime_handle["modelSelection"],
        json!({
            "modelName": "shared-model",
            "modelType": "user",
            "options": {
                "collaborationMode": "plan",
                "reasoningEffort": "high"
            }
        })
    );

    let _ = fs::remove_file(index_path);
}

#[test]
fn model_selection_falls_back_to_execution_model_for_legacy_requests() {
    let mut runtime_handle = json!({});

    set_runtime_handle_model_selection(
        &mut runtime_handle,
        &json!({
            "modelId": "legacy-model",
            "modelType": "runtime",
            "modelOptions": {"reasoningEffort": "medium"}
        }),
    );

    assert_eq!(
        runtime_handle["modelSelection"],
        json!({
            "modelName": "legacy-model",
            "modelType": "runtime",
            "options": {"reasoningEffort": "medium"}
        })
    );
}

#[test]
fn task_list_running_state_comes_from_executor_memory() {
    let index_path = temp_runtime_work_index_path("authoritative-running-state");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let thread = json!({
        "id": "thread-1",
        "cwd": "/tmp/project",
        "status": {"type": "active"},
        "turns": [{"status": "inProgress"}]
    });

    let idle_link = handler
        .link_from_thread(&thread)
        .expect("active Codex thread should produce a task link");

    assert!(!idle_link.running);
    assert_eq!(idle_link.status, "active");
    assert_eq!(idle_link.thread_status, "idle");
    assert_eq!(idle_link.turn_status.as_deref(), Some("completed"));

    handler.upsert_local_task(RuntimeTaskLink {
        local_task_id: "task-1".to_owned(),
        thread_id: Some("thread-1".to_owned()),
        workspace_path: "/tmp/project".to_owned(),
        ..RuntimeTaskLink::default()
    });
    handler.mark_active_local_task("task-1");

    let running_link = handler
        .link_from_thread(&thread)
        .expect("executor-owned task should produce a task link");

    assert!(running_link.running);
    assert_eq!(running_link.status, "running");
    assert_eq!(running_link.thread_status, "active");
    assert_eq!(running_link.turn_status.as_deref(), Some("inProgress"));

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
    link.updated_at = 1_780_000_000_000;
    handler.upsert_local_task(link);
    handler.mark_active_local_task(local_task_id);
    handler.register_thread_event_route("thread-1", local_task_id.to_owned(), request, true);

    assert_eq!(
        handler
            .store
            .get_task(local_task_id)
            .expect("registered task should remain stored")
            .updated_at,
        1_780_000_000_000
    );

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

#[test]
fn thread_read_repairs_legacy_activity_time_pollution() {
    let index_path = temp_runtime_work_index_path("repair-legacy-activity-time");
    let mut handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");
    handler.store = RuntimeWorkStore::new(index_path.clone());
    let local_task_id = "runtime-task-1";
    let mut link = RuntimeTaskLink::new_pending(
        local_task_id.to_owned(),
        "/tmp/project".to_owned(),
        "Task".to_owned(),
    );
    link.status = "done".to_owned();
    link.running = false;
    link.updated_at = 1_790_000_000_000;
    link.completed_at = None;
    handler.upsert_local_task(link);

    handler.repair_legacy_task_activity_time(local_task_id, &json!({"updatedAt": 1_780_000_000}));

    let repaired = handler
        .store
        .get_task(local_task_id)
        .expect("repaired task should remain stored");
    assert_eq!(repaired.updated_at, 1_780_000_000_000);
    assert_eq!(repaired.completed_at, Some(1_780_000_000_000));
    let _ = fs::remove_file(index_path);
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
fn guidance_inputs_include_only_local_images() {
    let attachments = json!([
        {
            "mime_type": "image/png",
            "local_path": "/tmp/screenshot.png"
        },
        {
            "mime_type": "text/plain",
            "local_path": "/tmp/notes.txt"
        },
        {
            "mime_type": "image/jpeg"
        }
    ]);

    assert_eq!(
        guidance_image_inputs(Some(&attachments)),
        vec![json!({
            "type": "localImage",
            "path": "/tmp/screenshot.png"
        })]
    );
    assert_eq!(
        guidance_input_items("", Some(&attachments)),
        vec![json!({
            "type": "localImage",
            "path": "/tmp/screenshot.png"
        })]
    );
    assert!(guidance_input_items("", None).is_empty());
}

#[test]
fn codex_guidance_turn_races_are_reported_as_no_active_turn() {
    assert_eq!(
        codex_guidance_failure_code("no active turn to steer"),
        "no_active_turn"
    );
    assert_eq!(
        codex_guidance_failure_code("expected active turn id `turn-1` but found `turn-2`"),
        "no_active_turn"
    );
    assert_eq!(
        codex_guidance_failure_code("turn/steer response missing turnId"),
        "guidance_failed"
    );
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

fn temp_runtime_work_index_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-runtime-work-{label}-{}-{}.json",
        std::process::id(),
        now_ms()
    ))
}
