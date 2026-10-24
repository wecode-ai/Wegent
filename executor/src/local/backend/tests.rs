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
    fail_first_pull: Arc<AtomicBool>,
    cleanup_enabled: Arc<AtomicBool>,
    claimed_cleanups: Arc<AtomicUsize>,
    accepted_cleanups: Arc<AtomicUsize>,
    disconnect_calls: Arc<AtomicUsize>,
    close_handler: Arc<TestMutex<Option<ConnectionClosedHandler>>>,
    close_during_registration: Arc<AtomicBool>,
    register_ack: Arc<TestMutex<Option<Value>>>,
}

impl LocalBackendTransport for RuntimeWorkPollTransport {
    fn connect<'a>(&'a self, _config: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }

    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            self.disconnect_calls.fetch_add(1, AtomicOrdering::AcqRel);
            Ok(())
        })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        _timeout: Duration,
    ) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            match event {
                "device:register" => Ok(self
                    .register_ack
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| json!({"success": true}))),
                "runtime.tasks.pull" => {
                    assert!(payload["runner_catalog"]["models"].is_array());
                    let pull_index = self.pull_calls.fetch_add(1, AtomicOrdering::AcqRel);
                    if pull_index == 0 && self.fail_first_pull.swap(false, AtomicOrdering::AcqRel) {
                        return Err("first queued execution failed preflight".to_owned());
                    }
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

    fn emit<'a>(&'a self, event: &'a str, _payload: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            if event == "device:heartbeat"
                && self
                    .close_during_registration
                    .swap(false, AtomicOrdering::AcqRel)
            {
                let on_close = self.close_handler.lock().unwrap().clone().unwrap();
                on_close();
            }
            Ok(())
        })
    }

    fn on(&self, _event: &str, _handler: EventHandler) {}

    fn on_close(&self, handler: ConnectionClosedHandler) {
        *self.close_handler.lock().unwrap() = Some(handler);
    }
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
                Some("runtime.runner.catalog") => Ok(json!({"models": []})),
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
        runtime_work_poll_interval: Duration::from_secs(5),
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
        .pull_runtime_work(Duration::from_secs(1), json!({"models": []}))
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

#[tokio::test]
async fn runtime_work_poll_continues_after_one_pull_preflight_failure() {
    let transport = RuntimeWorkPollTransport::default();
    transport
        .fail_first_pull
        .store(true, AtomicOrdering::Release);
    let client = LocalBackendClient::new(backend_config("local-device"), transport.clone());
    let handler = Arc::new(BlockingCapacityRuntimeWorkHandler::new());
    handler.release_first_capacity.notify_one();

    drain_available_runtime_work(&client, &(handler.clone() as Arc<dyn RuntimeWorkHandler>)).await;

    assert_eq!(transport.pull_calls.load(AtomicOrdering::Acquire), 2);
    assert_eq!(handler.create_calls.load(AtomicOrdering::Acquire), 1);
    assert_eq!(transport.accepted_tasks.load(AtomicOrdering::Acquire), 1);
}

#[tokio::test]
async fn heartbeat_reconnects_when_an_event_relay_marks_the_connection_unavailable() {
    let transport = RuntimeWorkPollTransport::default();
    let connection_status = Arc::new(AtomicBool::new(true));
    let runner =
        LocalBackendRunner::new_for_app_sidecar(backend_config("local-device"), transport.clone())
            .with_connection_status(Arc::clone(&connection_status));

    let mark_disconnected = async {
        sleep(Duration::from_millis(10)).await;
        connection_status.store(false, Ordering::Release);
    };
    let (stable_connection, ()) = tokio::time::timeout(Duration::from_secs(1), async {
        tokio::join!(runner.heartbeat_until_reconnect(), mark_disconnected)
    })
    .await
    .expect("connection status should trigger reconnect before the heartbeat interval");

    assert!(!stable_connection);
    assert_eq!(transport.disconnect_calls.load(AtomicOrdering::Acquire), 1);
}

#[tokio::test]
async fn socket_close_invalidates_ready_status_and_reconnects_before_heartbeat() {
    let transport = RuntimeWorkPollTransport::default();
    let connection_status = Arc::new(AtomicBool::new(true));
    let runner =
        LocalBackendRunner::new_for_app_sidecar(backend_config("local-device"), transport.clone())
            .with_connection_status(Arc::clone(&connection_status));
    runner.register_handlers();
    let on_close = transport
        .close_handler
        .lock()
        .unwrap()
        .clone()
        .expect("the runner must observe transport closure");

    on_close();

    assert!(!connection_status.load(Ordering::Acquire));
    let stable_connection =
        tokio::time::timeout(Duration::from_secs(1), runner.heartbeat_until_reconnect())
            .await
            .expect("closed transport must reconnect before the heartbeat interval");
    assert!(!stable_connection);
    assert_eq!(transport.disconnect_calls.load(AtomicOrdering::Acquire), 1);
}

#[tokio::test]
async fn socket_close_during_registration_cannot_publish_ready_status() {
    let transport = RuntimeWorkPollTransport::default();
    transport
        .close_during_registration
        .store(true, AtomicOrdering::Release);
    let connection_status = Arc::new(AtomicBool::new(false));
    let runner =
        LocalBackendRunner::new_for_app_sidecar(backend_config("local-device"), transport.clone())
            .with_connection_status(Arc::clone(&connection_status));
    runner.register_handlers();

    let result = runner.connect_and_register().await;

    assert!(result.is_err(), "a closed registration cannot become ready");
    assert!(!connection_status.load(Ordering::Acquire));

    runner.connect_and_register().await.unwrap();
    assert!(connection_status.load(Ordering::Acquire));
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

#[tokio::test]
async fn registration_captures_backend_assigned_device_route_id() {
    let transport = RuntimeWorkPollTransport::default();
    *transport.register_ack.lock().unwrap() =
        Some(json!({"success": true, "device_route_id": "app-record-42"}));
    let route_slot = Arc::new(std::sync::Mutex::new(None));
    let runner =
        LocalBackendRunner::new_for_app_sidecar(backend_config("local-device"), transport)
            .with_device_route_id_slot(Arc::clone(&route_slot));
    runner.register_handlers();

    runner
        .connect_and_register()
        .await
        .expect("registration succeeds");

    assert_eq!(
        route_slot.lock().unwrap().as_deref(),
        Some("app-record-42")
    );
}

#[test]
fn plugin_reconcile_delay_is_stable_and_bounded() {
    let delay = plugin_reconcile_delay("runtime-instance-1");
    assert_eq!(delay, plugin_reconcile_delay("runtime-instance-1"));
    assert!(delay >= PLUGIN_RECONCILE_INTERVAL);
    assert!(
        delay < PLUGIN_RECONCILE_INTERVAL + Duration::from_secs(PLUGIN_RECONCILE_JITTER_SECS)
    );
    // Distinct runtimes spread across the jitter window.
    assert_ne!(
        plugin_reconcile_delay("runtime-instance-1"),
        plugin_reconcile_delay("runtime-instance-2")
    );
}
