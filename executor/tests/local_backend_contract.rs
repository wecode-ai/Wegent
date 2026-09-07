// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::VecDeque,
    future::Future,
    io::Read,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::read::GzDecoder;
use serde_json::{json, Value};
use tokio::{sync::broadcast, time::timeout};
use wegent_executor::{
    config::device::{DeviceConfig, UpdateConfig},
    emitter::ResponsesEventBuilder,
    local::app_ipc::{AppIpcError, RuntimeWorkHandler},
    local::backend::{
        build_runtime_auth_file_report, is_usable_device_ip, CapabilityReportProvider,
        LocalBackendClient, LocalBackendConfig, LocalBackendEventSink, LocalBackendRunner,
        LocalBackendTransport,
    },
    runner::EventSink,
    runtime_work::RuntimeWorkRpcHandler,
};

static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tokio::test]
async fn local_backend_rejects_missing_persistent_identity_before_registration() {
    for missing_runtime in [false, true] {
        let transport = RecordingTransport::default();
        let mut config = local_backend_config();
        if missing_runtime {
            config.runtime_instance_id.clear();
        } else {
            config.device_id.clear();
        }
        let client = LocalBackendClient::with_capability_reporter(
            config,
            transport.clone(),
            StaticCapabilityReporter,
        );
        let error = client
            .register_device(Duration::from_secs(2))
            .await
            .unwrap_err();
        assert!(error.contains("persistent device and Runtime identities are required"));
        assert!(transport.calls().is_empty());
    }
}

