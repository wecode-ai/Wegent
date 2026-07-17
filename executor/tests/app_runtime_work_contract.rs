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
use tokio::sync::{Mutex, MutexGuard};
use wegent_executor::{
    local::app_ipc::{AppIpcServer, RuntimeWorkHandler},
    runtime_work::RuntimeWorkRpcHandler,
};

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = LOCK.get_or_init(|| Mutex::new(())).lock().await;
    std::env::set_var("WEGENT_DISABLE_CODEX_APP_NOTIFY", "1");
    guard
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

fn set_temp_codex_home(prefix: &str) -> EnvGuard {
    EnvGuard::set(
        "CODEX_HOME",
        &temp_path(prefix, "dir").display().to_string(),
    )
}

fn set_temp_codex_sqlite_home(prefix: &str) -> (EnvGuard, PathBuf) {
    let sqlite_home = temp_path(prefix, "dir");
    let guard = EnvGuard::set("CODEX_SQLITE_HOME", &sqlite_home.display().to_string());
    (guard, sqlite_home)
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-list-codex-home");
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
    assert_eq!(result["workspaces"][0]["tasks"][0]["taskId"], "thread-1");
    assert_eq!(result["workspaces"][0]["tasks"][0]["runtime"], "codex");
    assert_eq!(result["workspaces"][0]["tasks"][0]["title"], "Fix CI");
    assert_eq!(
        result["workspaces"][0]["tasks"][0]["runtimeHandle"]["threadId"],
        "thread-1"
    );

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| call["method"] == "thread/list"));
}

