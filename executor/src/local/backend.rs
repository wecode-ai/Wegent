// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tokio::{
    sync::{broadcast, Mutex as AsyncMutex},
    task::JoinHandle,
    time::{sleep, sleep_until, Instant},
};

use crate::{
    agents::{resolve_codex_binary, AgentCommandPlanner, AgentProcessEngine},
    config::device::{ConnectionConfig, DeviceConfig},
    local::{
        app_ipc::{AppIpcError, AppIpcServer, RuntimeWorkHandler},
        command::{CommandHandler, CommandRequest, DeviceCommandHandler},
        event_stream::{event_sequence, ExecutorEventHub},
        session::{LocalSessionHandler, SessionType, TerminalEvent},
        session_gateway::start_session_gateway,
        workspace_files::{execute_workspace_file_command, is_workspace_file_command},
    },
    logging::{format_executor_log, write_executor_error_line, write_executor_log_line},
    protocol::ExecutionRequest,
    runtime_work::RuntimeWorkRpcHandler,
    server::TaskRunner,
};

mod cancellation;
mod capability;
mod client;
mod config;
mod connection_controller;
mod extension;
pub(crate) mod runtime_rpc_encoding;
mod session_events;
mod socket_transport;
mod tasks;
mod upgrade;

pub use cancellation::LocalCancellationSnapshot;
pub use capability::{CapabilityReportProvider, CapabilitySyncRpcHandler, HttpPackageProvider};
pub use client::{build_runtime_auth_file_report, LocalBackendClient, LocalBackendEventSink};
pub use config::{is_usable_device_ip, LocalBackendConfig};
pub use connection_controller::LocalBackendConnectionController;
pub use extension::{DeviceExtensionHandler, DeviceExtensionRunner};
pub use socket_transport::SocketIoTransport;
pub use tasks::{LocalRunningTaskTracker, LocalTaskController, ManagedLocalTaskRunner};
pub use upgrade::{LocalDeviceUpgradeHandler, LocalUpgradeService};

use cancellation::LocalCancellationRegistry;
use capability::{default_capability_sync_handler, DefaultCapabilityReporter};
use extension::default_extension_handler;
use runtime_rpc_encoding::encode_runtime_rpc_response;
use session_events::{
    app_sidecar_session_handler, default_session_handler, session_result_payload,
    session_start_request, value_string, value_u16,
};
use upgrade::default_upgrade_handler;

const TASK_EXECUTE_EVENT: &str = "task:execute";
const TASK_CANCEL_EVENT: &str = "task:cancel";
const TASK_CLOSE_SESSION_EVENT: &str = "task:close-session";
const CHAT_MESSAGE_EVENT: &str = "chat:message";
const DEVICE_EXECUTE_COMMAND_EVENT: &str = "device:execute_command";
const DEVICE_SYNC_CAPABILITIES_EVENT: &str = "device:sync_capabilities";
const DEVICE_START_TERMINAL_SESSION_EVENT: &str = "device:start_terminal_session";
const DEVICE_START_CODE_SERVER_SESSION_EVENT: &str = "device:start_code_server_session";
const TERMINAL_ATTACH_EVENT: &str = "terminal:attach";
const TERMINAL_INPUT_EVENT: &str = "terminal:input";
const TERMINAL_RESIZE_EVENT: &str = "terminal:resize";
const TERMINAL_CLOSE_EVENT: &str = "terminal:close";
const TERMINAL_OUTPUT_EVENT: &str = "terminal:output";
const TERMINAL_EXIT_EVENT: &str = "terminal:exit";
const TERMINAL_POLL_INTERVAL: Duration = Duration::from_millis(25);
const RUNTIME_RPC_EVENT: &str = "runtime:rpc";
const RUNTIME_EVENT_EVENT: &str = "runtime:event";
const RUNTIME_TASKS_AVAILABLE_EVENT: &str = "runtime.tasks.available";
const RUNTIME_EVENT_CONNECTION_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DEVICE_UPGRADE_EVENT: &str = "device:upgrade";
const DEVICE_RUN_EXTENSION_EVENT: &str = "device:run_extension";
const APP_IPC_DEVICE_ID_ENV: &str = "WEGENT_APP_IPC_DEVICE_ID";
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES: u32 = 2;

#[derive(Clone, Copy)]
enum SessionGatewayProfile {
    AppSidecar,
    Standalone,
}

pub(super) type TransportFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub type EventHandler =
    Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;

pub trait DeviceUpgradeHandler: Send + Sync + 'static {
    fn handle_upgrade<'a>(
        &'a self,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Value> + Send + 'a>>;
}

pub trait LocalBackendTransport: Clone + Send + Sync + 'static {
    fn connect<'a>(&'a self, config: &'a LocalBackendConfig) -> TransportFuture<'a, ()>;
    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()>;
    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> TransportFuture<'a, Value>;
    fn emit<'a>(&'a self, event: &'a str, payload: Value) -> TransportFuture<'a, ()>;
    fn on(&self, event: &str, handler: EventHandler);
}

