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
use wegent_executor::{local::app_ipc::RuntimeWorkHandler, runtime_work::RuntimeWorkRpcHandler};

async fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let guard = LOCK.get_or_init(|| Mutex::new(())).lock().await;
    std::env::set_var("WEGENT_DISABLE_CODEX_APP_NOTIFY", "1");
    std::env::set_var("WEGENT_FORCE_CODEX_GLOBAL_STATE_OPLOG_FLUSH", "1");
    std::env::remove_var("WEGENT_DISABLE_CODEX_GLOBAL_STATE_OPLOG_FLUSH");
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
    assert_eq!(listed["workspaces"][0]["tasks"], json!([]));

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
async fn runtime_workspace_open_backfills_saved_roots_into_project_order() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-workspace-open-order-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-workspace-open-order-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": [
                "/repo/Unordered",
                "/repo/Ordered"
            ],
            "project-order": ["/repo/Ordered"]
        }),
    );
    let fake_codex = write_fake_codex_with_threads(
        &temp_path("runtime-workspace-open-order-log", "jsonl"),
        "[]",
    );
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let opened = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.open",
            "payload": {
                "workspacePath": "/repo/New",
                "label": "New"
            }
        }))
        .await
        .expect("workspace open should succeed");

    assert_eq!(opened["accepted"], true);
    let codex_state = read_json_file(&codex_home.join(".codex-global-state.json"));
    assert_eq!(
        codex_state["electron-saved-workspace-roots"],
        json!(["/repo/New", "/repo/Unordered", "/repo/Ordered"])
    );
    assert_eq!(
        codex_state["project-order"],
        json!(["/repo/New", "/repo/Ordered", "/repo/Unordered"])
    );
}

