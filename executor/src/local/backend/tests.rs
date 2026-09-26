// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::config::device::UpdateConfig;
use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering as AtomicOrdering},
        Mutex as TestMutex, MutexGuard, OnceLock,
    },
    time::Duration,
};

#[derive(Clone, Default)]
struct RuntimeWorkPollTransport {
    pull_calls: Arc<AtomicUsize>,
    accepted_tasks: Arc<AtomicUsize>,
    cleanup_enabled: Arc<AtomicBool>,
    claimed_cleanups: Arc<AtomicUsize>,
    accepted_cleanups: Arc<AtomicUsize>,
}

impl LocalBackendTransport for RuntimeWorkPollTransport {
    fn connect<'a>(&'a self, _config: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        _payload: Value,
        _timeout: Duration,
    ) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            match event {
                "runtime.tasks.pull" => {
                    let pull_index = self.pull_calls.fetch_add(1, AtomicOrdering::AcqRel);
                    let task = if pull_index == 1 {
                        json!({
                            "execution_id": "execution-1",
                            "runtime_task_id": "runtime-task-1",
                            "payload": {"execution_id": "execution-1"},
                        })
                    } else {
                        Value::Null
                    };
                    let workspace_cleanup_intents =
                        if pull_index == 0 && self.cleanup_enabled.load(AtomicOrdering::Acquire) {
                            json!([{
                                "intent_id": "cleanup-1",
                                "issue_id": "issue-1",
                                "issue_version": 3,
                                "action": "release",
                                "runtime_task_ids": ["runtime-task-1"],
                            }])
                        } else {
                            json!([])
                        };
                    Ok(json!({
                        "success": true,
                        "task": task,
                        "workspace_cleanup_intents": workspace_cleanup_intents,
                    }))
                }
                "runtime.tasks.accept" => {
                    self.accepted_tasks.fetch_add(1, AtomicOrdering::AcqRel);
                    Ok(json!({"success": true}))
                }
                "runtime.workspace_cleanup.claim" => {
                    self.claimed_cleanups.fetch_add(1, AtomicOrdering::AcqRel);
                    Ok(json!({"success": true}))
                }
                "runtime.workspace_cleanup.accept" => {
                    self.accepted_cleanups.fetch_add(1, AtomicOrdering::AcqRel);
                    Ok(json!({"success": true}))
                }
                _ => Err(format!("unexpected transport call: {event}")),
            }
        })
    }

    fn emit<'a>(&'a self, _event: &'a str, _payload: Value) -> TransportFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn on(&self, _event: &str, _handler: EventHandler) {}
}

struct BlockingCapacityRuntimeWorkHandler {
    capacity_calls: AtomicUsize,
    create_calls: AtomicUsize,
    first_capacity_started: Notify,
    release_first_capacity: Notify,
}

impl BlockingCapacityRuntimeWorkHandler {
    fn new() -> Self {
        Self {
            capacity_calls: AtomicUsize::new(0),
            create_calls: AtomicUsize::new(0),
            first_capacity_started: Notify::new(),
            release_first_capacity: Notify::new(),
        }
    }
}

impl RuntimeWorkHandler for BlockingCapacityRuntimeWorkHandler {
    fn handle_runtime_rpc<'a>(
        &'a self,
        data: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, AppIpcError>> + Send + 'a>> {
        Box::pin(async move {
            match data.get("method").and_then(Value::as_str) {
                Some("runtime.capacity.get") => {
                    let call_index = self.capacity_calls.fetch_add(1, AtomicOrdering::AcqRel);
                    if call_index == 0 {
                        self.first_capacity_started.notify_one();
                        self.release_first_capacity.notified().await;
                    }
                    Ok(json!({"limit": 1, "active": 0, "queued": 0}))
                }
                Some("runtime.tasks.create") => {
                    self.create_calls.fetch_add(1, AtomicOrdering::AcqRel);
                    Ok(json!({"success": true}))
                }
                method => Err(AppIpcError::new(
                    "unexpected_method",
                    format!("unexpected runtime method: {method:?}"),
                )),
            }
        })
    }
}

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
async fn runtime_pull_carries_and_acknowledges_workspace_cleanup_intents() {
    let transport = RuntimeWorkPollTransport::default();
    transport
        .cleanup_enabled
        .store(true, AtomicOrdering::Release);
    let client = LocalBackendClient::new(backend_config("local-device"), transport.clone());

    let work = client
        .pull_runtime_work(Duration::from_secs(1))
        .await
        .unwrap();
    let intent = &work.workspace_cleanup_intents[0];
    assert!(client
        .claim_workspace_cleanup(intent, Duration::from_secs(1))
        .await
        .unwrap());
    client
        .acknowledge_workspace_cleanup(intent, Duration::from_secs(1))
        .await
        .unwrap();

    assert_eq!(intent["intent_id"], "cleanup-1");
    assert_eq!(intent["runtime_task_ids"], json!(["runtime-task-1"]));
    assert_eq!(transport.claimed_cleanups.load(AtomicOrdering::Acquire), 1);
    assert_eq!(transport.accepted_cleanups.load(AtomicOrdering::Acquire), 1);
}

