// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    future::Future,
    net::{IpAddr, UdpSocket},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};
use tokio::time::sleep;

use crate::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    config::device::{DeviceConfig, UpdateConfig},
    emitter::EventEnvelope,
    local::{
        app_ipc::{serve_app_ipc_sidecar, AppIpcError, RuntimeWorkHandler},
        command::{CommandHandler, CommandRequest, DeviceCommandHandler},
        session::{LocalSessionHandler, SessionType},
    },
    protocol::ExecutionRequest,
    runner::EventSink,
    runtime_work::RuntimeWorkRpcHandler,
    server::TaskRunner,
    version::get_version,
};

mod cancellation;
mod capability;
mod extension;
mod session_events;
mod socket_transport;
mod tasks;
mod upgrade;

pub use cancellation::LocalCancellationSnapshot;
pub use capability::{CapabilityReportProvider, CapabilitySyncRpcHandler, HttpPackageProvider};
pub use extension::{DeviceExtensionHandler, DeviceExtensionRunner};
pub use socket_transport::SocketIoTransport;
pub use tasks::{LocalRunningTaskTracker, LocalTaskController, ManagedLocalTaskRunner};
pub use upgrade::{LocalDeviceUpgradeHandler, LocalUpgradeService};

use cancellation::LocalCancellationRegistry;
use capability::{default_capability_sync_handler, DefaultCapabilityReporter};
use extension::default_extension_handler;
use session_events::{
    default_session_handler, session_result_payload, session_start_request, value_string, value_u16,
};
use upgrade::default_upgrade_handler;

const REGISTER_EVENT: &str = "device:register";
const HEARTBEAT_EVENT: &str = "device:heartbeat";
const TASK_EXECUTE_EVENT: &str = "task:execute";
const TASK_CANCEL_EVENT: &str = "task:cancel";
const TASK_CLOSE_SESSION_EVENT: &str = "task:close-session";
const CHAT_MESSAGE_EVENT: &str = "chat:message";
const DEVICE_EXECUTE_COMMAND_EVENT: &str = "device:execute_command";
const DEVICE_SYNC_CAPABILITIES_EVENT: &str = "device:sync_capabilities";
const DEVICE_START_TERMINAL_SESSION_EVENT: &str = "device:start_terminal_session";
const DEVICE_START_CODE_SERVER_SESSION_EVENT: &str = "device:start_code_server_session";
const TERMINAL_INPUT_EVENT: &str = "terminal:input";
const TERMINAL_RESIZE_EVENT: &str = "terminal:resize";
const TERMINAL_CLOSE_EVENT: &str = "terminal:close";
const RUNTIME_RPC_EVENT: &str = "runtime:rpc";
const DEVICE_UPGRADE_EVENT: &str = "device:upgrade";
const DEVICE_RUN_EXTENSION_EVENT: &str = "device:run_extension";
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS: u64 = 30;
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS: u64 = 10;
const DEFAULT_RECONNECT_DELAY_SECONDS: u64 = 1;
const DEFAULT_RECONNECT_MAX_DELAY_SECONDS: u64 = 30;
const CODEX_AUTH_TARGET_PATH: &str = "~/.codex/auth.json";

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBackendConfig {
    pub backend_url: String,
    pub auth_token: String,
    pub device_id: String,
    pub device_name: String,
    pub device_type: String,
    pub bind_shell: String,
    pub executor_version: String,
    pub client_ip: String,
    pub runtime_transfer_host: String,
    pub heartbeat_interval: Duration,
    pub heartbeat_timeout: Duration,
    pub registration_timeout: Duration,
    pub reconnect_delay: Duration,
    pub reconnect_delay_max: Duration,
    pub configured_capabilities: Vec<String>,
    pub runtime_auth_home: PathBuf,
    pub local_workspace_root: PathBuf,
    pub update: UpdateConfig,
}

impl LocalBackendConfig {
    pub fn from_device_config(config: DeviceConfig) -> Self {
        let client_ip = detect_client_ip();
        let runtime_transfer_host = env::var("RUNTIME_TRANSFER_HOST")
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| client_ip.clone());