#[tokio::test]
async fn app_runtime_preserves_codex_thread_list_recency_order() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-list-order-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("wegent-app-runtime-list-order-codex-home");
    let log_path = temp_path("wegent-app-runtime-list-order-log", "jsonl");
    let fake_codex = write_fake_codex_recency_order(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("runtime task list should succeed");

    let task_ids = listed["workspaces"][0]["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|task| task["taskId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        task_ids,
        vec!["thread-recency-first", "thread-updated-first"]
    );
    assert_eq!(listed["workspaces"][0]["updatedAt"], 1780000060000_i64);
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-transcript-codex-home");
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-transcript-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let response = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project",
                "runtimeHandle": {"threadId": "thread-1"},
                "limit": 50
            }
        }))
        .await
        .expect("runtime transcript should succeed");

    assert_eq!(response["success"], true);
    assert_eq!(response["taskId"], "thread-1");
    assert_eq!(response["workspacePath"], "/tmp/project");
    assert_eq!(response["runtime"], "codex");
    assert_eq!(response["messages"][0]["role"], "user");
    assert_eq!(response["messages"][0]["content"], "please fix ci");
    assert_eq!(
        response["messages"][0]["attachments"][0]["filename"],
        "screenshot.png"
    );
    assert_eq!(
        response["messages"][0]["attachments"][0]["local_preview_url"],
        "/tmp/codex-clipboard/screenshot.png"
    );
    assert_eq!(
        response["messages"][0]["attachments"][0]["mime_type"],
        "image/png"
    );
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
async fn app_runtime_pages_codex_thread_transcript_from_provider() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-transcript-page-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("wegent-app-runtime-transcript-page-codex-home");
    let log_path = temp_path("wegent-app-runtime-transcript-page-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let latest = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project",
                "runtimeHandle": {"threadId": "thread-1"},
                "limit": 1
            }
        }))
        .await
        .expect("latest transcript page should succeed");
    let older = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project",
                "runtimeHandle": {"threadId": "thread-1"},
                "limit": 1,
                "beforeCursor": "offset:1"
            }
        }))
        .await
        .expect("older transcript page should succeed");

    assert_eq!(latest["messages"].as_array().unwrap().len(), 1);
    assert_eq!(latest["messages"][0]["role"], "assistant");
    assert_eq!(latest["hasMoreBefore"], true);
    assert_eq!(latest["beforeCursor"], "offset:1");
    assert_eq!(older["messages"].as_array().unwrap().len(), 1);
    assert_eq!(older["messages"][0]["role"], "user");
    assert_eq!(older["hasMoreBefore"], false);
    assert_eq!(older["beforeCursor"], Value::Null);

    let read_count = read_json_lines(&log_path)
        .into_iter()
        .filter(|line| line["method"] == "thread/read")
        .count();
    assert_eq!(read_count, 2);
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
    let codex_home = temp_path("wegent-app-runtime-store-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    fs::create_dir_all(&codex_home).unwrap();
    fs::write(
        codex_home.join(".codex-global-state.json"),
        serde_json::to_vec_pretty(&json!({
            "electron-saved-workspace-roots": ["/tmp/project"],
            "project-order": ["/tmp/project"],
            "thread-workspace-root-hints": {},
            "projectless-thread-ids": ["thread-1"]
        }))
        .unwrap(),
    )
    .unwrap();
    let (_sqlite_home_guard, sqlite_home) =
        set_temp_codex_sqlite_home("wegent-app-runtime-store-sqlite");
    write_default_codex_state_db_thread(&sqlite_home, false);
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-store-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "local-task-1",
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
    assert_eq!(created["taskId"], "local-task-1");

    let restored_handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());
    let restored = wait_for_persisted_mapping(&restored_handler).await;

    assert_eq!(
        restored["workspaces"][0]["tasks"][0]["taskId"],
        "local-task-1"
    );
    assert_eq!(
        restored["workspaces"][0]["tasks"][0]["runtimeHandle"]["threadId"],
        "thread-1"
    );
    let codex_state: Value = serde_json::from_str(
        &fs::read_to_string(codex_home.join(".codex-global-state.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        codex_state["thread-workspace-root-hints"]["thread-1"],
        "/tmp/project"
    );
    assert_eq!(codex_state["projectless-thread-ids"], json!([]));
}

#[tokio::test]
async fn app_runtime_create_standalone_chat_generates_default_workspace() {
    let _lock = env_lock().await;
    let home = temp_path("wegent-app-runtime-chat-home", "dir");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-chat-store-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("wegent-app-runtime-chat-codex-home");
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-chat-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let created = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.create",
            "payload": {
                "taskId": "standalone-chat-1",
                "title": "Standalone chat",
                "executionRequest": {
                    "task_id": 1904,
                    "subtask_id": 1905,
                    "prompt": "ordinary device task",
                    "bot": [{"shell_type": "Codex"}],
                    "model_config": {
                        "model": "openai",
                        "model_id": "gpt-5",
                        "api_format": "responses",
                        "protocol": "openai-responses"
                    },
                    "project_id": 0,
                    "standalone_chat_workspace": true
                }
            }
        }))
        .await
        .expect("standalone chat create should be accepted");

    assert_eq!(created["accepted"], true);
    assert_eq!(created["taskId"], "standalone-chat-1");
    let workspace_path = created["workspacePath"].as_str().unwrap();
    assert!(workspace_path.contains("/Documents/Codex/"));
    assert!(workspace_path.ends_with("/standalone-chat-1"));
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-archive-codex-home");
    let (_sqlite_home_guard, sqlite_home) =
        set_temp_codex_sqlite_home("wegent-app-runtime-archive-sqlite");
    write_default_codex_state_db_thread(&sqlite_home, false);
    let log_path = temp_path("wegent-app-runtime-archive-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let archived = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("archive should succeed");

    assert_eq!(archived["success"], true);
    assert_eq!(archived["accepted"], true);
    assert_eq!(archived["taskId"], "thread-1");
    assert_eq!(archived["workspacePath"], "/tmp/project");

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.list",
            "payload": {}
        }))
        .await
        .expect("archived list should succeed");

    assert_eq!(listed["total"], 1);
    assert_eq!(listed["items"][0]["taskId"], "thread-1");
    assert_eq!(listed["items"][0]["workspacePath"], "/tmp/project");
    assert_eq!(listed["items"][0]["source"], "local");

    let unarchived = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.unarchive",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("unarchive should succeed");

    assert_eq!(unarchived["success"], true);
    assert_eq!(unarchived["accepted"], true);
    assert_eq!(unarchived["taskId"], "thread-1");

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| call["method"] == "thread/archive"));
    assert!(calls
        .iter()
        .any(|call| call["method"] == "thread/unarchive"));
    assert!(calls
        .iter()
        .any(|call| { call["method"] == "thread/list" && call["params"]["archived"] == true }));
}