pub struct LocalBackendRunner<
    T,
    R = ManagedLocalTaskRunner<AgentProcessEngine, LocalBackendEventSink<T>>,
> where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    client: LocalBackendClient<T>,
    runner: R,
    command_handler: Arc<dyn DeviceCommandHandler>,
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    task_controller: Option<Arc<dyn LocalTaskController>>,
    capability_sync_handler: Option<Arc<dyn CapabilitySyncRpcHandler>>,
    session_handler: Option<Arc<Mutex<LocalSessionHandler>>>,
    start_session_gateway: bool,
    upgrade_handler: Option<Arc<dyn DeviceUpgradeHandler>>,
    upgrade_service: Option<Arc<dyn LocalUpgradeService>>,
    extension_handler: Option<Arc<dyn DeviceExtensionHandler>>,
    cancellations: LocalCancellationRegistry,
    runtime_event_forwarder: Option<JoinHandle<()>>,
    runtime_event_hub: Option<ExecutorEventHub>,
    connection_status: Arc<AtomicBool>,
    runtime_pull_lock: Arc<AsyncMutex<()>>,
}

impl<T, R> Drop for LocalBackendRunner<T, R>
where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    fn drop(&mut self) {
        self.connection_status.store(false, Ordering::Release);
        if let Some(forwarder) = self.runtime_event_forwarder.take() {
            forwarder.abort();
        }
    }
}

impl<T> LocalBackendRunner<T>
where
    T: LocalBackendTransport,
{
    pub fn new(config: LocalBackendConfig, transport: T) -> Self {
        Self::new_with_default_runtime_work_handler(
            config,
            transport,
            SessionGatewayProfile::Standalone,
        )
    }

    pub fn new_for_app_sidecar(config: LocalBackendConfig, transport: T) -> Self {
        Self::new_with_default_runtime_work_handler(
            config,
            transport,
            SessionGatewayProfile::AppSidecar,
        )
    }

    fn new_with_default_runtime_work_handler(
        config: LocalBackendConfig,
        transport: T,
        session_gateway_profile: SessionGatewayProfile,
    ) -> Self {
        let (runtime_event_tx, _) = broadcast::channel(super::RUNTIME_EVENT_BUFFER_CAPACITY);
        let event_hub = ExecutorEventHub::new(runtime_event_tx.clone());
        event_hub.ensure_started();
        let runtime_work_handler: Arc<dyn RuntimeWorkHandler> = Arc::new(
            RuntimeWorkRpcHandler::with_event_sender(
                config.device_id.clone(),
                resolve_codex_binary(),
                runtime_event_tx,
            )
            .with_backend_connection(Arc::new(Mutex::new(
                connection_snapshot_from_config(&config),
            ))),
        );
        Self::new_with_runtime_work_handler(
            config,
            transport,
            runtime_work_handler,
            event_hub,
            session_gateway_profile,
        )
    }

    pub fn new_for_app_sidecar_with_shared_runtime_work_handler(
        config: LocalBackendConfig,
        transport: T,
        runtime_work_handler: Arc<dyn RuntimeWorkHandler>,
        runtime_event_rx: broadcast::Receiver<Value>,
    ) -> Self {
        Self::new_for_app_sidecar_with_event_hub(
            config,
            transport,
            runtime_work_handler,
            ExecutorEventHub::from_receiver(runtime_event_rx),
        )
    }

    pub(crate) fn new_for_app_sidecar_with_event_hub(
        config: LocalBackendConfig,
        transport: T,
        runtime_work_handler: Arc<dyn RuntimeWorkHandler>,
        event_hub: ExecutorEventHub,
    ) -> Self {
        Self::new_with_runtime_work_handler(
            config,
            transport,
            runtime_work_handler,
            event_hub,
            SessionGatewayProfile::AppSidecar,
        )
    }

    fn new_with_runtime_work_handler(
        config: LocalBackendConfig,
        transport: T,
        runtime_work_handler: Arc<dyn RuntimeWorkHandler>,
        event_hub: ExecutorEventHub,
        session_gateway_profile: SessionGatewayProfile,
    ) -> Self {
        let running_tasks = LocalRunningTaskTracker::default();
        let client = LocalBackendClient::with_capability_reporter_and_tracker(
            config,
            transport,
            DefaultCapabilityReporter::new(),
            running_tasks.clone(),
        );
        let sink = LocalBackendEventSink::new(client.clone());
        let runner = ManagedLocalTaskRunner::new(
            AgentProcessEngine::new(AgentCommandPlanner::from_env()),
            sink,
            running_tasks,
        );
        let mut backend = Self::from_client_and_runner(client, runner.clone());
        backend.task_controller = Some(Arc::new(runner));
        backend.runtime_work_handler = Some(runtime_work_handler);
        backend.runtime_event_hub = Some(event_hub);
        backend.capability_sync_handler = Some(Arc::new(default_capability_sync_handler(
            backend.client.config.as_ref(),
        )));
        let session_handler = match session_gateway_profile {
            SessionGatewayProfile::AppSidecar => app_sidecar_session_handler(Some(
                backend.client.config.local_workspace_root.clone(),
            )),
            SessionGatewayProfile::Standalone => {
                default_session_handler(Some(backend.client.config.local_workspace_root.clone()))
            }
        };
        backend.start_session_gateway = session_handler.gateway_enabled;
        backend.session_handler = Some(Arc::new(Mutex::new(session_handler)));
        backend.upgrade_handler = Some(Arc::new(default_upgrade_handler(
            backend.client.clone(),
            backend.task_controller.clone(),
            backend.client.config.update.clone(),
        )));
        backend.extension_handler = Some(Arc::new(default_extension_handler(
            backend.client.config.local_workspace_root.clone(),
        )));
        backend
    }
}

