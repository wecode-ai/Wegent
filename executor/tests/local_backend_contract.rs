// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt};

use serde_json::{json, Value};
use tokio::time::timeout;
use wegent_executor::{
    config::device::{DeviceConfig, UpdateConfig},
    emitter::ResponsesEventBuilder,
    local::backend::{
        build_runtime_auth_file_report, is_usable_device_ip, CapabilityReportProvider,
        LocalBackendClient, LocalBackendConfig, LocalBackendEventSink, LocalBackendRunner,
        LocalBackendTransport,
    },
    runner::EventSink,
};

#[tokio::test]
async fn local_backend_registers_device_with_python_compatible_payload() {
    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let config = local_backend_config();
    let client = LocalBackendClient::with_capability_reporter(
        config,
        transport.clone(),
        StaticCapabilityReporter,
    );

    let registered = client
        .register_device(Duration::from_secs(2))
        .await
        .unwrap();

    assert!(registered);
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:register");
    assert_eq!(calls[0].payload["device_id"], "device-1");
    assert_eq!(calls[0].payload["name"], "Device One");
    assert_eq!(calls[0].payload["device_type"], "local");
    assert_eq!(calls[0].payload["bind_shell"], "claudecode");
    assert_eq!(calls[0].payload["executor_version"], "test-version");
    assert_eq!(calls[0].payload["client_ip"], "192.0.2.10");
    assert_eq!(calls[0].payload["runtime_transfer_host"], "192.0.2.10");
}

#[tokio::test]
async fn local_backend_accepts_socketio_wrapped_registration_ack() {
    let transport = RecordingTransport::with_responses(vec![json!([
        {"success": true, "device_id": "device-1"}
    ])]);
    let client = LocalBackendClient::new(local_backend_config(), transport);

    let registered = client
        .register_device(Duration::from_secs(2))
        .await
        .unwrap();

    assert!(registered);
}

#[tokio::test]
async fn local_backend_heartbeat_reports_running_tasks_capabilities_and_auth_files() {
    let home = temp_home("auth-report");
    std::fs::create_dir_all(home.join(".codex")).unwrap();
    std::fs::write(home.join(".codex/auth.json"), "{}").unwrap();

    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let mut config = local_backend_config();
    config.runtime_auth_home = home;
    let client = LocalBackendClient::with_capability_reporter(
        config,
        transport.clone(),
        StaticCapabilityReporter,
    );
    client.set_running_task_ids([10, 20]);

    let accepted = client.send_heartbeat(Duration::from_secs(2)).await.unwrap();

    assert!(accepted);
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:heartbeat");
    assert_eq!(calls[0].payload["device_id"], "device-1");
    assert_eq!(calls[0].payload["running_task_ids"], json!([10, 20]));
    assert_eq!(calls[0].payload["executor_version"], "test-version");
    assert_eq!(calls[0].payload["capabilities"]["revision"], 0);
    assert_eq!(calls[0].payload["capabilities"]["skills"], json!([]));
    assert_eq!(
        calls[0].payload["runtime_auth_files"]["codex"],
        json!({"target_path": "~/.codex/auth.json", "exists": true})
    );
}

#[tokio::test]
async fn local_backend_event_sink_emits_responses_api_event_names() {
    let transport = RecordingTransport::default();
    let client = LocalBackendClient::new(local_backend_config(), transport.clone());
    let sink = LocalBackendEventSink::new(client);
    let event = ResponsesEventBuilder::new(1, 2, "claude")
        .with_response_id("resp-test")
        .response_completed("done");

    sink.send(event).await.unwrap();

    let emits = transport.emits();
    assert_eq!(emits.len(), 1);
    assert_eq!(emits[0].event, "response.completed");
    assert_eq!(emits[0].payload["task_id"], 1);
    assert_eq!(emits[0].payload["subtask_id"], 2);
    assert_eq!(emits[0].payload["data"]["response"]["id"], "resp-test");
}

