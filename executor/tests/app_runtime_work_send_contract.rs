// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use rusqlite::Connection;
use serde_json::{json, Value};
use tokio::sync::{broadcast, Mutex, MutexGuard};
use wegent_executor::{local::app_ipc::RuntimeWorkHandler, runtime_work::RuntimeWorkRpcHandler};

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().await
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var(key).ok();
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = &self.previous {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

fn codex_execution_request(prompt: &str, workspace_path: &str, model_id: &str) -> Value {
    execution_request_with_model_config(
        prompt,
        workspace_path,
        json!({
            "model": "openai",
            "model_id": model_id,
            "api_format": "responses",
            "protocol": "openai-responses"
        }),
    )
}

fn execution_request_with_model_config(
    prompt: &str,
    workspace_path: &str,
    model_config: Value,
) -> Value {
    json!({
        "task_id": 1001,
        "subtask_id": 2001,
        "prompt": prompt,
        "project_workspace_path": workspace_path,
        "bot": [{"shell_type": "ClaudeCode"}],
        "model_config": model_config
    })
}

#[tokio::test]
async fn runtime_tasks_send_accepts_address_content_source_and_attachments() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-home", "dir").display().to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-codex-home", "dir")
            .display()
            .to_string(),
    );
    let sqlite_home = temp_path("runtime-send-sqlite", "dir");
    let _sqlite_home = EnvGuard::set("CODEX_SQLITE_HOME", &sqlite_home.display().to_string());
    write_codex_state_db_thread(&sqlite_home);
    let log_path = temp_path("runtime-send-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let (event_tx, mut events) = broadcast::channel(32);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        fake_codex.display().to_string(),
        event_tx,
    );

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-1",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": {
                    "task_id": 1001,
                    "subtask_id": 2001,
                    "prompt": "first turn",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("create should be accepted");
    assert_eq!(created["accepted"], true);
    wait_for_thread_mapping(&handler, "local-task-1", "thread-1").await;
    wait_for_turn_count(&log_path, 1).await;
    wait_for_response_event(&mut events, "response.completed", "2001").await;
    wait_until_task_idle(&handler, "local-task-1").await;
    drain_events(&mut events);

    let source = json!({
        "source": "im",
        "external_id": "session-1",
        "channel_type": "telegram",
        "conversation_id": "conv-1",
        "sender_id": "sender-1"
    });
    let attachment_path = temp_path("runtime-send-photo", "png");
    fs::write(&attachment_path, b"image").expect("attachment image should be writable");
    let attachment_path = attachment_path.display().to_string();
    let attachment = json!({
        "id": 45,
        "original_filename": "photo.png",
        "mime_type": "image/png",
        "file_size": 1200,
        "subtask_id": 0,
        "file_extension": ".png",
        "local_path": attachment_path,
        "local_preview_url": attachment_path
    });
    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "address": {
                    "deviceId": "device-1",
                    "workspacePath": "/tmp/project",
                    "taskId": "local-task-1"
                },
                "content": "continue from content",
                "collaborationMode": "default",
                "executionRequest": execution_request_with_model_config(
                    "continue from content",
                    "/tmp/project",
                    json!({
                        "model": "openai",
                        "model_id": "gpt-4.1",
                        "api_format": "responses",
                        "protocol": "openai-responses",
                        "reasoning": {
                            "effort": "extra_high",
                            "summary": "concise"
                        },
                        "service_tier": "fast"
                    })
                ),
                "source": source,
                "attachments": [attachment],
                "additionalContext": {
                    "wework.terminal.current": {
                        "kind": "application",
                        "value": "terminal output"
                    }
                }
            }
        }))
        .await
        .expect("send should be accepted");

    assert_eq!(sent["success"], true);
    assert_eq!(sent["accepted"], true);
    wait_for_turn_count(&log_path, 2).await;

    let calls = read_json_lines(&log_path);
    let resume = calls
        .iter()
        .find(|call| call["method"] == "thread/resume")
        .expect("send should resume the existing thread");
    assert_eq!(resume["params"]["threadId"], "thread-1");
    assert_eq!(resume["params"]["cwd"], "/tmp/project");
    assert_eq!(resume["params"]["model"], "gpt-4.1");
    assert_eq!(
        resume["params"]["config"]["model_reasoning_effort"],
        "xhigh"
    );
    assert_eq!(
        resume["params"]["config"]["model_reasoning_summary"],
        "concise"
    );
    assert_eq!(resume["params"]["config"]["service_tier"], "priority");

    let last_turn_start = calls
        .iter()
        .rev()
        .find(|call| call["method"] == "turn/start")
        .expect("send should start a turn");
    assert_eq!(last_turn_start["params"]["model"], "gpt-4.1");
    assert_eq!(last_turn_start["params"]["effort"], "xhigh");
    assert_eq!(last_turn_start["params"]["summary"], "concise");
    assert_eq!(
        last_turn_start["params"]["collaborationMode"]["mode"],
        "default"
    );
    assert_eq!(
        last_turn_start["params"]["additionalContext"]["wework.terminal.current"]["value"],
        "terminal output"
    );
    let input = last_turn_start["params"]["input"].as_array().unwrap();
    assert!(input.iter().any(|item| {
        item["type"] == "text"
            && item["text"]
                .as_str()
                .is_some_and(|text| text.contains("continue from content"))
    }));
    assert_eq!(input[0]["type"], "text");
    assert!(input.iter().any(|item| {
        item["type"] == "localImage"
            && item["path"]
                .as_str()
                .is_some_and(|path| path == attachment_path)
    }));

    let runtime_events = recv_events_until(&mut events, |runtime_events| {
        find_runtime_event(runtime_events, "response.created", |event| {
            event["payload"]["source"] == source
        })
        .is_some()
            && find_runtime_event(runtime_events, "response.block.created", |event| {
                let block = &event["payload"]["data"]["block"];
                block["type"] == "text"
                    && block["content"] == "Inspecting "
                    && block["status"] == "streaming"
            })
            .is_some()
            && find_runtime_event(runtime_events, "response.block.updated", |event| {
                let data = &event["payload"]["data"];
                data["updates"]["content"] == "Inspecting workspace."
                    && data["updates"]["status"] == "streaming"
            })
            .is_some()
            && find_runtime_event(runtime_events, "response.output_text.delta", |event| {
                event["payload"]["data"]["delta"] == "done"
            })
            .is_some()
            && find_runtime_event(runtime_events, "response.completed", |event| {
                event["payload"]["data"]["value"] == "done"
            })
            .is_some()
    })
    .await;

    let created_event = find_runtime_event(&runtime_events, "response.created", |event| {
        event["payload"]["source"] == source
    })
    .expect("send should emit response.created with source");
    assert_eq!(created_event["payload"]["source"], source);
    let process_created = find_runtime_event(&runtime_events, "response.block.created", |event| {
        let block = &event["payload"]["data"]["block"];
        block["type"] == "text"
            && block["content"] == "Inspecting "
            && block["status"] == "streaming"
    })
    .expect("commentary delta should create a process text block");
    let process_block_id = process_created["payload"]["data"]["block"]["id"]
        .as_str()
        .expect("process block should have a generated id")
        .to_owned();
    assert_eq!(process_block_id, "text-local-task-1-2001-1");
    assert_eq!(process_created["payload"]["data"]["block"]["type"], "text");
    assert_eq!(
        process_created["payload"]["data"]["block"]["content"],
        "Inspecting "
    );
    assert_eq!(
        process_created["payload"]["data"]["block"]["status"],
        "streaming"
    );

    let process_updated = find_runtime_event(&runtime_events, "response.block.updated", |event| {
        let data = &event["payload"]["data"];
        data["block_id"].as_str() == Some(process_block_id.as_str())
            && data["updates"]["status"] == "streaming"
    })
    .expect("second commentary delta should update the process text block");
    assert_eq!(
        process_updated["payload"]["data"]["block_id"],
        process_block_id
    );
    assert_eq!(
        process_updated["payload"]["data"]["updates"]["content"],
        "Inspecting workspace."
    );
    assert_eq!(
        process_updated["payload"]["data"]["updates"]["status"],
        "streaming"
    );

    let text_delta = find_runtime_event(&runtime_events, "response.output_text.delta", |event| {
        event["payload"]["data"]["delta"] == "done"
    })
    .expect("final answer delta should remain the main output text");
    assert_eq!(text_delta["payload"]["data"]["delta"], "done");
    let completed = find_runtime_event(&runtime_events, "response.completed", |event| {
        event["payload"]["data"]["value"] == "done"
    })
    .expect("completed response should contain only the final answer");
    assert_eq!(completed["payload"]["data"]["value"], "done");
}