#[test]
fn local_backend_config_does_not_invent_shared_identity_fallbacks() {
    let config = LocalBackendConfig::from_device_config(DeviceConfig::default());
    assert!(config.device_id.is_empty());
    assert!(config.runtime_instance_id.is_empty());
}

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
    assert_eq!(calls[0].payload["runtime_features"]["schemaVersion"], 3);
    assert_eq!(
        calls[0].payload["runtime_features"]["interactiveSessions"],
        json!({"codeServer": true, "terminal": true})
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["runtimeTaskCreate"]["schemaVersions"],
        json!([1, 2])
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["runtimeTaskCreate"]["features"]["goal"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["runtimeTaskCreate"]["features"]["supervisor"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["version"],
        1
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["managed"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["deferredPrepare"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["preflight"],
        true
    );
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
    let _lock = ENV_LOCK.lock().await;
    let executor_home = temp_home("auth-report");
    let _executor_home =
        EnvGuard::set("WEGENT_EXECUTOR_HOME", &executor_home.display().to_string());
    let _codex_home = EnvGuard::set("WEGENT_CODEX_HOME", "");
    let codex_home = executor_home.join("codex");
    std::fs::create_dir_all(&codex_home).unwrap();
    std::fs::write(codex_home.join("auth.json"), "{}").unwrap();
    let expected_auth_path = codex_home.join("auth.json").display().to_string();

    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let config = local_backend_config();
    let client = LocalBackendClient::with_capability_reporter(
        config,
        transport.clone(),
        StaticCapabilityReporter,
    );
    client.set_running_task_ids(["10".to_owned(), "20".to_owned()]);

    let accepted = client.send_heartbeat(Duration::from_secs(2)).await.unwrap();
    client.emit_liveness_heartbeat().await.unwrap();

    assert!(accepted);
    let calls = transport.calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].event, "device:heartbeat");
    assert_eq!(calls[0].payload["device_id"], "device-1");
    assert_eq!(calls[0].payload["running_task_ids"], json!(["10", "20"]));
    assert_eq!(calls[0].payload["executor_version"], "test-version");
    assert_eq!(calls[0].payload["capabilities"]["revision"], 0);
    assert_eq!(calls[0].payload["capabilities"]["skills"], json!([]));
    assert_eq!(calls[0].payload["runtime_features"]["schemaVersion"], 3);
    assert_eq!(
        calls[0].payload["runtime_features"]["interactiveSessions"],
        json!({"codeServer": true, "terminal": true})
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["runtimeTaskCreate"]["schemaVersions"],
        json!([1, 2])
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["version"],
        1
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["managed"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["deferredPrepare"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_features"]["worktrees"]["preflight"],
        true
    );
    assert_eq!(
        calls[0].payload["runtime_auth_files"]["codex"],
        json!({"target_path": expected_auth_path, "exists": true})
    );
    let emits = transport.emits();
    assert_eq!(emits.len(), 1);
    assert_eq!(emits[0].event, "device:heartbeat");
    assert_eq!(emits[0].payload, calls[0].payload);
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
	cat >/dev/null
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
	cat >/dev/null
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
	cat >/dev/null
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
	cat >/dev/null
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

    let emits = transport.wait_for_emit_event("response.completed").await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(
        emits.last().map(|emit| emit.event.as_str()),
        Some("response.completed")
    );

    let reasoning = emits
        .iter()
        .filter(|emit| emit.event == "response.reasoning_summary_text.delta")
        .filter_map(|emit| emit.payload["data"]["delta"].as_str())
        .collect::<String>();
    assert_eq!(reasoning, "abcdef");

    let output = emits
        .iter()
        .filter(|emit| emit.event == "response.output_text.delta")
        .filter_map(|emit| emit.payload["data"]["delta"].as_str())
        .collect::<String>();
    assert_eq!(output, "answer");
}

#[cfg(unix)]
#[tokio::test]
async fn local_backend_task_execute_streams_claude_tool_use_blocks() {
    let _lock = ENV_LOCK.lock().await;
    let fake_claude = write_fake_executable(
        "fake-local-backend-tool-claude",
        r##"#!/bin/sh
	cat >/dev/null
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
async fn local_backend_task_execute_streams_large_claude_assistant_message() {
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
	cat >/dev/null
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

    let emits = transport.wait_for_emit_event("response.completed").await;
    assert_eq!(emits[0].event, "response.created");
    assert_eq!(emits.last().unwrap().event, "response.completed");
    let streamed = emits
        .iter()
        .filter(|event| event.event == "response.output_text.delta")
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

#[tokio::test]
async fn local_backend_runtime_rpc_logs_accept_request_id_field() {
    let transport = RecordingTransport::default();
    let (event_tx, event_rx) = broadcast::channel(8);
    let runner = LocalBackendRunner::new_for_app_sidecar_with_shared_runtime_work_handler(
        local_backend_config(),
        transport.clone(),
        Arc::new(StaticRuntimeWorkHandler(json!({"success": true}))),
        event_rx,
    );
    drop(event_tx);
    runner.register_handlers();

    let handler = transport.handler("runtime:rpc").unwrap();
    let ack = handler(json!({
        "request_id": "cloud-runtime-request-1",
        "method": "runtime.tasks.list",
        "payload": {}
    }))
    .await
    .unwrap();

    assert_eq!(ack["success"], true, "{ack}");
}

#[tokio::test]
async fn local_backend_runtime_rpc_handler_compresses_large_ack_payloads() {
    let transport = RecordingTransport::default();
    let (event_tx, event_rx) = broadcast::channel(8);
    let expected = json!({
        "success": true,
        "messages": [{
            "id": "message-1",
            "role": "assistant",
            "content": "large transcript 中文🙂".repeat(80_000),
        }],
    });
    let runner = LocalBackendRunner::new_for_app_sidecar_with_shared_runtime_work_handler(
        local_backend_config(),
        transport.clone(),
        Arc::new(StaticRuntimeWorkHandler(expected.clone())),
        event_rx,
    );
    drop(event_tx);
    runner.register_handlers();

    let handler = transport.handler("runtime:rpc").unwrap();
    let ack = handler(json!({
        "method": "runtime.tasks.transcript",
        "payload": {"localTaskId": "large-1"}
    }))
    .await
    .unwrap();

    assert_eq!(ack["__runtimeRpcEncoding"], "gzip+base64+json");
    assert!(serde_json::to_vec(&ack).unwrap().len() < 1_000_000);
    assert_eq!(decode_compressed_runtime_ack(&ack), expected);
}

#[tokio::test]
async fn connected_executor_pulls_and_accepts_cloud_runtime_work() {
    let task = json!({
        "execution_id": 268,
        "runtime_task_id": "codex-queue-268",
        "prompt": "Build the calculator",
        "payload": {
            "taskId": "codex-queue-268",
            "executionRequest": {
                "task_id": "codex-queue-268",
                "subtask_id": "codex-queue-268-assistant"
            }
        }
    });
    let transport = RecordingTransport::with_responses(vec![
        json!([{"success": true}]),
        json!([{"success": true, "task": task}]),
        json!([{"success": true}]),
        json!([{"success": true, "task": null}]),
    ]);
    let (event_tx, event_rx) = broadcast::channel(8);
    let runner = LocalBackendRunner::new_for_app_sidecar_with_shared_runtime_work_handler(
        local_backend_config(),
        transport.clone(),
        Arc::new(StaticRuntimeWorkHandler(json!({"success": true}))),
        event_rx,
    );
    drop(event_tx);

    runner.connect_and_register().await.unwrap();

    let calls = transport.wait_for_calls(4).await;
    assert_eq!(
        calls
            .iter()
            .map(|call| call.event.as_str())
            .collect::<Vec<_>>(),
        vec![
            "device:register",
            "runtime.tasks.pull",
            "runtime.tasks.accept",
            "runtime.tasks.pull",
        ]
    );
    assert_eq!(calls[2].payload["execution_id"], 268);
    assert_eq!(calls[2].payload["runtime_task_id"], "codex-queue-268");
    assert_eq!(calls[2].payload["accepted"], true);
    assert_eq!(transport.emits()[0].event, "device:heartbeat");
}

#[tokio::test]
async fn runtime_polling_does_not_block_initial_liveness_heartbeat() {
    let transport = RecordingTransport::with_responses(vec![json!({"success": true})]);
    let (event_tx, event_rx) = broadcast::channel(8);
    let runner = LocalBackendRunner::new_for_app_sidecar_with_shared_runtime_work_handler(
        local_backend_config(),
        transport.clone(),
        Arc::new(PendingRuntimeWorkHandler),
        event_rx,
    );
    drop(event_tx);

    timeout(Duration::from_secs(1), runner.connect_and_register())
        .await
        .expect("runtime polling must not block registration heartbeat")
        .unwrap();

    assert_eq!(transport.emits()[0].event, "device:heartbeat");
}

#[tokio::test]
async fn local_backend_relays_events_from_shared_app_runtime_handler() {
    let transport = RecordingTransport::default();
    let (event_tx, _) = broadcast::channel(8);
    let handler = Arc::new(RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        "/bin/false",
        event_tx.clone(),
    ));
    let runner = LocalBackendRunner::new_for_app_sidecar_with_shared_runtime_work_handler(
        local_backend_config(),
        transport.clone(),
        handler,
        event_tx.subscribe(),
    );
    let runner_task = tokio::spawn(runner.run_forever());
    transport.wait_for_emit_event("device:heartbeat").await;

    event_tx
        .send(json!({
            "type": "event",
            "event": "runtime.task.completed",
            "payload": {"task_id": "runtime-1"}
        }))
        .unwrap();

    transport.wait_for_emit_event("runtime:event").await;
    runner_task.abort();
    let _ = runner_task.await;

    let emits = transport.emits_for_event("runtime:event");
    assert_eq!(emits.len(), 1);
    assert_eq!(emits[0].event, "runtime:event");
    assert_eq!(emits[0].payload["event"], "runtime.task.completed");
}

#[tokio::test]
async fn local_backend_replays_runtime_events_after_reconnecting() {
    let transport = RecordingTransport::with_emit_results(vec![
        Ok(()),
        Err("Socket.IO client is not connected".to_owned()),
        Err("heartbeat failed before reconnect".to_owned()),
        Err("heartbeat failed before reconnect".to_owned()),
        Ok(()),
        Ok(()),
    ]);
    let (event_tx, _) = broadcast::channel(8);
    let handler = Arc::new(RuntimeWorkRpcHandler::with_event_sender(
        "device-1",
        "/bin/false",
        event_tx.clone(),
    ));
    let mut config = local_backend_config();
    config.heartbeat_interval = Duration::from_millis(100);
    config.heartbeat_timeout = Duration::from_millis(5);
    config.reconnect_delay = Duration::from_millis(1);
    config.reconnect_delay_max = Duration::from_millis(1);
    let runner = LocalBackendRunner::new_for_app_sidecar_with_shared_runtime_work_handler(
        config,
        transport.clone(),
        handler,
        event_tx.subscribe(),
    );
    let runner_task = tokio::spawn(runner.run_forever());
    transport.wait_for_emit_event("device:heartbeat").await;
    let event = json!({
        "type": "event",
        "event": "runtime.task.completed",
        "payload": {"task_id": "runtime-1"}
    });

    event_tx.send(event.clone()).unwrap();

    let emits = transport.wait_for_emit_count("runtime:event", 2).await;
    runner_task.abort();
    let _ = runner_task.await;
    assert_eq!(emits.len(), 2);
    assert_eq!(emits[0].event, "runtime:event");
    assert_eq!(emits[1].event, "runtime:event");
    assert_eq!(emits[0].payload["event"], "runtime.task.completed");
    assert_eq!(emits[1].payload["event"], "runtime.task.completed");
}

#[test]
fn local_backend_config_uses_device_config_and_normalizes_token() {
    let mut device = DeviceConfig {
        device_id: "device-1".to_owned(),
        runtime_instance_id: "runtime-persisted".to_owned(),
        device_name: "Device One".to_owned(),
        device_type: "local".to_owned(),
        bind_shell: "claudecode".to_owned(),
        connection: wegent_executor::config::device::ConnectionConfig {
            backend_url: "http://localhost:8000".to_owned(),
            socket_url: "wss://socket.example.com".to_owned(),
            auth_token: "bEaReR\twg-token".to_owned(),
            runtime_auth_token: "bEaReR\truntime-wg-token".to_owned(),
        },
        ..DeviceConfig::default()
    };
    device.capabilities = vec!["claude".to_owned()];

    let config = LocalBackendConfig::from_device_config(device);

    assert_eq!(config.backend_url, "http://localhost:8000");
    assert_eq!(config.socket_url, "wss://socket.example.com");
    assert_eq!(config.auth_token, "wg-token");
    assert_eq!(config.runtime_auth_token, "runtime-wg-token");
    assert_eq!(config.device_id, "device-1");
    assert_eq!(config.runtime_instance_id, "runtime-persisted");
    assert_eq!(config.device_name, "Device One");
    assert_eq!(config.device_type, "local");
    assert_eq!(config.bind_shell, "claudecode");
    assert_eq!(config.configured_capabilities, vec!["claude"]);
}

#[tokio::test]
async fn local_backend_auth_file_report_and_ip_filter_follow_runtime_paths() {
    let codex_home = temp_home("missing-auth-report").join("codex");
    let expected_auth_path = codex_home.join("auth.json").display().to_string();
    assert_eq!(
        build_runtime_auth_file_report(&codex_home),
        json!({"codex": {"target_path": expected_auth_path, "exists": false}})
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
    emit_results: Arc<Mutex<VecDeque<Result<(), String>>>>,
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

    fn with_emit_results(results: Vec<Result<(), String>>) -> Self {
        Self {
            emit_results: Arc::new(Mutex::new(results.into())),
            ..Self::default()
        }
    }

    fn calls(&self) -> Vec<RecordedCall> {
        self.calls.lock().unwrap().clone()
    }

    fn emits(&self) -> Vec<RecordedCall> {
        self.emits.lock().unwrap().clone()
    }

    async fn wait_for_calls(&self, count: usize) -> Vec<RecordedCall> {
        timeout(Duration::from_secs(10), async {
            loop {
                let calls = self.calls();
                if calls.len() >= count {
                    return calls;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap()
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
        timeout(Duration::from_secs(10), async {
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

    async fn wait_for_emit_event(&self, event: &str) -> Vec<RecordedCall> {
        timeout(Duration::from_secs(10), async {
            loop {
                let notified = self.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let emits = self.emits();
                if emits.iter().any(|emit| emit.event == event) {
                    return emits;
                }
                notified.await;
            }
        })
        .await
        .unwrap()
    }

    async fn wait_for_emit_count(&self, event: &str, count: usize) -> Vec<RecordedCall> {
        timeout(Duration::from_secs(10), async {
            loop {
                let notified = self.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let emits = self.emits_for_event(event);
                if emits.len() >= count {
                    return emits;
                }
                notified.await;
            }
        })
        .await
        .unwrap()
    }

    fn emits_for_event(&self, event: &str) -> Vec<RecordedCall> {
        self.emits()
            .into_iter()
            .filter(|emit| emit.event == event)
            .collect()
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
            self.emit_results
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(Ok(()))
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
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(30),
        configured_capabilities: Vec::new(),
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

struct StaticRuntimeWorkHandler(Value);

impl RuntimeWorkHandler for StaticRuntimeWorkHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move { Ok(self.0.clone()) })
    }
}

struct PendingRuntimeWorkHandler;

impl RuntimeWorkHandler for PendingRuntimeWorkHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        _data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(std::future::pending())
    }
}

fn decode_compressed_runtime_ack(ack: &Value) -> Value {
    let compressed = BASE64_STANDARD
        .decode(ack["payload"].as_str().expect("compressed payload"))
        .expect("valid base64");
    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut raw = Vec::new();
    decoder.read_to_end(&mut raw).expect("valid gzip");
    serde_json::from_slice(&raw).expect("valid runtime response")
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