#[tokio::test]
async fn app_sidecar_runner_does_not_start_session_gateway() {
    let _guard = env_lock();
    let previous_enabled = env::var_os("DEVICE_SESSION_GATEWAY_ENABLED");
    env::remove_var("DEVICE_SESSION_GATEWAY_ENABLED");
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
}

#[tokio::test]
async fn app_sidecar_gateway_uses_dynamic_port_when_explicitly_enabled() {
    let _guard = env_lock();
    let previous_enabled = env::var_os("DEVICE_SESSION_GATEWAY_ENABLED");
    env::set_var("DEVICE_SESSION_GATEWAY_ENABLED", "true");
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
}

#[tokio::test]
async fn remote_backend_runner_starts_session_gateway() {
    let _guard = env_lock();
    let previous_enabled = env::var_os("DEVICE_SESSION_GATEWAY_ENABLED");
    env::remove_var("DEVICE_SESSION_GATEWAY_ENABLED");
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
}

#[tokio::test]
async fn runtime_work_poll_coalesces_notification_received_while_locked() {
    let transport = RuntimeWorkPollTransport::default();
    let client = LocalBackendClient::new(backend_config("local-device"), transport.clone());
    let handler = Arc::new(BlockingCapacityRuntimeWorkHandler::new());
    let pull_lock = Arc::new(AsyncMutex::new(()));
    let pull_pending = Arc::new(AtomicBool::new(true));

    let first_poll = tokio::spawn(poll_available_runtime_work(
        client.clone(),
        handler.clone(),
        Arc::clone(&pull_lock),
        Arc::clone(&pull_pending),
    ));
    handler.first_capacity_started.notified().await;

    pull_pending.store(true, Ordering::Release);
    poll_available_runtime_work(
        client,
        handler.clone(),
        Arc::clone(&pull_lock),
        Arc::clone(&pull_pending),
    )
    .await;
    handler.release_first_capacity.notify_one();

    tokio::time::timeout(Duration::from_secs(1), first_poll)
        .await
        .expect("coalesced poll should finish")
        .expect("poll task should not panic");

    assert_eq!(handler.capacity_calls.load(AtomicOrdering::Acquire), 2);
    assert_eq!(handler.create_calls.load(AtomicOrdering::Acquire), 1);
    assert_eq!(transport.pull_calls.load(AtomicOrdering::Acquire), 2);
    assert_eq!(transport.accepted_tasks.load(AtomicOrdering::Acquire), 1);
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
fn heartbeat_reports_installation_identity_without_scheduler_capacity() {
    let client =
        LocalBackendClient::new(backend_config("local-device"), SocketIoTransport::default());

    let payload = client.heartbeat_payload();

    assert_eq!(payload["runtime_instance_id"], "runtime-1");
    assert!(payload.get("runtime_capacity").is_none());
}

#[test]
fn local_project_request_keeps_device_without_backend_context() {
    let config = backend_config("local-device");
    let mut request = ExecutionRequest::default();
    request
        .extra
        .insert("origin".into(), json!({"projectStore":"local"}));
    normalize_local_task_request(&mut request, &config);
    assert_eq!(request.device_id.as_deref(), Some("local-device"));
    assert!(request.backend_url.is_none());
    assert!(request.auth_token.is_none());
    assert!(request.runtime_auth_token.is_none());
}
