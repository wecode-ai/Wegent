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
async fn runtime_prepare_fork_transfer_returns_git_workspace_package_metadata() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-fork-prepare-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("runtime-fork-prepare-codex-home");
    let (_sqlite_home_guard, sqlite_home) =
        set_temp_codex_sqlite_home("runtime-fork-prepare-sqlite");
    write_codex_state_db_thread(&sqlite_home);
    let fake_codex = write_fake_codex(&temp_path("runtime-fork-prepare-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.prepare_fork_transfer",
            "payload": {
                "workspacePath": "/tmp/project",
                "localTaskId": "thread-1",
                "transferId": "transfer-1",
                "workspaceTransfer": "git_workspace",
                "directHosts": ["127.0.0.1"]
            }
        }))
        .await
        .expect("prepare fork transfer should succeed");

    assert_eq!(result["success"], true);
    assert_eq!(result["accepted"], true);
    assert_eq!(result["package"]["sourceRuntime"], "codex");
    assert_eq!(result["package"]["title"], "Fork source");
    assert_eq!(result["package"]["runtimeHandle"]["threadId"], "thread-1");
    assert_eq!(result["package"]["archive"]["mode"], "git_workspace");
    assert_eq!(result["package"]["archive"]["transferId"], "transfer-1");
    assert_eq!(
        result["package"]["archive"]["requiresWorkspaceRestore"],
        true
    );
}

#[tokio::test]
async fn runtime_import_fork_rejects_codex_packages_for_runtime_index() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-fork-reject-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("runtime-fork-reject-codex-home");
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-fork-reject-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.import_fork",
            "payload": {
                "source": {
                    "deviceId": "source-device",
                    "workspacePath": "/source/project",
                    "localTaskId": "codex-1"
                },
                "workspacePath": "/target/project",
                "forkPackage": {
                    "sourceRuntime": "codex",
                    "title": "Forked Codex task",
                    "runtimeHandle": {"threadId": "codex-1"},
                    "archive": {"mode": "git_workspace"}
                }
            }
        }))
        .await
        .expect("import fork should return a contract response");

    assert_eq!(
        result,
        json!({
            "success": false,
            "error": "Codex fork imports must restore into native Codex, not runtime index",
            "code": "bad_request"
        })
    );
}

#[tokio::test]
async fn runtime_import_fork_persists_parent_runtime_handle_and_recent_messages() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-fork-import-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = set_temp_codex_home("runtime-fork-import-codex-home");
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-fork-import-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let result = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.import_fork",
            "payload": {
                "source": {
                    "deviceId": "source-device",
                    "workspacePath": "/source/project",
                    "localTaskId": "claude-1"
                },
                "workspacePath": "/target/project",
                "forkPackage": {
                    "sourceRuntime": "claude_code",
                    "title": "Forked runtime task",
                    "recentMessages": [
                        {"id": "m1", "role": "user", "content": "hello"}
                    ],
                    "runtimeHandle": {"executorSession": {"agent": "ClaudeCode"}},
                    "executorSession": {"agent": "ClaudeCode", "sessionId": "session-1"},
                    "archive": {"mode": "git_workspace"}
                }
            }
        }))
        .await
        .expect("import fork should succeed");

    assert_eq!(result["success"], true);
    assert_eq!(result["accepted"], true);
    assert_eq!(result["runtime"], "claude_code");
    assert_eq!(result["workspacePath"], "/target/project");

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("list should succeed");
    let task = &listed["workspaces"][0]["localTasks"][0];
    assert_eq!(task["localTaskId"], result["localTaskId"]);
    assert_eq!(task["runtime"], "claude_code");
    assert_eq!(
        task["parent"],
        json!({
            "deviceId": "source-device",
            "workspacePath": "/source/project",
            "localTaskId": "claude-1"
        })
    );
    assert_eq!(
        task["runtimeHandle"]["executorSession"],
        json!({"agent": "ClaudeCode", "sessionId": "session-1"})
    );

    let transcript = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.transcript",
            "payload": {
                "workspacePath": "/target/project",
                "localTaskId": result["localTaskId"]
            }
        }))
        .await
        .expect("transcript should read imported messages");
    assert_eq!(transcript["success"], true);
    assert_eq!(transcript["messages"][0]["content"], "hello");
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    write_fake_codex_with_threads(
        log_path,
        r#"[{"id":"thread-1","cwd":"/tmp/project","name":"Fork source","preview":"fork","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}]"#,
    )
}

fn write_fake_codex_empty(log_path: &Path) -> PathBuf {
    write_fake_codex_with_threads(log_path, "[]")
}

fn write_fake_codex_with_threads(log_path: &Path, threads: &str) -> PathBuf {
    let path = temp_path("fake-codex-fork-rpc", "sh");
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
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":2,"result":{{"data":{},"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
  esac
done
"#,
        log_path.display(),
        threads
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
                'Fork source',
                0,
                'test',
                1780000000000,
                1780000060000,
                'fork'
            )
            "#,
            (),
        )
        .unwrap();
}