impl<T, R> LocalBackendRunner<T, R>
where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    pub fn with_task_runner(config: LocalBackendConfig, transport: T, runner: R) -> Self {
        let client = LocalBackendClient::new(config, transport);
        Self::from_client_and_runner(client, runner)
    }

    pub fn from_client_and_runner(client: LocalBackendClient<T>, runner: R) -> Self {
        Self {
            client,
            runner,
            command_handler: Arc::new(CommandHandler),
            runtime_work_handler: None,
            task_controller: None,
            capability_sync_handler: None,
            session_handler: None,
            start_session_gateway: false,
            upgrade_handler: None,
            upgrade_service: None,
            extension_handler: None,
            cancellations: LocalCancellationRegistry::default(),
            runtime_event_forwarder: None,
            runtime_event_hub: None,
            connection_status: Arc::new(AtomicBool::new(false)),
            runtime_pull_lock: Arc::new(AsyncMutex::new(())),
        }
    }

    pub fn with_connection_status(mut self, connection_status: Arc<AtomicBool>) -> Self {
        self.connection_status = connection_status;
        self
    }

    pub fn with_task_controller<C>(mut self, controller: C) -> Self
    where
        C: LocalTaskController,
    {
        self.task_controller = Some(Arc::new(controller));
        self
    }

    pub fn with_capability_sync_handler<H>(mut self, handler: H) -> Self
    where
        H: CapabilitySyncRpcHandler,
    {
        self.capability_sync_handler = Some(Arc::new(handler));
        self
    }

    pub fn with_session_handler(mut self, handler: LocalSessionHandler) -> Self {
        self.session_handler = Some(Arc::new(Mutex::new(handler)));
        self
    }

    pub fn without_session_gateway(mut self) -> Self {
        self.start_session_gateway = false;
        self
    }

    pub fn with_upgrade_handler<H>(mut self, handler: H) -> Self
    where
        H: DeviceUpgradeHandler,
    {
        self.upgrade_handler = Some(Arc::new(handler));
        self.upgrade_service = None;
        self
    }

    pub fn with_upgrade_service<S>(mut self, service: S) -> Self
    where
        S: LocalUpgradeService,
    {
        self.upgrade_handler = None;
        self.upgrade_service = Some(Arc::new(service));
        self
    }

    pub fn with_extension_handler<H>(mut self, handler: H) -> Self
    where
        H: DeviceExtensionHandler,
    {
        self.extension_handler = Some(Arc::new(handler));
        self
    }

    pub fn cancellation_snapshot(&self) -> LocalCancellationSnapshot {
        self.cancellations.snapshot()
    }

    fn start_runtime_event_forwarder(&mut self, event_hub: ExecutorEventHub) {
        if let Some(forwarder) = self.runtime_event_forwarder.take() {
            forwarder.abort();
        }
        let client = self.client.clone();
        let connection_status = Arc::clone(&self.connection_status);
        self.runtime_event_forwarder = Some(tokio::spawn(async move {
            let mut delivered_sequence = 0;
            loop {
                while !connection_status.load(Ordering::Acquire) {
                    sleep(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL).await;
                }
                let mut subscription = event_hub.subscribe_after(delivered_sequence);
                let mut reconnect = false;
                for event in subscription.replay.drain(..) {
                    if !connection_status.load(Ordering::Acquire) {
                        reconnect = true;
                        break;
                    }
                    match client
                        .emit_raw_event(RUNTIME_EVENT_EVENT, event.clone())
                        .await
                    {
                        Ok(()) => {
                            delivered_sequence =
                                event_sequence(&event).unwrap_or(delivered_sequence);
                        }
                        Err(error) => {
                            connection_status.store(false, Ordering::Release);
                            write_executor_error_line(&format_executor_log(
                                "runtime event relay paused until reconnect",
                                &[("error", error)],
                            ));
                            reconnect = true;
                            break;
                        }
                    }
                }
                if reconnect {
                    while connection_status.load(Ordering::Acquire) {
                        sleep(RUNTIME_EVENT_CONNECTION_POLL_INTERVAL).await;
                    }
                    continue;
                }
                delivered_sequence = delivered_sequence.max(subscription.resume_after);
                loop {
                    if !connection_status.load(Ordering::Acquire) {
                        break;
                    }
                    match subscription.receiver.recv().await {
                        Ok(event) => {
                            let sequence = event_sequence(&event).unwrap_or(delivered_sequence);
                            if sequence <= delivered_sequence {
                                continue;
                            }
                            match client
                                .emit_raw_event(RUNTIME_EVENT_EVENT, event.clone())
                                .await
                            {
                                Ok(()) => delivered_sequence = sequence,
                                Err(error) => {
                                    connection_status.store(false, Ordering::Release);
                                    write_executor_error_line(&format_executor_log(
                                        "runtime event relay paused until reconnect",
                                        &[("error", error)],
                                    ));
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => break,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        }));
    }

    pub fn is_cancel_requested(&self, task_id: &str, subtask_id: Option<&str>) -> bool {
        self.cancellations.is_cancel_requested(task_id, subtask_id)
    }

    pub async fn run_forever(mut self) -> Result<(), String> {
        self.connection_status.store(false, Ordering::Release);
        if let Some(event_hub) = self.runtime_event_hub.take() {
            self.start_runtime_event_forwarder(event_hub);
        }
        self.register_handlers();
        let _session_gateway = if self.start_session_gateway {
            match &self.session_handler {
                Some(handler) => start_session_gateway(Arc::clone(handler)).await?,
                None => None,
            }
        } else {
            None
        };
        let mut retry_delay = self.client.config.reconnect_delay;
        write_executor_log_line(&local_backend_starting_log_line(
            &self.client.config.backend_url,
            &self.client.config.device_id,
        ));

        loop {
            match self.connect_and_register().await {
                Ok(()) => {
                    self.connection_status.store(true, Ordering::Release);
                    write_executor_log_line(&local_backend_registered_log_line(
                        &self.client.config.backend_url,
                        &self.client.config.device_id,
                    ));
                    retry_delay = self.client.config.reconnect_delay;
                    self.heartbeat_until_reconnect().await;
                    self.connection_status.store(false, Ordering::Release);
                    if let Err(error) = self.client.transport.disconnect().await {
                        write_executor_error_line(&format_executor_log(
                            "local backend stale connection cleanup failed",
                            &[("error", error)],
                        ));
                    }
                }
                Err(error) => {
                    self.connection_status.store(false, Ordering::Release);
                    let _ = self.client.transport.disconnect().await;
                    write_executor_error_line(&local_backend_connection_failure_log_line(
                        &self.client.config.backend_url,
                        &error,
                    ));
                    sleep(retry_delay).await;
                    retry_delay = retry_delay
                        .saturating_mul(2)
                        .min(self.client.config.reconnect_delay_max);
                }
            }
        }
    }

    pub fn register_handlers(&self) {
        self.client
            .transport
            .on(TASK_EXECUTE_EVENT, self.task_handler());
        self.client
            .transport
            .on(TASK_CANCEL_EVENT, self.cancel_handler());
        self.client
            .transport
            .on(TASK_CLOSE_SESSION_EVENT, self.close_session_handler());
        self.client
            .transport
            .on(CHAT_MESSAGE_EVENT, self.task_handler());
        self.client
            .transport
            .on(DEVICE_EXECUTE_COMMAND_EVENT, self.device_command_handler());
        self.client.transport.on(
            DEVICE_SYNC_CAPABILITIES_EVENT,
            self.capability_sync_handler(),
        );
        self.client.transport.on(
            DEVICE_START_TERMINAL_SESSION_EVENT,
            self.session_start_handler(SessionType::Terminal),
        );
        self.client.transport.on(
            DEVICE_START_CODE_SERVER_SESSION_EVENT,
            self.session_start_handler(SessionType::CodeServer),
        );
        self.client
            .transport
            .on(TERMINAL_ATTACH_EVENT, self.terminal_attach_handler());
        self.client
            .transport
            .on(TERMINAL_INPUT_EVENT, self.terminal_input_handler());
        self.client
            .transport
            .on(TERMINAL_RESIZE_EVENT, self.terminal_resize_handler());
        self.client
            .transport
            .on(TERMINAL_CLOSE_EVENT, self.terminal_close_handler());
        self.client
            .transport
            .on(RUNTIME_RPC_EVENT, self.runtime_rpc_handler());
        self.client.transport.on(
            RUNTIME_TASKS_AVAILABLE_EVENT,
            self.runtime_tasks_available_handler(),
        );
        self.client
            .transport
            .on(DEVICE_UPGRADE_EVENT, self.upgrade_handler());
        self.client
            .transport
            .on(DEVICE_RUN_EXTENSION_EVENT, self.extension_handler());
    }

    fn task_handler(&self) -> EventHandler {
        let runner = self.runner.clone();
        let config = Arc::clone(&self.client.config);
        let cancellations = self.cancellations.clone();
        Arc::new(move |payload| {
            let runner = runner.clone();
            let config = Arc::clone(&config);
            let cancellations = cancellations.clone();
            Box::pin(async move {
                write_executor_log_line(&format_executor_log(
                    "task:execute received",
                    &[(
                        "payload_keys",
                        payload
                            .as_object()
                            .map(|object| object.len().to_string())
                            .unwrap_or_else(|| "non-object".to_owned()),
                    )],
                ));
                let Ok(mut request) = serde_json::from_value::<ExecutionRequest>(payload) else {
                    write_executor_log_line(
                        "task:execute parse failed (unsupported execution request shape)",
                    );
                    return None;
                };
                write_executor_log_line(&format_executor_log(
                    "task:execute parsed",
                    &[
                        ("task_id", request.task_id.clone()),
                        (
                            "shell",
                            request
                                .resolved_shell_type()
                                .unwrap_or_else(|| "none".to_owned()),
                        ),
                        ("cwd", request.cwd().unwrap_or("<missing>").to_owned()),
                    ],
                ));
                normalize_local_task_request(&mut request, &config);
                cancellations.register_task(&request);
                let result = runner.submit(request).await;
                write_executor_log_line(&format_executor_log(
                    "task:execute submit result",
                    &[
                        ("status", format!("{:?}", result.status)),
                        ("message", result.message.unwrap_or_default()),
                    ],
                ));
                None
            })
        })
    }

    fn cancel_handler(&self) -> EventHandler {
        let cancellations = self.cancellations.clone();
        let task_controller = self.task_controller.clone();
        Arc::new(move |payload| {
            let cancellations = cancellations.clone();
            let task_controller = task_controller.clone();
            Box::pin(async move {
                let task_id = id_field(&payload, "task_id")?;
                let subtask_id = payload.get("subtask_id").and_then(id_value_string);
                cancellations.cancel_task(task_id.clone(), subtask_id.clone());
                if let Some(controller) = task_controller {
                    let _ = controller.cancel_task(task_id, subtask_id).await;
                }
                None
            })
        })
    }

    fn close_session_handler(&self) -> EventHandler {
        let task_controller = self.task_controller.clone();
        let client = self.client.clone();
        Arc::new(move |payload| {
            let task_controller = task_controller.clone();
            let client = client.clone();
            Box::pin(async move {
                let Some(task_id) = id_field(&payload, "task_id") else {
                    return Some(json!({"success": false, "error": "task_id is required"}));
                };
                if let Some(controller) = task_controller {
                    let _ = controller.close_task_session(task_id).await;
                    client.set_running_task_ids(controller.running_task_ids());
                }
                let _ = client.send_heartbeat(client.config.heartbeat_timeout).await;
                Some(json!({"success": true}))
            })
        })
    }

    fn device_command_handler(&self) -> EventHandler {
        let command_handler = Arc::clone(&self.command_handler);
        Arc::new(move |payload| {
            let command_handler = Arc::clone(&command_handler);
            Box::pin(async move {
                if let Some(command_key) = payload.get("command_key").and_then(Value::as_str) {
                    if is_workspace_file_command(command_key) {
                        let path = payload
                            .get("cwd")
                            .or_else(|| payload.get("path"))
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        let args = payload
                            .get("args")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default();
                        let env = payload
                            .get("env")
                            .and_then(Value::as_object)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(|(key, value)| {
                                        value.as_str().map(|value| (key.clone(), value.to_owned()))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let result =
                            execute_workspace_file_command(command_key, path, args, env).await;
                        return Some(serde_json::to_value(result).unwrap_or_else(
                            |error| json!({"success": false, "error": error.to_string()}),
                        ));
                    }
                }
                let result = command_handler
                    .handle_execute_command(CommandRequest::from_value(payload))
                    .await;
                Some(serde_json::to_value(result).unwrap_or_else(|error| {
                    json!({
                        "success": false,
                        "exit_code": null,
                        "stdout": "",
                        "stderr": "",
                        "duration": 0.0,
                        "timed_out": false,
                        "error": error.to_string(),
                    })
                }))
            })
        })
    }

    fn runtime_rpc_handler(&self) -> EventHandler {
        let runtime_work_handler = self.runtime_work_handler.clone();
        Arc::new(move |payload| {
            let runtime_work_handler = runtime_work_handler.clone();
            Box::pin(async move {
                let method = payload
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>")
                    .to_owned();
                let request_id = payload
                    .get("request_id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("-")
                    .to_owned();
                write_executor_log_line(&format_executor_log(
                    "runtime:rpc received",
                    &[
                        ("request_id", request_id.clone()),
                        ("method", method.clone()),
                    ],
                ));
                let response = if let Some(handler) = runtime_work_handler {
                    match handler.handle_runtime_rpc(payload).await {
                        Ok(result) => result,
                        Err(error) => runtime_error_response(error),
                    }
                } else {
                    runtime_error_response(AppIpcError::new(
                        "runtime_unavailable",
                        "Runtime work handler is not available",
                    ))
                };
                write_executor_log_line(&format_executor_log(
                    "runtime:rpc responded",
                    &[
                        ("request_id", request_id),
                        ("method", method.clone()),
                        (
                            "ok",
                            response
                                .get("success")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                .to_string(),
                        ),
                        (
                            "error",
                            response
                                .get("error")
                                .map(|v| v.to_string())
                                .unwrap_or_default(),
                        ),
                    ],
                ));
                Some(encode_runtime_rpc_response(&method, response))
            })
        })
    }

    fn runtime_tasks_available_handler(&self) -> EventHandler {
        let client = self.client.clone();
        let runtime_work_handler = self.runtime_work_handler.clone();
        let runtime_pull_lock = Arc::clone(&self.runtime_pull_lock);
        Arc::new(move |_| {
            let client = client.clone();
            let runtime_work_handler = runtime_work_handler.clone();
            let runtime_pull_lock = Arc::clone(&runtime_pull_lock);
            Box::pin(async move {
                if let Some(handler) = runtime_work_handler {
                    tokio::spawn(poll_available_runtime_work(
                        client,
                        handler,
                        runtime_pull_lock,
                    ));
                }
                Some(json!({"success": true}))
            })
        })
    }

    fn capability_sync_handler(&self) -> EventHandler {
        let capability_sync_handler = self.capability_sync_handler.clone();
        Arc::new(move |payload| {
            let capability_sync_handler = capability_sync_handler.clone();
            Box::pin(async move {
                let started_at = Instant::now();
                write_executor_log_line(&format_executor_log(
                    "device capability sync started",
                    &[(
                        "mode",
                        payload
                            .get("mode")
                            .and_then(Value::as_str)
                            .unwrap_or("merge")
                            .to_owned(),
                    )],
                ));
                let response = match capability_sync_handler {
                    Some(handler) => handler.handle_sync_capabilities(payload).await,
                    None => json!({
                        "success": false,
                        "error": "Capability sync handler is not available",
                    }),
                };
                write_executor_log_line(&format_executor_log(
                    "device capability sync finished",
                    &[
                        ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                        (
                            "ok",
                            response
                                .get("success")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                .to_string(),
                        ),
                        (
                            "error",
                            response
                                .get("error")
                                .map(Value::to_string)
                                .unwrap_or_default(),
                        ),
                    ],
                ));
                Some(response)
            })
        })
    }

    fn session_start_handler(&self, session_type: SessionType) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(json!({
                        "success": false,
                        "error": "Session handler is not available",
                    }));
                };
                let request = match session_start_request(payload, session_type) {
                    Ok(request) => request,
                    Err(error) => return Some(json!({"success": false, "error": error})),
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_start_session(request);
                Some(session_result_payload(result))
            })
        })
    }

    fn terminal_input_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let Some(data) = payload
                    .get("data")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                else {
                    return Some(json!({"success": false, "error": "data is required"}));
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_input(&session_id, &data);
                Some(session_result_payload(result))
            })
        })
    }

    fn terminal_attach_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_attach(&session_id);
                Some(session_result_payload(result))
            })
        })
    }

    fn terminal_resize_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let rows = value_u16(payload.get("rows")).unwrap_or(24);
                let cols = value_u16(payload.get("cols")).unwrap_or(80);
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_resize(&session_id, rows, cols);
                Some(session_result_payload(result))
            })
        })
    }

    fn terminal_close_handler(&self) -> EventHandler {
        let session_handler = self.session_handler.clone();
        Arc::new(move |payload| {
            let session_handler = session_handler.clone();
            Box::pin(async move {
                let Some(handler) = session_handler else {
                    return Some(
                        json!({"success": false, "error": "Session handler is not available"}),
                    );
                };
                let Some(session_id) = value_string(payload.get("session_id")) else {
                    return Some(json!({"success": false, "error": "session_id is required"}));
                };
                let result = handler
                    .lock()
                    .expect("session handler lock")
                    .handle_terminal_close(&session_id);
                Some(session_result_payload(result))
            })
        })
    }

    fn upgrade_handler(&self) -> EventHandler {
        let upgrade_handler = self.upgrade_handler.clone().or_else(|| {
            self.upgrade_service.as_ref().map(|service| {
                Arc::new(LocalDeviceUpgradeHandler::with_service_arc(
                    self.client.clone(),
                    self.task_controller.clone(),
                    self.client.config.update.clone(),
                    Arc::clone(service),
                )) as Arc<dyn DeviceUpgradeHandler>
            })
        });
        Arc::new(move |payload| {
            let upgrade_handler = upgrade_handler.clone();
            Box::pin(async move {
                let Some(handler) = upgrade_handler else {
                    return Some(json!({
                        "success": false,
                        "error": "Upgrade handler is not available",
                    }));
                };
                Some(handler.handle_upgrade(payload).await)
            })
        })
    }

    fn extension_handler(&self) -> EventHandler {
        let extension_handler = self.extension_handler.clone();
        Arc::new(move |payload| {
            let extension_handler = extension_handler.clone();
            Box::pin(async move {
                let Some(handler) = extension_handler else {
                    return Some(json!({
                        "success": false,
                        "message": "Extension handler is not available",
                    }));
                };
                Some(handler.handle_run_extension(payload).await)
            })
        })
    }

    pub async fn connect_and_register(&self) -> Result<(), String> {
        self.client.connect().await?;
        match self
            .client
            .register_device(self.client.config.registration_timeout)
            .await
        {
            Ok(true) => {
                if let Err(error) = self.client.emit_liveness_heartbeat().await {
                    let _ = self.client.disconnect().await;
                    return Err(error);
                }
                self.trigger_runtime_work_poll();
                Ok(())
            }
            Ok(false) => {
                let _ = self.client.disconnect().await;
                Err("device registration was rejected by backend".to_owned())
            }
            Err(error) => {
                let _ = self.client.disconnect().await;
                Err(error)
            }
        }
    }

    async fn heartbeat_until_reconnect(&self) {
        let mut consecutive_failures = 0_u32;
        let mut next_heartbeat_at = Instant::now() + self.client.config.heartbeat_interval;
        loop {
            tokio::select! {
                _ = sleep_until(next_heartbeat_at) => {}
                _ = sleep(TERMINAL_POLL_INTERVAL) => {
                    self.forward_terminal_events().await;
                    continue;
                }
            }
            let failure = match self.client.emit_liveness_heartbeat().await {
                Ok(()) => {
                    consecutive_failures = 0;
                    self.trigger_runtime_work_poll();
                    next_heartbeat_at = Instant::now() + self.client.config.heartbeat_interval;
                    continue;
                }
                Err(error) => error,
            };

            consecutive_failures += 1;
            write_executor_error_line(&local_backend_heartbeat_failure_log_line(
                &self.client.config.backend_url,
                &failure,
            ));
            if consecutive_failures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES {
                let _ = self.client.disconnect().await;
                return;
            }
            next_heartbeat_at = Instant::now() + self.client.config.heartbeat_timeout;
        }
    }

    fn trigger_runtime_work_poll(&self) {
        let Some(handler) = self.runtime_work_handler.clone() else {
            return;
        };
        tokio::spawn(poll_available_runtime_work(
            self.client.clone(),
            handler,
            Arc::clone(&self.runtime_pull_lock),
        ));
    }

    async fn forward_terminal_events(&self) {
        let Some(handler) = &self.session_handler else {
            return;
        };
        let events = handler
            .lock()
            .expect("session handler lock")
            .drain_terminal_events();

        for event in events {
            let (event_name, payload, error) = match event {
                TerminalEvent::Output { session_id, data } => (
                    TERMINAL_OUTPUT_EVENT,
                    json!({"session_id": session_id, "data": data}),
                    None,
                ),
                TerminalEvent::Exit {
                    session_id,
                    exit_code,
                    error,
                } => {
                    let mut payload = json!({"session_id": session_id, "exit_code": exit_code});
                    if let Some(error) = &error {
                        payload["error"] = json!(error);
                    }
                    (TERMINAL_EXIT_EVENT, payload, error)
                }
            };
            if let Some(error) = error {
                write_executor_error_line(&format_executor_log(
                    "terminal session failed",
                    &[("error", error)],
                ));
            }
            if let Err(error) = self.client.emit_raw_event(event_name, payload).await {
                write_executor_error_line(&format_executor_log(
                    "terminal event relay failed",
                    &[("event", event_name.to_owned()), ("error", error)],
                ));
            }
        }
    }
}

