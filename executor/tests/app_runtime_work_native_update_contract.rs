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
async fn runtime_task_list_maps_native_running_thread_statuses() {
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
    let fake_codex = write_fake_codex(&temp_path("runtime-native-status-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let tasks = listed["workspaces"][0]["localTasks"].as_array().unwrap();
    let running_by_status = tasks
        .iter()
        .find(|task| task["localTaskId"] == "thread-running-status")
        .unwrap();
    let running_by_turn = tasks
        .iter()
        .find(|task| task["localTaskId"] == "thread-running-turn")
        .unwrap();
    let idle = tasks
        .iter()
        .find(|task| task["localTaskId"] == "thread-idle")
        .unwrap();

    assert_eq!(running_by_status["status"], "active");
    assert_eq!(running_by_status["running"], true);
    assert_eq!(running_by_turn["status"], "active");
    assert_eq!(running_by_turn["running"], true);
    assert_eq!(idle["status"], "active");
    assert_eq!(idle["running"], false);
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    let path = temp_path("fake-codex-native-status", "sh");
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
      printf '%s\n' '{{"id":2,"result":{{"data":[{{"id":"thread-running-status","cwd":"/tmp/project","name":"Running status","preview":"run","path":"/tmp/codex/running-status.jsonl","createdAt":1780000000,"updatedAt":1780000062,"status":"inProgress","turns":[]}},{{"id":"thread-running-turn","cwd":"/tmp/project","name":"Running turn","preview":"run","path":"/tmp/codex/running-turn.jsonl","createdAt":1780000000,"updatedAt":1780000061,"status":"idle","turns":[{{"id":"turn-1","status":"inProgress","items":[{{"id":"cmd-1","type":"commandExecution","status":"inProgress","command":"cargo test","cwd":"/tmp/project"}}]}}]}},{{"id":"thread-idle","cwd":"/tmp/project","name":"Idle","preview":"idle","path":"/tmp/codex/idle.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[{{"id":"turn-1","status":"completed","items":[]}}]}}],"nextCursor":null,"backwardsCursor":null}}}}'
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