#[tokio::test]
async fn runtime_tasks_create_sets_initial_goal_before_first_turn() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-create-goal-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-create-goal-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-create-goal-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-goal",
                "workspacePath": "/tmp/project",
                "message": "ship goal-first",
                "initialGoal": {
                    "objective": "ship goal-first",
                    "status": "active",
                    "tokenBudget": null
                },
                "executionRequest": {
                    "task_id": 5001,
                    "subtask_id": 6001,
                    "prompt": "ship goal-first",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("create should be accepted");
    assert_eq!(created["accepted"], true);
    wait_for_thread_mapping(&handler, "local-task-goal", "thread-1").await;
    wait_for_turn_count(&log_path, 1).await;
    wait_until_task_idle(&handler, "local-task-goal").await;

    let calls = read_json_lines(&log_path);
    let start_index = call_index(&calls, "thread/start");
    let goal_index = call_index(&calls, "thread/goal/set");
    let turn_index = call_index(&calls, "turn/start");
    assert!(
        start_index < goal_index && goal_index < turn_index,
        "expected goal-first order; calls: {calls:?}"
    );

    let goal_call = &calls[goal_index];
    assert_eq!(goal_call["params"]["threadId"], "thread-1");
    assert_eq!(goal_call["params"]["objective"], "ship goal-first");
    assert_eq!(goal_call["params"]["status"], "active");
    assert!(goal_call["params"]["tokenBudget"].is_null());
}

#[tokio::test]
async fn runtime_tasks_create_ephemeral_codex_thread_hidden_from_task_list() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-ephemeral-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-ephemeral-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-ephemeral-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "side-chat-1",
                "workspacePath": "/tmp/project",
                "message": "quick side question",
                "ephemeral": true,
                "sideSource": {
                    "deviceId": "device-1",
                    "taskId": "main-task-1",
                    "workspacePath": "/tmp/project",
                    "runtimeHandle": {
                        "threadId": "parent-thread-1",
                        "threadPath": "/tmp/codex/parent-thread-1.jsonl"
                    }
                },
                "executionRequest": {
                    "task_id": "side-chat-1",
                    "subtask_id": "side-turn-1",
                    "prompt": "quick side question",
                    "project_workspace_path": "/tmp/project",
                    "ephemeral": true,
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("ephemeral create should be accepted");
    assert_eq!(created["accepted"], true);
    wait_for_codex_call(&log_path, "thread/fork").await;
    wait_for_codex_call(&log_path, "thread/inject_items").await;
    wait_for_codex_call(&log_path, "turn/start").await;

    let calls = read_json_lines(&log_path);
    let fork_call = calls
        .iter()
        .find(|call| call["method"] == "thread/fork")
        .expect("thread/fork should be called");
    assert_eq!(fork_call["params"]["threadId"], "parent-thread-1");
    assert_eq!(
        fork_call["params"]["path"],
        "/tmp/codex/parent-thread-1.jsonl"
    );
    assert_eq!(fork_call["params"]["ephemeral"], true);
    let inject_call = calls
        .iter()
        .find(|call| call["method"] == "thread/inject_items")
        .expect("thread/inject_items should be called");
    assert_eq!(inject_call["params"]["threadId"], "thread-1");
    assert!(inject_call["params"]["items"][0]["content"][0]["text"]
        .as_str()
        .is_some_and(|text| text.contains("Side conversation boundary.")));
    assert!(calls.iter().all(|call| call["method"] != "thread/start"));
    assert!(calls.iter().all(|call| call["method"] != "thread/name/set"));
    assert!(calls.iter().all(|call| call["method"] != "thread/goal/set"));

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("runtime task list should succeed");
    assert_eq!(listed["success"], true);
    assert!(listed["workspaces"]
        .as_array()
        .is_some_and(|workspaces| workspaces.is_empty()));
}