async fn poll_available_runtime_work<T>(
    client: LocalBackendClient<T>,
    handler: Arc<dyn RuntimeWorkHandler>,
    pull_lock: Arc<AsyncMutex<()>>,
) where
    T: LocalBackendTransport,
{
    let Ok(_guard) = pull_lock.try_lock() else {
        return;
    };
    let capacity = handler
        .handle_runtime_rpc(json!({
            "method": "runtime.capacity.get",
            "payload": {},
        }))
        .await
        .ok();
    client.set_runtime_capacity(capacity);

    loop {
        let task = match client
            .pull_runtime_task(client.config.heartbeat_timeout)
            .await
        {
            Ok(Some(task)) => task,
            Ok(None) => return,
            Err(error) => {
                write_executor_error_line(&format_executor_log(
                    "runtime task pull failed",
                    &[("error", error)],
                ));
                return;
            }
        };
        let Some(payload) = task.get("payload").cloned() else {
            write_executor_error_line("runtime task pull returned no payload");
            return;
        };
        let response = match handler
            .handle_runtime_rpc(json!({
                "method": "runtime.tasks.create",
                "payload": payload,
            }))
            .await
        {
            Ok(response) => response,
            Err(error) => runtime_error_response(error),
        };
        let accepted = response.get("success").and_then(Value::as_bool) == Some(true);
        if let Err(error) = client
            .acknowledge_runtime_task(&task, accepted, &response, client.config.heartbeat_timeout)
            .await
        {
            write_executor_error_line(&format_executor_log(
                "runtime task acceptance report failed",
                &[("error", error)],
            ));
        }
        if !accepted {
            return;
        }
    }
}