#[tokio::test]
async fn runtime_sidebar_semantic_rpcs_update_codex_global_state() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-sidebar-state-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-sidebar-state-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "unknown-codex-setting": {"keep": true},
            "local-projects": {
                "p1": {"id": "p1", "name": "One"},
                "p2": {"id": "p2", "name": "Two"}
            },
            "project-writable-roots": {
                "p1": [{"kind": "local", "path": "/repo/one"}],
                "p2": [{"kind": "local", "path": "/repo/two"}]
            },
            "project-order": ["p1", "p2"],
            "pinned-project-ids": ["p1"],
            "pinned-thread-ids": ["t1"],
            "sidebar-project-thread-orders": {
                "p2": {"threadIds": ["t1", "t2"], "sortKey": "manual"}
            }
        }),
    );
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-sidebar-state-log", "jsonl"));
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    for request in [
        json!({
            "method": "runtime.sidebar.projects.reorder",
            "payload": {"projectKey": "p2", "beforeProjectKey": "p1"}
        }),
        json!({
            "method": "runtime.sidebar.projects.pin",
            "payload": {"projectKey": "p2", "pinned": true, "beforeProjectKey": "p1"}
        }),
        json!({
            "method": "runtime.sidebar.projects.appearance",
            "payload": {"projectKey": "p2", "appearance": {"color": "blue"}}
        }),
        json!({
            "method": "runtime.sidebar.projects.sync_remote",
            "payload": {
                "projects": [{
                    "id": "remote-1",
                    "hostId": "remote-host-1",
                    "remotePath": "/srv/remote",
                    "label": "Remote"
                }]
            }
        }),
        json!({
            "method": "runtime.sidebar.projects.activate",
            "payload": {
                "projectKey": "remote-1",
                "workspacePath": "/srv/remote",
                "remoteHostId": "remote-host-1"
            }
        }),
        json!({
            "method": "runtime.sidebar.tasks.reorder",
            "payload": {"projectKey": "p2", "threadId": "t2", "beforeThreadId": "t1"}
        }),
        json!({
            "method": "runtime.sidebar.tasks.pin",
            "payload": {"threadId": "t2", "pinned": true, "beforeThreadId": "t1"}
        }),
    ] {
        let response = handler
            .handle_runtime_rpc(request)
            .await
            .expect("sidebar mutation should succeed");
        assert_eq!(response["accepted"], true);
        assert_eq!(response["deviceId"], "device-1");
    }

    let state = read_json_file(&codex_home.join(".codex-global-state.json"));
    assert_eq!(state["project-order"], json!(["remote-1", "p2", "p1"]));
    assert_eq!(state["pinned-project-ids"], json!(["p2", "p1"]));
    assert_eq!(state["project-appearances"]["p2"], json!({"color": "blue"}));
    assert_eq!(
        state["remote-projects"],
        json!([{
            "id": "remote-1",
            "hostId": "remote-host-1",
            "remotePath": "/srv/remote",
            "label": "Remote"
        }])
    );
    assert_eq!(state["active-remote-project-id"], "remote-1");
    assert_eq!(state["selected-remote-host-id"], "remote-host-1");
    assert_eq!(
        state["sidebar-project-thread-orders"]["p2"]["threadIds"],
        json!(["t2", "t1"])
    );
    assert_eq!(state["pinned-thread-ids"], json!(["t2", "t1"]));
    assert_eq!(state["unknown-codex-setting"], json!({"keep": true}));
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
    let sqlite_home = temp_path("runtime-workspace-group-sqlite", "dir");
    let _sqlite_home = EnvGuard::set("CODEX_SQLITE_HOME", &sqlite_home.display().to_string());
    write_codex_state_db_thread(
        &sqlite_home,
        CodexStateDbThread {
            id: "thread-1",
            cwd: "/tmp/project",
            title: "Fix UI",
            preview: "fix ui",
            rollout_path: "/tmp/codex/thread-1.jsonl",
            created_at_ms: 1780000000000,
            updated_at_ms: 1780000060000,
            archived: false,
        },
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
    assert_eq!(workspace["tasks"][0]["taskId"], "thread-1");
    assert_eq!(workspace["tasks"][0]["workspacePath"], "/tmp/project");
    assert_eq!(workspace["updatedAt"], 1780000060000_i64);
    assert_eq!(workspace["tasks"][0]["createdAt"], 1780000000000_i64);
    assert_eq!(workspace["tasks"][0]["updatedAt"], 1780000060000_i64);
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
    assert_eq!(listed["workspaces"][0]["tasks"], json!([]));
}

