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

use serde_json::{json, Value};
use tokio::sync::{Mutex, MutexGuard};
use wegent_executor::{
    local::app_ipc::{AppIpcServer, RuntimeWorkHandler},
    runtime_work::RuntimeWorkRpcHandler,
};

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
async fn app_runtime_lists_codex_threads_through_app_server() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-list-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("wegent-app-runtime-list-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let server = AppIpcServer::new()
        .with_device_id("device-1")
        .with_local_runtime_work_handler(fake_codex.display().to_string());

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-list",
                "method": "runtime.tasks.list",
                "params": {}
            })
            .to_string(),
        )
        .await
        .expect("app IPC should return a response");

    assert_eq!(response["ok"], true);
    let result = &response["result"];
    assert_eq!(result["success"], true);
    assert_eq!(result["workspaces"][0]["workspacePath"], "/tmp/project");
    assert_eq!(result["workspaces"][0]["workspaceKind"], "workspace");
    assert_eq!(
        result["workspaces"][0]["localTasks"][0]["localTaskId"],
        "thread-1"
    );
    assert_eq!(result["workspaces"][0]["localTasks"][0]["runtime"], "codex");
    assert_eq!(result["workspaces"][0]["localTasks"][0]["title"], "Fix CI");
    assert_eq!(
        result["workspaces"][0]["localTasks"][0]["runtimeHandle"]["threadId"],
        "thread-1"
    );

    let calls = read_json_lines(&log_path);
    assert_eq!(calls[0]["method"], "initialize");
    assert_eq!(calls[1]["method"], "initialized");
    assert_eq!(calls[2]["method"], "thread/list");
    assert_eq!(calls[2]["params"]["useStateDbOnly"], true);
}

#[tokio::test]
async fn app_runtime_reads_codex_thread_transcript_through_app_server() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-transcript-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-transcript-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project",
                "limit": 50
            }
        }))
        .await
        .expect("runtime transcript should succeed");

    assert_eq!(response["success"], true);
    assert_eq!(response["localTaskId"], "thread-1");
    assert_eq!(response["workspacePath"], "/tmp/project");
    assert_eq!(response["runtime"], "codex");
    assert_eq!(response["messages"][0]["role"], "user");
    assert_eq!(response["messages"][0]["content"], "please fix ci");
    assert_eq!(response["messages"][1]["role"], "assistant");
    assert_eq!(response["messages"][1]["content"], "done");
    assert_eq!(response["messages"][1]["blocks"][0]["type"], "thinking");
    assert_eq!(
        response["messages"][1]["blocks"][0]["content"],
        "inspect failure"
    );
    assert_eq!(response["messages"][1]["blocks"][1]["type"], "tool");
    assert_eq!(response["messages"][1]["blocks"][1]["tool_name"], "bash");
    assert_eq!(
        response["messages"][1]["blocks"][1]["tool_input"]["command"],
        "cargo test"
    );
    assert_eq!(
        response["messages"][1]["blocks"][1]["tool_output"],
        "test result: ok\n"
    );
    assert_eq!(response["hasMoreBefore"], false);
    assert_eq!(response["beforeCursor"], Value::Null);
}

#[tokio::test]
async fn app_runtime_persists_local_task_thread_mapping() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-store-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-store-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "localTaskId": "local-task-1",
                "workspacePath": "/tmp/project",
                "title": "Persist me",
                "executionRequest": {
                    "prompt": "please persist",
                    "bot": [{"shell_type": "ClaudeCode"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5",
                        "api_format": "responses",
                        "protocol": "openai-responses"
                    },
                    "project_workspace_path": "/tmp/project"
                }
            }
        }))
        .await
        .expect("create should be accepted");

    assert_eq!(created["accepted"], true);
    assert_eq!(created["localTaskId"], "local-task-1");

    let restored_handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());
    let restored = wait_for_persisted_mapping(&restored_handler).await;

    assert_eq!(
        restored["workspaces"][0]["localTasks"][0]["localTaskId"],
        "local-task-1"
    );
    assert_eq!(
        restored["workspaces"][0]["localTasks"][0]["runtimeHandle"]["threadId"],
        "thread-1"
    );
}

#[tokio::test]
async fn app_runtime_archives_and_unarchives_codex_threads_through_app_server() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-archive-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("wegent-app-runtime-archive-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let archived = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("archive should succeed");

    assert_eq!(archived["success"], true);
    assert_eq!(archived["accepted"], true);
    assert_eq!(archived["localTaskId"], "thread-1");
    assert_eq!(archived["workspacePath"], "/tmp/project");

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.list",
            "payload": {}
        }))
        .await
        .expect("archived list should succeed");

    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["localTaskId"], "thread-1");
    assert_eq!(listed["items"][0]["workspacePath"], "/tmp/project");
    assert_eq!(listed["items"][0]["source"], "local");

    let unarchived = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.unarchive",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("unarchive should succeed");

    assert_eq!(unarchived["success"], true);
    assert_eq!(unarchived["accepted"], true);
    assert_eq!(unarchived["localTaskId"], "thread-1");

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| call["method"] == "thread/archive"));
    assert!(calls
        .iter()
        .any(|call| call["method"] == "thread/unarchive"));
    assert!(calls
        .iter()
        .any(|call| call["method"] == "thread/list" && call["params"]["archived"] == true));
}