fn id_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(id_value_string)
}

fn id_value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) if !value.trim().is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

pub fn local_backend_connection_failure_log_line(backend_url: &str, error: &str) -> String {
    format_executor_log(
        "local backend connection failed",
        &[
            ("backend_url", backend_url.to_owned()),
            ("error", error.to_owned()),
        ],
    )
}

pub fn local_backend_starting_log_line(backend_url: &str, device_id: &str) -> String {
    format_executor_log(
        "local backend runner starting",
        &[
            ("backend_url", backend_url.to_owned()),
            ("device_id", device_id.to_owned()),
        ],
    )
}

pub fn local_backend_registered_log_line(backend_url: &str, device_id: &str) -> String {
    format_executor_log(
        "local backend registered",
        &[
            ("backend_url", backend_url.to_owned()),
            ("device_id", device_id.to_owned()),
        ],
    )
}

pub fn local_backend_heartbeat_failure_log_line(backend_url: &str, error: &str) -> String {
    format_executor_log(
        "local backend heartbeat failed",
        &[
            ("backend_url", backend_url.to_owned()),
            ("error", error.to_owned()),
        ],
    )
}

pub async fn serve_local_app_sidecar(config: DeviceConfig) -> Result<(), String> {
    local_app_ipc_server(config).await?.serve_stdio().await
}

