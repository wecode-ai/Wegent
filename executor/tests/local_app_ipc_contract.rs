// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex, MutexGuard, OnceLock},
};

use serde_json::{json, Value};
use wegent_executor::local::{
    app_ipc::{
        app_ipc_listening_log_line, app_ipc_socket_path, AppIpcError, AppIpcServer,
        RuntimeWorkHandler,
    },
    command::{CommandRequest, CommandResult, DeviceCommandHandler},
};

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
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

    let _ = fs::remove_dir_all(workspace);
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

#[test]
fn app_ipc_socket_path_can_be_overridden() {
    let _lock = env_lock();
    let socket_path = std::env::temp_dir().join("wegent-executor-local-app.sock");
    let _socket = EnvGuard::set(
        "WEGENT_EXECUTOR_APP_IPC_SOCKET",
        &socket_path.display().to_string(),
    );

    assert_eq!(app_ipc_socket_path(), socket_path);
}

#[test]
fn app_ipc_listening_log_line_includes_device_and_socket_path() {
    let line = app_ipc_listening_log_line("device-1", "/tmp/wegent executor/app-ipc.sock");

    assert_log_timestamp(&line);
    assert!(line.ends_with(
        " app IPC listening device_id=device-1 socket_path=\"/tmp/wegent executor/app-ipc.sock\""
    ));
}

fn assert_log_timestamp(line: &str) {
    let timestamp = &line[..19];
    assert_eq!(timestamp.as_bytes()[4], b'-');
    assert_eq!(timestamp.as_bytes()[7], b'-');
    assert_eq!(timestamp.as_bytes()[10], b' ');
    assert_eq!(timestamp.as_bytes()[13], b':');
    assert_eq!(timestamp.as_bytes()[16], b':');
}

#[cfg(unix)]
#[tokio::test]
async fn app_ipc_socket_serves_ready_event_and_responses() {
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixStream,
        time::{sleep, Duration},
    };

    let socket_path = std::env::temp_dir().join(format!(
        "wegent-executor-local-app-ipc-{}.sock",
        std::process::id()
    ));
    let server = AppIpcServer::new().with_device_id("device-1");
    let server_socket_path = socket_path.clone();
    let task = tokio::spawn(async move { server.serve_forever(server_socket_path).await });

    for _ in 0..50 {
        if socket_path.exists() {
            break;
        }
        sleep(Duration::from_millis(10)).await;
    }

    let stream = UnixStream::connect(&socket_path).await.unwrap();
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
    let _ = std::fs::remove_file(socket_path);
}

fn unique_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-local-app-ipc-{label}-{}",
        std::process::id()
    ))
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