#[tokio::test]
async fn runtime_task_list_applies_manual_order_to_projectless_chats() {
    let _lock = env_lock().await;
    let home = temp_path("runtime-chat-order-home", "dir");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _executor_home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-chat-order-executor-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-chat-order-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "projectless-thread-ids": ["thread-newer", "thread-older"],
            "sidebar-project-thread-orders": {
                "chats": {"threadIds": ["thread-older", "thread-newer"]}
            }
        }),
    );
    let chat_workspace = home
        .join("Documents")
        .join("Codex")
        .join("2026-07-12")
        .join("manual");
    let threads = json!([
        {
            "id": "thread-newer",
            "cwd": chat_workspace.display().to_string(),
            "name": "Newer chat",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000200000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-older",
            "cwd": chat_workspace.display().to_string(),
            "name": "Older chat",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000100000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-chat-order-log", "jsonl"), &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("chat task list should succeed");

    assert_eq!(listed["workspaces"][0]["workspaceKind"], "chat");
    assert_eq!(
        listed["workspaces"][0]["tasks"]
            .as_array()
            .expect("chat tasks")
            .iter()
            .map(|task| task["taskId"].as_str().expect("task id"))
            .collect::<Vec<_>>(),
        vec!["thread-older", "thread-newer"]
    );
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

    let threads = json!([
        {
            "id": "thread-b",
            "cwd": codex_worktree_b.join("executor").display().to_string(),
            "name": "Resolve conflict",
            "preview": "resolve conflict",
            "path": "/tmp/codex/thread-b.jsonl",
            "createdAt": 1780000100000_i64,
            "updatedAt": 1780000120000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-a",
            "cwd": codex_worktree_a.join("frontend").display().to_string(),
            "name": "Fix conflict",
            "preview": "fix conflict",
            "path": "/tmp/codex/thread-a.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
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
    assert_eq!(workspace["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(workspace["tasks"][0]["taskId"], "thread-b");
    assert_eq!(
        workspace["tasks"][0]["workspacePath"],
        codex_worktree_b.display().to_string()
    );
    assert_eq!(workspace["tasks"][0]["workspaceKind"], "worktree");
    assert_eq!(workspace["tasks"][0]["worktreeId"], "b");
    assert_eq!(workspace["tasks"][1]["taskId"], "thread-a");
    assert_eq!(
        workspace["tasks"][1]["workspacePath"],
        codex_worktree_a.display().to_string()
    );
    assert_eq!(workspace["tasks"][1]["workspaceKind"], "worktree");
    assert_eq!(workspace["tasks"][1]["worktreeId"], "a");
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
    let threads = json!([
        {
            "id": "thread-outside-project",
            "cwd": "/repo/Other",
            "name": "Hidden",
            "preview": "hidden",
            "path": "/tmp/codex/thread-outside-project.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000070000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-in-project",
            "cwd": "/repo/Wegent/frontend",
            "name": "Visible",
            "preview": "visible",
            "path": "/tmp/codex/thread-in-project.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
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
    assert_eq!(workspace["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(workspace["tasks"][0]["taskId"], "thread-in-project");
}

#[tokio::test]
async fn runtime_task_list_preserves_codex_global_project_order() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-global-order-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-global-order-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": ["/repo/Older", "/repo/Newer"],
            "project-order": ["/repo/Older", "/repo/Newer"],
            "electron-workspace-root-labels": {
                "/repo/Older": "Older",
                "/repo/Newer": "Newer"
            }
        }),
    );
    let threads = json!([
        {
            "id": "thread-newer",
            "cwd": "/repo/Newer",
            "name": "Newer task",
            "preview": "newer task",
            "path": "/tmp/codex/thread-newer.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000200000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-older",
            "cwd": "/repo/Older",
            "name": "Older task",
            "preview": "older task",
            "path": "/tmp/codex/thread-older.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000100000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-global-order-log", "jsonl"), &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["success"], true);
    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 2);
    assert_eq!(listed["workspaces"][0]["workspacePath"], "/repo/Older");
    assert_eq!(listed["workspaces"][1]["workspacePath"], "/repo/Newer");
}

#[tokio::test]
async fn runtime_task_list_keeps_new_project_first_when_old_roots_are_missing_project_order() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-global-saved-order-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-global-saved-order-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": [
                "/repo/hello-33",
                "/repo/hello-32",
                "/repo/hello-31",
                "/repo/Wegent"
            ],
            "remote-projects": [{
                "id": "remote-project-1",
                "hostId": "remote-ssh-discovered:10.201.3.200",
                "remotePath": "/home/ubuntu/workspace/Wegent",
                "label": "Remote Wegent"
            }],
            "project-order": [
                "/repo/hello-33",
                "remote-project-1",
                "/repo/Wegent"
            ]
        }),
    );
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-global-saved-order-log", "jsonl"), "[]");
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["success"], true);
    let workspaces = listed["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 5);
    assert_eq!(workspaces[0]["workspacePath"], "/repo/hello-33");
    assert_eq!(workspaces[1]["workspacePath"], "/repo/hello-32");
    assert_eq!(workspaces[2]["workspacePath"], "/repo/hello-31");
    assert_eq!(
        workspaces[3]["workspacePath"],
        "/home/ubuntu/workspace/Wegent"
    );
    assert_eq!(workspaces[4]["workspacePath"], "/repo/Wegent");
}

#[tokio::test]
async fn runtime_task_list_matches_codex_saved_and_nested_project_order() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-global-nested-order-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-global-nested-order-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": [
                "/repo/hello-11 2",
                "/repo/Wegent/wework",
                "/repo/Wegent"
            ],
            "remote-projects": [{
                "id": "remote-project-1",
                "hostId": "remote-ssh-discovered:10.201.3.200",
                "remotePath": "/home/ubuntu/workspace/Wegent",
                "label": "Remote Wegent"
            }],
            "project-order": [
                "remote-project-1",
                "/repo/Wegent",
                "/repo/Wegent/wework"
            ],
            "electron-workspace-root-labels": {
                "/repo/Wegent/wework": "wework"
            }
        }),
    );
    let threads = json!([
        {
            "id": "thread-hello",
            "cwd": "/repo/hello-11 2",
            "name": "Hello task",
            "preview": "hello task",
            "path": "/tmp/codex/thread-hello.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000100000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-parent",
            "cwd": "/repo/Wegent/backend",
            "name": "Parent task",
            "preview": "parent task",
            "path": "/tmp/codex/thread-parent.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000200000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-child",
            "cwd": "/repo/Wegent/wework/src",
            "name": "Child task",
            "preview": "child task",
            "path": "/tmp/codex/thread-child.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000300000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let fake_codex = write_fake_codex_with_threads(
        &temp_path("runtime-global-nested-order-log", "jsonl"),
        &threads,
    );
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["success"], true);
    let workspaces = listed["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 4);
    assert_eq!(workspaces[0]["workspacePath"], "/repo/hello-11 2");
    assert_eq!(
        workspaces[1]["workspacePath"],
        "/home/ubuntu/workspace/Wegent"
    );
    assert_eq!(workspaces[1]["workspaceSource"], "remote");
    assert_eq!(workspaces[2]["workspacePath"], "/repo/Wegent");
    assert_eq!(workspaces[3]["workspacePath"], "/repo/Wegent/wework");
    assert_eq!(workspaces[3]["label"], "wework");
    assert_eq!(workspaces[0]["tasks"][0]["taskId"], "thread-hello");
    assert_eq!(workspaces[2]["tasks"][0]["taskId"], "thread-parent");
    assert_eq!(workspaces[3]["tasks"][0]["taskId"], "thread-child");
}

#[tokio::test]
async fn runtime_task_list_preserves_remote_codex_projects() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-remote-project-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-remote-project-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "remote-projects": [{
                "id": "remote-project-1",
                "hostId": "remote-ssh-discovered:10.201.3.200",
                "remotePath": "/home/ubuntu/workspace/Wegent",
                "label": "Remote Wegent"
            }],
            "project-order": ["remote-project-1"]
        }),
    );
    let threads = json!([{
        "id": "thread-remote",
        "cwd": "/home/ubuntu/workspace/Wegent",
        "name": "Remote task",
        "preview": "remote task",
        "path": "/tmp/codex/thread-remote.jsonl",
        "createdAt": 1780000000000_i64,
        "updatedAt": 1780000060000_i64,
        "status": "idle",
        "turns": []
    }])
    .to_string();
    let log_path = temp_path("runtime-remote-project-log", "jsonl");
    let fake_codex = write_fake_codex_with_threads(&log_path, &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let workspace = &listed["workspaces"][0];
    assert_eq!(workspace["workspacePath"], "/home/ubuntu/workspace/Wegent");
    assert_eq!(workspace["label"], "Remote Wegent");
    assert_eq!(workspace["workspaceSource"], "remote");
    assert_eq!(
        workspace["remoteHostId"],
        "remote-ssh-discovered:10.201.3.200"
    );
    assert_eq!(workspace["tasks"][0]["taskId"], "thread-remote");

    let archived = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.archive_project",
            "payload": {
                "runtimeProjectKey": "remote-project-1",
                "workspacePath": "remote-project-1"
            }
        }))
        .await
        .expect("remote project archive should succeed");

    assert_eq!(archived["accepted"], true);
    assert_eq!(archived["requestedCount"], 1);
    let archive_calls = read_json_lines(&log_path)
        .into_iter()
        .filter(|call| call["method"] == "thread/archive")
        .collect::<Vec<_>>();
    assert_eq!(archive_calls.len(), 1);
    assert_eq!(archive_calls[0]["params"]["threadId"], "thread-remote");
}