pub async fn serve_local_app_endpoint(
    config: DeviceConfig,
    endpoint: &str,
    token: &str,
    owner_token: &str,
) -> Result<(), String> {
    local_app_ipc_server(config)
        .await?
        .serve_local_endpoint(endpoint, token, owner_token)
        .await
}

async fn local_app_ipc_server(config: DeviceConfig) -> Result<AppIpcServer, String> {
    crate::browser_mcp::http::ensure_browser_mcp_http_endpoint().await?;
    crate::task_runtime::mcp_http::ensure_space_mcp_http_endpoint().await?;
    let backend_config = LocalBackendConfig::from_device_config(config.clone());
    let app_ipc_device_id = app_ipc_sidecar_device_id(&backend_config);
    let runtime_instance_id = backend_config.runtime_instance_id.clone();
    let (runtime_event_tx, _) = broadcast::channel(super::RUNTIME_EVENT_BUFFER_CAPACITY);
    let event_hub = ExecutorEventHub::new(runtime_event_tx.clone());
    event_hub.ensure_started();
    let backend_connection_snapshot: Arc<Mutex<Option<ConnectionConfig>>> =
        Arc::new(Mutex::new(None));
    let runtime_work_handler: Arc<dyn RuntimeWorkHandler> = Arc::new(
        RuntimeWorkRpcHandler::with_event_sender(
            app_ipc_device_id.clone(),
            resolve_codex_binary(),
            runtime_event_tx.clone(),
        )
        .with_backend_connection(backend_connection_snapshot.clone()),
    );
    let backend_connection = LocalBackendConnectionController::start_with_runtime(
        config,
        runtime_work_handler.clone(),
        event_hub.clone(),
        backend_connection_snapshot,
    )
    .await;
    let server = AppIpcServer::new()
        .with_device_id(app_ipc_device_id)
        .with_runtime_instance_id(runtime_instance_id)
        .with_shared_runtime_work_handler(runtime_work_handler, runtime_event_tx, event_hub)
        .with_backend_connection_handler(backend_connection);
    Ok(server)
}

