// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
    env,
    fmt::Write as _,
    future::Future,
    net::{IpAddr, UdpSocket},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::FutureExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tf_rust_socketio::{
    asynchronous::{Client, ClientBuilder},
    Payload, TransportType,
};
use tokio::{sync::oneshot, time::sleep};

use crate::{
    agents::{AgentCommandPlanner, AgentProcessEngine},
    config::device::DeviceConfig,
    emitter::EventEnvelope,
    local::{
        app_ipc::{serve_app_ipc_sidecar, AppIpcError, RuntimeWorkHandler},
        command::{CommandHandler, CommandRequest, DeviceCommandHandler},
    },
    logging::format_executor_log,
    protocol::ExecutionRequest,
    runner::{BackgroundTaskRunner, EventSink},
    server::TaskRunner,
    version::get_version,
};

const NAMESPACE: &str = "/local-executor";
const REGISTER_EVENT: &str = "device:register";
const HEARTBEAT_EVENT: &str = "device:heartbeat";
const TASK_EXECUTE_EVENT: &str = "task:execute";
const TASK_CANCEL_EVENT: &str = "task:cancel";
const CHAT_MESSAGE_EVENT: &str = "chat:message";
const DEVICE_EXECUTE_COMMAND_EVENT: &str = "device:execute_command";
const RUNTIME_RPC_EVENT: &str = "runtime:rpc";
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS: u64 = 30;
const DEFAULT_HEARTBEAT_TIMEOUT_SECONDS: u64 = 10;
const DEFAULT_RECONNECT_DELAY_SECONDS: u64 = 1;
const DEFAULT_RECONNECT_MAX_DELAY_SECONDS: u64 = 30;
const CODEX_AUTH_TARGET_PATH: &str = "~/.codex/auth.json";

type TransportFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'a>>;
pub type EventHandler =
    Arc<dyn Fn(Value) -> Pin<Box<dyn Future<Output = Option<Value>> + Send>> + Send + Sync>;

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
    running_task_ids: Arc<Mutex<BTreeSet<i64>>>,
}