#[tokio::test]
async fn app_runtime_deletes_archived_codex_threads_through_app_server() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-delete-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("wegent-app-runtime-delete-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("archive should succeed");

    let deleted = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.delete",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("delete should succeed");

    assert_eq!(deleted["success"], true);
    assert_eq!(deleted["accepted"], true);
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["localTaskId"], "thread-1");

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| call["method"] == "thread/delete"));
}

#[tokio::test]
async fn app_runtime_renames_codex_threads_through_app_server() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-rename-home", "dir")
            .display()
            .to_string(),
    );
    let log_path = temp_path("wegent-app-runtime-rename-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let renamed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.rename",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project",
                "title": "New Codex Title"
            }
        }))
        .await
        .expect("rename should succeed");

    assert_eq!(renamed["success"], true);
    assert_eq!(renamed["accepted"], true);
    assert_eq!(renamed["localTaskId"], "thread-1");

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("runtime task list should succeed");

    assert_eq!(
        listed["workspaces"][0]["localTasks"][0]["title"],
        "New Codex Title"
    );

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| {
        call["method"] == "thread/name/set" && call["params"]["name"] == "New Codex Title"
    }));
}

#[tokio::test]
async fn app_runtime_searches_codex_titles_and_transcripts() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-search-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-search-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let title_result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.search",
            "payload": {"query": "fix", "limit": 10}
        }))
        .await
        .expect("title search should succeed");

    assert_eq!(title_result["success"], true);
    assert_eq!(
        title_result["items"][0]["address"]["localTaskId"],
        "thread-1"
    );
    assert_eq!(title_result["items"][0]["address"]["deviceId"], "device-1");
    assert_eq!(title_result["items"][0]["title"], "Fix CI");
    assert_eq!(title_result["items"][0]["snippet"], "Fix CI");
    assert_eq!(title_result["items"][0]["messageRole"], "title");

    let transcript_result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.search",
            "payload": {"query": "please", "limit": 10}
        }))
        .await
        .expect("transcript search should succeed");

    assert_eq!(transcript_result["success"], true);
    assert_eq!(
        transcript_result["items"][0]["address"]["localTaskId"],
        "thread-1"
    );
    assert_eq!(transcript_result["items"][0]["snippet"], "please fix ci");
    assert_eq!(transcript_result["items"][0]["messageRole"], "user");
}

#[tokio::test]
async fn app_runtime_search_excludes_archived_threads_by_default() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-search-archive-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-search-archive-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "localTaskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("archive should succeed");

    let default_result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.search",
            "payload": {"query": "fix", "limit": 10}
        }))
        .await
        .expect("default search should succeed");
    let archived_result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.search",
            "payload": {"query": "fix", "limit": 10, "includeArchived": true}
        }))
        .await
        .expect("archived search should succeed");

    assert_eq!(default_result["success"], true);
    assert_eq!(default_result["items"].as_array().unwrap().len(), 0);
    assert_eq!(
        archived_result["items"][0]["address"]["localTaskId"],
        "thread-1"
    );
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-app-runtime", "sh");
    let _ = fs::remove_file(log_path);
    let content = format!(
        r#"#!/bin/sh
LOG_PATH='{}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$LOG_PATH"
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":1,"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*'"archived":true'*)
      printf '%s\n' '{{"id":2,"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"archived","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":2,"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-1","createdAt":1780000000,"items":[{{"id":"user-1","type":"userMessage","content":[{{"type":"text","text":"please fix ci"}}]}},{{"id":"reason-1","type":"reasoning","summary":["inspect failure"]}},{{"id":"cmd-1","type":"commandExecution","command":"cargo test","cwd":"/tmp/project","status":"completed","aggregatedOutput":"test result: ok\n","exitCode":0}},{{"id":"agent-1","type":"agentMessage","text":"done","phase":"final_answer"}}]}}]}}}}}}'
      exit 0
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/archive"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/unarchive"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/delete"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":2,"result":{{"thread":{{"id":"thread-1","name":"New Codex Title"}}}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":3,"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"delta":"done","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"completed"}}}}}}'
      exit 0
      ;;
  esac
done
"#,
        log_path.display()
    );
    fs::write(&path, content).unwrap();
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&path, permissions).unwrap();
    }
    path
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

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect()
}

async fn wait_for_persisted_mapping(handler: &RuntimeWorkRpcHandler) -> Value {
    for _ in 0..50 {
        let response = handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.list",
                "payload": {}
            }))
            .await
            .expect("runtime task list should succeed");
        if response["workspaces"][0]["localTasks"][0]["localTaskId"] == "local-task-1"
            && response["workspaces"][0]["localTasks"][0]["runtimeHandle"]["threadId"] == "thread-1"
        {
            return response;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("persisted local task mapping was not restored");
}