#[tokio::test]
async fn local_backend_disconnects_when_registration_is_rejected() {
    let transport = RecordingTransport::with_responses(vec![json!({"success": false})]);
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());

    let error = runner.connect_and_register().await.unwrap_err();

    assert_eq!(error, "device registration was rejected by backend");
    assert_eq!(transport.disconnects(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_handler_runs_agent_and_emits_events() {
    let fake_claude = write_fake_executable(
        "fake-local-backend-claude",
        r#"#!/bin/sh
printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"local done"}]}}'
"#,
    );
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 100,
        "subtask_id": 101,
        "prompt": "run",
        "bot": [{"shell_type": "ClaudeCode"}],
        "model_config": {
            "env": {
                "model": "anthropic",
                "model_id": "claude-3-5-sonnet-20241022"
            }
        }
    }))
    .await;
    assert_eq!(ack, None);

    let emits = transport.wait_for_emits(2).await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits[1].event, "response.completed");
    assert_eq!(
        emits[1].payload["data"]["response"]["output"][0]["content"][0]["text"],
        "local done"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_execute_command_handler_returns_backend_call_ack_payload() {
    let cwd = temp_home("command-handler");
    std::fs::create_dir_all(&cwd).unwrap();
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("device:execute_command").unwrap();
    let ack = handler(json!({
        "command": "printf executor",
        "argv": ["printf", "executor"],
        "cwd": cwd,
        "timeout_seconds": 2,
        "max_output_bytes": 1024
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true);
    assert_eq!(ack["exit_code"], 0);
    assert_eq!(ack["stdout"], "executor");
    assert_eq!(ack["stderr"], "");
}

#[tokio::test]
async fn local_backend_runtime_rpc_handler_uses_default_runtime_work_handler() {
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("runtime:rpc").unwrap();
    let ack = handler(json!({
        "method": "runtime.tasks.list",
        "payload": {}
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
    assert!(ack["workspaces"].is_array(), "{ack}");
}

#[test]
fn local_backend_config_uses_device_config_and_normalizes_token() {
    let mut device = DeviceConfig {
        device_id: "device-1".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        bind_shell: "claudecode".to_owned(),
        connection: wegent_executor::config::device::ConnectionConfig {
            backend_url: "http://localhost:8000".to_owned(),
            auth_token: "Bearer wg-token".to_owned(),
        },
        ..DeviceConfig::default()
    };
    device.capabilities = vec!["claude".to_owned()];

    let config = LocalBackendConfig::from_device_config(device);

    assert_eq!(config.backend_url, "http://localhost:8000");
    assert_eq!(config.auth_token, "wg-token");
    assert_eq!(config.device_id, "device-1");
    assert_eq!(config.device_name, "Device One");
    assert_eq!(config.device_type, "local");
    assert_eq!(config.bind_shell, "claudecode");
    assert_eq!(config.configured_capabilities, vec!["claude"]);
}

#[test]
fn local_backend_auth_file_report_and_ip_filter_match_python_contract() {
    let home = temp_home("missing-auth-report");
    assert_eq!(
        build_runtime_auth_file_report(&home),
        json!({"codex": {"target_path": "~/.codex/auth.json", "exists": false}})
    );

    assert!(is_usable_device_ip("192.0.2.10"));
    assert!(is_usable_device_ip("192.168.1.8"));
    assert!(!is_usable_device_ip("127.0.0.1"));
    assert!(!is_usable_device_ip("localhost"));
}

#[derive(Clone, Debug)]
struct RecordedCall {
    event: String,
    payload: Value,
}

#[derive(Clone, Default)]
struct RecordingTransport {
    calls: Arc<Mutex<Vec<RecordedCall>>>,
    emits: Arc<Mutex<Vec<RecordedCall>>>,
    responses: Arc<Mutex<VecDeque<Value>>>,
    handlers: Arc<Mutex<Vec<(String, wegent_executor::local::backend::EventHandler)>>>,
    disconnects: Arc<Mutex<usize>>,
    notify: Arc<tokio::sync::Notify>,
}

impl RecordingTransport {
    fn with_responses(responses: Vec<Value>) -> Self {
        Self {
            responses: Arc::new(Mutex::new(responses.into())),
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }

    fn emits(&self) -> Vec<RecordedCall> {
        self.emits.lock().unwrap().clone()
    }

    fn handler(&self, event: &str) -> Option<wegent_executor::local::backend::EventHandler> {
        self.handlers
            .lock()
            .unwrap()
            .iter()
            .find(|(name, _)| name == event)
            .map(|(_, handler)| Arc::clone(handler))
    }

    fn disconnects(&self) -> usize {
        *self.disconnects.lock().unwrap()
    }

    async fn wait_for_emits(&self, count: usize) -> Vec<RecordedCall> {
        timeout(Duration::from_secs(3), async {
            loop {
                let emits = self.emits();
                if emits.len() >= count {
                    return emits;
                }
                self.notify.notified().await;
            }
        })
        .await
        .unwrap()
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
        Box::pin(async move {
            *self.disconnects.lock().unwrap() += 1;
            Ok(())
        })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        _timeout: Duration,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + 'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(RecordedCall {
                event: event.to_owned(),
                payload,
            });
            Ok(self
                .responses
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| json!({"success": true})))
        })
    }

    fn emit<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            self.emits.lock().unwrap().push(RecordedCall {
                event: event.to_owned(),
                payload,
            });
            self.notify.notify_waiters();
            Ok(())
        })
    }

    fn on(&self, event: &str, handler: wegent_executor::local::backend::EventHandler) {
        self.handlers
            .lock()
            .unwrap()
            .push((event.to_owned(), handler));
    }
}

fn local_backend_config() -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: "http://localhost:8000".to_owned(),
        auth_token: "wg-token".to_owned(),
        device_id: "device-1".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        bind_shell: "claudecode".to_owned(),
        executor_version: "test-version".to_owned(),
        client_ip: "192.0.2.10".to_owned(),
        runtime_transfer_host: "192.0.2.10".to_owned(),
        heartbeat_interval: Duration::from_secs(30),
        heartbeat_timeout: Duration::from_secs(10),
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(30),
        configured_capabilities: Vec::new(),
        runtime_auth_home: temp_home("runtime-auth"),
        local_workspace_root: temp_home("workspace"),
        update: UpdateConfig::default(),
    }
}

fn temp_home(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "wegent-executor-local-backend-{label}-{}",
        std::process::id()
    ))
}

struct StaticCapabilityReporter;

impl CapabilityReportProvider for StaticCapabilityReporter {
    fn build_report(&self) -> Value {
        json!({
            "revision": 0,
            "digest": "sha256:empty",
            "full": true,
            "skills": [],
            "plugins": [],
            "mcps": [],
            "last_sync_at": null,
        })
    }
}

#[cfg(unix)]
fn write_fake_executable(name: &str, content: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    fs::write(&path, content).unwrap();
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&path, permissions).unwrap();
    path
}

struct EnvGuard {
    key: &'static str,
    previous: Option<String>,
}

impl EnvGuard {
    #[cfg(unix)]
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
