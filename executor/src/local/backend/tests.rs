// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::config::device::UpdateConfig;
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{Mutex as TestMutex, MutexGuard, OnceLock},
    time::Duration,
};

fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<TestMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| TestMutex::new(()))
        .lock()
        .expect("env lock should be available")
}

fn restore_env(key: &str, value: Option<OsString>) {
    if let Some(value) = value {
        env::set_var(key, value);
    } else {
        env::remove_var(key);
    }
}

fn backend_config(device_id: &str) -> LocalBackendConfig {
    LocalBackendConfig {
        backend_url: "https://backend.example.com".to_string(),
        socket_url: "wss://socket.example.com".to_string(),
        auth_token: "token".to_string(),
        runtime_auth_token: "runtime-token".to_string(),
        device_id: device_id.to_string(),
        runtime_instance_id: "runtime-1".to_string(),
        device_name: "Cloud Device".to_string(),
        device_type: "remote".to_string(),
        app_device_id: String::new(),
        bind_shell: "claudecode".to_string(),
        executor_version: "1.0.0".to_string(),
        client_ip: "127.0.0.1".to_string(),
        runtime_transfer_host: "127.0.0.1".to_string(),
        heartbeat_interval: Duration::from_secs(30),
        heartbeat_timeout: Duration::from_secs(10),
        registration_timeout: Duration::from_secs(10),
        reconnect_delay: Duration::from_secs(1),
        reconnect_delay_max: Duration::from_secs(30),
        configured_capabilities: Vec::new(),
        local_workspace_root: PathBuf::from("/tmp/workspace"),
        update: UpdateConfig::default(),
    }
}

#[test]
fn app_ipc_sidecar_device_id_uses_explicit_app_device_id() {
    let _guard = env_lock();
    let previous = env::var_os(APP_IPC_DEVICE_ID_ENV);
    env::set_var(APP_IPC_DEVICE_ID_ENV, "local-app-device");

    let device_id = app_ipc_sidecar_device_id(&backend_config("local-app-device-cloud"));

    restore_env(APP_IPC_DEVICE_ID_ENV, previous);
    assert_eq!(device_id, "local-app-device");
}

#[test]
fn app_ipc_sidecar_device_id_falls_back_to_backend_device_id() {
    let _guard = env_lock();
    let previous = env::var_os(APP_IPC_DEVICE_ID_ENV);
    env::remove_var(APP_IPC_DEVICE_ID_ENV);

    let device_id = app_ipc_sidecar_device_id(&backend_config("remote-device"));

    restore_env(APP_IPC_DEVICE_ID_ENV, previous);
    assert_eq!(device_id, "remote-device");
}

#[tokio::test]
async fn app_sidecar_runner_does_not_start_session_gateway() {
    let _guard = env_lock();
    let previous_enabled = env::var_os("DEVICE_SESSION_GATEWAY_ENABLED");
    let previous_public_url = env::var_os("DEVICE_PUBLIC_BASE_URL");
    env::remove_var("DEVICE_SESSION_GATEWAY_ENABLED");
    env::remove_var("DEVICE_PUBLIC_BASE_URL");
    let (event_tx, _) = broadcast::channel(8);
    let event_hub = ExecutorEventHub::new(event_tx.clone());
    event_hub.ensure_started();
    let runtime_work_handler: Arc<dyn RuntimeWorkHandler> = Arc::new(
        RuntimeWorkRpcHandler::with_event_sender("local-app-device", "/bin/false", event_tx),
    );
    let runner = LocalBackendRunner::new_for_app_sidecar_with_event_hub(
        backend_config("local-device"),
        SocketIoTransport::default(),
        runtime_work_handler,
        event_hub,
    );

    assert!(!runner.start_session_gateway);
    let session_handler = runner.session_handler.as_ref().unwrap().lock().unwrap();
    assert!(!session_handler.gateway_enabled);
    assert_eq!(session_handler.public_base_url, "http://localhost:0");
    drop(session_handler);
    restore_env("DEVICE_SESSION_GATEWAY_ENABLED", previous_enabled);
    restore_env("DEVICE_PUBLIC_BASE_URL", previous_public_url);
}

#[tokio::test]
async fn app_sidecar_gateway_uses_dynamic_port_when_explicitly_enabled() {
    let _guard = env_lock();
    let previous_enabled = env::var_os("DEVICE_SESSION_GATEWAY_ENABLED");
    let previous_public_url = env::var_os("DEVICE_PUBLIC_BASE_URL");
    env::set_var("DEVICE_SESSION_GATEWAY_ENABLED", "true");
    env::remove_var("DEVICE_PUBLIC_BASE_URL");
    let runner = LocalBackendRunner::new_for_app_sidecar(
        backend_config("local-device"),
        SocketIoTransport::default(),
    );

    assert!(runner.start_session_gateway);
    let session_handler = runner.session_handler.as_ref().unwrap().lock().unwrap();
    assert!(session_handler.gateway_enabled);
    assert_eq!(session_handler.public_base_url, "http://localhost:0");
    drop(session_handler);
    restore_env("DEVICE_SESSION_GATEWAY_ENABLED", previous_enabled);
    restore_env("DEVICE_PUBLIC_BASE_URL", previous_public_url);
}

#[tokio::test]
async fn remote_backend_runner_starts_session_gateway() {
    let _guard = env_lock();
    let previous_enabled = env::var_os("DEVICE_SESSION_GATEWAY_ENABLED");
    let previous_public_url = env::var_os("DEVICE_PUBLIC_BASE_URL");
    env::remove_var("DEVICE_SESSION_GATEWAY_ENABLED");
    env::remove_var("DEVICE_PUBLIC_BASE_URL");
    let runner = LocalBackendRunner::new(
        backend_config("remote-device"),
        SocketIoTransport::default(),
    );

    assert!(runner.start_session_gateway);
    let session_handler = runner.session_handler.as_ref().unwrap().lock().unwrap();
    assert!(session_handler.gateway_enabled);
    assert_eq!(session_handler.public_base_url, "http://localhost:17888");
    drop(session_handler);
    restore_env("DEVICE_SESSION_GATEWAY_ENABLED", previous_enabled);
    restore_env("DEVICE_PUBLIC_BASE_URL", previous_public_url);
}

#[test]
fn normalizes_backend_context_for_local_task_mcp() {
    let config = backend_config("local-device");
    let mut request = ExecutionRequest::default();

    normalize_local_task_request(&mut request, &config);

    assert_eq!(
        request.backend_url.as_deref(),
        Some("https://backend.example.com")
    );
    assert_eq!(request.auth_token.as_deref(), Some("token"));
    assert_eq!(request.runtime_auth_token.as_deref(), Some("runtime-token"));
    assert_eq!(request.device_id.as_deref(), Some("local-device"));
}

#[test]
fn heartbeat_reports_runtime_capacity_and_installation_identity() {
    let client =
        LocalBackendClient::new(backend_config("local-device"), SocketIoTransport::default());
    client.set_runtime_capacity(Some(json!({
        "limit": 4,
        "active": 2,
        "active_task_ids": ["task-1", "task-2"],
        "queued": 1,
    })));

    let payload = client.heartbeat_payload();

    assert_eq!(payload["runtime_instance_id"], "runtime-1");
    assert_eq!(payload["runtime_capacity"]["limit"], 4);
    assert_eq!(payload["runtime_capacity"]["active"], 2);
    assert_eq!(
        payload["runtime_capacity"]["active_task_ids"],
        json!(["task-1", "task-2"])
    );
    assert_eq!(payload["runtime_capacity"]["queued"], 1);
}
