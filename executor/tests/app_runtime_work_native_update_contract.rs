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
use serde_json::json;
use tokio::sync::{Mutex, MutexGuard};
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
async fn runtime_task_list_trusts_native_thread_status_without_rollout_probe() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-native-status-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-native-status-codex-home", "dir")
            .display()
            .to_string(),
    );
    let sqlite_home = temp_path("runtime-native-status-sqlite", "dir");
    let _sqlite_home = EnvGuard::set("CODEX_SQLITE_HOME", &sqlite_home.display().to_string());
    let active_rollout = temp_path("runtime-native-active-rollout", "jsonl");
    fs::write(
        &active_rollout,
        [
            json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string(),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"continue"}})
                .to_string(),
            json!({"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"working"}})
                .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();
    write_codex_state_db_thread(
        &sqlite_home,
        CodexStateDbThread {
            id: "thread-running-rollout",
            cwd: "/tmp/project",
            title: "Running rollout",
            preview: "run",
            rollout_path: &active_rollout.display().to_string(),
            created_at_ms: 1780000000000,
            updated_at_ms: 1780000062000,
            archived: false,
        },
    );
    write_codex_state_db_thread(
        &sqlite_home,
        CodexStateDbThread {
            id: "thread-idle",
            cwd: "/tmp/project",
            title: "Idle",
            preview: "idle",
            rollout_path: "/tmp/codex/idle.jsonl",
            created_at_ms: 1780000000000,
            updated_at_ms: 1780000060000,
            archived: false,
        },
    );
    let fake_codex = write_fake_codex(&temp_path("runtime-native-status-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let tasks = listed["workspaces"][0]["tasks"].as_array().unwrap();
    let running_by_rollout = tasks
        .iter()
        .find(|task| task["taskId"] == "thread-running-rollout")
        .unwrap();
    let idle = tasks
        .iter()
        .find(|task| task["taskId"] == "thread-idle")
        .unwrap();
    let active_completed = tasks
        .iter()
        .find(|task| task["taskId"] == "thread-active-completed")
        .unwrap();

    assert_eq!(running_by_rollout["status"], "active");
    assert_eq!(running_by_rollout["running"], false);
    assert_eq!(idle["status"], "active");
    assert_eq!(idle["running"], false);
    assert_eq!(active_completed["status"], "running");
    assert_eq!(active_completed["running"], true);
}

#[tokio::test]
async fn runtime_task_list_uses_native_idle_state_when_local_running_is_stale() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-local-running-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-local-running-codex-home", "dir")
            .display()
            .to_string(),
    );
    let sqlite_home = temp_path("runtime-local-running-sqlite", "dir");
    let _sqlite_home = EnvGuard::set("CODEX_SQLITE_HOME", &sqlite_home.display().to_string());
    write_codex_state_db_thread(
        &sqlite_home,
        CodexStateDbThread {
            id: "thread-idle",
            cwd: "/tmp/project",
            title: "Idle",
            preview: "idle",
            rollout_path: "/tmp/codex/idle.jsonl",
            created_at_ms: 1780000000000,
            updated_at_ms: 1780000060000,
            archived: false,
        },
    );
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "tasks": {
                "local-running-idle": {
                    "local_task_id": "local-running-idle",
                    "thread_id": "thread-idle",
                    "workspace_path": "/tmp/project",
                    "title": "Locally running idle",
                    "runtime": "codex",
                    "status": "running",
                    "running": true,
                    "created_at": 1780000000000_i64,
                    "updated_at": 1780000070000_i64,
                    "runtime_handle": {"threadId": "thread-idle"},
                    "parent": null
                }
            },
            "workspaces": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let fake_codex = write_fake_codex(&temp_path("runtime-local-running-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let tasks = listed["workspaces"][0]["tasks"].as_array().unwrap();
    let locally_running = tasks
        .iter()
        .find(|task| task["taskId"] == "local-running-idle")
        .unwrap();

    assert_eq!(locally_running["title"], "Locally running idle");
    assert_eq!(locally_running["status"], "active");
    assert_eq!(locally_running["running"], false);
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    assert_eq!(persisted["tasks"]["local-running-idle"]["status"], "active");
    assert_eq!(persisted["tasks"]["local-running-idle"]["running"], false);
}

#[tokio::test]
async fn runtime_task_list_clears_local_running_state_when_thread_is_missing() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-local-missing-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-local-missing-codex-home", "dir")
            .display()
            .to_string(),
    );
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "tasks": {
                "local-running-missing": {
                    "local_task_id": "local-running-missing",
                    "thread_id": "missing-thread",
                    "workspace_path": "/tmp/project",
                    "title": "Missing thread",
                    "runtime": "codex",
                    "status": "running",
                    "running": true,
                    "created_at": 1780000000000_i64,
                    "updated_at": 1780000070000_i64,
                    "runtime_handle": {"threadId": "missing-thread"},
                    "parent": null
                }
            },
            "workspaces": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let fake_codex = write_fake_codex(&temp_path("runtime-local-missing-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let tasks = listed["workspaces"][0]["tasks"].as_array().unwrap();
    let missing = tasks
        .iter()
        .find(|task| task["taskId"] == "local-running-missing")
        .unwrap();

    assert_eq!(missing["status"], "active");
    assert_eq!(missing["running"], false);
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    assert_eq!(
        persisted["tasks"]["local-running-missing"]["status"],
        "active"
    );
    assert_eq!(
        persisted["tasks"]["local-running-missing"]["running"],
        false
    );
}

#[tokio::test]
async fn runtime_task_list_preserves_local_failed_state_when_codex_thread_is_idle() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-local-failed-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-local-failed-codex-home", "dir")
            .display()
            .to_string(),
    );
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "tasks": {
                "local-failed-running-rollout": {
                    "local_task_id": "local-failed-running-rollout",
                    "thread_id": "thread-running-rollout",
                    "workspace_path": "/tmp/project",
                    "title": "Locally failed running rollout",
                    "runtime": "codex",
                    "status": "failed",
                    "running": false,
                    "created_at": 1780000000000_i64,
                    "updated_at": 1780000070000_i64,
                    "runtime_handle": {"threadId": "thread-running-rollout"},
                    "parent": null
                }
            },
            "workspaces": {}
        }))
        .unwrap(),
    )
    .unwrap();
    let fake_codex = write_fake_codex(&temp_path("runtime-local-failed-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let tasks = listed["workspaces"][0]["tasks"].as_array().unwrap();
    let locally_failed = tasks
        .iter()
        .find(|task| task["taskId"] == "local-failed-running-rollout")
        .unwrap();

    assert_eq!(locally_failed["status"], "failed");
    assert_eq!(locally_failed["running"], false);
    assert_eq!(locally_failed["continuable"], true);
    assert_eq!(locally_failed["threadStatus"], "idle");
    assert_eq!(locally_failed["turnStatus"], "failed");
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-native-status", "sh");
    let active_rollout = temp_path("runtime-native-active-rollout", "jsonl");
    let _ = fs::remove_file(log_path);
    fs::write(
        &active_rollout,
        [
            json!({"type":"event_msg","payload":{"type":"task_complete"}}).to_string(),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"continue"}})
                .to_string(),
            json!({"type":"event_msg","payload":{"type":"agent_message","phase":"commentary","message":"working"}})
                .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();
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
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":[{{"id":"thread-running-status","cwd":"/tmp/project","name":"Running status","preview":"run","path":"/tmp/codex/running-status.jsonl","createdAt":1780000000,"updatedAt":1780000064,"status":"inProgress","turns":[]}},{{"id":"thread-running-turn","cwd":"/tmp/project","name":"Running turn","preview":"run","path":"/tmp/codex/running-turn.jsonl","createdAt":1780000000,"updatedAt":1780000063,"status":"idle","turns":[{{"id":"turn-1","status":"inProgress","items":[{{"id":"cmd-1","type":"commandExecution","status":"inProgress","command":"cargo test","cwd":"/tmp/project"}}]}}]}},{{"id":"thread-running-rollout","cwd":"/tmp/project","name":"Running rollout","preview":"run","path":"{}","createdAt":1780000000,"updatedAt":1780000062,"status":"idle","turns":[]}},{{"id":"thread-running-wrapped-item","cwd":"/tmp/project","name":"Running wrapped item","preview":"run","path":"/tmp/codex/running-wrapped-item.jsonl","createdAt":1780000000,"updatedAt":1780000061,"status":"idle","turns":[{{"id":"turn-1","status":"completed","items":[{{"type":"response_item","payload":{{"id":"call-1","type":"function_call","status":"inProgress","call_id":"call-1","name":"exec_command"}}}}]}}]}},{{"id":"thread-active-completed","cwd":"/tmp/project","name":"Active completed","preview":"active","path":"/tmp/codex/active-completed.jsonl","createdAt":1780000000,"updatedAt":1780000061,"status":"active","turns":[{{"id":"turn-1","status":"completed","items":[]}}]}},{{"id":"thread-idle","cwd":"/tmp/project","name":"Idle","preview":"idle","path":"/tmp/codex/idle.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-1","status":"completed","items":[]}}]}}],"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
  esac
done
"#,
        log_path.display(),
        active_rollout.display()
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
