// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use wegent_executor::{
    config::device::UpdateConfig,
    local::backend::{EventHandler, LocalBackendConfig, LocalBackendRunner, LocalBackendTransport},
    protocol::{ExecutionRequest, TaskStatus},
    server::{RunnerResult, TaskRunner},
};

#[path = "../src/test_env.rs"]
mod test_env;

#[path = "support/git_clone_fixture.rs"]
mod git_clone_fixture;

#[tokio::test]
async fn backend_clone_preserves_cwd_for_preflight_and_relative_destination() {
    for device_type in ["local", "cloud", "remote"] {
        for relative_source in [true, false] {
            let fixture = git_clone_fixture::GitCloneFixture::new();
            let transport = RecordingTransport::default();
            let mut config = local_backend_config();
            config.device_type = device_type.to_owned();
            let runner = LocalBackendRunner::with_task_runner(
                config,
                transport.clone(),
                RecordingTaskRunner::default(),
            );
            runner.register_handlers();
            let result = transport.handler("device:execute_command").unwrap()(json!({
                "command_key": "git_clone",
                "command": "git clone",
                "cwd": fixture.directory.path(),
                "args": fixture.args(relative_source),
                "env": fixture.env,
                "timeout_seconds": 10,
            }))
            .await
            .unwrap();
            assert_eq!(
                result["success"], true,
                "{device_type}, {relative_source}: {result}"
            );
            fixture.assert_checkout();
        }
    }
}

#[tokio::test]
async fn backend_clone_reports_invalid_branch_after_successful_access_check() {
    for device_type in ["local", "cloud", "remote"] {
        let fixture = git_clone_fixture::GitCloneFixture::new();
        let transport = RecordingTransport::default();
        let mut config = local_backend_config();
        config.device_type = device_type.to_owned();
        let runner = LocalBackendRunner::with_task_runner(
            config,
            transport.clone(),
            RecordingTaskRunner::default(),
        );
        runner.register_handlers();
        let mut args = fixture.args(true);
        args[1] = "invalid..branch".into();
        let result = transport.handler("device:execute_command").unwrap()(json!({
            "command_key": "git_clone",
            "command": "git clone",
            "cwd": fixture.directory.path(),
            "args": args,
            "env": fixture.env,
            "timeout_seconds": 10,
        }))
        .await
        .unwrap();
        assert_eq!(result["success"], false, "{device_type}: {result}");
        let error = result["error"].as_str().unwrap();
        let failure: serde_json::Value =
            serde_json::from_str(error.strip_prefix("git-access:").unwrap()).unwrap();
        assert_eq!(failure["code"], "clone-failed", "{device_type}: {result}");
        assert_eq!(result["stderr"], "");
        assert!(!fixture.directory.path().join("checkout").exists());
    }
}

#[tokio::test]
async fn device_workspace_file_commands_read_unregistered_directories() {
    let directory = tempfile::tempdir().unwrap();
    let path = std::fs::canonicalize(directory.path()).unwrap();
    let workspace = path.join("test");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(path.join("README.md"), "hello").unwrap();
    std::fs::write(path.join("sunset.png"), b"image").unwrap();

    for device_type in ["local", "cloud", "remote"] {
        let transport = RecordingTransport::default();
        let mut config = local_backend_config();
        config.device_type = device_type.to_owned();
        let runner = LocalBackendRunner::with_task_runner(
            config,
            transport.clone(),
            RecordingTaskRunner::default(),
        );
        runner.register_handlers();
        let handler = transport.handler("device:execute_command").unwrap();
        for (command_key, args, field, expected) in [
            (
                "workspace_read_text_file",
                vec!["README.md"],
                "content",
                "hello",
            ),
            (
                "workspace_read_file_chunk",
                vec!["sunset.png", "0"],
                "content_base64",
                "aW1hZ2U=",
            ),
        ] {
            let result = handler(json!({
                "command_key": command_key,
                "cwd": path,
                "args": args,
                "env": {"WEGENT_WORKSPACE_ROOTS": workspace},
            }))
            .await
            .unwrap();

            assert_eq!(result["success"], true, "{device_type}: {result}");
            assert_eq!(result["stdout"][field], expected);
        }
    }
}