#[tokio::test]
async fn runtime_tasks_send_ephemeral_codex_thread_uses_loaded_thread_directly() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-ephemeral-follow-up-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-ephemeral-follow-up-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-ephemeral-follow-up-log", "jsonl");
    let fake_codex = write_fake_codex_ephemeral_two_turns(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "side-chat-follow-up",
                "workspacePath": "/tmp/project",
                "message": "quick side question",
                "ephemeral": true,
                "sideSource": {
                    "deviceId": "device-1",
                    "taskId": "main-task-1",
                    "workspacePath": "/tmp/project",
                    "runtimeHandle": {
                        "threadId": "parent-thread-1",
                        "threadPath": "/tmp/codex/parent-thread-1.jsonl"
                    }
                },
                "executionRequest": {
                    "task_id": "side-chat-follow-up",
                    "subtask_id": "side-turn-1",
                    "prompt": "quick side question",
                    "project_workspace_path": "/tmp/project",
                    "ephemeral": true,
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("ephemeral create should be accepted");
    wait_for_turn_count(&log_path, 1).await;
    wait_until_task_idle(&handler, "side-chat-follow-up").await;

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "taskId": "side-chat-follow-up",
                "workspacePath": "/tmp/project",
                "message": "follow up",
                "executionRequest": {
                    "task_id": "side-chat-follow-up",
                    "subtask_id": "side-turn-2",
                    "prompt": "follow up",
                    "project_workspace_path": "/tmp/project",
                    "ephemeral": true,
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("ephemeral follow-up should be accepted");
    assert_eq!(sent["accepted"], true);
    wait_for_turn_count(&log_path, 2).await;
    wait_until_task_idle(&handler, "side-chat-follow-up").await;

    let calls = read_json_lines(&log_path);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/fork")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/resume")
            .count(),
        0
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/unsubscribe")
            .count(),
        0
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        2
    );
}

#[tokio::test]
async fn runtime_tasks_reuse_one_codex_process_across_follow_up_turns() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-persistent-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-persistent-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-persistent-log", "jsonl");
    let fake_codex = write_fake_codex_persistent_two_turns(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-persistent",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": {
                    "task_id": 5101,
                    "subtask_id": 6101,
                    "prompt": "first turn",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("create should be accepted");
    assert_eq!(created["accepted"], true);
    wait_for_thread_mapping(&handler, "local-task-persistent", "thread-persistent").await;
    wait_until_task_idle(&handler, "local-task-persistent").await;

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "taskId": "local-task-persistent",
                "workspacePath": "/tmp/project",
                "message": "second turn",
                "executionRequest": {
                    "task_id": 5101,
                    "subtask_id": 6102,
                    "prompt": "second turn",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("send should be accepted");
    assert_eq!(sent["accepted"], true);
    wait_for_turn_count(&log_path, 2).await;
    wait_until_task_idle(&handler, "local-task-persistent").await;

    let calls = read_json_lines(&log_path);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "initialize")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/start")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/resume")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/unsubscribe")
            .count(),
        2
    );
}

#[tokio::test]
async fn runtime_tasks_share_one_codex_app_server_across_handlers() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-shared-handlers-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-shared-handlers-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-shared-handlers-log", "jsonl");
    let fake_codex = write_fake_codex_persistent_two_turns(&log_path);
    let codex_binary = fake_codex.display().to_string();
    let handler_a = RuntimeWorkRpcHandler::new("device-1", codex_binary.clone());
    let handler_b = RuntimeWorkRpcHandler::new("device-1", codex_binary);

    handler_a
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("first handler list should succeed");
    handler_b
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("second handler list should succeed");

    wait_for_method_count(&log_path, "thread/list", 2).await;
    let calls = read_json_lines(&log_path);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "initialize")
            .count(),
        1,
        "handlers using the same Codex binary should share one app-server process"
    );
}

#[tokio::test]
async fn runtime_tasks_do_not_restart_shared_codex_app_server_after_turn_failure() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-turn-failure-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-turn-failure-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-turn-failure-log", "jsonl");
    let fake_codex = write_fake_codex_failed_first_turn_stays_alive(&log_path);
    let (event_tx, mut events) = broadcast::channel(64);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        fake_codex.display().to_string(),
        event_tx,
    );

    let failed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-fail-once",
                "workspacePath": "/tmp/project",
                "message": "first turn fails",
                "executionRequest": {
                    "task_id": 5201,
                    "subtask_id": 6201,
                    "prompt": "first turn fails",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("failed turn create should still be accepted");
    assert_eq!(failed["accepted"], true);
    wait_for_response_event(&mut events, "response.failed", "6201").await;
    wait_until_task_idle(&handler, "local-task-fail-once").await;

    let recovered = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-after-failure",
                "workspacePath": "/tmp/project",
                "message": "second turn succeeds",
                "executionRequest": {
                    "task_id": 5201,
                    "subtask_id": 6202,
                    "prompt": "second turn succeeds",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("second create should be accepted on the same shared app-server");
    assert_eq!(recovered["accepted"], true);
    wait_for_response_event(&mut events, "response.completed", "6202").await;
    wait_until_task_idle(&handler, "local-task-after-failure").await;

    let calls = read_json_lines(&log_path);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "initialize")
            .count(),
        1,
        "a failed turn must not restart the shared app-server while the process is still alive"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        2
    );
}