pub async fn serve_remote_local_backend(config: DeviceConfig) -> Result<(), String> {
    let backend_config = LocalBackendConfig::from_device_config(config);
    LocalBackendRunner::new(backend_config, SocketIoTransport::default())
        .run_forever()
        .await
}

fn app_ipc_sidecar_device_id(config: &LocalBackendConfig) -> String {
    env::var(APP_IPC_DEVICE_ID_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| config.device_id.clone())
}

/// Snapshot of the static connection used by the remote backend runner path.
/// The App sidecar path instead shares the live controller snapshot so
/// `executor.backend.configure` updates reach running tasks immediately.
fn connection_snapshot_from_config(config: &LocalBackendConfig) -> Option<ConnectionConfig> {
    let backend_url = config.backend_url.trim();
    let auth_token = config.auth_token.trim();
    if backend_url.is_empty() || auth_token.is_empty() {
        return None;
    }
    Some(ConnectionConfig {
        backend_url: backend_url.to_owned(),
        socket_url: config.socket_url.trim().trim_end_matches('/').to_owned(),
        auth_token: auth_token.to_owned(),
        runtime_auth_token: config.runtime_auth_token.clone(),
    })
}

fn normalize_local_task_request(request: &mut ExecutionRequest, config: &LocalBackendConfig) {
    if request
        .backend_url
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        request.backend_url = Some(config.backend_url.clone());
    }
    if request
        .auth_token
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        request.auth_token = Some(config.auth_token.clone());
    }
    if request
        .runtime_auth_token
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
        && !config.runtime_auth_token.trim().is_empty()
    {
        request.runtime_auth_token = Some(config.runtime_auth_token.clone());
    }
    if request.device_id.as_deref().unwrap_or("").trim().is_empty() {
        request.device_id = Some(config.device_id.clone());
    }
}

fn runtime_error_response(error: AppIpcError) -> Value {
    json!({
        "success": false,
        "code": error.code,
        "error": error.message,
    })
}

#[cfg(test)]
mod tests {
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
            runtime_auth_home: PathBuf::from("/tmp/auth"),
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
}