#[tokio::test]
async fn task_execute_preserves_skill_identity_token() {
    let transport = RecordingTransport::default();
    let task_runner = RecordingTaskRunner::default();
    let runner = LocalBackendRunner::with_task_runner(
        local_backend_config(),
        transport.clone(),
        task_runner.clone(),
    );
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 1,
        "subtask_id": 2,
        "skill_identity_token": "skill-jwt",
    }))
    .await;

    assert_eq!(ack, None);
    let submitted = task_runner.submitted();
    assert_eq!(submitted.len(), 1);
    assert_eq!(
        submitted[0].skill_identity_token.as_deref(),
        Some("skill-jwt")
    );
    assert_eq!(
        submitted[0].runtime_auth_token.as_deref(),
        Some("runtime-wg-token")
    );
}

#[test]
fn early_cancel_is_recovered_and_only_cancels_the_targeted_dispatch() {
    test_env::run_with_executor_home(verify_early_cancel());
}

async fn verify_early_cancel() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();
    for (task, subtask) in [(10, Some(20)), (11, None)] {
        transport.handler("task:cancel").unwrap()(json!({"task_id":task,"subtask_id":subtask}))
            .await;
    }
    drop(runner);
    let restored = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), restored.clone());
    runner.register_handlers();
    for (task, subtask) in [(11, 21), (10, 20)] {
        restored.handler("task:execute").unwrap()(json!({"task_id":task,"subtask_id":subtask}))
            .await;
    }
    let events = restored.events.lock().unwrap();
    assert_eq!(
        events
            .iter()
            .map(|(name, payload)| (
                name.as_str(),
                payload["subtask_id"].as_i64(),
                payload["data"]["response"]["status"].as_str()
            ))
            .collect::<Vec<_>>(),
        vec![
            ("response.incomplete", Some(21), Some("cancelled")),
            ("response.incomplete", Some(20), Some("cancelled")),
        ]
    );
}

#[derive(Clone, Default)]
struct RecordingTransport {
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
    events: Arc<Mutex<Vec<(String, Value)>>>,
}

impl RecordingTransport {
    fn handler(&self, event: &str) -> Option<EventHandler> {
        self.handlers
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| name == event)
            .map(|(_, handler)| Arc::clone(handler))
    }
}

impl LocalBackendTransport for RecordingTransport {
    fn connect<'a>(
        &'a self,
        _config: &'a LocalBackendConfig,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn disconnect<'a>(&'a self) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async { Ok(()) })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        _timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        self.events
            .lock()
            .unwrap()
            .push((event.to_owned(), payload));
        Box::pin(async { Ok(json!({"success": true})) })
    }

    fn emit<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        self.events
            .lock()
            .unwrap()
            .push((event.to_owned(), payload));
        Box::pin(async { Ok(()) })
    }

    fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .lock()
            .unwrap()
            .push((event.to_owned(), handler));
    }

    fn on_close(&self, _: wegent_executor::local::backend::ConnectionClosedHandler) {}
}

#[derive(Clone, Default)]
struct RecordingTaskRunner {
    submitted: Arc<Mutex<Vec<ExecutionRequest>>>,
}

impl RecordingTaskRunner {
    fn submitted(&self) -> Vec<ExecutionRequest> {
        self.submitted.lock().unwrap().clone()
    }
}

impl TaskRunner for RecordingTaskRunner {
    type SubmitFuture = Pin<Box<dyn Future<Output = RunnerResult> + Send>>;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        self.submitted.lock().unwrap().push(request);
        Box::pin(async { RunnerResult::accepted(TaskStatus::Running) })
    }
}

fn local_backend_config() -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: "http://localhost:8000".to_owned(),
        socket_url: "http://localhost:8000".to_owned(),
        auth_token: "wg-token".to_owned(),
        runtime_auth_token: "runtime-wg-token".to_owned(),
        device_id: "device-1".to_owned(),
        runtime_instance_id: "runtime-1".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        app_device_id: String::new(),
        bind_shell: "claudecode".to_owned(),
        executor_version: "test-version".to_owned(),
        client_ip: "192.0.2.10".to_owned(),
        runtime_transfer_host: "192.0.2.10".to_owned(),
        heartbeat_interval: Duration::from_secs(30),
        heartbeat_timeout: Duration::from_secs(10),
        runtime_work_poll_interval: Duration::from_secs(2),
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(30),
        configured_capabilities: Vec::new(),
        local_workspace_root: std::env::temp_dir()
            .join(format!("wegent-dispatch-workspace-{}", std::process::id())),
        update: UpdateConfig::default(),
    }
}