#[tokio::test]
async fn app_runtime_archive_cleans_codex_threads_with_missing_rollout() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("wegent-app-runtime-missing-rollout-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("wegent-app-runtime-missing-rollout-codex-home");
    let log_path = temp_path("wegent-app-runtime-missing-rollout-log", "jsonl");
    let fake_codex = write_fake_codex_missing_rollout_on_archive(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let archived = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("archive cleanup should succeed");

    assert_eq!(archived["success"], true);
    assert_eq!(archived["accepted"], true);
    assert_eq!(archived["cleaned"], true);
    assert_eq!(archived["cleanupReason"], "missing_rollout");

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("runtime task list should succeed");
    let active_task_ids = listed["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|workspace| workspace["tasks"].as_array().unwrap().iter())
        .map(|task| task["taskId"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(!active_task_ids.contains(&"thread-1"));

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().any(|call| call["method"] == "thread/archive"));
    assert!(calls.iter().any(|call| call["method"] == "thread/delete"));
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-delete-codex-home");
    let log_path = temp_path("wegent-app-runtime-delete-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("archive should succeed");

    let deleted = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.delete",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("delete should succeed");

    assert_eq!(deleted["success"], true);
    assert_eq!(deleted["accepted"], true);
    assert_eq!(deleted["deleted"], true);
    assert_eq!(deleted["taskId"], "thread-1");

    let calls = wait_for_codex_method(&log_path, "thread/delete").await;
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-rename-codex-home");
    let (_sqlite_home_guard, sqlite_home) =
        set_temp_codex_sqlite_home("wegent-app-runtime-rename-sqlite");
    write_default_codex_state_db_thread(&sqlite_home, false);
    let log_path = temp_path("wegent-app-runtime-rename-log", "jsonl");
    let fake_codex = write_fake_codex(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let renamed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.rename",
            "payload": {
                "taskId": "thread-1",
                "workspacePath": "/tmp/project",
                "title": "New Codex Title"
            }
        }))
        .await
        .expect("rename should succeed");

    assert_eq!(renamed["success"], true);
    assert_eq!(renamed["accepted"], true);
    assert_eq!(renamed["taskId"], "thread-1");

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("runtime task list should succeed");

    assert_eq!(
        listed["workspaces"][0]["tasks"][0]["title"],
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-search-codex-home");
    let (_sqlite_home_guard, sqlite_home) =
        set_temp_codex_sqlite_home("wegent-app-runtime-search-sqlite");
    write_default_codex_state_db_thread(&sqlite_home, false);
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
    assert_eq!(title_result["items"][0]["address"]["taskId"], "thread-1");
    assert_eq!(title_result["items"][0]["address"]["deviceId"], "device-1");
    assert_eq!(
        title_result["items"][0]["address"]["runtimeHandle"]["threadId"],
        "thread-1"
    );
    assert_eq!(title_result["items"][0]["title"], "Fix CI");
    assert_eq!(title_result["items"][0]["snippet"], "Fix CI");
    assert_eq!(title_result["items"][0]["messageRole"], "title");

    let transcript_from_search_result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": title_result["items"][0]["address"].clone()
        }))
        .await
        .expect("search result address should load transcript");

    assert_eq!(transcript_from_search_result["success"], true);
    assert_eq!(
        transcript_from_search_result["messages"][0]["content"],
        "please fix ci"
    );

    let transcript_result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.search",
            "payload": {"query": "please", "limit": 10}
        }))
        .await
        .expect("transcript search should succeed");

    assert_eq!(transcript_result["success"], true);
    assert_eq!(
        transcript_result["items"][0]["address"]["taskId"],
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
    let _codex_home = set_temp_codex_home("wegent-app-runtime-search-archive-codex-home");
    let (_sqlite_home_guard, sqlite_home) =
        set_temp_codex_sqlite_home("wegent-app-runtime-search-archive-sqlite");
    write_default_codex_state_db_thread(&sqlite_home, false);
    let fake_codex = write_fake_codex(&temp_path("wegent-app-runtime-search-archive-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.archive",
            "payload": {
                "taskId": "thread-1",
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
    assert_eq!(archived_result["items"][0]["address"]["taskId"], "thread-1");
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-app-runtime", "sh");
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
    *'"method":"thread/list"'*'"archived":true'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"archived","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/read"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-1","createdAt":1780000000,"items":[{{"id":"user-1","type":"userMessage","content":[{{"type":"text","text":"please fix ci"}},{{"type":"localImage","path":"/tmp/codex-clipboard/screenshot.png"}}]}},{{"id":"reason-1","type":"reasoning","summary":["inspect failure"]}},{{"id":"cmd-1","type":"commandExecution","command":"cargo test","cwd":"/tmp/project","status":"completed","aggregatedOutput":"test result: ok\n","exitCode":0}},{{"id":"agent-1","type":"agentMessage","text":"done","phase":"final_answer"}}]}}]}}}}}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/resume"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/archive"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/unarchive"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/delete"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
      ;;
    *'"method":"thread/name/set"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1","name":"New Codex Title"}}}}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"turn":{{"id":"turn-1","status":"inProgress"}}}}}}'
      printf '%s\n' '{{"method":"item/agentMessage/delta","params":{{"delta":"done","phase":"finalAnswer"}}}}'
      printf '%s\n' '{{"method":"turn/completed","params":{{"turn":{{"id":"turn-1","status":"completed"}}}}}}'
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

fn write_fake_codex_missing_rollout_on_archive(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-app-runtime-missing-rollout", "sh");
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
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-1","cwd":"/tmp/project","name":"Fix CI","preview":"fix ci","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/archive"'*)
      printf '%s\n' '{{"id":'"$request_id"',"error":{{"code":-32000,"message":"no rollout found for thread id thread-1"}}}}'
      ;;
    *'"method":"thread/delete"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"thread":{{"id":"thread-1"}}}}}}'
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

fn write_fake_codex_recency_order(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-app-runtime-list-order", "sh");
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
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-recency-first","cwd":"/tmp/project","name":"Recency first","preview":"recency first","path":"/tmp/codex/thread-recency-first.jsonl","createdAt":1780000000,"updatedAt":1780000010,"status":"idle","turns":[]}},{{"id":"thread-updated-first","cwd":"/tmp/project","name":"Updated first","preview":"updated first","path":"/tmp/codex/thread-updated-first.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}}],"nextCursor":null,"backwardsCursor":null}}}}'
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