        Self {
            backend_url: config
                .connection
                .backend_url
                .trim()
                .trim_end_matches('/')
                .to_owned(),
            auth_token: normalize_token(&config.connection.auth_token),
            device_id: normalize_nonempty(config.device_id, "local-device"),
            device_name: normalize_nonempty(config.device_name, &default_device_name()),
            device_type: normalize_nonempty(config.device_type, "local"),
            bind_shell: normalize_nonempty(config.bind_shell, "claudecode").to_ascii_lowercase(),
            executor_version: get_version(),
            client_ip,
            runtime_transfer_host,
            heartbeat_interval: duration_from_env(
                "LOCAL_HEARTBEAT_INTERVAL",
                DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
            ),
            heartbeat_timeout: duration_from_env(
                "LOCAL_HEARTBEAT_CALL_TIMEOUT",
                DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
            ),
            registration_timeout: Duration::from_secs(10),
            reconnect_delay: duration_from_env(
                "LOCAL_RECONNECT_DELAY",
                DEFAULT_RECONNECT_DELAY_SECONDS,
            ),
            reconnect_delay_max: duration_from_env(
                "LOCAL_RECONNECT_MAX_DELAY",
                DEFAULT_RECONNECT_MAX_DELAY_SECONDS,
            ),
            configured_capabilities: config.capabilities,
            runtime_auth_home: home_dir(),
            local_workspace_root: config.local_workspace_root,
            update: config.update,
        }
    }
}

#[derive(Clone)]
pub struct LocalBackendClient<T>
where
    T: LocalBackendTransport,
{
    config: Arc<LocalBackendConfig>,
    transport: T,
    running_tasks: LocalRunningTaskTracker,
    capability_reporter: Arc<dyn CapabilityReportProvider>,
}

impl<T> LocalBackendClient<T>
where
    T: LocalBackendTransport,
{
    pub fn new(config: LocalBackendConfig, transport: T) -> Self {
        Self::with_capability_reporter(config, transport, DefaultCapabilityReporter::new())
    }

    pub fn with_capability_reporter<R>(
        config: LocalBackendConfig,
        transport: T,
        capability_reporter: R,
    ) -> Self
    where
        R: CapabilityReportProvider,
    {
        Self::with_capability_reporter_and_tracker(
            config,
            transport,
            capability_reporter,
            LocalRunningTaskTracker::default(),
        )
    }

    pub fn with_capability_reporter_and_tracker<R>(
        config: LocalBackendConfig,
        transport: T,
        capability_reporter: R,
        running_tasks: LocalRunningTaskTracker,
    ) -> Self
    where
        R: CapabilityReportProvider,
    {
        Self {
            config: Arc::new(config),
            transport,
            running_tasks,
            capability_reporter: Arc::new(capability_reporter),
        }
    }

    pub async fn connect(&self) -> Result<(), String> {
        if self.config.backend_url.trim().is_empty() {
            return Err("WEGENT_BACKEND_URL is required for local backend mode".to_owned());
        }
        if self.config.auth_token.trim().is_empty() {
            return Err("WEGENT_AUTH_TOKEN is required for local backend mode".to_owned());
        }
        self.transport.connect(&self.config).await
    }

    pub async fn disconnect(&self) -> Result<(), String> {
        self.transport.disconnect().await
    }

    pub async fn register_device(&self, timeout: Duration) -> Result<bool, String> {
        let response = self
            .transport
            .call(REGISTER_EVENT, self.registration_payload(), timeout)
            .await?;
        Ok(ack_success(&response))
    }

    pub async fn send_heartbeat(&self, timeout: Duration) -> Result<bool, String> {
        let response = self
            .transport
            .call(HEARTBEAT_EVENT, self.heartbeat_payload(), timeout)
            .await?;
        Ok(ack_success(&response))
    }

    pub async fn emit_event(&self, event: EventEnvelope) -> Result<(), String> {
        let event_type = event.event_type.clone();
        let payload = serde_json::to_value(event).map_err(|error| error.to_string())?;
        self.transport.emit(&event_type, payload).await
    }

    pub async fn emit_raw_event(&self, event: &str, payload: Value) -> Result<(), String> {
        self.transport.emit(event, payload).await
    }

    pub fn set_running_task_ids<I>(&self, task_ids: I)
    where
        I: IntoIterator<Item = i64>,
    {
        self.running_tasks.set(task_ids);
    }

    fn registration_payload(&self) -> Value {
        json!({
            "device_id": self.config.device_id,
            "name": self.config.device_name,
            "device_type": self.config.device_type,
            "bind_shell": self.config.bind_shell,
            "executor_version": self.config.executor_version,
            "client_ip": self.config.client_ip,
            "runtime_transfer_host": self.config.runtime_transfer_host,
        })
    }

    fn heartbeat_payload(&self) -> Value {
        let running_task_ids = self.running_tasks.running_task_ids();
        json!({
            "device_id": self.config.device_id,
            "running_task_ids": running_task_ids,
            "executor_version": self.config.executor_version,
            "capabilities": self.capability_reporter.build_report(),
            "runtime_auth_files": build_runtime_auth_file_report(&self.config.runtime_auth_home),
            "runtime_transfer_host": self.config.runtime_transfer_host,
        })
    }
}