#[tokio::test]
async fn runtime_tasks_route_interleaved_codex_notifications_by_thread_id() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-interleaved-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-interleaved-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-interleaved-log", "jsonl");
    let fake_codex = write_fake_codex_interleaved_threads(&log_path);
    let (event_tx, mut events) = broadcast::channel(128);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        fake_codex.display().to_string(),
        event_tx,
    );

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-a",
                "workspacePath": "/tmp/project",
                "message": "task a",
                "executionRequest": {
                    "task_id": 5301,
                    "subtask_id": 6301,
                    "prompt": "task a",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("first create should be accepted");
    wait_for_thread_mapping(&handler, "local-task-a", "thread-a").await;

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-b",
                "workspacePath": "/tmp/project",
                "message": "task b",
                "executionRequest": {
                    "task_id": 5302,
                    "subtask_id": 6302,
                    "prompt": "task b",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("second create should be accepted");

    let routed_events = recv_events_until(&mut events, |received| {
        find_runtime_event(received, "response.output_text.delta", |event| {
            event["payload"]["taskId"] == "local-task-a"
                && event["payload"]["data"]["delta"] == "alpha"
        })
        .is_some()
            && find_runtime_event(received, "response.output_text.delta", |event| {
                event["payload"]["taskId"] == "local-task-b"
                    && event["payload"]["data"]["delta"] == "beta"
            })
            .is_some()
            && find_runtime_event(received, "response.completed", |event| {
                event["payload"]["taskId"] == "local-task-a"
                    && event["payload"]["data"]["value"] == "alpha"
            })
            .is_some()
            && find_runtime_event(received, "response.completed", |event| {
                event["payload"]["taskId"] == "local-task-b"
                    && event["payload"]["data"]["value"] == "beta"
            })
            .is_some()
    })
    .await;

    assert!(
        find_runtime_event(&routed_events, "response.output_text.delta", |event| {
            event["payload"]["taskId"] == "local-task-a"
                && event["payload"]["data"]["delta"] == "beta"
        })
        .is_none(),
        "thread-b delta must not be routed to local-task-a"
    );
    assert!(
        find_runtime_event(&routed_events, "response.output_text.delta", |event| {
            event["payload"]["taskId"] == "local-task-b"
                && event["payload"]["data"]["delta"] == "alpha"
        })
        .is_none(),
        "thread-a delta must not be routed to local-task-b"
    );
    wait_until_task_idle(&handler, "local-task-a").await;
    wait_until_task_idle(&handler, "local-task-b").await;
}

#[tokio::test]
async fn runtime_tasks_keep_shared_codex_alive_for_goal_continuation() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-goal-continuation-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-goal-continuation-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-goal-continuation-log", "jsonl");
    let fake_codex = write_fake_codex_goal_continuation(&log_path);
    let (event_tx, mut events) = broadcast::channel(64);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        fake_codex.display().to_string(),
        event_tx,
    );

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-goal-loop",
                "workspacePath": "/tmp/project",
                "message": "ship goal",
                "initialGoal": {
                    "objective": "ship goal",
                    "status": "active",
                    "tokenBudget": null
                },
                "executionRequest": {
                    "task_id": 5002,
                    "subtask_id": 6002,
                    "prompt": "ship goal",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("create should be accepted");
    assert_eq!(created["accepted"], true);

    wait_for_thread_mapping(&handler, "local-task-goal-loop", "thread-goal").await;
    let goal_events = recv_events_until(&mut events, |received| {
        find_runtime_event(received, "response.completed", |event| {
            event["payload"]["subtaskId"] == "6002"
        })
        .is_some()
            && find_runtime_event(received, "runtime.goal.updated", |event| {
                event["payload"]["data"]["goal"]["status"] == "complete"
            })
            .is_some()
    })
    .await;
    assert!(
        find_runtime_event(&goal_events, "runtime.goal.updated", |event| {
            event["payload"]["data"]["goal"]["status"] == "complete"
        })
        .is_some()
    );
    wait_until_task_idle(&handler, "local-task-goal-loop").await;

    let calls = read_json_lines(&log_path);
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "thread/start")
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count(),
        1
    );
}

#[tokio::test]
async fn runtime_tasks_send_answers_pending_request_user_input_while_running() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-request-user-input-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-request-user-input-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-request-user-input-log", "jsonl");
    let fake_codex = write_fake_codex_request_user_input(&log_path);
    let (event_tx, mut events) = broadcast::channel(32);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        fake_codex.display().to_string(),
        event_tx,
    );

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-input",
                "workspacePath": "/tmp/project",
                "message": "ask me",
                "executionRequest": {
                    "task_id": 3001,
                    "subtask_id": 4001,
                    "prompt": "ask me",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("create should be accepted");
    assert_eq!(created["accepted"], true);

    let request_events = recv_events_until(&mut events, |runtime_events| {
        find_runtime_event(runtime_events, "response.block.created", |event| {
            let block = &event["payload"]["data"]["block"];
            block["tool_name"] == "request_user_input" && block["render_payload"]["requestId"] == 99
        })
        .is_some()
    })
    .await;
    let block_event = find_runtime_event(&request_events, "response.block.created", |event| {
        event["payload"]["data"]["block"]["tool_name"] == "request_user_input"
    })
    .expect("request_user_input block should be emitted");
    assert_eq!(
        block_event["payload"]["data"]["block"]["render_payload"]["questions"][0]["id"],
        "goal"
    );

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "address": {
                    "deviceId": "device-1",
                    "workspacePath": "/tmp/project",
                    "taskId": "local-task-input"
                },
                "message": "Work goal",
                "requestUserInputResponse": {
                    "requestId": 99,
                    "answers": {
                        "goal": { "answers": ["Work goal"] }
                    }
                }
            }
        }))
        .await
        .expect("request_user_input answer should be accepted");

    assert_eq!(sent["success"], true);
    assert_eq!(sent["accepted"], true);
    wait_until_task_idle(&handler, "local-task-input").await;

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| {
        call["id"] == 99 && call["result"]["answers"]["goal"]["answers"][0] == "Work goal"
    }));
}

#[tokio::test]
async fn runtime_tasks_send_includes_local_text_attachment_content() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-text-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-text-codex-home", "dir")
            .display()
            .to_string(),
    );
    let sqlite_home = temp_path("runtime-send-text-sqlite", "dir");
    let _sqlite_home = EnvGuard::set("CODEX_SQLITE_HOME", &sqlite_home.display().to_string());
    write_codex_state_db_thread(&sqlite_home);
    let log_path = temp_path("runtime-send-text-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let (event_tx, mut events) = broadcast::channel(32);
    let handler = RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        fake_codex.display().to_string(),
        event_tx,
    );

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-text",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": {
                    "task_id": 1002,
                    "subtask_id": 2002,
                    "prompt": "first turn",
                    "project_workspace_path": "/tmp/project",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5.5",
                        "api_format": "responses"
                    }
                }
            }
        }))
        .await
        .expect("create should be accepted");
    wait_for_thread_mapping(&handler, "local-task-text", "thread-1").await;
    wait_for_turn_count(&log_path, 1).await;
    wait_for_response_event(&mut events, "response.completed", "2002").await;
    wait_until_task_idle(&handler, "local-task-text").await;
    drain_events(&mut events);

    let attachment_path = temp_path("runtime-send-pasted-text", "txt");
    fs::write(&attachment_path, "THE_USER_PASTED_TEXT_ATTACHMENT").unwrap();
    let attachment_path = attachment_path.display().to_string();
    let attachment = json!({
        "id": -46,
        "original_filename": "clipboard-text.txt",
        "mime_type": "text/plain",
        "file_size": 31,
        "local_path": attachment_path,
        "local_preview_url": attachment_path
    });

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "address": {
                    "deviceId": "device-1",
                    "workspacePath": "/tmp/project",
                    "taskId": "local-task-text"
                },
                "content": "我贴的是啥",
                "executionRequest": codex_execution_request("我贴的是啥", "/tmp/project", "gpt-4.1"),
                "attachments": [attachment]
            }
        }))
        .await
        .expect("send should be accepted");

    assert_eq!(sent["success"], true);
    wait_for_turn_count(&log_path, 2).await;

    let calls = read_json_lines(&log_path);
    let last_turn_start = calls
        .iter()
        .rev()
        .find(|call| call["method"] == "turn/start")
        .expect("send should start a turn");
    let input_text = last_turn_start["params"]["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["type"] == "text")
        .filter_map(|item| item["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(input_text.contains("clipboard-text.txt"));
    assert!(input_text.contains("THE_USER_PASTED_TEXT_ATTACHMENT"));
    assert!(input_text.contains("我贴的是啥"));
}

#[tokio::test]
async fn runtime_tasks_create_rejects_missing_execution_request() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-create-missing-request-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-create-missing-request-codex-home", "dir")
            .display()
            .to_string(),
    );
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let error = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-1",
                "message": "first turn",
                "modelId": "gpt-5.5"
            }
        }))
        .await
        .expect_err("create without executionRequest should fail fast");

    assert_eq!(error.code, "bad_request");
    assert_eq!(error.message, "executionRequest is required");
}