impl<T> LocalBackendClient<T>
where
    T: LocalBackendTransport,
{
    pub fn new(config: LocalBackendConfig, transport: T) -> Self {
        Self {
            config: Arc::new(config),
            transport,
            running_task_ids: Arc::new(Mutex::new(BTreeSet::new())),
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

    pub fn set_running_task_ids<I>(&self, task_ids: I)
    where
        I: IntoIterator<Item = i64>,
    {
        let mut running = self.running_task_ids.lock().expect("running task lock");
        running.clear();
        running.extend(task_ids);
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
        let running_task_ids: Vec<i64> = self
            .running_task_ids
            .lock()
            .expect("running task lock")
            .iter()
            .copied()
            .collect();
        json!({
            "device_id": self.config.device_id,
            "running_task_ids": running_task_ids,
            "executor_version": self.config.executor_version,
            "capabilities": build_capability_report(),
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalCancellationSnapshot {
    pub pending_task_ids: Vec<i64>,
    pub pending_subtask_ids: Vec<i64>,
    pub cancel_requested_task_ids: Vec<i64>,
}

#[derive(Clone, Default)]
struct LocalCancellationRegistry {
    inner: Arc<Mutex<LocalCancellationState>>,
}

#[derive(Default)]
struct LocalCancellationState {
    registered_task_ids: BTreeSet<i64>,
    pending_task_ids: BTreeSet<i64>,
    pending_subtask_ids: BTreeSet<i64>,
    cancel_requested_task_ids: BTreeSet<i64>,
}

impl LocalCancellationRegistry {
    fn register_task(&self, request: &ExecutionRequest) {
        let mut state = self.inner.lock().expect("cancellation state lock");
        state.registered_task_ids.insert(request.task_id);
        let task_cancelled = state.pending_task_ids.remove(&request.task_id);
        let subtask_cancelled = state.pending_subtask_ids.remove(&request.subtask_id);
        if task_cancelled || subtask_cancelled {
            state.cancel_requested_task_ids.insert(request.task_id);
        }
    }

    fn cancel_task(&self, task_id: i64, subtask_id: Option<i64>) {
        let mut state = self.inner.lock().expect("cancellation state lock");
        if state.registered_task_ids.contains(&task_id) {
            state.cancel_requested_task_ids.insert(task_id);
        } else if let Some(subtask_id) = subtask_id {
            state.pending_subtask_ids.insert(subtask_id);
        } else {
            state.pending_task_ids.insert(task_id);
        }
    }

    fn is_cancel_requested(&self, task_id: i64, subtask_id: Option<i64>) -> bool {
        let state = self.inner.lock().expect("cancellation state lock");
        state.cancel_requested_task_ids.contains(&task_id)
            || state.pending_task_ids.contains(&task_id)
            || subtask_id.is_some_and(|subtask_id| state.pending_subtask_ids.contains(&subtask_id))
    }

    fn snapshot(&self) -> LocalCancellationSnapshot {
        let state = self.inner.lock().expect("cancellation state lock");
        LocalCancellationSnapshot {
            pending_task_ids: state.pending_task_ids.iter().copied().collect(),
            pending_subtask_ids: state.pending_subtask_ids.iter().copied().collect(),
            cancel_requested_task_ids: state.cancel_requested_task_ids.iter().copied().collect(),
        }
    }
}

#[derive(Clone)]
pub struct LocalBackendRunner<
    T,
    R = BackgroundTaskRunner<AgentProcessEngine, LocalBackendEventSink<T>>,
> where
    T: LocalBackendTransport,
    R: TaskRunner,
{
    client: LocalBackendClient<T>,
    runner: R,
    command_handler: Arc<dyn DeviceCommandHandler>,
    runtime_work_handler: Option<Arc<dyn RuntimeWorkHandler>>,
    cancellations: LocalCancellationRegistry,
}

impl<T> LocalBackendRunner<T>
where
    T: LocalBackendTransport,
{
    pub fn new(config: LocalBackendConfig, transport: T) -> Self {
        let client = LocalBackendClient::new(config, transport);
        let sink = LocalBackendEventSink::new(client.clone());
        let runner = BackgroundTaskRunner::new(
            AgentProcessEngine::new(AgentCommandPlanner::from_env()),
            sink,
        );
        Self::from_client_and_runner(client, runner)
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

    fn from_client_and_runner(client: LocalBackendClient<T>, runner: R) -> Self {
        Self {
            client,
            runner,
            command_handler: Arc::new(CommandHandler),
            runtime_work_handler: None,
            cancellations: LocalCancellationRegistry::default(),
        }
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
                    eprintln!(
                        "{}",
                        local_backend_connection_failure_log_line(
                            &self.client.config.backend_url,
                            &error
                        )
                    );
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
            .on(CHAT_MESSAGE_EVENT, self.task_handler());
        self.client
            .transport
            .on(DEVICE_EXECUTE_COMMAND_EVENT, self.device_command_handler());
        self.client
            .transport
            .on(RUNTIME_RPC_EVENT, self.runtime_rpc_handler());
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
        Arc::new(move |payload| {
            let cancellations = cancellations.clone();
            Box::pin(async move {
                let task_id = payload.get("task_id").and_then(Value::as_i64)?;
                let subtask_id = payload.get("subtask_id").and_then(Value::as_i64);
                cancellations.cancel_task(task_id, subtask_id);
                None
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

pub fn local_backend_connection_failure_log_line(backend_url: &str, error: &str) -> String {
    format_executor_log(
        "local backend connection failed",
        &[
            ("backend_url", backend_url.to_owned()),
            ("error", error.to_owned()),
        ],
    )
}

#[derive(Clone, Default)]
pub struct SocketIoTransport {
    client: Arc<tokio::sync::Mutex<Option<Client>>>,
    handlers: Arc<Mutex<Vec<(String, EventHandler)>>>,
}

impl LocalBackendTransport for SocketIoTransport {
    fn connect<'a>(&'a self, config: &'a LocalBackendConfig) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let handlers = self.handlers.lock().expect("handler lock").clone();
            let mut builder = ClientBuilder::new(config.backend_url.clone())
                .namespace(NAMESPACE)
                .auth(json!({ "token": config.auth_token }))
                .transport_type(TransportType::Websocket)
                .reconnect(true)
                .reconnect_on_disconnect(true)
                .reconnect_delay(
                    duration_to_millis(config.reconnect_delay),
                    duration_to_millis(config.reconnect_delay_max),
                )
                .on("error", |payload: Payload, _socket: Client| {
                    async move {
                        eprintln!("local backend socket error: {payload:?}");
                    }
                    .boxed()
                });

            for (event, handler) in handlers {
                builder = builder.on(event, move |payload: Payload, socket: Client| {
                    let handler = Arc::clone(&handler);
                    async move {
                        let ack_id = payload.ack_id();
                        let value = payload_to_value(payload);
                        let ack_payload = handler(value).await;
                        if let (Some(ack_id), Some(ack_payload)) = (ack_id, ack_payload) {
                            if let Err(error) = socket.ack_with_id(ack_id, ack_payload).await {
                                eprintln!("local backend socket ACK failed: {error}");
                            }
                        }
                    }
                    .boxed()
                });
            }

            let socket = builder.connect().await.map_err(|error| error.to_string())?;
            *self.client.lock().await = Some(socket);
            Ok(())
        })
    }

    fn disconnect<'a>(&'a self) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            if let Some(client) = self.client.lock().await.take() {
                client
                    .disconnect()
                    .await
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        })
    }

    fn call<'a>(
        &'a self,
        event: &'a str,
        payload: Value,
        timeout: Duration,
    ) -> TransportFuture<'a, Value> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .await
                .clone()
                .ok_or_else(|| "Socket.IO client is not connected".to_owned())?;
            let (sender, receiver) = oneshot::channel();
            let sender = Arc::new(Mutex::new(Some(sender)));
            let ack_sender = Arc::clone(&sender);

            client
                .emit_with_ack(
                    event.to_owned(),
                    payload,
                    timeout,
                    move |payload: Payload, _socket: Client| {
                        let ack_sender = Arc::clone(&ack_sender);
                        async move {
                            if let Some(sender) = ack_sender.lock().expect("ack lock").take() {
                                let _ = sender.send(payload_to_value(payload));
                            }
                        }
                        .boxed()
                    },
                )
                .await
                .map_err(|error| error.to_string())?;

            tokio::time::timeout(timeout, receiver)
                .await
                .map_err(|_| format!("{event} timed out"))?
                .map_err(|_| format!("{event} acknowledgment was dropped"))
        })
    }

    fn emit<'a>(&'a self, event: &'a str, payload: Value) -> TransportFuture<'a, ()> {
        Box::pin(async move {
            let client = self
                .client
                .lock()
                .await
                .clone()
                .ok_or_else(|| "Socket.IO client is not connected".to_owned())?;
            client
                .emit(event.to_owned(), payload)
                .await
                .map_err(|error| error.to_string())
        })
    }

    fn on(&self, event: &str, handler: EventHandler) {
        self.handlers
            .lock()
            .expect("handler lock")
            .push((event.to_owned(), handler));
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

fn build_capability_report() -> Value {
    let details = json!({
        "skills": [],
        "plugins": [],
        "mcps": [],
    });
    json!({
        "revision": 0,
        "digest": canonical_digest(&details),
        "full": true,
        "skills": [],
        "plugins": [],
        "mcps": [],
        "last_sync_at": null,
    })
}

fn canonical_digest(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity("sha256:".len() + digest.len() * 2);
    output.push_str("sha256:");
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
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

fn duration_to_millis(duration: Duration) -> u64 {
    duration.as_millis().try_into().unwrap_or(u64::MAX)
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

fn home_dir() -> PathBuf {
    env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[allow(deprecated)]
fn payload_to_value(payload: Payload) -> Value {
    match payload {
        Payload::Text(mut values, _) => {
            if values.len() == 1 {
                values.remove(0)
            } else {
                Value::Array(values)
            }
        }
        Payload::String(value, _) => serde_json::from_str(&value).unwrap_or(Value::String(value)),
        Payload::Binary(_, _) => Value::Null,
    }
}
