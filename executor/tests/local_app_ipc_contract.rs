// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, OnceLock},
};

use serde_json::{json, Value};
use tokio::sync::{Mutex as AsyncMutex, MutexGuard as AsyncMutexGuard};
use wegent_executor::local::{
    app_ipc::{
        app_ipc_listening_log_line, local_app_ipc_addr_file_path, read_app_ipc_addr_file,
        AppIpcError, AppIpcServer, RuntimeWorkHandler,
    },
    command::{CommandRequest, CommandResult, DeviceCommandHandler},
};

const LOCAL_GIT_ENV_VARS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

async fn env_lock() -> AsyncMutexGuard<'static, ()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(())).lock().await
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
async fn app_ipc_routes_runtime_rpc_request() {
    let server = AppIpcServer::new().with_runtime_work_handler(RuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-1",
                "method": "runtime.tasks.list",
                "params": {"workspacePath": "/tmp/project"}
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        json!({
            "type": "response",
            "id": "req-1",
            "ok": true,
            "result": {"success": true, "workspaces": []}
        })
    );
}

#[tokio::test]
async fn app_ipc_routes_codex_app_server_request() {
    let server = AppIpcServer::new().with_runtime_work_handler(CodexRuntimeHandler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-codex",
                "method": "codex.app_server_request",
                "params": {
                    "method": "plugin/installed",
                    "params": {"cwds": null}
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        response,
        json!({
            "type": "response",
            "id": "req-codex",
            "ok": true,
            "result": {"marketplaces": []}
        })
    );
}

#[tokio::test]
async fn app_ipc_emits_runtime_events_with_device_id() {
    let server = AppIpcServer::new().with_device_id("device-1");

    let event = server.event_message(
        "response.output_text.delta",
        json!({"local_task_id": "task-1", "data": {"delta": "hi"}}),
    );

    assert_eq!(
        event,
        json!({
            "type": "event",
            "event": "response.output_text.delta",
            "payload": {
                "device_id": "device-1",
                "local_task_id": "task-1",
                "data": {"delta": "hi"}
            }
        })
    );
}

#[tokio::test]
async fn app_ipc_resolves_configured_device_command() {
    let command_handler = CaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-2",
                "method": "device.execute_command",
                "params": {
                    "command_key": "ls_dirs",
                    "path": "/tmp/project",
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(
        *seen_request.lock().unwrap(),
        Some(CommandRequest {
            command: "ls -a -p".to_owned(),
            argv: vec!["ls".to_owned(), "-a".to_owned(), "-p".to_owned()],
            cwd: Some("/tmp/project".to_owned()),
            env: Default::default(),
            timeout_seconds: 10.0,
            max_output_bytes: 4096,
        })
    );
    assert_eq!(response["result"]["stdout"], json!(["src"]));
}

#[tokio::test]
async fn app_ipc_lists_and_reads_workspace_files_locally() {
    let workspace = unique_dir("workspace-files");
    fs::create_dir_all(workspace.join("src")).unwrap();
    fs::write(workspace.join("README.md"), "hello").unwrap();
    let workspace = fs::canonicalize(workspace).unwrap();
    let server = AppIpcServer::new();

    let tree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-tree",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_tree",
                    "path": workspace.display().to_string(),
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(tree_response["ok"], true);
    assert_eq!(tree_response["result"]["success"], true);
    assert_eq!(
        tree_response["result"]["stdout"]["path"],
        json!(workspace.display().to_string())
    );
    assert_eq!(
        tree_response["result"]["stdout"]["entries"][0]["name"],
        json!("src")
    );

    let file_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-file",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_read_text_file",
                    "path": workspace.display().to_string(),
                    "args": ["README.md"],
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(file_response["ok"], true);
    assert_eq!(file_response["result"]["success"], true);
    assert_eq!(file_response["result"]["stdout"]["content"], json!("hello"));

    let chunk_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-file-chunk",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_read_file_chunk",
                    "path": workspace.display().to_string(),
                    "args": ["README.md", "0"],
                    "timeout_seconds": 10,
                    "max_output_bytes": 2_097_152
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(chunk_response["ok"], true);
    assert_eq!(chunk_response["result"]["success"], true);
    assert_eq!(
        chunk_response["result"]["stdout"]["content_base64"],
        json!("aGVsbG8=")
    );
    assert_eq!(chunk_response["result"]["stdout"]["eof"], true);

    let _ = fs::remove_dir_all(workspace);
}

#[tokio::test]
async fn app_ipc_rejects_workspace_files_outside_allowed_roots() {
    let allowed_workspace = unique_dir("workspace-files-allowed");
    fs::create_dir_all(&allowed_workspace).unwrap();
    let allowed_workspace = fs::canonicalize(allowed_workspace).unwrap();
    let blocked_workspace = unique_dir("workspace-files-blocked");
    fs::create_dir_all(&blocked_workspace).unwrap();
    let blocked_workspace = fs::canonicalize(blocked_workspace).unwrap();
    let server = AppIpcServer::new();

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-blocked-tree",
                "method": "device.execute_command",
                "params": {
                    "command_key": "workspace_tree",
                    "path": blocked_workspace.display().to_string(),
                    "env": {"WEGENT_WORKSPACE_ROOTS": allowed_workspace.display().to_string()},
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["success"], false);
    assert_eq!(
        response["result"]["error"],
        json!("Workspace path is outside allowed workspace roots")
    );

    let _ = fs::remove_dir_all(allowed_workspace);
    let _ = fs::remove_dir_all(blocked_workspace);
}

#[tokio::test]
async fn app_ipc_lists_codex_skills_from_runtime_directories() {
    let _lock = env_lock().await;
    let home = unique_dir("local-skills-home");
    let _home = EnvGuard::set("HOME", &home.display().to_string());
    let _codex_home = EnvGuard::set("CODEX_HOME", "");
    let agents_skill = home.join(".agents/skills/env-context");
    let claude_skill = home.join(".claude/skills/claude-review");
    let codex_skill = home.join(".codex/skills/codex-review");
    let codex_system_skill = home.join(".codex/skills/.system/codex-system");
    let claude_plugin_skill = home.join(".claude/plugins/cache/vendor/example/skills/plugin-skill");
    let codex_plugin_skill = home
        .join(".codex/plugins/cache/openai-curated-remote/codex-pack/0.1.0/skills/codex-plugin");
    let old_codex_plugin_skill =
        home.join(".codex/plugins/cache/openai-curated/codex-pack/deadbeef/skills/codex-plugin");
    fs::create_dir_all(&agents_skill).unwrap();
    fs::create_dir_all(&claude_skill).unwrap();
    fs::create_dir_all(&codex_skill).unwrap();
    fs::create_dir_all(&codex_system_skill).unwrap();
    fs::create_dir_all(&claude_plugin_skill).unwrap();
    fs::create_dir_all(&codex_plugin_skill).unwrap();
    fs::create_dir_all(&old_codex_plugin_skill).unwrap();
    fs::write(
        agents_skill.join("SKILL.md"),
        "---\nname: env-context\ndescription: Environment facts\n---\n",
    )
    .unwrap();
    fs::write(
        claude_skill.join("SKILL.md"),
        "---\nname: claude-review\ndescription: Claude review\n---\n",
    )
    .unwrap();
    fs::write(
        codex_skill.join("SKILL.md"),
        "---\nname: codex-review\ndescription: |\n  Review with Codex\n  across files\n---\n",
    )
    .unwrap();
    fs::write(
        codex_system_skill.join("SKILL.md"),
        "---\nname: codex-system\ndescription: Built in Codex skill\n---\n",
    )
    .unwrap();
    fs::write(
        claude_plugin_skill.join("SKILL.md"),
        "---\nname: plugin-skill\ndescription: Claude plugin skill\n---\n",
    )
    .unwrap();
    fs::write(
        codex_plugin_skill.join("SKILL.md"),
        "---\nname: codex-plugin\ndescription: Current Codex plugin skill\n---\n",
    )
    .unwrap();
    fs::write(
        old_codex_plugin_skill.join("SKILL.md"),
        "---\nname: codex-plugin\ndescription: Old Codex plugin skill\n---\n",
    )
    .unwrap();

    let server = AppIpcServer::new();
    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-skills",
                "method": "device.execute_command",
                "params": {
                    "command_key": "ls_skills",
                    "timeout_seconds": 10,
                    "max_output_bytes": 4096
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["success"], true);
    let skills = response["result"]["stdout"].as_array().unwrap();
    assert_eq!(skills.len(), 3);
    assert_eq!(skills[0]["name"], json!("codex-review"));
    assert_eq!(
        skills[0]["description"],
        json!("Review with Codex\nacross files")
    );
    assert_eq!(skills[0]["source"], json!("codex"));
    assert_eq!(skills[0]["scope"], json!("user"));
    assert_eq!(skills[0]["source_priority"], json!(0));
    assert_eq!(
        skills[0]["path"],
        json!(codex_skill.join("SKILL.md").display().to_string())
    );
    assert_eq!(skills[1]["name"], json!("codex-system"));
    assert_eq!(skills[1]["description"], json!("Built in Codex skill"));
    assert_eq!(skills[1]["source"], json!("codex"));
    assert_eq!(skills[1]["scope"], json!("system"));
    assert_eq!(skills[1]["source_priority"], json!(10));
    assert_eq!(
        skills[1]["path"],
        json!(codex_system_skill.join("SKILL.md").display().to_string())
    );
    assert_eq!(skills[2]["name"], json!("codex-plugin"));
    assert_eq!(
        skills[2]["description"],
        json!("Current Codex plugin skill")
    );
    assert_eq!(skills[2]["source"], json!("codex-plugin"));
    assert_eq!(skills[2]["scope"], json!("user"));
    assert_eq!(skills[2]["plugin_name"], json!("codex-pack"));
    assert_eq!(skills[2]["plugin_provider"], json!("openai-curated-remote"));
    assert_eq!(skills[2]["plugin_version"], json!("0.1.0"));
    assert_eq!(skills[2]["source_priority"], json!(20));
    assert_eq!(
        skills[2]["path"],
        json!(codex_plugin_skill.join("SKILL.md").display().to_string())
    );

    let _ = fs::remove_dir_all(home);
}

#[tokio::test]
async fn app_ipc_resolves_review_and_git_device_commands() {
    let command_handler = CaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let git_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-git",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_diff",
                    "path": "/tmp/project"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(git_response["ok"], true);
    assert_eq!(
        seen_request.lock().unwrap().as_ref().unwrap().argv[0],
        "bash"
    );

    let worktree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-worktree",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_add",
                    "args": ["/tmp/project", "/tmp/worktrees/1/project"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(worktree_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert_eq!(request.argv[3], "--");
    assert_eq!(request.argv[4], "/tmp/project");
    assert_eq!(request.argv[5], "/tmp/worktrees/1/project");
    assert_eq!(request.argv.len(), 6);

    let selected_branch_worktree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-worktree-branch",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_add",
                    "args": ["/tmp/project", "/tmp/worktrees/2/project", "main"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(selected_branch_worktree_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert_eq!(request.argv[3], "--");
    assert_eq!(request.argv[4], "/tmp/project");
    assert_eq!(request.argv[5], "/tmp/worktrees/2/project");
    assert_eq!(request.argv[6], "main");

    let remove_worktree_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-worktree-remove",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_remove",
                    "args": ["/tmp/worktrees/2/project", "/tmp/worktrees/2/project"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(remove_worktree_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert_eq!(request.argv[3], "--");
    assert_eq!(request.argv[4], "/tmp/worktrees/2/project");
    assert_eq!(request.argv[5], "/tmp/worktrees/2/project");
    assert_eq!(request.argv.len(), 6);

    let review_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-review",
                "method": "device.execute_command",
                "params": {
                    "command_key": "turn_file_changes_review",
                    "path": "/tmp/project",
                    "args": ["turn-file-changes/0/1"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(review_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "python3");
    assert_eq!(request.argv[3], "review");
    assert_eq!(request.argv[4], "turn-file-changes/0/1");
    let review_request = request;

    let commit_message_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-commit-message",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_generate_commit_message",
                    "path": "/tmp/project"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(commit_message_response["ok"], true);
    assert_eq!(commit_message_response["result"]["success"], false);
    assert_eq!(
        commit_message_response["result"]["stdout"]["success"],
        false
    );
    assert_eq!(
        seen_request.lock().unwrap().as_ref(),
        Some(&review_request),
        "native commit message generation must not dispatch through the generic command handler"
    );
    let push_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-git-push",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_push",
                    "path": "/tmp/project"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(push_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert!(!request.argv[2].contains("@{u}"));
    assert!(
        request.argv[2].contains("exec git push -u origin \"$branch\""),
        "push must publish the current branch under the same remote branch name"
    );
}

#[tokio::test]
async fn app_ipc_resolves_browser_session_device_commands() {
    let command_handler = JsonCaptureCommandHandler::default();
    let seen_request = Arc::clone(&command_handler.seen_request);
    let server = AppIpcServer::new().with_command_handler(command_handler);

    let relay_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-browser-relay",
                "method": "device.execute_command",
                "params": {
                    "command_key": "browser_relay_restart"
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(relay_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert!(request.argv[2].contains("cdp-relay-server"));
    assert!(request.argv[2].contains("--restart"));

    let tool_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-browser-tool",
                "method": "device.execute_command",
                "params": {
                    "command_key": "browser_tool",
                    "args": ["{\"action\":\"open\",\"url\":\"https://example.com\"}"]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(tool_response["ok"], true);
    let request = seen_request.lock().unwrap().clone().unwrap();
    assert_eq!(request.argv[0], "sh");
    assert_eq!(request.argv[3], "--");
    assert_eq!(
        request.argv[4],
        "{\"action\":\"open\",\"url\":\"https://example.com\"}"
    );
    assert!(request.argv[2].contains("browser-tool"));
}

#[derive(Default)]
struct JsonCaptureCommandHandler {
    seen_request: Arc<Mutex<Option<CommandRequest>>>,
}

impl DeviceCommandHandler for JsonCaptureCommandHandler {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        Box::pin(async move {
            *self.seen_request.lock().unwrap() = Some(request);
            CommandResult::ok(json!({"ok": true}).to_string())
        })
    }
}

#[tokio::test]
async fn app_ipc_accepts_gitdir_with_configured_worktree_as_worktree_source() {
    let root = unique_dir("gitdir-worktree-source");
    let source_worktree = root.join("source");
    let source_gitdir = root.join("source.git");
    let target_worktree = root.join("target");
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&source_worktree).unwrap();

    assert_command_success(
        git_command()
            .args([
                "init",
                "--separate-git-dir",
                source_gitdir.to_str().unwrap(),
            ])
            .arg(&source_worktree)
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "-C",
                source_worktree.to_str().unwrap(),
                "config",
                "user.email",
                "test@example.com",
            ])
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "-C",
                source_worktree.to_str().unwrap(),
                "config",
                "user.name",
                "Test User",
            ])
            .output()
            .unwrap(),
    );
    fs::write(source_worktree.join("README.md"), "hello\n").unwrap();
    assert_command_success(
        git_command()
            .args(["-C", source_worktree.to_str().unwrap(), "add", "README.md"])
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "-C",
                source_worktree.to_str().unwrap(),
                "commit",
                "-m",
                "init",
            ])
            .output()
            .unwrap(),
    );
    assert_command_success(
        git_command()
            .args([
                "--git-dir",
                source_gitdir.to_str().unwrap(),
                "config",
                "core.worktree",
                source_worktree.to_str().unwrap(),
            ])
            .output()
            .unwrap(),
    );

    let server = AppIpcServer::new();
    let check_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-gitdir-check",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_is_worktree",
                    "args": [source_gitdir.display().to_string()]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(check_response["ok"], true);
    assert_eq!(check_response["result"]["success"], true);
    assert_eq!(check_response["result"]["stdout"], json!("true\n"));

    let add_response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-gitdir-add",
                "method": "device.execute_command",
                "params": {
                    "command_key": "git_worktree_add",
                    "args": [
                        source_gitdir.display().to_string(),
                        target_worktree.display().to_string()
                    ]
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(add_response["ok"], true);
    assert_eq!(add_response["result"]["success"], true);
    assert!(target_worktree.join("README.md").is_file());

    let _ = fs::remove_dir_all(root);
}

#[tokio::test]
async fn app_ipc_unknown_method_returns_protocol_error() {
    let server = AppIpcServer::new();

    let response = server
        .handle_line(
            &json!({
                "type": "request",
                "id": "req-3",
                "method": "unknown.method",
                "params": {}
            })
            .to_string(),
        )
        .await
        .unwrap();

    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unsupported_method");
}

#[tokio::test]
async fn app_ipc_addr_can_be_overridden() {
    let _lock = env_lock().await;
    let _addr = EnvGuard::set("WEGENT_EXECUTOR_APP_IPC_ADDR", "127.0.0.1:17490");
    let server = AppIpcServer::new();
    let task = tokio::spawn(async move { server.serve_forever().await });

    let mut addr = None;
    for _ in 0..50 {
        if let Some(found) = read_app_ipc_addr_file() {
            addr = Some(found);
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    }

    task.abort();
    let _ = std::fs::remove_file(local_app_ipc_addr_file_path());

    assert_eq!(addr, Some("127.0.0.1:17490".parse().unwrap()));
}

#[test]
fn app_ipc_listening_log_line_includes_device_and_addr() {
    let line = app_ipc_listening_log_line("device-1", "127.0.0.1:17490");

    assert_log_timestamp(&line);
    assert!(line.ends_with(" app IPC listening device_id=device-1 addr=127.0.0.1:17490"));
}

fn assert_log_timestamp(line: &str) {
    let timestamp = &line[..19];
    assert_eq!(timestamp.as_bytes()[4], b'-');
    assert_eq!(timestamp.as_bytes()[7], b'-');
    assert_eq!(timestamp.as_bytes()[10], b' ');
    assert_eq!(timestamp.as_bytes()[13], b':');
    assert_eq!(timestamp.as_bytes()[16], b':');
}

#[tokio::test]
async fn app_ipc_socket_serves_ready_event_and_responses() {
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::TcpStream,
        time::{sleep, Duration},
    };

    let _lock = env_lock().await;
    let _addr = EnvGuard::set("WEGENT_EXECUTOR_APP_IPC_ADDR", "127.0.0.1:0");
    let server = AppIpcServer::new().with_device_id("device-1");
    let task = tokio::spawn(async move { server.serve_forever().await });

    let mut bound_addr = None;
    for _ in 0..50 {
        if let Some(addr) = read_app_ipc_addr_file() {
            bound_addr = Some(addr);
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }
    let bound_addr = bound_addr.expect("server did not write app IPC address file");

    let stream = TcpStream::connect(bound_addr).await.unwrap();
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let mut line = String::new();

    reader.read_line(&mut line).await.unwrap();
    let ready: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(ready["event"], "executor.ready");
    assert_eq!(ready["payload"]["device_id"], "device-1");
    assert_eq!(ready["payload"]["ready"], true);

    writer
        .write_all(
            json!({
                "type": "request",
                "id": "req-socket",
                "method": "unknown.method",
                "params": {}
            })
            .to_string()
            .as_bytes(),
        )
        .await
        .unwrap();
    writer.write_all(b"\n").await.unwrap();

    line.clear();
    reader.read_line(&mut line).await.unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], "req-socket");
    assert_eq!(response["ok"], false);
    assert_eq!(response["error"]["code"], "unsupported_method");

    task.abort();
    let _ = std::fs::remove_file(local_app_ipc_addr_file_path());
}

fn unique_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-local-app-ipc-{label}-{}",
        std::process::id()
    ))
}

fn git_command() -> std::process::Command {
    let mut command = std::process::Command::new("git");
    for key in LOCAL_GIT_ENV_VARS {
        command.env_remove(key);
    }
    command
}

fn assert_command_success(output: std::process::Output) {
    assert!(
        output.status.success(),
        "command failed: status={} stdout={} stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

struct RuntimeHandler;

impl RuntimeWorkHandler for RuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "runtime.tasks.list",
                    "payload": {"workspacePath": "/tmp/project"}
                })
            );
            Ok(json!({"success": true, "workspaces": []}))
        })
    }
}

struct CodexRuntimeHandler;

impl RuntimeWorkHandler for CodexRuntimeHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async { Err(AppIpcError::new("unexpected_runtime_rpc", "unexpected")) })
    }

    fn handle_codex_app_server_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            assert_eq!(
                data,
                json!({
                    "method": "plugin/installed",
                    "params": {"cwds": null}
                })
            );
            Ok(json!({"marketplaces": []}))
        })
    }
}

#[derive(Default)]
struct CaptureCommandHandler {
    seen_request: Arc<Mutex<Option<CommandRequest>>>,
}

impl DeviceCommandHandler for CaptureCommandHandler {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        Box::pin(async move {
            *self.seen_request.lock().unwrap() = Some(request);
            CommandResult::ok(".\n..\nsrc/\nREADME.md\n")
        })
    }
}
