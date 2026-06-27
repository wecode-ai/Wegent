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
async fn runtime_workspace_open_persists_empty_workspace_without_starting_thread() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-workspace-open-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let codex_home = temp_path("runtime-workspace-open-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    let log_path = temp_path("runtime-workspace-open-log", "jsonl");
    let fake_codex = write_fake_codex_empty(&log_path);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let opened = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.open",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("workspace open should succeed");
    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(
        opened,
        json!({
            "success": true,
            "accepted": true,
            "runtime": "codex",
            "workspacePath": "/tmp/project"
        })
    );
    assert_eq!(listed["success"], true);
    assert_eq!(listed["workspaces"][0]["workspacePath"], "/tmp/project");
    assert_eq!(listed["workspaces"][0]["workspaceKind"], "workspace");
    assert_eq!(listed["workspaces"][0]["label"], "project");
    assert_eq!(listed["workspaces"][0]["localTasks"], json!([]));

    let calls = read_json_lines(&log_path);
    assert!(calls.iter().all(|call| call["method"] != "thread/start"));

    let codex_state = read_json_file(&codex_home.join(".codex-global-state.json"));
    assert_eq!(
        codex_state["electron-saved-workspace-roots"],
        json!(["/tmp/project"])
    );
    assert_eq!(codex_state["project-order"], json!(["/tmp/project"]));
    assert!(!executor_home
        .join("runtime-work")
        .join("index.json")
        .exists());
}

#[tokio::test]
async fn runtime_task_list_groups_threads_under_open_workspace_roots() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-workspace-group-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-workspace-group-codex-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex(&temp_path("runtime-workspace-group-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.open",
            "payload": {"workspacePath": "/tmp/project"}
        }))
        .await
        .expect("workspace open should succeed");
    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 1);
    let workspace = &listed["workspaces"][0];
    assert_eq!(workspace["workspacePath"], "/tmp/project");
    assert_eq!(workspace["localTasks"][0]["localTaskId"], "thread-1");
    assert_eq!(workspace["localTasks"][0]["workspacePath"], "/tmp/project");
    assert_eq!(workspace["updatedAt"], 1780000060000_i64);
    assert_eq!(workspace["localTasks"][0]["createdAt"], 1780000000000_i64);
    assert_eq!(workspace["localTasks"][0]["updatedAt"], 1780000060000_i64);
}

#[tokio::test]
async fn runtime_task_list_preserves_chat_workspace_kind_for_opened_chat_roots() {
    let _lock = env_lock().await;
    let home = temp_path("runtime-chat-home", "dir");
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-chat-executor-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-chat-codex-home", "dir")
            .display()
            .to_string(),
    );
    let chat_workspace = home
        .join("Documents")
        .join("Codex")
        .join("2026-06-25")
        .join("ci");
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-chat-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.open",
            "payload": {"workspacePath": chat_workspace.display().to_string()}
        }))
        .await
        .expect("chat workspace open should succeed");
    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(
        listed["workspaces"][0]["workspacePath"],
        chat_workspace.display().to_string()
    );
    assert_eq!(listed["workspaces"][0]["workspaceKind"], "chat");
    assert_eq!(listed["workspaces"][0]["localTasks"], json!([]));
}

#[tokio::test]
async fn runtime_task_list_coalesces_codex_git_worktrees_under_common_repo_root() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-worktree-home", "dir")
            .display()
            .to_string(),
    );
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-worktree-codex-home", "dir")
            .display()
            .to_string(),
    );
    let root = temp_path("runtime-worktree-root", "dir");
    let repo = root.join("Wegent");
    let git_dir = repo.join(".git");
    let worktree_a_git_dir = git_dir.join("worktrees").join("a");
    let worktree_b_git_dir = git_dir.join("worktrees").join("b");
    let codex_worktree_a = root
        .join(".codex")
        .join("worktrees")
        .join("a")
        .join("Wegent");
    let codex_worktree_b = root
        .join(".codex")
        .join("worktrees")
        .join("b")
        .join("Wegent");
    fs::create_dir_all(&worktree_a_git_dir).unwrap();
    fs::create_dir_all(&worktree_b_git_dir).unwrap();
    fs::create_dir_all(&codex_worktree_a).unwrap();
    fs::create_dir_all(&codex_worktree_b).unwrap();
    fs::write(worktree_a_git_dir.join("commondir"), "../..").unwrap();
    fs::write(worktree_b_git_dir.join("commondir"), "../..").unwrap();
    fs::write(
        codex_worktree_a.join(".git"),
        format!("gitdir: {}\n", worktree_a_git_dir.display()),
    )
    .unwrap();
    fs::write(
        codex_worktree_b.join(".git"),
        format!("gitdir: {}\n", worktree_b_git_dir.display()),
    )
    .unwrap();

    let threads = serde_json::to_string(&json!([
        {
            "id": "thread-a",
            "cwd": codex_worktree_a.join("frontend").display().to_string(),
            "name": "Fix conflict",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-b",
            "cwd": codex_worktree_b.join("executor").display().to_string(),
            "name": "Resolve conflict",
            "createdAt": 1780000100000_i64,
            "updatedAt": 1780000120000_i64,
            "status": "idle",
            "turns": []
        }
    ]))
    .unwrap();
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-worktree-log", "jsonl"), &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["success"], true);
    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 1);
    let workspace = &listed["workspaces"][0];
    assert_eq!(workspace["workspacePath"], repo.display().to_string());
    assert_eq!(workspace["label"], "Wegent");
    assert_eq!(workspace["updatedAt"], 1780000120000_i64);
    assert_eq!(workspace["localTasks"].as_array().unwrap().len(), 2);
    assert_eq!(workspace["localTasks"][0]["localTaskId"], "thread-b");
    assert_eq!(
        workspace["localTasks"][0]["workspacePath"],
        codex_worktree_b.display().to_string()
    );
    assert_eq!(workspace["localTasks"][0]["workspaceKind"], "worktree");
    assert_eq!(workspace["localTasks"][0]["worktreeId"], "b");
    assert_eq!(workspace["localTasks"][1]["localTaskId"], "thread-a");
    assert_eq!(
        workspace["localTasks"][1]["workspacePath"],
        codex_worktree_a.display().to_string()
    );
    assert_eq!(workspace["localTasks"][1]["workspaceKind"], "worktree");
    assert_eq!(workspace["localTasks"][1]["worktreeId"], "a");
}