struct CodexStateDbThread<'a> {
    id: &'a str,
    cwd: &'a str,
    title: &'a str,
    preview: &'a str,
    rollout_path: &'a str,
    created_at_ms: i64,
    updated_at_ms: i64,
    archived: bool,
}

fn write_codex_state_db_thread(sqlite_home: &Path, thread: CodexStateDbThread<'_>) {
    fs::create_dir_all(sqlite_home).unwrap();
    let connection = Connection::open(sqlite_home.join("state_5.sqlite")).unwrap();
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS threads (
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
            VALUES (?1, ?2, ?3, ?4, 'vscode', 'openai', ?5, ?6, ?7, 'test', ?8, ?9, ?10)
            "#,
            (
                thread.id,
                thread.rollout_path,
                thread.created_at_ms / 1000,
                thread.updated_at_ms / 1000,
                thread.cwd,
                thread.title,
                if thread.archived { 1_i64 } else { 0_i64 },
                thread.created_at_ms,
                thread.updated_at_ms,
                thread.preview,
            ),
        )
        .unwrap();
}

fn write_default_codex_state_db_thread(sqlite_home: &Path, archived: bool) {
    write_codex_state_db_thread(
        sqlite_home,
        CodexStateDbThread {
            id: "thread-1",
            cwd: "/tmp/project",
            title: "Fix CI",
            preview: "fix ci",
            rollout_path: "/tmp/codex/thread-1.jsonl",
            created_at_ms: 1780000000000,
            updated_at_ms: 1780000060000,
            archived,
        },
    );
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect()
}

async fn wait_for_codex_method(path: &Path, method: &str) -> Vec<Value> {
    for _ in 0..50 {
        let calls = read_json_lines(path);
        if calls.iter().any(|call| call["method"] == method) {
            return calls;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("codex app-server method was not called: {method}");
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
        if response["workspaces"][0]["tasks"][0]["taskId"] == "local-task-1"
            && response["workspaces"][0]["tasks"][0]["runtimeHandle"]["threadId"] == "thread-1"
        {
            return response;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("persisted local task mapping was not restored");
}