#[tokio::test]
async fn runtime_tasks_send_rejects_missing_execution_request() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-missing-request-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-missing-request-codex-home", "dir")
            .display()
            .to_string(),
    );
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let error = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-1",
                "message": "second turn",
                "modelId": "gpt-5.5"
            }
        }))
        .await
        .expect_err("send without executionRequest should fail fast");

    assert_eq!(error.code, "bad_request");
    assert_eq!(error.message, "executionRequest is required");
}

#[tokio::test]
async fn runtime_tasks_send_rejects_running_local_task_until_cancelled() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-cancel-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-cancel-codex-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex_hanging_turn(&temp_path("runtime-send-cancel-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-1",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": codex_execution_request("first turn", "/tmp/project", "gpt-5.5")
            }
        }))
        .await
        .expect("create should be accepted");
    wait_until_task_running(&handler, "local-task-1").await;

    let rejected = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-1",
                "message": "second turn"
            }
        }))
        .await
        .expect("running send should return a contract response");
    assert_eq!(
        rejected,
        json!({
            "success": false,
            "error": "runtime task is already running",
            "code": "bad_request"
        })
    );

    let cancelled = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.cancel",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-1"
            }
        }))
        .await
        .expect("cancel should be accepted");
    assert_eq!(cancelled["accepted"], true);
}

#[tokio::test]
async fn runtime_tasks_guidance_steers_running_codex_turn() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-guidance-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-guidance-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-guidance-log", "jsonl");
    let fake_codex = write_fake_codex_hanging_turn(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-guide",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": codex_execution_request("first turn", "/tmp/project", "gpt-5.5")
            }
        }))
        .await
        .expect("create should be accepted");
    wait_until_task_running(&handler, "local-task-guide").await;
    wait_for_method_count(&log_path, "turn/start", 1).await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;

    let guided = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.guidance",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-guide",
                "message": "use this steering input",
                "clientGuidanceId": "guide-1",
                "additionalContext": {
                    "wework.terminal.current": {
                        "kind": "application",
                        "value": "terminal output"
                    }
                }
            }
        }))
        .await
        .expect("guidance should return a contract response");

    assert_eq!(
        guided,
        json!({
            "success": true,
            "accepted": true,
            "guidance_id": "guide-1",
            "guidanceId": "guide-1",
            "taskId": "local-task-guide",
            "turnId": "turn-1",
            "runtime": "codex"
        })
    );
    wait_for_method_count(&log_path, "turn/steer", 1).await;
    let calls = read_json_lines(&log_path);
    let steer = calls
        .iter()
        .find(|call| call["method"] == "turn/steer")
        .expect("guidance should steer the active turn");
    assert_eq!(
        steer["params"]["additionalContext"]["wework.terminal.current"]["value"],
        "terminal output"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| call["method"] == "turn/interrupt")
            .count(),
        0
    );
}

#[tokio::test]
async fn runtime_tasks_cancel_interrupts_running_codex_turn_without_killing_app_server() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-cancel-kill-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-cancel-kill-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-cancel-kill-log", "jsonl");
    let fake_codex = write_fake_codex_interruptible_turn(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-cancel",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": codex_execution_request("first turn", "/tmp/project", "gpt-5.5")
            }
        }))
        .await
        .expect("create should be accepted");
    let pid = wait_for_logged_pid(&log_path, "persistent-pid:").await;

    let cancelled = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.cancel",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-cancel"
            }
        }))
        .await
        .expect("cancel should be accepted");

    assert_eq!(cancelled["accepted"], true);
    wait_for_method_count(&log_path, "turn/interrupt", 1).await;
    assert_process_alive(pid);
}

#[tokio::test]
async fn runtime_tasks_cancel_does_not_kill_shared_app_server_process_group() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-cancel-group-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-cancel-group-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-cancel-group-log", "jsonl");
    let fake_codex = write_fake_codex_spawns_worker(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-cancel-group",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": codex_execution_request("first turn", "/tmp/project", "gpt-5.5")
            }
        }))
        .await
        .expect("create should be accepted");
    let parent_pid = wait_for_logged_pid(&log_path, "persistent-pid:").await;
    let worker_pid = wait_for_logged_pid(&log_path, "worker-pid:").await;

    let cancelled = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.cancel",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-task-cancel-group"
            }
        }))
        .await
        .expect("cancel should be accepted");

    assert_eq!(cancelled["accepted"], true);
    wait_for_method_count(&log_path, "turn/interrupt", 1).await;
    assert_process_alive(parent_pid);
    assert_process_alive(worker_pid);
    kill_process(worker_pid);
}