#[tokio::test]
async fn runtime_task_list_filters_threads_to_codex_global_projects() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-global-filter-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-global-filter-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": ["/repo/Wegent"],
            "project-order": ["/repo/Wegent"],
            "electron-workspace-root-labels": {"/repo/Wegent": "Wegent"}
        }),
    );
    let threads = serde_json::to_string(&json!([
        {
            "id": "thread-in-project",
            "cwd": "/repo/Wegent/frontend",
            "name": "Visible",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-outside-project",
            "cwd": "/repo/Other",
            "name": "Hidden",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000070000_i64,
            "status": "idle",
            "turns": []
        }
    ]))
    .unwrap();
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-global-filter-log", "jsonl"), &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["success"], true);
    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 1);
    let workspace = &listed["workspaces"][0];
    assert_eq!(workspace["workspacePath"], "/repo/Wegent");
    assert_eq!(workspace["label"], "Wegent");
    assert_eq!(workspace["localTasks"].as_array().unwrap().len(), 1);
    assert_eq!(
        workspace["localTasks"][0]["localTaskId"],
        "thread-in-project"
    );
}

#[tokio::test]
async fn runtime_workspace_rename_and_remove_update_codex_global_state() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-workspace-manage-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-workspace-manage-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-workspace-manage-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.open",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/tmp/project",
                "label": "Old name"
            }
        }))
        .await
        .expect("workspace open should succeed");
    let renamed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.rename",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/tmp/project",
                "label": "New name"
            }
        }))
        .await
        .expect("workspace rename should succeed");
    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");
    let removed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.remove",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/tmp/project"
            }
        }))
        .await
        .expect("workspace remove should succeed");
    let listed_after_remove = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(renamed["success"], true);
    assert_eq!(listed["workspaces"][0]["label"], "New name");
    assert_eq!(removed["success"], true);
    assert_eq!(listed_after_remove["workspaces"], json!([]));
    let codex_state = read_json_file(&codex_home.join(".codex-global-state.json"));
    assert_eq!(codex_state["electron-saved-workspace-roots"], json!([]));
    assert_eq!(codex_state["project-order"], json!([]));
}

#[tokio::test]
async fn runtime_task_list_ignores_stale_cached_codex_store_entries() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-stale-store-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-stale-store-codex-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-stale-store-log", "jsonl"));
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "tasks": {
                "stale-thread": {
                    "local_task_id": "stale-thread",
                    "thread_id": "stale-thread",
                    "workspace_path": "/repo/Wegent",
                    "title": "Stale cached Codex task",
                    "runtime": "codex",
                    "status": "active",
                    "running": false,
                    "created_at": 1780000000000_i64,
                    "updated_at": 1780000060000_i64,
                    "runtime_handle": {"threadId": "stale-thread"},
                    "parent": null
                }
            },
            "workspaces": {
                "/repo/Ghost": {
                    "workspace_path": "/repo/Ghost",
                    "title": "Ghost",
                    "runtime": "codex",
                    "created_at": 1780000000000_i64,
                    "updated_at": 1780000060000_i64
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed, json!({"success": true, "workspaces": []}));
}

fn write_fake_codex(log_path: &Path) -> PathBuf {
    write_fake_codex_with_threads(
        log_path,
        r#"[{"id":"thread-1","cwd":"/tmp/project/frontend","name":"Fix UI","preview":"fix ui","path":"/tmp/codex/thread-1.jsonl","createdAt":1780000000,"updatedAt":1780000060,"status":"idle","turns":[]}]"#,
    )
}

fn write_fake_codex_empty(log_path: &Path) -> PathBuf {
    write_fake_codex_with_threads(log_path, "[]")
}

fn write_fake_codex_with_threads(log_path: &Path, threads: &str) -> PathBuf {
    let path = temp_path("fake-codex-workspace", "sh");
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

fn read_json_lines(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect()
}

fn read_json_file(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn write_codex_global_state(codex_home: &Path, payload: Value) {
    fs::create_dir_all(codex_home).unwrap();
    fs::write(
        codex_home.join(".codex-global-state.json"),
        serde_json::to_vec_pretty(&payload).unwrap(),
    )
    .unwrap();
}