#[tokio::test]
async fn runtime_task_list_uses_thread_root_hints_and_skips_projectless_threads() {
    let _lock = env_lock().await;
    let _home = EnvGuard::set(
        "WEGENT_EXECUTOR_HOME",
        &temp_path("runtime-thread-hints-home", "dir")
            .display()
            .to_string(),
    );
    let codex_home = temp_path("runtime-thread-hints-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": ["/repo/Wegent"],
            "project-order": ["/repo/Wegent"],
            "thread-workspace-root-hints": {
                "thread-hinted": "/repo/Wegent"
            },
            "projectless-thread-ids": ["thread-projectless"]
        }),
    );
    let threads = json!([
        {
            "id": "thread-hinted",
            "cwd": "/tmp/outside",
            "name": "Hinted task",
            "preview": "hinted task",
            "path": "/tmp/codex/thread-hinted.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-projectless",
            "cwd": "/repo/Wegent",
            "name": "Projectless task",
            "preview": "projectless task",
            "path": "/tmp/codex/thread-projectless.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000070000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-thread-hints-log", "jsonl"), &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    let workspace = &listed["workspaces"][0];
    assert_eq!(workspace["workspacePath"], "/repo/Wegent");
    let tasks = workspace["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["taskId"], "thread-hinted");
}

#[tokio::test]
async fn runtime_archives_project_and_all_conversations() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-archive-project-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let codex_home = temp_path("runtime-archive-project-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": ["/repo/Wegent", "/repo/Other"],
            "project-order": ["/repo/Wegent", "/repo/Other"]
        }),
    );
    let threads = json!([
        {
            "id": "thread-project",
            "cwd": "/repo/Wegent",
            "name": "Project task",
            "preview": "project task",
            "path": "/tmp/codex/thread-project.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        },
        {
            "id": "thread-other",
            "cwd": "/repo/Other",
            "name": "Other task",
            "preview": "other task",
            "path": "/tmp/codex/thread-other.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000070000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let log_path = temp_path("runtime-archive-project-log", "jsonl");
    let fake_codex = write_fake_codex_with_threads(&log_path, &threads);
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    let archived_project = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.archive_project",
            "payload": {"runtimeProjectKey": "local:/repo/Wegent"}
        }))
        .await
        .expect("project archive should succeed");
    let archived_all = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.archived_conversations.archive_all",
            "payload": {}
        }))
        .await
        .expect("archive all should succeed");

    assert_eq!(archived_project["accepted"], true);
    assert_eq!(archived_project["requestedCount"], 1);
    assert_eq!(archived_project["acceptedCount"], 1);
    assert_eq!(archived_all["accepted"], true);
    assert_eq!(archived_all["requestedCount"], 1);
    assert_eq!(archived_all["acceptedCount"], 1);
    let archive_calls = read_json_lines(&log_path)
        .into_iter()
        .filter(|call| call["method"] == "thread/archive")
        .collect::<Vec<_>>();
    assert_eq!(archive_calls.len(), 2);
    assert_eq!(archive_calls[0]["params"]["threadId"], "thread-project");
    assert_eq!(archive_calls[1]["params"]["threadId"], "thread-other");
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
    let threads = json!([
        {
            "id": "thread-in-project",
            "cwd": "/tmp/project",
            "name": "Existing task",
            "preview": "existing task",
            "path": "/tmp/codex/thread-in-project.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let fake_codex = write_fake_codex_with_threads(
        &temp_path("runtime-workspace-manage-log", "jsonl"),
        &threads,
    );
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
    let mut codex_state = read_json_file(&codex_home.join(".codex-global-state.json"));
    codex_state["active-workspace-roots"] = json!(["/tmp/project"]);
    codex_state["pinned-project-ids"] = json!(["/tmp/project", "remote-project"]);
    write_codex_global_state(&codex_home, codex_state);
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
    assert_eq!(
        listed["workspaces"][0]["tasks"][0]["taskId"],
        "thread-in-project"
    );
    assert_eq!(removed["success"], true);
    assert_eq!(listed_after_remove["workspaces"], json!([]));
    let codex_state = read_json_file(&codex_home.join(".codex-global-state.json"));
    assert_eq!(codex_state["electron-saved-workspace-roots"], json!([]));
    assert_eq!(codex_state["project-order"], json!([]));
    assert_eq!(codex_state["active-workspace-roots"], json!([]));
    assert_eq!(codex_state["pinned-project-ids"], json!(["remote-project"]));
    assert_eq!(codex_state["electron-workspace-root-labels"], json!({}));
}

#[tokio::test]
async fn runtime_workspace_oplog_overlays_project_changes_while_codex_is_running() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-workspace-oplog-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _disable_flush = EnvGuard::set("WEGENT_DISABLE_CODEX_GLOBAL_STATE_OPLOG_FLUSH", "1");
    let codex_home = temp_path("runtime-workspace-oplog-codex-home", "dir");
    let _codex_home = EnvGuard::set("CODEX_HOME", &codex_home.display().to_string());
    write_codex_global_state(
        &codex_home,
        json!({
            "electron-saved-workspace-roots": ["/repo/Other", "/repo/Old"],
            "project-order": ["/repo/Other", "/repo/Old"],
            "electron-workspace-root-labels": {
                "/repo/Old": "Old name"
            }
        }),
    );
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-workspace-oplog-log", "jsonl"), "[]");
    let handler = RuntimeWorkRpcHandler::new("device-1", fake_codex.display().to_string());

    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.open",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/repo/New",
                "label": "New project"
            }
        }))
        .await
        .expect("workspace open should succeed");
    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.rename",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/repo/Old",
                "label": "Renamed old"
            }
        }))
        .await
        .expect("workspace rename should succeed");
    handler
        .handle_runtime_rpc(json!({
            "method": "runtime.workspaces.remove",
            "payload": {
                "runtime": "codex",
                "workspacePath": "/repo/Other"
            }
        }))
        .await
        .expect("workspace remove should succeed");
    let listed = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.tasks.list",
            "payload": {}
        }))
        .await
        .expect("task list should succeed");

    assert_eq!(listed["workspaces"][0]["workspacePath"], "/repo/New");
    assert_eq!(listed["workspaces"][0]["label"], "New project");
    assert_eq!(listed["workspaces"][1]["workspacePath"], "/repo/Old");
    assert_eq!(listed["workspaces"][1]["label"], "Renamed old");
    assert_eq!(listed["workspaces"].as_array().unwrap().len(), 2);

    let codex_state = read_json_file(&codex_home.join(".codex-global-state.json"));
    assert_eq!(
        codex_state["electron-saved-workspace-roots"],
        json!(["/repo/Other", "/repo/Old"])
    );
    assert_eq!(
        codex_state["project-order"],
        json!(["/repo/Other", "/repo/Old"])
    );
    assert_eq!(
        codex_state["electron-workspace-root-labels"]["/repo/Old"],
        "Old name"
    );

    let oplog_path = executor_home
        .join("runtime-work")
        .join(".codex-global-state.oplog.jsonl");
    let oplog = fs::read_to_string(oplog_path).expect("oplog should remain pending");
    let ops = oplog.lines().collect::<Vec<_>>();
    assert_eq!(ops.len(), 3);
    assert!(ops[0].contains("\"kind\":\"upsert\""));
    assert!(ops[1].contains("\"kind\":\"rename\""));
    assert!(ops[2].contains("\"kind\":\"remove\""));
}