#[tokio::test]
async fn runtime_tasks_send_after_cancel_resumes_started_thread_not_local_task_id() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-guide-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-guide-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-send-guide-log", "jsonl");
    let fake_codex = write_fake_codex_slow_first_turn(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-visible-task",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "executionRequest": codex_execution_request("first turn", "/tmp/project", "gpt-5.5")
            }
        }))
        .await
        .expect("create should be accepted");
    wait_for_thread_mapping(&handler, "local-visible-task", "thread-1").await;

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.cancel",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-visible-task"
            }
        }))
        .await
        .expect("cancel should be accepted");

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "local-visible-task",
                "message": "second turn",
                "executionRequest": codex_execution_request("second turn", "/tmp/project", "gpt-5.5")
            }
        }))
        .await
        .expect("send should be accepted");
    assert_eq!(sent["accepted"], true);

    wait_for_method_count(&log_path, "thread/resume", 1).await;
    let calls = read_json_lines(&log_path);
    let resume = calls
        .iter()
        .rev()
        .find(|call| call["method"] == "thread/resume")
        .expect("send should resume a provider thread");
    assert_eq!(resume["params"]["threadId"], "thread-1");
}

#[tokio::test]
async fn runtime_tasks_send_uses_nested_address_runtime_handle_without_local_index() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-address-handle-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-address-handle-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-send-address-handle-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "address": {
                    "deviceId": "device-1",
                    "workspacePath": "/tmp/project",
                    "taskId": "local-visible-task",
                    "runtimeHandle": {
                        "threadId": "thread-1"
                    }
                },
                "content": "continue from address handle",
                "executionRequest": codex_execution_request(
                    "continue from address handle",
                    "/tmp/project",
                    "gpt-4.1"
                )
            }
        }))
        .await
        .expect("send should be accepted");
    assert_eq!(sent["accepted"], true);

    wait_for_method_count(&log_path, "thread/resume", 1).await;
    let calls = read_json_lines(&log_path);
    let resume = calls
        .iter()
        .find(|call| call["method"] == "thread/resume")
        .expect("send should resume the nested runtime handle");
    assert_eq!(resume["params"]["threadId"], "thread-1");
}

#[tokio::test]
async fn runtime_tasks_send_recovers_thread_from_unique_workspace_when_visible_task_id_is_stale() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-send-stale-visible-id-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-send-stale-visible-id-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-send-stale-visible-id-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let sent = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/tmp/project",
                "taskId": "runtime-visible-stale-id",
                "message": "continue stale visible task",
                "executionRequest": codex_execution_request(
                    "continue stale visible task",
                    "/tmp/project",
                    "gpt-4.1"
                )
            }
        }))
        .await
        .expect("send should be accepted");
    assert_eq!(sent["accepted"], true);

    wait_for_method_count(&log_path, "thread/resume", 1).await;
    let calls = read_json_lines(&log_path);
    let list = calls
        .iter()
        .find(|call| call["method"] == "thread/list")
        .expect("send should recover from thread list");
    assert_eq!(list["params"]["sortKey"], "updated_at");
    let resume = calls
        .iter()
        .find(|call| call["method"] == "thread/resume")
        .expect("send should resume the recovered provider thread");
    assert_eq!(resume["params"]["threadId"], "thread-1");
}

#[tokio::test]
async fn runtime_tasks_rollback_uses_nested_address_runtime_handle_without_local_index() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-rollback-address-handle-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-rollback-address-handle-codex-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("runtime-rollback-address-handle-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let rollback = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.rollback",
            "payload": {
                "address": {
                    "deviceId": "device-1",
                    "workspacePath": "/tmp/project",
                    "taskId": "local-visible-task",
                    "runtimeHandle": {
                        "threadId": "thread-1"
                    }
                },
                "message": "edited from address handle",
                "messageId": "user-last",
                "executionRequest": codex_execution_request(
                    "edited from address handle",
                    "/tmp/project",
                    "gpt-4.1"
                )
            }
        }))
        .await
        .expect("rollback should be accepted");
    assert_eq!(rollback["accepted"], true);

    wait_for_method_count(&log_path, "thread/rollback", 1).await;
    wait_for_method_count(&log_path, "turn/start", 1).await;
    wait_for_thread_mapping(&handler, "local-visible-task", "thread-1").await;
    let calls = read_json_lines(&log_path);
    let rollback = calls
        .iter()
        .find(|call| call["method"] == "thread/rollback")
        .expect("rollback should use the nested runtime handle");
    assert_eq!(rollback["params"]["threadId"], "thread-1");
    assert_eq!(rollback["params"]["numTurns"], 1);
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-send", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-1","createdAt":1780000000,"items":[{{"id":"user-1","type":"userMessage","content":[{{"type":"text","text":"first turn"}}]}},{{"id":"agent-1","type":"agentMessage","text":"done","phase":"final_answer"}}]}}]}}}}}}'
      exit 0
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/fork"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/inject_items"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"thread/goal/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"goal":{{"threadId":"thread-1","objective":"ship goal-first","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1780000000,"updatedAt":1780000000}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"thread/rollback"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/goal/get"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"goal":null}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      progress_id='progress-1'
      case "$line" in
        *'"model":"gpt-4.1"'*) progress_id='progress-2' ;;
      esac
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/started","params":{{"item":{{"id":"'"$progress_id"'","type":"agentMessage","phase":"commentary"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"item_id":"'"$progress_id"'","delta":"Inspecting "}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"item_id":"'"$progress_id"'","delta":"workspace."}}}}'
      printf '%s\n' '{{"method":"item/completed","params":{{"item":{{"id":"'"$progress_id"'","type":"agentMessage","text":"Inspecting workspace.","phase":"commentary"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"delta":"done","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"completed"}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_ephemeral_two_turns(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-ephemeral-two-turns", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
turn_count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"parent-thread-1","cwd":"/tmp/project","name":"Parent","preview":"parent","path":"/tmp/codex/parent-thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/fork"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-ephemeral"}}}}}}'
      ;;
    *'"method":"thread/inject_items"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":'"$request_id"',"error":{{"message":"ephemeral thread should not resume"}}}}'
      ;;
    *'"method":"turn/start"'*)
      turn_count=$((turn_count + 1))
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-'"$turn_count"'","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-ephemeral","turnId":"turn-'"$turn_count"'","delta":"done '"$turn_count"'","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-ephemeral","turn":{{"id":"turn-'"$turn_count"'","status":"completed"}}}}}}'
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_goal_continuation(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-goal-continuation", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-goal","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-goal.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-goal"}}}}}}'
      ;;
    *'"method":"thread/goal/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"goal":{{"threadId":"thread-goal","objective":"ship goal","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1780000000,"updatedAt":1780000000}}}}}}'
      printf '%s\n' '{{"method":"thread/goal/updated","params":{{"threadId":"thread-goal","goal":{{"threadId":"thread-goal","objective":"ship goal","status":"active","tokenBudget":null,"tokensUsed":0,"timeUsedSeconds":0,"createdAt":1780000000,"updatedAt":1780000000}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-goal","turnId":"turn-1","delta":"first","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-goal","turn":{{"id":"turn-1","status":"completed"}}}}}}'
      printf '%s\n' '{{"method":"turn/started","params":{{"threadId":"thread-goal","turn":{{"id":"turn-2","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-goal","turnId":"turn-2","delta":"second","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"thread/goal/updated","params":{{"threadId":"thread-goal","turnId":"turn-2","goal":{{"threadId":"thread-goal","objective":"ship goal","status":"complete","tokenBudget":null,"tokensUsed":10,"timeUsedSeconds":2,"createdAt":1780000000,"updatedAt":1780000002}}}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-goal","turn":{{"id":"turn-2","status":"completed"}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_persistent_two_turns(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-persistent-two-turns", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