#[derive(Clone)]
pub struct LocalBackendEventSink<T>
where
    T: LocalBackendTransport,
{
    client: LocalBackendClient<T>,
}

impl<T> LocalBackendEventSink<T>
where
    T: LocalBackendTransport,
{
    pub fn new(client: LocalBackendClient<T>) -> Self {
        Self { client }
    }
}

impl<T> EventSink for LocalBackendEventSink<T>
where
    T: LocalBackendTransport,
{
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let client = self.client.clone();
        Box::pin(async move { client.emit_event(event).await })
    }
}

#[derive(Clone)]
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
    upgrade_handler: Option<Arc<dyn DeviceUpgradeHandler>>,
    extension_handler: Option<Arc<dyn DeviceExtensionHandler>>,
    cancellations: LocalCancellationRegistry,
}

impl<T> LocalBackendRunner<T>
where
    T: LocalBackendTransport,
{
    pub fn new(config: LocalBackendConfig, transport: T) -> Self {
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
        backend.runtime_work_handler = Some(Arc::new(RuntimeWorkRpcHandler::new(
            backend.client.config.device_id.clone(),
            default_codex_binary(),
        )));
        backend.capability_sync_handler = Some(Arc::new(default_capability_sync_handler(
            backend.client.config.as_ref(),
        )));
        backend.session_handler = Some(Arc::new(Mutex::new(default_session_handler())));
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
            upgrade_handler: None,
            extension_handler: None,
            cancellations: LocalCancellationRegistry::default(),
        }
    }

    pub fn with_task_controller<C>(mut self, controller: C) -> Self
    where
        C: LocalTaskController,
    {
        self.task_controller = Some(Arc::new(controller));
        self
    }

    pub fn with_runtime_work_handler<H>(mut self, handler: H) -> Self
    where
        H: RuntimeWorkHandler + 'static,
    {
        self.runtime_work_handler = Some(Arc::new(handler));
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

    pub fn with_upgrade_handler<H>(mut self, handler: H) -> Self
    where
        H: DeviceUpgradeHandler,
    {
        self.upgrade_handler = Some(Arc::new(handler));
        self
    }

    pub fn with_upgrade_service<S>(mut self, service: S) -> Self
    where
        S: LocalUpgradeService,
    {
        self.upgrade_handler = Some(Arc::new(LocalDeviceUpgradeHandler::with_service(
            self.client.clone(),
            self.task_controller.clone(),
            self.client.config.update.clone(),
            service,
        )));
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

    pub fn is_cancel_requested(&self, task_id: i64, subtask_id: Option<i64>) -> bool {
        self.cancellations.is_cancel_requested(task_id, subtask_id)
    }

    pub async fn run_forever(self) -> Result<(), String> {
        self.register_handlers();
        let mut retry_delay = self.client.config.reconnect_delay;

        loop {
            match self.connect_and_register().await {
                Ok(()) => {
                    retry_delay = self.client.config.reconnect_delay;
                    self.heartbeat_until_reconnect().await;
                }
                Err(error) => {
                    eprintln!("local backend connection failed: {error}");
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
                let Ok(mut request) = serde_json::from_value::<ExecutionRequest>(payload) else {
                    return None;
                };
                normalize_local_task_request(&mut request, &config);
                cancellations.register_task(&request);
                let _ = runner.submit(request).await;
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
                let task_id = payload.get("task_id").and_then(Value::as_i64)?;
                let subtask_id = payload.get("subtask_id").and_then(Value::as_i64);
                cancellations.cancel_task(task_id, subtask_id);
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
                let Some(task_id) = payload.get("task_id").and_then(Value::as_i64) else {
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
                let Some(handler) = runtime_work_handler else {
                    return Some(runtime_error_response(AppIpcError::new(
                        "runtime_unavailable",
                        "Runtime work handler is not available",
                    )));
                };

                Some(match handler.handle_runtime_rpc(payload).await {
                    Ok(result) => result,
                    Err(error) => runtime_error_response(error),
                })
            })
        })
    }

    fn capability_sync_handler(&self) -> EventHandler {
        let capability_sync_handler = self.capability_sync_handler.clone();
        Arc::new(move |payload| {
            let capability_sync_handler = capability_sync_handler.clone();
            Box::pin(async move {
                let Some(handler) = capability_sync_handler else {
                    return Some(json!({
                        "success": false,
                        "error": "Capability sync handler is not available",
                    }));
                };
                Some(handler.handle_sync_capabilities(payload).await)
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
        let upgrade_handler = self.upgrade_handler.clone();
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
            Ok(true) => Ok(()),
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
        let mut consecutive_failures = 0usize;
        loop {
            sleep(self.client.config.heartbeat_interval).await;
            match self
                .client
                .send_heartbeat(self.client.config.heartbeat_timeout)
                .await
            {
                Ok(true) => consecutive_failures = 0,
                Ok(false) | Err(_) => consecutive_failures += 1,
            }

            if consecutive_failures >= 3 {
                let _ = self.client.disconnect().await;
                return;
            }
        }
    }
}

pub async fn serve_local_backend_sidecar(config: DeviceConfig) -> Result<(), String> {
    let backend_config = LocalBackendConfig::from_device_config(config);
    let device_id = backend_config.device_id.clone();
    let runner = LocalBackendRunner::new(backend_config, SocketIoTransport::default());

    let ipc_task = tokio::spawn(async move { serve_app_ipc_sidecar(device_id).await });
    let backend_task = tokio::spawn(async move { runner.run_forever().await });

    tokio::select! {
        result = ipc_task => task_result("app IPC sidecar", result),
        result = backend_task => task_result("local backend runner", result),
    }
}

pub fn build_runtime_auth_file_report(home: &Path) -> Value {
    json!({
        "codex": {
            "target_path": CODEX_AUTH_TARGET_PATH,
            "exists": home.join(".codex").join("auth.json").is_file(),
        }
    })
}

pub fn is_usable_device_ip(value: &str) -> bool {
    match value.trim().parse::<IpAddr>() {
        Ok(address) => !is_unusable_ip(address),
        Err(_) => false,
    }
}

fn is_unusable_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_link_local()
        }
        IpAddr::V6(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (address.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

fn normalize_local_task_request(request: &mut ExecutionRequest, config: &LocalBackendConfig) {
    if request
        .auth_token
        .as_deref()
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        request.auth_token = Some(config.auth_token.clone());
    }
    if request.device_id.as_deref().unwrap_or("").trim().is_empty() {
        request.device_id = Some(config.device_id.clone());
    }
}

fn task_result(
    label: &str,
    result: Result<Result<(), String>, tokio::task::JoinError>,
) -> Result<(), String> {
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(error) => Err(format!("{label} task failed: {error}")),
    }
}

fn runtime_error_response(error: AppIpcError) -> Value {
    json!({
        "success": false,
        "code": error.code,
        "error": error.message,
    })
}

fn ack_success(response: &Value) -> bool {
    if response.get("success").and_then(Value::as_bool) == Some(true) {
        return true;
    }

    response
        .as_array()
        .map(|values| values.iter().any(ack_success))
        .unwrap_or(false)
}

fn normalize_token(token: &str) -> String {
    let token = token.trim();
    token
        .strip_prefix("Bearer ")
        .or_else(|| token.strip_prefix("bearer "))
        .unwrap_or(token)
        .to_owned()
}

fn normalize_nonempty(value: String, default: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default.to_owned()
    } else {
        value.to_owned()
    }
}

fn duration_from_env(name: &str, default_seconds: u64) -> Duration {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .map(Duration::from_secs)
        .unwrap_or_else(|| Duration::from_secs(default_seconds))
}

fn detect_client_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .ok()
        .map(|address| address.ip().to_string())
        .filter(|ip| is_usable_device_ip(ip))
        .unwrap_or_else(|| "127.0.0.1".to_owned())
}

fn default_device_name() -> String {
    let host = env::var("HOSTNAME")
        .or_else(|_| env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "local".to_owned());
    format!("{} - {host}", env::consts::OS)
}

fn default_codex_binary() -> String {
    env::var("CODEX_BINARY_PATH")
        .ok()
        .or_else(|| env::var("CODEX_BIN").ok())
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "codex".to_owned())
}

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}
