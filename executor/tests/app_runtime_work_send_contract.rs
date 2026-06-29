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
                "localTaskId": "local-task-1",
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
                    "localTaskId": "local-task-1"
                },
                "content": "continue from content",
                "modelId": "gpt-4.1",
                "source": source,
                "attachments": [attachment]
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

    let last_turn_start = calls
        .iter()
        .rev()
        .find(|call| call["method"] == "turn/start")
        .expect("send should start a turn");
    assert_eq!(last_turn_start["params"]["model"], "gpt-4.1");
    let input = last_turn_start["params"]["input"].as_array().unwrap();
    assert!(input.iter().any(|item| {
        item["type"] == "text"
            && item["text"]
                .as_str()
                .is_some_and(|text| text.contains("continue from content"))
    }));
    assert!(input.iter().any(|item| {
        item["type"] == "localImage"
            && item["path"]
                .as_str()
                .is_some_and(|path| path == attachment_path)
    }));

    let created_event = recv_event(&mut events, "response.created").await;
    assert_eq!(created_event["payload"]["source"], source);

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "local-task-1"
            }
        }))
        .await
        .expect("transcript should succeed");
    let user = transcript["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["content"] == "continue from content")
        .expect("cached follow-up user message should be present");
    assert_eq!(user["source"], source);
    assert_eq!(user["attachments"][0]["filename"], "photo.png");
    assert_eq!(user["attachments"][0]["status"], "ready");
    assert_eq!(user["attachments"][0]["file_size"], 1200);
    assert_eq!(user["attachments"][0]["local_preview_url"], attachment_path);
    assert_eq!(user["attachments"][0]["local_path"], attachment_path);
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
                "localTaskId": "local-task-text",
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
                    "localTaskId": "local-task-text"
                },
                "content": "我贴的是啥",
                "modelId": "gpt-4.1",
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
async fn runtime_tasks_send_rejects_missing_model_without_execution_request() {
    let handler = RuntimeWorkRpcHandler::new("device-1", "/bin/false");

    let error = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.send",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "local-task-1",
                "message": "second turn"
            }
        }))
        .await
        .expect_err("send without executionRequest or modelId should fail fast");

    assert_eq!(error.code, "bad_request");
    assert_eq!(
        error.message,
        "modelId is required when executionRequest is not provided"
    );
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
                "localTaskId": "local-task-1",
                "workspacePath": "/tmp/project",
                "message": "first turn",
                "modelId": "gpt-5.5"
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
                "localTaskId": "local-task-1",
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
                "localTaskId": "local-task-1"
            }
        }))
        .await
        .expect("cancel should be accepted");
    assert_eq!(cancelled["accepted"], true);
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
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
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
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      sleep 1
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
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect()
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
            .flat_map(|workspace| workspace["localTasks"].as_array().into_iter().flatten())
            .any(|task| {
                task["localTaskId"] == local_task_id
                    && task["runtimeHandle"]["threadId"] == thread_id
            });
        if mapped {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("runtime task mapping was not persisted");
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
            .flat_map(|workspace| workspace["localTasks"].as_array().into_iter().flatten())
            .any(|task| task["localTaskId"] == local_task_id && task["running"] == true);
        if running {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("runtime task did not become running");
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

async fn recv_event(events: &mut broadcast::Receiver<Value>, event: &str) -> Value {
    for _ in 0..20 {
        let message = tokio::time::timeout(std::time::Duration::from_millis(200), events.recv())
            .await
            .expect("timed out waiting for runtime event")
            .expect("runtime event channel should stay open");
        if message["event"] == event {
            return message;
        }
    }
    panic!("did not receive event {event}");
}