turn_count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-persistent","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-persistent.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-persistent"}}}}}}'
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-persistent"}}}}}}'
      ;;
    *'"method":"thread/goal/get"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"goal":null}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      turn_count=$((turn_count + 1))
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-'"$turn_count"'","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-persistent","turnId":"turn-'"$turn_count"'","delta":"done '"$turn_count"'","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-persistent","turn":{{"id":"turn-'"$turn_count"'","status":"completed"}}}}}}'
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_failed_first_turn_stays_alive(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-failed-first-turn", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
thread_start_count=0
turn_start_count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      thread_start_count=$((thread_start_count + 1))
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-failure-'"$thread_start_count"'"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      turn_start_count=$((turn_start_count + 1))
      if [ "$turn_start_count" -eq 1 ]; then
        printf '%s\n' '{{"id":'"$request_id"',"error":{{"message":"synthetic turn failure"}}}}'
      else
        printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-recovered","status":"inProgress"}}}}}}'
        printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-failure-2","turnId":"turn-recovered","delta":"recovered","phase":"finalAnswer"}}}}'
        printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-failure-2","turn":{{"id":"turn-recovered","status":"completed"}}}}}}'
      fi
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_interleaved_threads(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-interleaved-threads", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
thread_start_count=0
turn_start_count=0
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      thread_start_count=$((thread_start_count + 1))
      if [ "$thread_start_count" -eq 1 ]; then
        thread_id='thread-a'
      else
        thread_id='thread-b'
      fi
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"'"$thread_id"'"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      turn_start_count=$((turn_start_count + 1))
      if [ "$turn_start_count" -eq 1 ]; then
        printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-a","status":"inProgress"}}}}}}'
      else
        printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-b","status":"inProgress"}}}}}}'
        printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-a","turnId":"turn-a","delta":"alpha","phase":"finalAnswer"}}}}'
        printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"threadId":"thread-b","turnId":"turn-b","delta":"beta","phase":"finalAnswer"}}}}'
        printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-a","turn":{{"id":"turn-a","status":"completed"}}}}}}'
        printf '%s\n' '{{"method":"turn/completed","params":{{"threadId":"thread-b","turn":{{"id":"turn-b","status":"completed"}}}}}}'
      fi
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_request_user_input(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-request-user-input", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  if printf '%s\n' "$line" | grep -q '"method":"initialize"'; then
    printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
  elif printf '%s\n' "$line" | grep -q '"method":"thread/list"'; then
    printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-input","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-input.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
  elif printf '%s\n' "$line" | grep -q '"method":"thread/start"'; then
    printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-input"}}}}}}'
  elif printf '%s\n' "$line" | grep -q '"method":"thread/goal/get"'; then
    printf '%s\n' '{{"id":'"$request_id"',"result":{{"goal":null}}}}'
  elif printf '%s\n' "$line" | grep -q '"method":"thread/name/set"'; then
    printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
  elif printf '%s\n' "$line" | grep -q '"method":"turn/start"'; then
    printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-input","status":"inProgress"}}}}}}'
    printf '%s\n' '{{"id":99,"method":"item/tool/requestUserInput","params":{{"threadId":"thread-input","turnId":"turn-input","itemId":"item-input","questions":[{{"id":"goal","header":"工作目标","question":"你希望我接下来问你哪些问题？","options":[{{"label":"Work goal","description":"Focus on one concrete task."}}]}}],"autoResolutionMs":null}}}}'
  elif printf '%s\n' "$line" | grep -q '"id":99' && printf '%s\n' "$line" | grep -q '"result"'; then
    printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"delta":"answered","phase":"finalAnswer"}}}}'
    printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-input","status":"completed"}}}}}}'
    exit 0
  fi
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_slow_first_turn(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-send-guide", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"inProgress","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/goal/get"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"goal":null}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      case "$line" in
        *'second turn'*)
          printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-2","status":"completed"}}}}}}'
          exit 0
          ;;
      esac
      sleep 2
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"completed"}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_hanging_turn(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-send-hang", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Runtime task","preview":"runtime","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"inProgress","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      ;;
    *'"method":"turn/steer"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turnId":"turn-1"}}}}'
      ;;
    *'"method":"turn/interrupt"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"cancelled"}}}}}}'
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_interruptible_turn(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-cancel-kill", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
printf 'persistent-pid:%s\n' "$$" >> "$LOG_PATH"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      ;;
    *'"method":"turn/interrupt"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"cancelled"}}}}}}'
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_fake_codex_spawns_worker(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-cancel-group", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
printf 'persistent-pid:%s\n' "$$" >> "$LOG_PATH"
worker_pid=''
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      if [ -z "$worker_pid" ]; then
        sh -c 'trap "" TERM; while true; do sleep 1; done' &
        worker_pid=$!
        printf 'worker-pid:%s\n' "$worker_pid" >> "$LOG_PATH"
      fi
      ;;
    *'"method":"turn/interrupt"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"cancelled"}}}}}}'
      ;;
  esac
done
"#,
        log_path.display()
    );
    write_executable(&path, &content);
    path
}

fn write_executable(path: &Path, content: &str) {
    fs::write(path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions).unwrap();
    }
}

fn temp_path(prefix: &str, extension: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "{prefix}-{}-{nanos}.{extension}",
        std::process::id(),
    ))
}

