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

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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
    assert_eq!(calls[0].payload["runtime_instance_id"], "runtime-1");
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
    client.set_running_task_ids(["10".to_owned(), "20".to_owned()]);

    let accepted = client.send_heartbeat(Duration::from_secs(2)).await.unwrap();

    assert!(accepted);
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:heartbeat");
    assert_eq!(calls[0].payload["device_id"], "device-1");
    assert_eq!(calls[0].payload["running_task_ids"], json!(["10", "20"]));
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
    let event = ResponsesEventBuilder::new("1", "2", "claude")
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
    let _lock = ENV_LOCK.lock().await;
    let fake_claude = write_fake_executable(
        "fake-local-backend-claude",
        r#"#!/bin/sh
	printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"local done"}]}}'
	printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
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

    let emits = transport.wait_for_emits(3).await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits[1].event, "response.output_text.delta");
    assert_eq!(emits[1].payload["data"]["delta"], "local done");
    assert_eq!(emits[2].event, "response.completed");
    assert_eq!(
        emits[2].payload["data"]["response"]["output"][0]["content"][0]["text"],
        "local done"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_streams_claude_stdout_before_completion() {
    let _lock = ENV_LOCK.lock().await;
    let fake_claude = write_fake_executable(
        "fake-local-backend-streaming-claude",
        r#"#!/bin/sh
	printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}'
	sleep 0.1
	printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":" world"}]}}'
	printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
	"#,
    );
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 110,
        "subtask_id": 111,
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

    let emits = transport.wait_for_emits(4).await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits[1].event, "response.output_text.delta");
    assert_eq!(emits[1].payload["data"]["delta"], "hello");
    assert_eq!(emits[1].payload["data"]["offset"], 0);
    assert_eq!(emits[2].event, "response.output_text.delta");
    assert_eq!(emits[2].payload["data"]["delta"], " world");
    assert_eq!(emits[2].payload["data"]["offset"], 5);
    assert_eq!(emits[3].event, "response.completed");
    assert_eq!(
        emits[3].payload["data"]["response"]["output"][0]["content"][0]["text"],
        "hello world"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_streams_claude_thinking_deltas_before_text() {
    let _lock = ENV_LOCK.lock().await;
    let fake_claude = write_fake_executable(
        "fake-local-backend-thinking-claude",
        r#"#!/bin/sh
	printf '%s\n' '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"checking image"}}'
	sleep 0.1
	printf '%s\n' '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"visible answer"}}'
	printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
	"#,
    );
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 112,
        "subtask_id": 113,
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

    let emits = transport.wait_for_emits(4).await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits[1].event, "response.reasoning_summary_text.delta");
    assert_eq!(emits[1].payload["data"]["delta"], "checking image");
    assert_eq!(emits[2].event, "response.output_text.delta");
    assert_eq!(emits[2].payload["data"]["delta"], "visible answer");
    assert_eq!(emits[3].event, "response.completed");
    assert_eq!(
        emits[3].payload["data"]["response"]["output"][0]["content"][0]["text"],
        "visible answer"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_streams_claude_assistant_thinking_blocks_as_chunks() {
    let _lock = ENV_LOCK.lock().await;
    let fake_claude = write_fake_executable(
        "fake-local-backend-assistant-thinking-claude",
        r#"#!/bin/sh
	printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"abcdef"},{"type":"text","text":"answer"}]}}'
	printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
	"#,
    );
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let _chunk_chars = EnvGuard::set("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS", "3");
    let _reasoning_chunk_chars = EnvGuard::set("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS", "3");
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 114,
        "subtask_id": 115,
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

    let emits = transport.wait_for_emits(6).await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits[1].event, "response.reasoning_summary_text.delta");
    assert_eq!(emits[1].payload["data"]["delta"], "abc");
    assert_eq!(emits[2].event, "response.reasoning_summary_text.delta");
    assert_eq!(emits[2].payload["data"]["delta"], "def");
    assert_eq!(emits[3].event, "response.output_text.delta");
    assert_eq!(emits[3].payload["data"]["delta"], "ans");
    assert_eq!(emits[4].event, "response.output_text.delta");
    assert_eq!(emits[4].payload["data"]["delta"], "wer");
    assert_eq!(emits[5].event, "response.completed");
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_streams_claude_tool_use_blocks() {
    let _lock = ENV_LOCK.lock().await;
    let fake_claude = write_fake_executable(
        "fake-local-backend-tool-claude",
        r##"#!/bin/sh
	printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"Read_0","name":"Read","input":{"file_path":"README.md"}}]}}'
	sleep 0.1
	printf '%s\n' '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"Read_0","content":"# Project"}]}}'
	printf '%s\n' '{"type":"assistant","message":{"content":[{"type":"text","text":"read done"}]}}'
	printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}'
	"##,
    );
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 116,
        "subtask_id": 117,
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

    let emits = transport.wait_for_emits(5).await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits[1].event, "response.block.created");
    assert_eq!(emits[1].payload["data"]["block"]["type"], "tool");
    assert_eq!(emits[1].payload["data"]["block"]["id"], "Read_0");
    assert_eq!(emits[1].payload["data"]["block"]["tool_use_id"], "Read_0");
    assert_eq!(emits[1].payload["data"]["block"]["tool_name"], "Read");
    assert_eq!(
        emits[1].payload["data"]["block"]["tool_input"],
        json!({"file_path": "README.md"})
    );
    assert_eq!(emits[1].payload["data"]["block"]["status"], "pending");
    assert_eq!(emits[2].event, "response.block.updated");
    assert_eq!(emits[2].payload["data"]["block_id"], "Read_0");
    assert_eq!(
        emits[2].payload["data"]["updates"]["tool_output"],
        "# Project"
    );
    assert_eq!(emits[2].payload["data"]["updates"]["status"], "done");
    assert_eq!(emits[3].event, "response.output_text.delta");
    assert_eq!(emits[3].payload["data"]["delta"], "read done");
    assert_eq!(emits[4].event, "response.completed");
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_splits_large_claude_assistant_message_into_deltas() {
    let _lock = ENV_LOCK.lock().await;
    let long_text = "abcdefghijklmnopqrstuvwxyz".repeat(7);
    let claude_event = json!({
        "type": "assistant",
        "message": {
            "content": [{"type": "text", "text": long_text}]
        }
    })
    .to_string();
    let fake_claude = write_fake_executable(
        "fake-local-backend-large-assistant-claude",
        &format!(
            r#"#!/bin/sh
	printf '%s\n' '{}'
	printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"stop_reason":"end_turn"}}'
	"#,
            claude_event
        ),
    );
    let _claude = EnvGuard::set("CLAUDE_BINARY_PATH", &fake_claude.display().to_string());
    let _chunk_chars = EnvGuard::set("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS", "20");
    let transport = RecordingTransport::default();
    let runner = LocalBackendRunner::new(local_backend_config(), transport.clone());
    runner.register_handlers();

    let handler = transport.handler("task:execute").unwrap();
    let ack = handler(json!({
        "task_id": 120,
        "subtask_id": 121,
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

    let expected_chunks = long_text.chars().count().div_ceil(20);
    let emits = transport.wait_for_emits(expected_chunks + 2).await;
    assert_eq!(emits[0].event, "response.created");
    for emit in &emits[1..=expected_chunks] {
        assert_eq!(emit.event, "response.output_text.delta");
    }
    assert_eq!(emits[expected_chunks + 1].event, "response.completed");
    let streamed = emits[1..=expected_chunks]
        .iter()
        .map(|event| event.payload["data"]["delta"].as_str().unwrap())
        .collect::<String>();
    assert_eq!(streamed, long_text);
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
            auth_token: "bEaReR\twg-token".to_owned(),
        },
        ..DeviceConfig::default()
    };
    device.capabilities = vec!["claude".to_owned()];

    let config = LocalBackendConfig::from_device_config(device);

    assert_eq!(config.backend_url, "http://localhost:8000");
    assert_eq!(config.auth_token, "wg-token");
    assert_eq!(config.device_id, "device-1");
    assert_eq!(config.runtime_instance_id, "runtime-local");
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
