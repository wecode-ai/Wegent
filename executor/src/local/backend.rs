// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    future::{pending, Future},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::{json, Value};
use tokio::{
    sync::{broadcast, Mutex as AsyncMutex, Notify},
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
mod handlers;
pub(crate) mod runtime_rpc_encoding;
mod session_events;
mod socket_transport;
mod tasks;
mod terminal_relay;
#[cfg(test)]
mod tests;
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
const TERMINAL_ACK_EVENT: &str = "terminal:ack";
const TERMINAL_INPUT_EVENT: &str = "terminal:input";
const TERMINAL_RESIZE_EVENT: &str = "terminal:resize";
const TERMINAL_CLOSE_EVENT: &str = "terminal:close";
const TERMINAL_OUTPUT_EVENT: &str = "terminal:output";
const TERMINAL_EXIT_EVENT: &str = "terminal:exit";
const TERMINAL_OUTPUT_BATCH_DELAY: Duration = Duration::from_millis(3);
const TERMINAL_DELIVERY_TIMEOUT: Duration = Duration::from_secs(10);
const TERMINAL_SESSION_DELIVERY_CONCURRENCY: usize = 8;
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
            .on(TERMINAL_ACK_EVENT, self.terminal_ack_handler());
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
                if let Some(handler) = &self.session_handler {
                    handler
                        .lock()
                        .expect("session handler lock")
                        .prepare_terminal_reconnect();
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
        let terminal_event_notifier = self.session_handler.as_ref().map(|handler| {
            handler
                .lock()
                .expect("session handler lock")
                .terminal_event_notifier()
        });
        let terminal_relay = self.relay_terminal_events_until_error(terminal_event_notifier);
        tokio::pin!(terminal_relay);
        loop {
            tokio::select! {
                _ = sleep_until(next_heartbeat_at) => {},
                result = &mut terminal_relay => {
                    let error = result.expect_err("terminal relay only stops on error");
                    write_executor_error_line(&format_executor_log(
                        "terminal event relay paused until reconnect",
                        &[("error", error)],
                    ));
                    let _ = self.client.disconnect().await;
                    return;
                }
            }
            if let Some(handler) = &self.session_handler {
                handler
                    .lock()
                    .expect("session handler lock")
                    .reap_expired_sessions();
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