fn write_codex_state_db_thread(sqlite_home: &Path) {
    fs::create_dir_all(sqlite_home).unwrap();
    let connection = Connection::open(sqlite_home.join("state_5.sqlite")).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE threads (
                id TEXT PRIMARY KEY,
                rollout_path TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                source TEXT NOT NULL,
                model_provider TEXT NOT NULL,
                cwd TEXT NOT NULL,
                title TEXT NOT NULL,
                sandbox_policy TEXT NOT NULL DEFAULT '',
                approval_mode TEXT NOT NULL DEFAULT '',
                tokens_used INTEGER NOT NULL DEFAULT 0,
                has_user_event INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                archived_at INTEGER,
                git_sha TEXT,
                git_branch TEXT,
                git_origin_url TEXT,
                cli_version TEXT NOT NULL DEFAULT '',
                first_user_message TEXT NOT NULL DEFAULT '',
                agent_nickname TEXT,
                agent_role TEXT,
                memory_mode TEXT NOT NULL DEFAULT 'enabled',
                model TEXT,
                reasoning_effort TEXT,
                agent_path TEXT,
                created_at_ms INTEGER,
                updated_at_ms INTEGER,
                thread_source TEXT,
                preview TEXT NOT NULL DEFAULT ''
            );
            "#,
        )
        .unwrap();
    connection
        .execute(
            r#"
            INSERT INTO threads (
                id, rollout_path, created_at, updated_at, source, model_provider,
                cwd, title, archived, cli_version, created_at_ms, updated_at_ms, preview
            )
            VALUES (
                'thread-1',
                '/tmp/codex/thread-1.jsonl',
                1780000000,
                1780000060,
                'vscode',
                'openai',
                '/tmp/project',
                'Runtime task',
                0,
                'test',
                1780000000000,
                1780000060000,
                'runtime'
            )
            "#,
            (),
        )
        .unwrap();
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter(|line| line.trim_start().starts_with('{'))
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect()
}

fn call_index(calls: &[Value], method: &str) -> usize {
    calls
        .iter()
        .position(|call| call["method"] == method)
        .unwrap_or_else(|| panic!("expected {method} call in {calls:?}"))
}

async fn wait_for_codex_call(path: &Path, method: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if read_json_lines(path)
            .iter()
            .any(|call| call["method"].as_str() == Some(method))
        {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "codex call {method} was not logged"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

async fn wait_for_thread_mapping(
    handler: &RuntimeWorkRpcHandler,
    local_task_id: &str,
    thread_id: &str,
) {
    for _ in 0..50 {
        let listed = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.list",
                "payload": {}
            }))
            .await
            .expect("list should succeed");
        let mapped = listed["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|workspace| workspace["tasks"].as_array().into_iter().flatten())
            .any(|task| {
                task["taskId"] == local_task_id && task["runtimeHandle"]["threadId"] == thread_id
            });
        if mapped {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("runtime task mapping was not persisted");
}

async fn wait_for_method_count(log_path: &Path, method: &str, expected: usize) {
    for _ in 0..200 {
        let calls = read_json_lines(log_path);
        let count = calls.iter().filter(|call| call["method"] == method).count();
        if count >= expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("expected at least {expected} {method} calls");
}

async fn wait_for_logged_pid(log_path: &Path, prefix: &str) -> u32 {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let content = fs::read_to_string(log_path).unwrap_or_default();
        if let Some(pid) = content.lines().find_map(|line| {
            line.strip_prefix(prefix)
                .and_then(|value| value.trim().parse::<u32>().ok())
        }) {
            return pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for fake codex pid with prefix {prefix:?}; content:\n{content}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

fn assert_process_alive(pid: u32) {
    assert!(
        process_exists(pid),
        "cancel should not terminate shared fake codex process {pid}"
    );
}

fn kill_process(pid: u32) {
    let _ = std::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

fn process_exists(pid: u32) -> bool {
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

async fn wait_until_task_running(handler: &RuntimeWorkRpcHandler, local_task_id: &str) {
    for _ in 0..50 {
        let listed = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.list",
                "payload": {}
            }))
            .await
            .expect("list should succeed");
        let running = listed["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|workspace| workspace["tasks"].as_array().into_iter().flatten())
            .any(|task| task["taskId"] == local_task_id && task["running"] == true);
        if running {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("runtime task did not become running");
}

async fn wait_until_task_idle(handler: &RuntimeWorkRpcHandler, local_task_id: &str) {
    for _ in 0..50 {
        let listed = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.list",
                "payload": {}
            }))
            .await
            .expect("list should succeed");
        let running = listed["workspaces"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|workspace| workspace["tasks"].as_array().into_iter().flatten())
            .any(|task| task["taskId"] == local_task_id && task["running"] == true);
        if !running {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("runtime task did not become idle");
}

async fn wait_for_turn_count(log_path: &Path, expected_turns: usize) {
    for _ in 0..50 {
        let count = read_json_lines(log_path)
            .iter()
            .filter(|call| call["method"] == "turn/start")
            .count();
        if count >= expected_turns {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("expected at least {expected_turns} turn/start calls");
}

fn drain_events(events: &mut broadcast::Receiver<Value>) {
    while events.try_recv().is_ok() {}
}

async fn recv_events_until<F>(events: &mut broadcast::Receiver<Value>, mut done: F) -> Vec<Value>
where
    F: FnMut(&[Value]) -> bool,
{
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    let mut received = Vec::new();
    loop {
        if done(&received) {
            return received;
        }

        let message = tokio::time::timeout_at(deadline, events.recv())
            .await
            .unwrap_or_else(|_| {
                let names = received
                    .iter()
                    .map(|event| event["event"].as_str().unwrap_or("<missing>"))
                    .collect::<Vec<_>>()
                    .join(", ");
                panic!("timed out waiting for expected runtime events; received: {names}");
            })
            .expect("runtime event channel should stay open");
        received.push(message);
    }
}

async fn wait_for_response_event(
    events: &mut broadcast::Receiver<Value>,
    event_name: &str,
    subtask_id: &str,
) {
    recv_events_until(events, |received| {
        find_runtime_event(received, event_name, |event| {
            event["payload"]["subtaskId"] == subtask_id
        })
        .is_some()
    })
    .await;
}

fn find_runtime_event<'a, F>(
    events: &'a [Value],
    event_name: &str,
    mut matches: F,
) -> Option<&'a Value>
where
    F: FnMut(&Value) -> bool,
{
    events
        .iter()
        .find(|event| event["event"] == event_name && matches(event))
}