#[tokio::test]
async fn runtime_task_list_keeps_cached_codex_store_entries_until_provider_discovers_thread() {
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

    let workspaces = listed["workspaces"].as_array().unwrap();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(workspaces[0]["workspacePath"], "/repo/Wegent");
    let tasks = workspaces[0]["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["taskId"], "stale-thread");
    assert_eq!(tasks[0]["runtimeHandle"]["threadId"], "stale-thread");
}

#[tokio::test]
async fn runtime_task_list_drops_unmapped_pending_task_when_matching_codex_thread_exists() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-pending-shadow-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-pending-shadow-codex-home", "dir")
            .display()
            .to_string(),
    );
    let threads = json!([
        {
            "id": "thread-real",
            "cwd": "/repo/Wegent",
            "name": "Fix cloud connection state",
            "preview": "Fix cloud connection state",
            "path": "/tmp/codex/thread-real.jsonl",
            "createdAt": 1780000000000_i64,
            "updatedAt": 1780000060000_i64,
            "status": "idle",
            "turns": []
        }
    ])
    .to_string();
    let fake_codex =
        write_fake_codex_with_threads(&temp_path("runtime-pending-shadow-log", "jsonl"), &threads);
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "tasks": {
                "local-pending": {
                    "local_task_id": "local-pending",
                    "thread_id": null,
                    "workspace_path": "/repo/Wegent",
                    "title": "Fix cloud connection state",
                    "runtime": "codex",
                    "status": "running",
                    "running": true,
                    "created_at": 4102444800000_i64,
                    "updated_at": 4102444800000_i64,
                    "runtime_handle": {},
                    "parent": null
                }
            },
            "workspaces": {}
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

    let tasks = listed["workspaces"][0]["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["taskId"], "thread-real");
    assert_eq!(tasks[0]["running"], false);
}

#[tokio::test]
async fn runtime_task_list_normalizes_unmapped_pending_codex_tasks() {
    let _lock = env_lock().await;
    let executor_home = temp_path("runtime-stale-pending-home", "dir");
    let _home = EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set(
        "CODEX_HOME",
        &temp_path("runtime-stale-pending-codex-home", "dir")
            .display()
            .to_string(),
    );
    let fake_codex = write_fake_codex_empty(&temp_path("runtime-stale-pending-log", "jsonl"));
    let index_path = executor_home.join("runtime-work").join("index.json");
    fs::create_dir_all(index_path.parent().unwrap()).unwrap();
    fs::write(
        &index_path,
        serde_json::to_vec_pretty(&json!({
            "version": 1,
            "tasks": {
                "unmapped-pending": {
                    "local_task_id": "unmapped-pending",
                    "thread_id": null,
                    "workspace_path": "/repo/Wegent",
                    "title": "Unmapped pending task",
                    "runtime": "codex",
                    "status": "running",
                    "running": true,
                    "created_at": 4102444800000_i64,
                    "updated_at": 4102444800000_i64,
                    "runtime_handle": {},
                    "parent": null
                }
            },
            "workspaces": {}
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

    let tasks = listed["workspaces"][0]["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["taskId"], "unmapped-pending");
    assert_eq!(tasks[0]["status"], "active");
    assert_eq!(tasks[0]["running"], false);
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
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"protocolVersion":1}}}}'
      ;;
    *'"method":"initialized"'*)
      ;;
    *'"method":"thread/list"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"data":{},"nextCursor":null,"backwardsCursor":null}}}}'
      ;;
    *'"method":"thread/archive"'*)
      printf '%s\n' '{{"id":'"$request_id"',"result":{{"success":true}}}}'
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
