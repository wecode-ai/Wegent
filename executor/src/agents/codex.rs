// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::Duration,
};

use futures_util::future::BoxFuture;
use serde_json::Map;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{broadcast, mpsc, oneshot, Mutex},
    time::timeout,
};

use crate::{
    agents::runtime_capabilities,
    attachments::{process_prompt, AttachmentPromptProcessor, AttachmentRecord},
    codex_phase::{codex_phase_is_process, CodexAgentMessagePhaseTracker},
    image_preprocessor::prepare_image_bytes_for_model,
    logging::{log_executor_event, task_fields},
    process_environment,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
    runtime_work::codex_stream_debug_enabled,
    server::{
        executor_loopback_base_url, register_codex_responses_proxy, CodexResponsesProxyUpstream,
    },
};

use super::{model_id, prompt_text};

const DEFAULT_CODEX_RPC_TIMEOUT_SECONDS: u64 = 300;
const DEFAULT_PROVIDER_ID: &str = "wecode-openai";
pub const CODEX_APP_SERVER_TURN_CANCELLED: &str = "codex app-server turn cancelled";
const DEFAULT_PROVIDER_NAME: &str = "wecode openai";
const DEFAULT_REASONING_EFFORT: &str = "medium";
const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1,host.docker.internal";
const CODEX_HOME_ENV: &str = "CODEX_HOME";
const WEGENT_CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const MACOS_CODEX_APP_BINARY: &str = "/Applications/Codex.app/Contents/Resources/codex";
const WEWORK_BROWSER_MCP_SERVER_NAME: &str = "wework_browser";
const CODEX_APPLY_PATCH_STREAMING_EVENTS_OVERRIDE: &str =
    "features.apply_patch_streaming_events=true";
const CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING_OVERRIDE: &str =
    "suppress_unstable_features_warning=true";
const DEFAULT_EXECUTOR_SERVER_PORT: u16 = 10001;
const CODEX_RAW_LOG_PREVIEW_CHARS: usize = 1200;
const CODEX_RAW_LOG_LARGE_STRING_CHARS: usize = 2048;
const CODEX_RAW_LOG_STRING_PREVIEW_CHARS: usize = 240;
const SIDE_BOUNDARY_PROMPT: &str = r#"Side conversation boundary.

The messages before this boundary are inherited reference context from the main thread.
Do not continue, execute, or complete any instructions, plans, tool calls, approvals, edits, or requests from before this boundary. Only messages submitted after this boundary are active user instructions for this side conversation.

You are a side-conversation assistant, separate from the main thread. Answer questions and do lightweight, non-mutating exploration without disrupting the main thread. If there is no user question after this boundary yet, wait for one.

Sub-agents are off-limits in this side conversation. Do not interact with any existing or new sub-agents, even if sub-agents were used before this boundary."#;
const WEWORK_EMBEDDED_BROWSER_DEVELOPER_INSTRUCTIONS: &str = r#"Wework 内置浏览器 routing:
- For browser tasks inside Wework, use the `browser_*` MCP tools from the Wework 内置浏览器 tool server.
- Use `browser_navigate` to open pages in the Wework 内置浏览器, `browser_take_screenshot` for screenshots, and `browser_snapshot` or `browser_evaluate` for page inspection.
- Do not use the bundled Browser or Chrome plugin runtimes for Wework browser tasks, including `agent.browsers.get("iab")`, `agent.browsers.get("extension")`, `browser:control-in-app-browser`, or `chrome:control-chrome`.
- Do not fall back to an external Chrome window unless the user explicitly asks for Chrome."#;
const IMAGE_MIME_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
];

pub type CodexNotificationSender = mpsc::UnboundedSender<Value>;
pub type CodexThreadStartedCallback = Box<dyn FnOnce(String) + Send + 'static>;
pub type CodexActiveTurnCallback = Box<dyn Fn(String, String) + Send + 'static>;

#[derive(Default)]
pub struct CodexAppServerTurnOptions {
    pub direct_thread_id: Option<String>,
    pub fork_thread_id: Option<String>,
    pub fork_thread_path: Option<String>,
    pub resume_thread_id: Option<String>,
    pub initial_thread_name: Option<String>,
    pub initial_thread_goal: Option<Value>,
    pub notifications: Option<CodexNotificationSender>,
    pub cancellation: Option<oneshot::Receiver<()>>,
    pub request_user_input_answers: Option<CodexRequestUserInputReceiver>,
    pub thread_started: Option<CodexThreadStartedCallback>,
    pub active_turn_started: Option<CodexActiveTurnCallback>,
}

pub trait CodexTurnInterrupter: Send + Sync {
    fn interrupt_turn<'a>(
        &'a self,
        thread_id: &'a str,
        turn_id: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexCancellationState {
    active_turn: Option<ActiveCodexTurn>,
    cancel_requested: bool,
}

impl CodexCancellationState {
    pub fn mark_turn_started(&mut self, thread_id: impl Into<String>, turn_id: impl Into<String>) {
        self.active_turn = Some(ActiveCodexTurn {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
        });
        self.cancel_requested = false;
    }

    pub fn mark_turn_finished(&mut self) {
        self.active_turn = None;
    }

    pub fn cancel_requested(&self) -> bool {
        self.cancel_requested
    }

    pub fn consume_pending_cancel(&mut self) -> bool {
        let requested = self.cancel_requested;
        self.cancel_requested = false;
        requested
    }

    pub async fn cancel(&mut self, interrupter: &impl CodexTurnInterrupter) -> bool {
        let Some(active_turn) = self.active_turn.clone() else {
            self.cancel_requested = true;
            return true;
        };

        if interrupter
            .interrupt_turn(&active_turn.thread_id, &active_turn.turn_id)
            .await
            .is_ok()
        {
            self.cancel_requested = false;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveCodexTurn {
    thread_id: String,
    turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerTurn {
    pub thread_id: String,
    pub outcome: ExecutionOutcome,
}

pub type CodexRequestUserInputReceiver = mpsc::Receiver<Value>;

#[derive(Debug, Clone)]
pub struct CodexAppServerEngine {
    binary: String,
}

impl CodexAppServerEngine {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: resolve_codex_binary(&binary.into()),
        }
    }
}

impl AgentEngine for CodexAppServerEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let binary = self.binary.clone();
        Box::pin(async move {
            match run_codex_app_server_turn(&binary, request, None, None, None, None).await {
                Ok(turn) => turn.outcome,
                Err(message) => ExecutionOutcome::Failed { message },
            }
        })
    }
}

#[derive(Clone)]
pub struct CodexAppServerClient {
    binary: String,
    state: Arc<Mutex<CodexAppServerSharedState>>,
}

impl CodexAppServerClient {
    pub fn new(binary: impl Into<String>) -> Self {
        let binary = resolve_codex_binary(&binary.into());
        Self {
            state: shared_codex_app_server_state(&binary),
            binary,
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let timeout_seconds = codex_rpc_timeout_seconds();
        let (request_id, handle, response_rx) = self.prepare_request().await?;
        let message = json!({
            "method": method,
            "id": request_id,
            "params": params,
        });
        if let Err(error) = handle.write_message(message).await {
            handle.remove_pending(request_id).await;
            return Err(error);
        }

        with_rpc_timeout(method, timeout_seconds, async {
            response_rx
                .await
                .map_err(|_| "codex app-server response channel closed".to_owned())?
        })
        .await
    }

    async fn request_existing(&self, method: &str, params: Value) -> Result<Value, String> {
        let timeout_seconds = codex_rpc_timeout_seconds();
        let (request_id, handle, response_rx) = self.prepare_existing_request().await?;
        let message = json!({
            "method": method,
            "id": request_id,
            "params": params,
        });
        if let Err(error) = handle.write_message(message).await {
            handle.remove_pending(request_id).await;
            return Err(error);
        }

        with_rpc_timeout(method, timeout_seconds, async {
            response_rx
                .await
                .map_err(|_| "codex app-server response channel closed".to_owned())?
        })
        .await
    }

    pub async fn run_turn_with_cancel(
        &self,
        request: ExecutionRequest,
        options: CodexAppServerTurnOptions,
    ) -> Result<CodexAppServerTurn, String> {
        run_codex_app_server_turn_on_shared_client(self, request, options).await
    }

    pub async fn restart(&self) {
        self.state.lock().await.process = None;
    }

    pub async fn steer_turn(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        input: Value,
    ) -> Result<String, String> {
        let response = self
            .request_existing(
                "turn/steer",
                json!({
                    "threadId": thread_id,
                    "expectedTurnId": expected_turn_id,
                    "input": input,
                }),
            )
            .await?;
        string_value(&response, "turnId")
            .or_else(|| string_value(&response, "turn_id"))
            .ok_or_else(|| "turn/steer response missing turnId".to_owned())
    }

    async fn prepare_request(
        &self,
    ) -> Result<
        (
            u64,
            CodexAppServerHandle,
            oneshot::Receiver<Result<Value, String>>,
        ),
        String,
    > {
        self.prepare_request_with_process(true).await
    }

    async fn prepare_existing_request(
        &self,
    ) -> Result<
        (
            u64,
            CodexAppServerHandle,
            oneshot::Receiver<Result<Value, String>>,
        ),
        String,
    > {
        self.prepare_request_with_process(false).await
    }

    async fn prepare_request_with_process(
        &self,
        start_if_missing: bool,
    ) -> Result<
        (
            u64,
            CodexAppServerHandle,
            oneshot::Receiver<Result<Value, String>>,
        ),
        String,
    > {
        let mut state = self.state.lock().await;
        if state
            .process
            .as_mut()
            .is_some_and(|process| process.has_exited())
        {
            state.process = None;
        }
        if state.process.is_none() {
            if !start_if_missing {
                return Err("codex app-server is not running".to_owned());
            }
            let (process, next_id) = start_persistent_codex_app_server(
                &self.binary,
                state.next_id,
                &CodexLaunchConfig::default(),
            )
            .await?;
            state.process = Some(process);
            state.next_id = next_id;
        }

        let request_id = state.next_id;
        state.next_id += 1;
        let handle = state
            .process
            .as_ref()
            .expect("persistent Codex app-server should be initialized")
            .handle();
        let (tx, rx) = oneshot::channel();
        handle.pending.lock().await.insert(request_id, tx);
        Ok((request_id, handle, rx))
    }

    async fn send_response(&self, request_id: u64, result: Value) -> Result<(), String> {
        let handle = self.existing_process().await?;
        handle
            .write_message(json!({
                "id": request_id,
                "result": result,
            }))
            .await
    }

    pub(crate) async fn subscribe_notifications(
        &self,
    ) -> Result<broadcast::Receiver<Value>, String> {
        Ok(self.ensure_process().await?.notifications.subscribe())
    }

    async fn subscribe_notifications_for_launch_config(
        &self,
        launch_config: &CodexLaunchConfig,
    ) -> Result<broadcast::Receiver<Value>, String> {
        Ok(self
            .ensure_process_for_launch_config(launch_config)
            .await?
            .notifications
            .subscribe())
    }

    async fn existing_process(&self) -> Result<CodexAppServerHandle, String> {
        let mut state = self.state.lock().await;
        if state
            .process
            .as_mut()
            .is_some_and(|process| process.has_exited())
        {
            state.process = None;
        }
        Ok(state
            .process
            .as_ref()
            .ok_or_else(|| "codex app-server is not running".to_owned())?
            .handle())
    }

    async fn mark_thread_active(&self, thread_id: &str) {
        self.state
            .lock()
            .await
            .active_threads
            .insert(thread_id.to_owned());
    }

    async fn mark_thread_idle(&self, thread_id: &str) {
        self.state.lock().await.active_threads.remove(thread_id);
    }

    async fn unscoped_notification_belongs_to_thread(&self, thread_id: &str) -> bool {
        let state = self.state.lock().await;
        state.active_threads.len() == 1 && state.active_threads.contains(thread_id)
    }

    async fn ensure_process(&self) -> Result<CodexAppServerHandle, String> {
        let mut state = self.state.lock().await;
        if state
            .process
            .as_mut()
            .is_some_and(|process| process.has_exited())
        {
            state.process = None;
        }
        if state.process.is_none() {
            let (process, next_id) = start_persistent_codex_app_server(
                &self.binary,
                state.next_id,
                &CodexLaunchConfig::default(),
            )
            .await?;
            state.process = Some(process);
            state.next_id = next_id;
        }
        Ok(state
            .process
            .as_ref()
            .expect("persistent Codex app-server should be initialized")
            .handle())
    }

    async fn ensure_process_for_launch_config(
        &self,
        launch_config: &CodexLaunchConfig,
    ) -> Result<CodexAppServerHandle, String> {
        let mut state = self.state.lock().await;
        if state
            .process
            .as_mut()
            .is_some_and(|process| process.has_exited())
        {
            state.process = None;
        }
        if state.process.is_none() {
            let (process, next_id) =
                start_persistent_codex_app_server(&self.binary, state.next_id, launch_config)
                    .await?;
            state.process = Some(process);
            state.next_id = next_id;
        }
        Ok(state
            .process
            .as_ref()
            .expect("persistent Codex app-server should be initialized")
            .handle())
    }
}

fn shared_codex_app_server_state(binary: &str) -> Arc<Mutex<CodexAppServerSharedState>> {
    static STATES: OnceLock<StdMutex<HashMap<String, Arc<Mutex<CodexAppServerSharedState>>>>> =
        OnceLock::new();
    let states = STATES.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut states = states
        .lock()
        .expect("Codex app-server shared state registry should not be poisoned");
    states
        .entry(binary.to_owned())
        .or_insert_with(|| Arc::new(Mutex::new(CodexAppServerSharedState::default())))
        .clone()
}

#[allow(dead_code)]
fn codex_app_server_request_is_retryable(method: &str) -> bool {
    matches!(
        method,
        "thread/list" | "thread/read" | "config/read" | "model/list"
    )
}

struct CodexAppServerSharedState {
    process: Option<CodexAppServerProcess>,
    next_id: u64,
    active_threads: HashSet<String>,
}

impl Default for CodexAppServerSharedState {
    fn default() -> Self {
        Self {
            process: None,
            next_id: 1,
            active_threads: HashSet::new(),
        }
    }
}

type PendingCodexResponse = oneshot::Sender<Result<Value, String>>;

struct CodexAppServerProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, PendingCodexResponse>>>,
    notifications: broadcast::Sender<Value>,
    reader_task: tokio::task::JoinHandle<()>,
}

impl CodexAppServerProcess {
    fn handle(&self) -> CodexAppServerHandle {
        CodexAppServerHandle {
            stdin: Arc::clone(&self.stdin),
            pending: Arc::clone(&self.pending),
            notifications: self.notifications.clone(),
        }
    }

    fn has_exited(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(Some(_)))
    }
}

impl Drop for CodexAppServerProcess {
    fn drop(&mut self) {
        self.reader_task.abort();
        signal_codex_app_server_child(&mut self.child);
    }
}

#[derive(Clone)]
struct CodexAppServerHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, PendingCodexResponse>>>,
    notifications: broadcast::Sender<Value>,
}

impl CodexAppServerHandle {
    async fn write_message(&self, message: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&message)
            .map_err(|error| format!("failed to encode codex JSON-RPC message: {error}"))?;
        line.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("failed to write codex JSON-RPC message: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex JSON-RPC message: {error}"))
    }

    async fn remove_pending(&self, request_id: u64) {
        self.pending.lock().await.remove(&request_id);
    }
}

async fn start_persistent_codex_app_server(
    binary: &str,
    next_id: u64,
    request_launch_config: &CodexLaunchConfig,
) -> Result<(CodexAppServerProcess, u64), String> {
    let launch_config = persistent_codex_app_server_launch_config(request_launch_config);
    let mut child = spawn_codex_app_server(binary, &launch_config)?;
    let result: Result<(ChildStdin, BufReader<ChildStdout>, u64), String> = async {
        let timeout_seconds = codex_rpc_timeout_seconds();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin was not captured".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout was not captured".to_owned())?;
        let mut rpc = JsonRpcConnection::new_with_next_id(stdin, stdout, next_id);
        with_rpc_timeout(
            "initialize",
            timeout_seconds,
            rpc.request_ignoring_notifications("initialize", initialize_params()),
        )
        .await?;
        with_rpc_timeout(
            "initialized",
            timeout_seconds,
            rpc.notify("initialized", json!({})),
        )
        .await?;
        Ok((rpc.stdin, rpc.stdout, rpc.next_id))
    }
    .await;

    match result {
        Ok((stdin, stdout, next_id)) => {
            let pending = Arc::new(Mutex::new(HashMap::new()));
            let (notifications, _) = broadcast::channel(2048);
            let reader_task = tokio::spawn(read_persistent_codex_app_server_stdout(
                stdout,
                Arc::clone(&pending),
                notifications.clone(),
            ));
            Ok((
                CodexAppServerProcess {
                    child,
                    stdin: Arc::new(Mutex::new(stdin)),
                    pending,
                    notifications,
                    reader_task,
                },
                next_id,
            ))
        }
        Err(error) => {
            terminate_codex_app_server_child(&mut child).await;
            Err(error)
        }
    }
}

fn persistent_codex_app_server_launch_config(
    request_launch_config: &CodexLaunchConfig,
) -> CodexLaunchConfig {
    let mut launch_config = CodexLaunchConfig {
        env: request_launch_config.env.clone(),
        ..CodexLaunchConfig::default()
    };
    launch_config.config_overrides.push("goals=true".to_owned());
    launch_config
}

async fn read_persistent_codex_app_server_stdout(
    mut stdout: BufReader<ChildStdout>,
    pending: Arc<Mutex<HashMap<u64, PendingCodexResponse>>>,
    notifications: broadcast::Sender<Value>,
) {
    loop {
        let mut line = String::new();
        let message = match stdout.read_line(&mut line).await {
            Ok(0) => {
                notify_shared_process_closed(
                    &notifications,
                    "codex app-server exited while shared process was running",
                );
                fail_all_pending(
                    &pending,
                    "codex app-server exited while shared process was running".to_owned(),
                )
                .await;
                break;
            }
            Ok(_) => match serde_json::from_str::<Value>(&line) {
                Ok(message) => message,
                Err(error) => {
                    notify_shared_process_closed(
                        &notifications,
                        &format!("failed to parse codex JSON-RPC message: {error}"),
                    );
                    fail_all_pending(
                        &pending,
                        format!("failed to parse codex JSON-RPC message: {error}"),
                    )
                    .await;
                    break;
                }
            },
            Err(error) => {
                notify_shared_process_closed(
                    &notifications,
                    &format!("failed to read codex JSON-RPC message: {error}"),
                );
                fail_all_pending(
                    &pending,
                    format!("failed to read codex JSON-RPC message: {error}"),
                )
                .await;
                break;
            }
        };

        if is_json_rpc_response(&message) {
            if let Some(request_id) = response_id(&message) {
                if let Some(sender) = pending.lock().await.remove(&request_id) {
                    let _ = sender.send(response_result(message));
                    continue;
                }
            }
        }

        let _ = notifications.send(message);
    }
}

fn notify_shared_process_closed(notifications: &broadcast::Sender<Value>, message: &str) {
    let _ = notifications.send(json!({
        "method": "codex/app-server/exited",
        "params": {
            "message": message,
        }
    }));
}

async fn fail_all_pending(
    pending: &Arc<Mutex<HashMap<u64, PendingCodexResponse>>>,
    message: String,
) {
    let pending = std::mem::take(&mut *pending.lock().await);
    for (_, sender) in pending {
        let _ = sender.send(Err(message.clone()));
    }
}

fn is_json_rpc_response(message: &Value) -> bool {
    response_id(message).is_some() && message.get("method").is_none()
}

pub async fn run_codex_app_server_turn(
    binary: &str,
    request: ExecutionRequest,
    resume_thread_id: Option<String>,
    initial_thread_name: Option<String>,
    initial_thread_goal: Option<Value>,
    notifications: Option<CodexNotificationSender>,
) -> Result<CodexAppServerTurn, String> {
    run_codex_app_server_turn_with_cancel(
        binary,
        request,
        CodexAppServerTurnOptions {
            resume_thread_id,
            initial_thread_name,
            initial_thread_goal,
            notifications,
            ..CodexAppServerTurnOptions::default()
        },
    )
    .await
}

async fn run_codex_app_server_turn_on_shared_client(
    client: &CodexAppServerClient,
    request: ExecutionRequest,
    options: CodexAppServerTurnOptions,
) -> Result<CodexAppServerTurn, String> {
    let prepared = prepare_codex_execution_request(request);
    let CodexAppServerTurnOptions {
        direct_thread_id,
        fork_thread_id,
        fork_thread_path,
        resume_thread_id,
        initial_thread_name,
        initial_thread_goal,
        notifications,
        cancellation,
        request_user_input_answers,
        thread_started,
        active_turn_started,
    } = options;
    let launch_config = build_codex_launch_config(&prepared.request);
    let mut fields = task_fields(&prepared.request.task_id, &prepared.request.subtask_id);
    fields.push(("binary", client.binary.clone()));
    if let Some(cwd) = prepared.request.cwd() {
        fields.push(("cwd", cwd.to_owned()));
    }
    log_executor_event("codex shared app-server turn starting", &fields);

    let result: Result<CodexAppServerTurn, String> = async {
        let request = &prepared.request;
        let mut notification_rx = client
            .subscribe_notifications_for_launch_config(&launch_config)
            .await?;
        let mut state = CodexRunState::default();
        let direct_thread_id = direct_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|thread_id| !thread_id.is_empty())
            .map(str::to_owned);
        let resuming_thread = resume_thread_id.is_some();
        let forking_thread = fork_thread_id.is_some();
        let thread_id = if let Some(thread_id) = direct_thread_id {
            state.set_root_thread_id(thread_id.clone());
            let mut thread_fields = task_fields(&request.task_id, &request.subtask_id);
            thread_fields.push(("operation", "thread/direct".to_owned()));
            thread_fields.push(("thread_id", thread_id.clone()));
            log_executor_event("codex shared thread request skipped", &thread_fields);
            thread_id
        } else {
            let (thread_operation, thread_params) = if let Some(thread_id) = fork_thread_id {
                (
                    "thread/fork",
                    thread_fork_params(
                        &thread_id,
                        fork_thread_path.as_deref(),
                        request,
                        &launch_config,
                    ),
                )
            } else if let Some(thread_id) = resume_thread_id {
                (
                    "thread/resume",
                    thread_resume_params(&thread_id, request, &launch_config),
                )
            } else {
                ("thread/start", thread_start_params(request, &launch_config))
            };
            let mut thread_fields = task_fields(&request.task_id, &request.subtask_id);
            thread_fields.push(("operation", thread_operation.to_owned()));
            log_executor_event("codex shared thread request started", &thread_fields);
            let thread = client.request(thread_operation, thread_params).await?;
            let thread_id = thread
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!("codex app-server {thread_operation} did not return thread.id")
                })?
                .to_owned();
            state.set_root_thread_id(thread_id.clone());
            thread_fields.push(("thread_id", thread_id.clone()));
            log_executor_event("codex shared thread request finished", &thread_fields);
            thread_id
        };
        if let Some(callback) = thread_started {
            callback(thread_id.clone());
        }
        if let Some(sender) = &notifications {
            let _ = sender.send(json!({
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": thread_id.clone()
                    }
                }
            }));
        }
        if forking_thread && request.ephemeral {
            client
                .request(
                    "thread/inject_items",
                    side_boundary_inject_params(&thread_id),
                )
                .await?;
        }

        let mut goal_run_active = false;
        if !request.ephemeral {
            if let Some(goal) = initial_thread_goal.as_ref() {
                let goal_params = thread_goal_set_params(&thread_id, goal)?;
                let goal_response = client.request("thread/goal/set", goal_params).await?;
                if goal_response_goal_is_active(&goal_response) {
                    goal_run_active = true;
                    state.set_goal_status("active");
                }
            } else if resuming_thread {
                if let Ok(goal_response) = client
                    .request("thread/goal/get", json!({"threadId": thread_id.clone()}))
                    .await
                {
                    if goal_response_goal_is_active(&goal_response) {
                        goal_run_active = true;
                        state.set_goal_status("active");
                    }
                }
            }

            if let Some(name) = initial_thread_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                client
                    .request(
                        "thread/name/set",
                        json!({"threadId": thread_id.clone(), "name": name}),
                    )
                    .await?;
            }
        }

        let turn_input = turn_input(&request.prompt);
        let mut turn_fields = task_fields(&request.task_id, &request.subtask_id);
        turn_fields.push(("thread_id", thread_id.clone()));
        turn_fields.push(("input_items", turn_input.len().to_string()));
        turn_fields.push(("prompt_len", prompt_text(&request.prompt).len().to_string()));
        if let Some(cwd) = request.cwd() {
            turn_fields.push(("cwd", cwd.to_owned()));
        }
        if let Some(model) = model_id(request) {
            turn_fields.push(("model", model));
        }
        log_executor_event("codex shared turn request started", &turn_fields);
        client.mark_thread_active(&thread_id).await;
        let turn = match client
            .request(
                "turn/start",
                turn_start_params(&thread_id, request, &launch_config, turn_input),
            )
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                client.mark_thread_idle(&thread_id).await;
                return Err(error);
            }
        };
        let active_turn_id = turn_start_response_turn_id(&turn);
        if let (Some(turn_id), Some(callback)) =
            (active_turn_id.as_deref(), active_turn_started.as_ref())
        {
            callback(thread_id.clone(), turn_id.to_owned());
        }
        let outcome_result = read_shared_turn_notifications(
            client,
            &mut notification_rx,
            &thread_id,
            &mut state,
            SharedTurnNotificationOptions {
                active_turn_id,
                notifications,
                cancellation,
                request_user_input_answers,
                goal_run_active,
                active_turn_started,
            },
        )
        .await;
        client.mark_thread_idle(&thread_id).await;
        let outcome = outcome_result?;
        turn_fields.push(("outcome", codex_outcome_name(&outcome).to_owned()));
        if let ExecutionOutcome::Failed { message } = &outcome {
            turn_fields.push(("error", message.clone()));
            turn_fields.push(("error_len", message.len().to_string()));
        }
        log_executor_event("codex shared turn request finished", &turn_fields);
        Ok(CodexAppServerTurn { thread_id, outcome })
    }
    .await;

    if let Err(error) = &result {
        let mut failed_fields = fields.clone();
        failed_fields.push(("error", error.clone()));
        failed_fields.push(("error_len", error.len().to_string()));
        log_executor_event("codex shared app-server turn failed", &failed_fields);
    }
    cleanup_generated_files(&prepared.generated_files);
    result
}

pub async fn run_codex_app_server_turn_with_cancel(
    binary: &str,
    request: ExecutionRequest,
    options: CodexAppServerTurnOptions,
) -> Result<CodexAppServerTurn, String> {
    let prepared = prepare_codex_execution_request(request);
    let CodexAppServerTurnOptions {
        direct_thread_id,
        fork_thread_id,
        fork_thread_path,
        resume_thread_id,
        initial_thread_name,
        initial_thread_goal,
        notifications,
        mut cancellation,
        request_user_input_answers,
        ..
    } = options;
    let launch_config = build_codex_launch_config(&prepared.request);
    let mut fields = task_fields(&prepared.request.task_id, &prepared.request.subtask_id);
    fields.push(("binary", resolve_codex_binary(binary)));
    if let Some(cwd) = prepared.request.cwd() {
        fields.push(("cwd", cwd.to_owned()));
    }
    log_executor_event("codex app-server starting", &fields);
    let mut child = match spawn_codex_app_server(binary, &launch_config) {
        Ok(child) => {
            log_executor_event("codex app-server started", &fields);
            child
        }
        Err(error) => {
            let mut failed_fields = fields.clone();
            failed_fields.push(("error_len", error.len().to_string()));
            log_executor_event("codex app-server failed to start", &failed_fields);
            cleanup_generated_files(&prepared.generated_files);
            return Err(error);
        }
    };

    let result: Result<CodexAppServerTurn, String> = async {
        let timeout_seconds = codex_rpc_timeout_seconds();
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex app-server stdin was not captured".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex app-server stdout was not captured".to_owned())?;
        let mut rpc = JsonRpcConnection::new(stdin, stdout);
        let mut state = CodexRunState::default();

        with_rpc_timeout(
            "initialize",
            timeout_seconds,
            rpc.request("initialize", initialize_params(), &mut state),
        )
        .await?;
        with_rpc_timeout(
            "initialized",
            timeout_seconds,
            rpc.notify("initialized", json!({})),
        )
        .await?;

        let request = &prepared.request;
        let direct_thread_id = direct_thread_id
            .as_deref()
            .map(str::trim)
            .filter(|thread_id| !thread_id.is_empty())
            .map(str::to_owned);
        let forking_thread = fork_thread_id.is_some();
        let thread_id = if let Some(thread_id) = direct_thread_id {
            state.set_root_thread_id(thread_id.clone());
            let mut thread_fields = task_fields(&request.task_id, &request.subtask_id);
            thread_fields.push(("operation", "thread/direct".to_owned()));
            thread_fields.push(("thread_id", thread_id.clone()));
            log_executor_event("codex thread request skipped", &thread_fields);
            thread_id
        } else {
            let (thread_operation, thread_params) = if let Some(thread_id) = fork_thread_id {
                (
                    "thread/fork",
                    thread_fork_params(
                        &thread_id,
                        fork_thread_path.as_deref(),
                        request,
                        &launch_config,
                    ),
                )
            } else if let Some(thread_id) = resume_thread_id {
                (
                    "thread/resume",
                    thread_resume_params(&thread_id, request, &launch_config),
                )
            } else {
                ("thread/start", thread_start_params(request, &launch_config))
            };
            let mut thread_fields = task_fields(&request.task_id, &request.subtask_id);
            thread_fields.push(("operation", thread_operation.to_owned()));
            log_executor_event("codex thread request started", &thread_fields);
            let thread = with_rpc_timeout(
                thread_operation,
                timeout_seconds,
                rpc.request(thread_operation, thread_params, &mut state),
            )
            .await?;
            let thread_id = thread
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    format!("codex app-server {thread_operation} did not return thread.id")
                })?
                .to_owned();
            state.set_root_thread_id(thread_id.clone());
            thread_fields.push(("thread_id", thread_id.clone()));
            log_executor_event("codex thread request finished", &thread_fields);
            thread_id
        };
        if let Some(sender) = &notifications {
            let _ = sender.send(json!({
                "method": "thread/started",
                "params": {
                    "thread": {
                        "id": thread_id.clone()
                    }
                }
            }));
        }
        if forking_thread && request.ephemeral {
            with_rpc_timeout(
                "thread/inject_items",
                timeout_seconds,
                rpc.request(
                    "thread/inject_items",
                    side_boundary_inject_params(&thread_id),
                    &mut state,
                ),
            )
            .await?;
        }
        if !request.ephemeral {
            if let Some(goal) = initial_thread_goal.as_ref() {
                let goal_params = thread_goal_set_params(&thread_id, goal)?;
                with_rpc_timeout(
                    "thread/goal/set",
                    timeout_seconds,
                    rpc.request("thread/goal/set", goal_params, &mut state),
                )
                .await?;
            }
            if let Some(name) = initial_thread_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
            {
                with_rpc_timeout(
                    "thread/name/set",
                    timeout_seconds,
                    rpc.request(
                        "thread/name/set",
                        json!({"threadId": thread_id.clone(), "name": name}),
                        &mut state,
                    ),
                )
                .await?;
            }
        }

        let turn_input = turn_input(&request.prompt);
        let mut turn_fields = task_fields(&request.task_id, &request.subtask_id);
        turn_fields.push(("thread_id", thread_id.clone()));
        turn_fields.push(("input_items", turn_input.len().to_string()));
        turn_fields.push(("prompt_len", prompt_text(&request.prompt).len().to_string()));
        if let Some(cwd) = request.cwd() {
            turn_fields.push(("cwd", cwd.to_owned()));
        }
        if let Some(model) = model_id(request) {
            turn_fields.push(("model", model));
        }
        log_executor_event("codex turn request started", &turn_fields);
        let turn_request_id = with_rpc_timeout(
            "turn/start",
            timeout_seconds,
            rpc.send_request(
                "turn/start",
                turn_start_params(&thread_id, request, &launch_config, turn_input),
            ),
        )
        .await?;
        let outcome = if let Some(cancellation) = cancellation.as_mut() {
            tokio::select! {
                outcome = rpc.read_turn(
                    turn_request_id,
                    &mut state,
                    notifications,
                    request_user_input_answers,
                ) => outcome?,
                _ = cancellation => return Err(CODEX_APP_SERVER_TURN_CANCELLED.to_owned()),
            }
        } else {
            rpc.read_turn(
                turn_request_id,
                &mut state,
                notifications,
                request_user_input_answers,
            )
            .await?
        };
        turn_fields.push(("outcome", codex_outcome_name(&outcome).to_owned()));
        if let ExecutionOutcome::Failed { message } = &outcome {
            turn_fields.push(("error", message.clone()));
            turn_fields.push(("error_len", message.len().to_string()));
        }
        log_executor_event("codex turn request finished", &turn_fields);
        Ok(CodexAppServerTurn { thread_id, outcome })
    }
    .await;

    terminate_codex_app_server_child(&mut child).await;
    if let Err(error) = &result {
        let mut failed_fields = fields.clone();
        failed_fields.push(("error", error.clone()));
        failed_fields.push(("error_len", error.len().to_string()));
        log_executor_event("codex app-server request failed", &failed_fields);
    }
    log_executor_event("codex app-server stopped", &fields);
    cleanup_generated_files(&prepared.generated_files);
    result
}

fn codex_outcome_name(outcome: &ExecutionOutcome) -> &'static str {
    match outcome {
        ExecutionOutcome::Completed { .. } => "completed",
        ExecutionOutcome::WaitingForUserInput { .. } => "waiting_for_user_input",
        ExecutionOutcome::Failed { .. } => "failed",
        ExecutionOutcome::Running => "running",
        ExecutionOutcome::Cancelled { .. } => "cancelled",
    }
}

struct SharedTurnNotificationOptions {
    active_turn_id: Option<String>,
    notifications: Option<CodexNotificationSender>,
    cancellation: Option<oneshot::Receiver<()>>,
    request_user_input_answers: Option<CodexRequestUserInputReceiver>,
    goal_run_active: bool,
    active_turn_started: Option<CodexActiveTurnCallback>,
}

async fn read_shared_turn_notifications(
    client: &CodexAppServerClient,
    notification_rx: &mut broadcast::Receiver<Value>,
    thread_id: &str,
    state: &mut CodexRunState,
    mut options: SharedTurnNotificationOptions,
) -> Result<ExecutionOutcome, String> {
    let mut cancel_requested = false;
    let mut last_outcome: Option<ExecutionOutcome> = None;
    loop {
        let notification = if let Some(cancel_rx) = options.cancellation.as_mut() {
            tokio::select! {
                _ = cancel_rx => {
                    options.cancellation = None;
                    cancel_requested = true;
                    if let Some(turn_id) = options.active_turn_id.as_deref() {
                        interrupt_shared_turn(client, thread_id, turn_id).await?;
                    }
                    continue;
                }
                message = notification_rx.recv() => shared_notification_result(message, last_outcome.clone())?,
            }
        } else {
            shared_notification_result(notification_rx.recv().await, last_outcome.clone())?
        };
        let message = match notification {
            SharedNotification::Message(message) => message,
            SharedNotification::Completed(outcome) => return Ok(outcome),
        };
        if message.get("method").and_then(Value::as_str) == Some("codex/app-server/exited") {
            if let Some(outcome) = last_outcome {
                return Ok(outcome);
            }
            return Err(message
                .get("params")
                .and_then(|params| params.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("codex app-server exited before completing the turn")
                .to_owned());
        }

        if !notification_belongs_to_thread(client, &message, thread_id).await {
            continue;
        }
        log_codex_raw_turn_message(&message);

        if let Some(turn_id) = turn_started_notification_turn_id(&message) {
            if options.active_turn_id.as_deref() != Some(turn_id.as_str()) {
                if let Some(callback) = options.active_turn_started.as_ref() {
                    callback(thread_id.to_owned(), turn_id.clone());
                }
            }
            options.active_turn_id = Some(turn_id);
            if cancel_requested {
                if let Some(turn_id) = options.active_turn_id.as_deref() {
                    interrupt_shared_turn(client, thread_id, turn_id).await?;
                }
            }
        }

        if let Some(sender) = &options.notifications {
            let _ = sender.send(message.clone());
        }

        if message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method == "item/tool/requestUserInput")
        {
            answer_shared_request_user_input(
                client,
                &message,
                &mut options.request_user_input_answers,
            )
            .await?;
            continue;
        }

        if let Some(outcome) = state.handle_message(&message) {
            options.active_turn_id = None;
            if !matches!(outcome, ExecutionOutcome::Completed { .. }) {
                return Ok(outcome);
            }
            if !options.goal_run_active || !state.goal_is_active() {
                return Ok(outcome);
            }
            last_outcome = Some(outcome);
            state.reset_turn_output();
        }
    }
}

enum SharedNotification {
    Message(Value),
    Completed(ExecutionOutcome),
}

fn shared_notification_result(
    result: Result<Value, broadcast::error::RecvError>,
    last_outcome: Option<ExecutionOutcome>,
) -> Result<SharedNotification, String> {
    match result {
        Ok(message) => Ok(SharedNotification::Message(message)),
        Err(broadcast::error::RecvError::Lagged(_)) => {
            Err("codex app-server notification stream lagged".to_owned())
        }
        Err(broadcast::error::RecvError::Closed) => last_outcome
            .map(SharedNotification::Completed)
            .ok_or_else(|| {
                "codex app-server notification stream closed before completing the turn".to_owned()
            }),
    }
}

async fn interrupt_shared_turn(
    client: &CodexAppServerClient,
    thread_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    client
        .request_existing(
            "turn/interrupt",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .await
        .map(|_| ())
}

async fn answer_shared_request_user_input(
    client: &CodexAppServerClient,
    message: &Value,
    request_user_input_answers: &mut Option<CodexRequestUserInputReceiver>,
) -> Result<(), String> {
    let request_id = response_id(message)
        .ok_or_else(|| "request_user_input message is missing JSON-RPC id".to_owned())?;
    let Some(receiver) = request_user_input_answers else {
        return Err("request_user_input requires a runtime response channel".to_owned());
    };
    let response = receiver
        .recv()
        .await
        .ok_or_else(|| "request_user_input response channel closed".to_owned())?;
    client
        .send_response(request_id, request_user_input_result(response))
        .await
}

async fn notification_belongs_to_thread(
    client: &CodexAppServerClient,
    message: &Value,
    thread_id: &str,
) -> bool {
    match stream_thread_id(message_params(message)).or_else(|| stream_thread_id(message)) {
        Some(message_thread_id) => message_thread_id == thread_id,
        None => {
            client
                .unscoped_notification_belongs_to_thread(thread_id)
                .await
        }
    }
}

fn turn_start_response_turn_id(response: &Value) -> Option<String> {
    response
        .get("turn")
        .and_then(|turn| string_value(turn, "id"))
        .or_else(|| string_value(response, "turnId"))
        .or_else(|| string_value(response, "turn_id"))
}

fn turn_started_notification_turn_id(message: &Value) -> Option<String> {
    if message.get("method").and_then(Value::as_str) != Some("turn/started") {
        return None;
    }
    let params = message_params(message);
    params
        .get("turn")
        .and_then(|turn| string_value(turn, "id"))
        .or_else(|| string_value(params, "turnId"))
        .or_else(|| string_value(params, "turn_id"))
}

fn goal_response_goal_is_active(response: &Value) -> bool {
    response
        .get("goal")
        .and_then(|goal| goal.get("status"))
        .and_then(Value::as_str)
        .is_some_and(|status| status.eq_ignore_ascii_case("active"))
}

fn string_value(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn spawn_codex_app_server(
    binary: &str,
    launch_config: &CodexLaunchConfig,
) -> Result<tokio::process::Child, String> {
    let resolved_binary = resolve_codex_binary(binary);
    let codex_home = wework_codex_home();
    prepare_wework_codex_home(&codex_home)?;
    let mut command = Command::new(&resolved_binary);
    for config_override in &launch_config.config_overrides {
        command.arg("-c").arg(config_override);
    }
    command.arg("app-server").arg("--stdio");
    for (key, value) in &launch_config.env {
        command.env(key, value);
    }
    command.env(CODEX_HOME_ENV, &codex_home);
    command.env(
        "PATH",
        process_environment::normalized_process_path(
            env::var("PATH").ok().as_deref().unwrap_or_default(),
        ),
    );
    configure_codex_app_server_process_group(&mut command);
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start codex app-server: {error}"))
}

fn wework_codex_home() -> PathBuf {
    env::var_os(WEGENT_CODEX_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| executor_home().join("codex"))
}

fn prepare_wework_codex_home(codex_home: &Path) -> Result<(), String> {
    fs::create_dir_all(codex_home).map_err(|error| {
        format!(
            "failed to create Codex home {}: {error}",
            codex_home.display()
        )
    })?;
    link_user_codex_auth(codex_home)
}

fn link_user_codex_auth(codex_home: &Path) -> Result<(), String> {
    let target = codex_home.join("auth.json");
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() && !target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove stale Codex auth link {}: {error}",
                    target.display()
                )
            })?;
        } else {
            return Ok(());
        }
    }
    let Some(source) = user_codex_auth_path().filter(|path| path.is_file()) else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target).map_err(|error| {
            format!(
                "failed to link Codex auth {} -> {}: {error}",
                target.display(),
                source.display()
            )
        })
    }
    #[cfg(not(unix))]
    {
        fs::copy(&source, &target).map(|_| ()).map_err(|error| {
            format!(
                "failed to copy Codex auth {} -> {}: {error}",
                source.display(),
                target.display()
            )
        })
    }
}

fn user_codex_auth_path() -> Option<PathBuf> {
    env::var_os(CODEX_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|home| home.join("auth.json"))
        .or_else(|| {
            env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .map(|home| home.join(".codex").join("auth.json"))
        })
}

#[cfg(test)]
fn unique_test_path(prefix: &str) -> PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    env::temp_dir().join(format!("{prefix}-{}-{id}", std::process::id()))
}

#[cfg(test)]
struct EnvRestore {
    key: &'static str,
    value: Option<std::ffi::OsString>,
}

#[cfg(test)]
impl EnvRestore {
    fn capture(key: &'static str) -> Self {
        Self {
            key,
            value: env::var_os(key),
        }
    }
}

#[cfg(test)]
impl Drop for EnvRestore {
    fn drop(&mut self) {
        restore_env(self.key, self.value.clone());
    }
}

#[cfg(test)]
fn restore_env(key: &'static str, value: Option<std::ffi::OsString>) {
    if let Some(value) = value {
        env::set_var(key, value);
    } else {
        env::remove_var(key);
    }
}

#[cfg(unix)]
fn configure_codex_app_server_process_group(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if libc::setpgid(0, 0) == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn configure_codex_app_server_process_group(_command: &mut Command) {}

async fn terminate_codex_app_server_child(child: &mut Child) {
    signal_codex_app_server_child(child);
    let _ = child.wait().await;
}

fn signal_codex_app_server_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    #[cfg(unix)]
    if let Some(process_group_id) = child.id() {
        unsafe {
            let _ = libc::kill(-(process_group_id as libc::pid_t), libc::SIGTERM);
            let _ = libc::kill(-(process_group_id as libc::pid_t), libc::SIGKILL);
        }
        return;
    }

    let _ = child.start_kill();
}

async fn with_rpc_timeout<T>(
    operation: &str,
    timeout_seconds: u64,
    future: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match timeout(Duration::from_secs(timeout_seconds), future).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "codex app-server {operation} timed out after {timeout_seconds}s"
        )),
    }
}

fn codex_rpc_timeout_seconds() -> u64 {
    env::var("WEGENT_CODEX_RPC_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_CODEX_RPC_TIMEOUT_SECONDS)
}

struct JsonRpcConnection {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl JsonRpcConnection {
    fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self::new_with_next_id(stdin, stdout, 1)
    }

    fn new_with_next_id(stdin: ChildStdin, stdout: ChildStdout, next_id: u64) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            next_id,
        }
    }

    async fn request(
        &mut self,
        method: &str,
        request_params: Value,
        state: &mut CodexRunState,
    ) -> Result<Value, String> {
        let request_id = self.send_request(method, request_params).await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                return response_result(message);
            }
            if let Some(outcome) = state.handle_message(&message) {
                return Err(format!(
                    "codex app-server completed before {method} response: {outcome:?}"
                ));
            }
        }
    }

    async fn request_ignoring_notifications(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let request_id = self.send_request(method, params).await?;
        loop {
            let message = self.read_message().await?;
            if response_id(&message) == Some(request_id) {
                return response_result(message);
            }
            if message.get("method").and_then(Value::as_str) == Some("error") {
                return Err(codex_error_message(message_params(&message)));
            }
        }
    }

    async fn send_request(&mut self, method: &str, params: Value) -> Result<u64, String> {
        let request_id = self.next_id;
        self.next_id += 1;
        self.write_message(json!({
            "method": method,
            "id": request_id,
            "params": params,
        }))
        .await?;
        Ok(request_id)
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(json!({
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn read_turn(
        &mut self,
        turn_request_id: u64,
        state: &mut CodexRunState,
        notifications: Option<CodexNotificationSender>,
        mut request_user_input_answers: Option<CodexRequestUserInputReceiver>,
    ) -> Result<ExecutionOutcome, String> {
        let mut saw_turn_response = false;
        loop {
            let message = self.read_message().await?;
            log_codex_raw_turn_message(&message);
            if response_id(&message) == Some(turn_request_id) {
                response_result(message)?;
                saw_turn_response = true;
                continue;
            }
            if let Some(sender) = &notifications {
                let _ = sender.send(message.clone());
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method == "item/tool/requestUserInput")
            {
                self.answer_request_user_input(&message, &mut request_user_input_answers)
                    .await?;
                continue;
            }
            if let Some(outcome) = state.handle_message(&message) {
                return Ok(outcome);
            }
            if !saw_turn_response {
                continue;
            }
        }
    }

    async fn answer_request_user_input(
        &mut self,
        message: &Value,
        request_user_input_answers: &mut Option<CodexRequestUserInputReceiver>,
    ) -> Result<(), String> {
        let request_id = response_id(message)
            .ok_or_else(|| "request_user_input message is missing JSON-RPC id".to_owned())?;
        let Some(receiver) = request_user_input_answers else {
            return Err("request_user_input requires a runtime response channel".to_owned());
        };
        let response = receiver
            .recv()
            .await
            .ok_or_else(|| "request_user_input response channel closed".to_owned())?;
        self.write_message(json!({
            "id": request_id,
            "result": request_user_input_result(response),
        }))
        .await
    }

    async fn write_message(&mut self, message: Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(&message)
            .map_err(|error| format!("failed to encode codex JSON-RPC message: {error}"))?;
        line.push(b'\n');
        self.stdin
            .write_all(&line)
            .await
            .map_err(|error| format!("failed to write codex JSON-RPC message: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("failed to flush codex JSON-RPC message: {error}"))
    }

    async fn read_message(&mut self) -> Result<Value, String> {
        let mut line = String::new();
        let bytes_read = self
            .stdout
            .read_line(&mut line)
            .await
            .map_err(|error| format!("failed to read codex JSON-RPC message: {error}"))?;
        if bytes_read == 0 {
            return Err("codex app-server exited before completing the turn".to_owned());
        }
        serde_json::from_str(&line)
            .map_err(|error| format!("failed to parse codex JSON-RPC message: {error}"))
    }
}

#[derive(Default)]
struct CodexRunState {
    final_text: String,
    saw_delta: bool,
    agent_message_phases: CodexAgentMessagePhaseTracker,
    root_thread_id: Option<String>,
    goal_status: Option<String>,
}

impl CodexRunState {
    fn set_root_thread_id(&mut self, thread_id: impl Into<String>) {
        self.root_thread_id = Some(thread_id.into());
    }

    fn set_goal_status(&mut self, status: impl Into<String>) {
        self.goal_status = Some(status.into().to_ascii_lowercase());
    }

    fn goal_is_active(&self) -> bool {
        self.goal_status
            .as_deref()
            .is_some_and(|status| status.eq_ignore_ascii_case("active"))
    }

    fn reset_turn_output(&mut self) {
        self.final_text.clear();
        self.saw_delta = false;
        self.agent_message_phases = CodexAgentMessagePhaseTracker::default();
    }

    fn handle_message(&mut self, message: &Value) -> Option<ExecutionOutcome> {
        match message.get("method").and_then(Value::as_str) {
            Some("thread/started") => {
                if self.root_thread_id.is_none() {
                    if let Some(thread_id) = stream_thread_id(message_params(message)) {
                        self.root_thread_id = Some(thread_id);
                    }
                }
                None
            }
            Some("turn/started") => {
                if !self.is_subagent_message(message_params(message)) {
                    self.reset_turn_output();
                }
                None
            }
            Some("thread/goal/updated") => {
                if let Some(status) = message_params(message)
                    .get("goal")
                    .and_then(|goal| goal.get("status"))
                    .and_then(Value::as_str)
                {
                    self.set_goal_status(status);
                }
                None
            }
            Some("thread/goal/cleared") => {
                self.goal_status = None;
                None
            }
            Some("item/started") => {
                if self.is_subagent_message(message_params(message)) {
                    return None;
                }
                self.agent_message_phases
                    .observe_item(message_params(message));
                None
            }
            Some("item/agentMessage/delta") => {
                if self.is_subagent_message(message_params(message)) {
                    return None;
                }
                self.append_delta(message_params(message));
                None
            }
            Some("item/completed") => {
                let params = message_params(message);
                if self.is_subagent_message(params) {
                    return None;
                }
                self.append_completed_message(params);
                self.agent_message_phases.forget_item(params);
                None
            }
            Some("turn/completed")
                if !self.is_subagent_message(message_params(message))
                    && is_root_codex_turn_event(message_params(message)) =>
            {
                Some(self.completed(message_params(message)))
            }
            Some("turn/completed") => None,
            Some("error") => {
                let params = message_params(message);
                log_codex_run_state_error(params);
                Some(ExecutionOutcome::Failed {
                    message: codex_error_message(params),
                })
            }
            _ => None,
        }
    }

    fn is_subagent_message(&self, params: &Value) -> bool {
        codex_agent_path(params)
            .or_else(|| params.get("item").and_then(codex_agent_path))
            .is_some_and(|agent_path| agent_path != "/root")
            || self
                .root_thread_id
                .as_deref()
                .is_some_and(|root_thread_id| {
                    stream_thread_id(params).is_some_and(|thread_id| thread_id != root_thread_id)
                })
    }

    fn append_delta(&mut self, params: &Value) {
        let text = params.get("delta").and_then(Value::as_str).unwrap_or("");
        let phase = self.agent_message_phases.phase_for_delta(params);
        if codex_phase_is_process(phase.as_deref()) {
            log_codex_run_state_text(
                "delta",
                "skip_process",
                phase.as_deref(),
                params,
                params,
                text,
            );
            return;
        }
        if let Some(delta) = params.get("delta").and_then(Value::as_str) {
            log_codex_run_state_text(
                "delta",
                "append_final",
                phase.as_deref(),
                params,
                params,
                delta,
            );
            self.final_text.push_str(delta);
            self.saw_delta = true;
        }
    }

    fn append_completed_message(&mut self, params: &Value) {
        let phase = self.agent_message_phases.phase_for_item(params);
        if self.saw_delta {
            log_codex_run_state_text(
                "completed",
                "skip_after_delta",
                phase.as_deref(),
                params,
                params,
                "",
            );
            return;
        }
        let item = params.get("item").unwrap_or(params);
        let item_type = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace('_', "")
            .to_ascii_lowercase();
        if item_type == "plan" {
            let text = extract_text(item).unwrap_or_default();
            log_codex_run_state_text(
                "completed",
                "skip_plan",
                phase.as_deref(),
                params,
                item,
                &text,
            );
            return;
        }
        if !matches!(item_type.as_str(), "agentmessage" | "message") {
            log_codex_run_state_text("completed", "skip_non_message", None, params, item, "");
            return;
        }
        if codex_phase_is_process(phase.as_deref()) {
            let text = extract_text(item).unwrap_or_default();
            log_codex_run_state_text(
                "completed",
                "skip_process",
                phase.as_deref(),
                params,
                item,
                &text,
            );
            return;
        }
        if item
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role != "assistant")
        {
            log_codex_run_state_text(
                "completed",
                "skip_non_assistant",
                phase.as_deref(),
                params,
                item,
                "",
            );
            return;
        }
        if let Some(text) = extract_text(item) {
            log_codex_run_state_text(
                "completed",
                "set_final",
                phase.as_deref(),
                params,
                item,
                &text,
            );
            self.final_text = text;
            self.saw_delta = true;
        }
    }

    fn completed(&self, params: &Value) -> ExecutionOutcome {
        let status = params
            .get("turn")
            .and_then(|turn| turn.get("status"))
            .or_else(|| params.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("completed")
            .to_ascii_lowercase();
        match status.as_str() {
            "completed" | "complete" | "succeeded" => ExecutionOutcome::Completed {
                content: self.final_text.clone(),
            },
            "cancelled" | "canceled" | "interrupted" => {
                ExecutionOutcome::Cancelled { message: status }
            }
            other => ExecutionOutcome::Failed {
                message: format!("codex turn ended with status {other}"),
            },
        }
    }
}

fn is_root_codex_turn_event(params: &Value) -> bool {
    let turn = params.get("turn").unwrap_or(params);
    codex_agent_path(turn)
        .or_else(|| codex_agent_path(params))
        .map_or(true, |agent_path| agent_path == "/root")
}

fn stream_thread_id(value: &Value) -> Option<String> {
    value
        .get("threadId")
        .or_else(|| value.get("thread_id"))
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn codex_agent_path(value: &Value) -> Option<String> {
    value
        .get("agent_path")
        .or_else(|| value.get("agentPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn log_codex_run_state_text(
    source: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    item: &Value,
    text: &str,
) {
    if source == "delta" && !codex_stream_debug_enabled() {
        return;
    }

    log_executor_event(
        "codex run state text classification",
        &[
            ("source", source.to_owned()),
            ("action", action.to_owned()),
            (
                "resolved_phase",
                resolved_phase.unwrap_or("<none>").to_owned(),
            ),
            ("item_id", json_string_field(params, "itemId")),
            ("params_type", json_string_field(params, "type")),
            ("params_phase", json_string_field(params, "phase")),
            ("params_channel", json_string_field(params, "channel")),
            ("item_type", json_string_field(item, "type")),
            ("item_phase", json_string_field(item, "phase")),
            ("item_channel", json_string_field(item, "channel")),
            (
                "payload_type",
                nested_json_string_field(item, "payload", "type"),
            ),
            (
                "payload_phase",
                nested_json_string_field(item, "payload", "phase"),
            ),
            (
                "payload_channel",
                nested_json_string_field(item, "payload", "channel"),
            ),
            ("text_len", text.len().to_string()),
            ("text_preview", truncate_log_text(text, 160)),
        ],
    );
}

fn log_codex_run_state_error(params: &Value) {
    let message = codex_error_message(params);
    let params_json = serde_json::to_string(params)
        .unwrap_or_else(|error| format!("failed to serialize codex error params: {error}"));
    log_executor_event(
        "codex run state error",
        &[
            ("message", message),
            ("code", json_string_field(params, "code")),
            ("params_len", params_json.len().to_string()),
            ("params_preview", truncate_log_text(&params_json, 500)),
        ],
    );
}

fn log_codex_raw_turn_message(message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if matches!(
        method,
        "item/agentMessage/delta" | "item/reasoning/delta" | "item/reasoningSummary/delta"
    ) && !codex_stream_debug_enabled()
    {
        return;
    }

    if !matches!(
        method,
        "item/agentMessage/delta"
            | "item/reasoning/delta"
            | "item/reasoningSummary/delta"
            | "item/started"
            | "item/completed"
            | "turn/completed"
            | "error"
    ) {
        return;
    }

    let params = message_params(message);
    let item = params.get("item").unwrap_or(params);
    let raw_len = serialized_json_len(message)
        .map(|length| length.to_string())
        .unwrap_or_else(|error| format!("failed to measure codex raw message: {error}"));
    let raw_preview = codex_raw_log_preview(message);
    log_executor_event(
        "codex raw turn message",
        &[
            ("method", method.to_owned()),
            ("message_id", json_string_field(message, "id")),
            ("params_keys", json_object_keys(params)),
            ("params_type", json_string_field(params, "type")),
            ("params_phase", json_string_field(params, "phase")),
            ("params_channel", json_string_field(params, "channel")),
            ("params_item_id", json_string_field(params, "item_id")),
            ("params_message_id", json_string_field(params, "message_id")),
            (
                "params_output_index",
                json_scalar_field(params, "output_index"),
            ),
            (
                "params_content_index",
                json_scalar_field(params, "content_index"),
            ),
            ("item_keys", json_object_keys(item)),
            ("item_type", json_string_field(item, "type")),
            ("item_id", json_string_field(item, "id")),
            ("item_phase", json_string_field(item, "phase")),
            ("item_channel", json_string_field(item, "channel")),
            (
                "item_turn_id",
                nested_json_string_field(
                    item,
                    "internal_chat_message_metadata_passthrough",
                    "turn_id",
                ),
            ),
            ("raw_len", raw_len),
            ("raw_preview", raw_preview),
        ],
    );
}

struct ByteCounter {
    length: usize,
}

impl Write for ByteCounter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.length += buffer.len();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn serialized_json_len(value: &Value) -> serde_json::Result<usize> {
    let mut counter = ByteCounter { length: 0 };
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.length)
}

fn codex_raw_log_preview(value: &Value) -> String {
    let sanitized = sanitize_codex_raw_log_value(value, None);
    let preview = serde_json::to_string(&sanitized)
        .unwrap_or_else(|error| format!("failed to serialize codex raw message preview: {error}"));
    truncate_log_text(&preview, CODEX_RAW_LOG_PREVIEW_CHARS)
}

fn sanitize_codex_raw_log_value(value: &Value, key: Option<&str>) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        sanitize_codex_raw_log_value(value, Some(key.as_str())),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| sanitize_codex_raw_log_value(item, None))
                .collect(),
        ),
        Value::String(text) if should_summarize_codex_raw_log_string(key, text) => {
            Value::String(format!(
                "[{} chars omitted; preview: {}]",
                text.chars().count(),
                truncate_log_text(text, CODEX_RAW_LOG_STRING_PREVIEW_CHARS)
            ))
        }
        _ => value.clone(),
    }
}

fn should_summarize_codex_raw_log_string(key: Option<&str>, text: &str) -> bool {
    matches!(
        key,
        Some("aggregatedOutput")
            | Some("toolOutput")
            | Some("tool_output")
            | Some("toolOutputDelta")
            | Some("tool_output_delta")
            | Some("output")
            | Some("stdout")
            | Some("stderr")
    ) || text.len() > CODEX_RAW_LOG_LARGE_STRING_CHARS
}

fn json_string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn json_scalar_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_default()
}

fn json_object_keys(value: &Value) -> String {
    value
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>().join(","))
        .unwrap_or_default()
}

fn nested_json_string_field(value: &Value, object_key: &str, key: &str) -> String {
    value
        .get(object_key)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn truncate_log_text(text: &str, max_chars: usize) -> String {
    let mut result = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars {
            result.push('…');
            return result;
        }
        result.push(ch);
    }
    result
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "wegent_executor",
            "title": "Wegent Executor",
            "version": crate::version::get_version(),
        },
        "capabilities": {
            "experimentalApi": true,
        }
    })
}

#[derive(Debug, Clone, Default)]
struct CodexLaunchConfig {
    config_overrides: Vec<String>,
    thread_config: Map<String, Value>,
    model_provider: Option<String>,
    env: BTreeMap<String, String>,
    effort: Option<String>,
    summary: Option<String>,
}

struct PreparedCodexExecutionRequest {
    request: ExecutionRequest,
    generated_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CodexLocalImage {
    path: String,
}

fn build_codex_launch_config(request: &ExecutionRequest) -> CodexLaunchConfig {
    let model = model_id(request);
    let reasoning = normalize_reasoning(request.model_config.get("reasoning"));
    let service_tier = normalize_service_tier(request.model_config.get("service_tier"));
    let thread_config = thread_config(&reasoning, service_tier.as_deref());
    let mut launch_config = CodexLaunchConfig {
        thread_config,
        effort: reasoning.effort.clone(),
        summary: reasoning.summary.clone(),
        env: runtime_proxy_env(&request.model_config),
        ..CodexLaunchConfig::default()
    };
    launch_config
        .config_overrides
        .push(shell_path_config_override());
    launch_config
        .config_overrides
        .extend(codex_streaming_patch_config_overrides());
    launch_config
        .config_overrides
        .extend(codex_model_config_overrides(&request.model_config));

    if let Some(model) = &model {
        launch_config
            .config_overrides
            .push(format!("model={model}"));
    }

    let use_user_config = use_user_runtime_config(&request.model_config);
    let project_id = project_id(request);
    if use_user_config {
        launch_config.model_provider = explicit_model_provider(&request.model_config);
        if let Some(model_provider) = &launch_config.model_provider {
            launch_config.config_overrides.extend(header_overrides(
                model_provider,
                request.model_config.get("default_headers"),
                project_id.as_deref(),
            ));
        }
    } else if let (Some(base_url), Some(api_key)) = (
        non_empty_config(&request.model_config, "base_url"),
        api_key(&request.model_config),
    ) {
        let model_provider = model_provider(&request.model_config);
        let provider_base_url = codex_provider_base_url(&request.model_config, &base_url, &api_key);
        let provider_api_key = if provider_base_url == base_url.trim_end_matches('/') {
            api_key.clone()
        } else {
            "wegent-codex-responses-proxy".to_owned()
        };
        launch_config.model_provider = Some(model_provider.clone());
        launch_config.config_overrides.extend([
            "forced_login_method=api".to_owned(),
            format!("model_provider={model_provider}"),
            format!(
                "model_providers.{model_provider}.name={}",
                toml_value(
                    &non_empty_config(&request.model_config, "provider_name")
                        .or_else(|| non_empty_config(&request.model_config, "display_name"))
                        .unwrap_or_else(|| DEFAULT_PROVIDER_NAME.to_owned())
                )
            ),
            format!(
                "model_providers.{model_provider}.base_url={}",
                toml_value(&provider_base_url)
            ),
            format!(
                "model_providers.{model_provider}.wire_api={}",
                toml_value(&wire_api(&request.model_config))
            ),
            format!(
                "model_providers.{model_provider}.experimental_bearer_token={}",
                toml_value(&provider_api_key)
            ),
        ]);
        launch_config.config_overrides.extend(header_overrides(
            &model_provider,
            request.model_config.get("default_headers"),
            project_id.as_deref(),
        ));
    } else {
        launch_config.model_provider = explicit_model_provider(&request.model_config);
    }

    launch_config
        .config_overrides
        .extend(global_mcp_config_overrides());
    launch_config
        .config_overrides
        .extend(cdp_browser_mcp_config_overrides(request));
    launch_config
        .config_overrides
        .extend(runtime_capabilities::request_mcp_config_overrides(request));
    launch_config
}

fn shell_path_config_override() -> String {
    let path = process_environment::normalized_process_path(
        env::var("PATH").ok().as_deref().unwrap_or_default(),
    );
    format!("shell_environment_policy.set.PATH={}", toml_value(&path))
}

fn codex_streaming_patch_config_overrides() -> Vec<String> {
    vec![
        CODEX_APPLY_PATCH_STREAMING_EVENTS_OVERRIDE.to_owned(),
        CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING_OVERRIDE.to_owned(),
    ]
}

fn codex_model_config_overrides(model_config: &Value) -> Vec<String> {
    let mut overrides = Vec::new();
    if let Some(web_search) = codex_web_search_mode(model_config) {
        overrides.push(format!("web_search={}", toml_value(&web_search)));
    }
    if let Some(image_generation) = codex_image_generation_enabled(model_config) {
        overrides.push(format!("features.image_generation={image_generation}"));
    }
    if let Some(context_window) = codex_model_context_window(model_config) {
        overrides.push(format!("model_context_window={context_window}"));
    }
    overrides
}

fn codex_web_search_mode(model_config: &Value) -> Option<String> {
    let value = non_empty_config(model_config, "web_search")
        .or_else(|| non_empty_config(model_config, "webSearch"))
        .or_else(|| non_empty_config(model_config, "web_search_mode"))
        .or_else(|| non_empty_config(model_config, "webSearchMode"))?;
    let normalized = value.to_ascii_lowercase();
    match normalized.as_str() {
        "disabled" | "cached" | "indexed" | "live" => Some(normalized),
        _ => None,
    }
}

fn codex_image_generation_enabled(model_config: &Value) -> Option<bool> {
    bool_value(model_config.get("image_generation"))
        .or_else(|| bool_value(model_config.get("imageGeneration")))
        .or_else(|| bool_value(model_config.get("image_generation_enabled")))
        .or_else(|| bool_value(model_config.get("imageGenerationEnabled")))
}

fn codex_model_context_window(model_config: &Value) -> Option<i64> {
    model_config
        .get("model_context_window")
        .or_else(|| model_config.get("context_window"))
        .or_else(|| model_config.get("contextWindow"))
        .and_then(value_i64)
        .filter(|value| *value > 0)
}

fn codex_provider_base_url(model_config: &Value, base_url: &str, api_key: &str) -> String {
    let normalized_base_url = base_url.trim_end_matches('/').to_owned();
    let wire_api = wire_api(model_config);
    let use_compat_proxy = bool_value(model_config.get("codex_responses_compat_proxy"))
        .unwrap_or(false)
        || bool_value(model_config.get("codexResponsesCompatProxy")).unwrap_or(false);
    if wire_api != "responses" || !use_compat_proxy {
        return normalized_base_url;
    }

    let token = register_codex_responses_proxy(CodexResponsesProxyUpstream {
        base_url: normalized_base_url,
        responses_url: non_empty_config(model_config, "responses_url")
            .or_else(|| non_empty_config(model_config, "responsesUrl")),
        api_key: api_key.to_owned(),
        default_headers: parse_header_map(model_config.get("default_headers")),
        proxy_url: runtime_proxy_url(model_config).map(str::to_owned),
    });
    let base_url = executor_loopback_base_url()
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", executor_server_port()));
    format!("{base_url}/v1/codex-responses-proxy/{token}")
}

fn executor_server_port() -> u16 {
    env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(DEFAULT_EXECUTOR_SERVER_PORT)
}

fn thread_config(
    reasoning: &NormalizedReasoning,
    service_tier: Option<&str>,
) -> Map<String, Value> {
    let mut config = Map::new();
    if let Some(effort) = &reasoning.effort {
        config.insert(
            "model_reasoning_effort".to_owned(),
            Value::String(effort.clone()),
        );
    }
    if let Some(summary) = &reasoning.summary {
        config.insert(
            "model_reasoning_summary".to_owned(),
            Value::String(summary.clone()),
        );
    }
    if let Some(service_tier) = service_tier {
        config.insert(
            "service_tier".to_owned(),
            Value::String(service_tier.to_owned()),
        );
    }
    config
}

fn use_user_runtime_config(model_config: &Value) -> bool {
    runtime_config(model_config).is_some_and(|config| {
        bool_value(config.get("use_user_config")).unwrap_or(false)
            && bool_value(config.get("configured")).unwrap_or(true)
    })
}

fn runtime_proxy_env(model_config: &Value) -> BTreeMap<String, String> {
    let Some(runtime_config) = runtime_config(model_config) else {
        return BTreeMap::new();
    };
    if !bool_value(runtime_config.get("use_proxy")).unwrap_or(false) {
        return BTreeMap::new();
    }
    let Some(proxy_url) = runtime_proxy_url(model_config) else {
        return BTreeMap::new();
    };

    let no_proxy = env::var("NO_PROXY")
        .ok()
        .or_else(|| env::var("no_proxy").ok())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_NO_PROXY.to_owned());
    [
        ("ALL_PROXY", proxy_url),
        ("HTTP_PROXY", proxy_url),
        ("HTTPS_PROXY", proxy_url),
        ("NO_PROXY", no_proxy.as_str()),
        ("all_proxy", proxy_url),
        ("http_proxy", proxy_url),
        ("https_proxy", proxy_url),
        ("no_proxy", no_proxy.as_str()),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_owned(), value.to_owned()))
    .collect()
}

fn runtime_proxy_url(model_config: &Value) -> Option<&str> {
    model_config
        .get("proxy")
        .and_then(|proxy| proxy.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn runtime_config(model_config: &Value) -> Option<&Value> {
    model_config
        .get("runtime_config")
        .or_else(|| model_config.get("runtimeConfig"))?
        .get("codex")
        .filter(|value| value.is_object())
}

fn bool_value(value: Option<&Value>) -> Option<bool> {
    match value? {
        Value::Bool(value) => Some(*value),
        Value::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(true),
            "false" | "0" | "no" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn model_provider(model_config: &Value) -> String {
    explicit_model_provider(model_config).unwrap_or_else(|| DEFAULT_PROVIDER_ID.to_owned())
}

fn explicit_model_provider(model_config: &Value) -> Option<String> {
    non_empty_config(model_config, "codex_model_provider")
        .or_else(|| non_empty_config(model_config, "model_provider"))
        .or_else(|| non_empty_config(model_config, "provider"))
        .map(|value| sanitize_provider_id(&value))
}

fn sanitize_provider_id(value: &str) -> String {
    let mut sanitized = String::new();
    let mut last_was_separator = false;
    for character in value.trim().chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            sanitized.push(character);
            last_was_separator = false;
        } else if !last_was_separator {
            sanitized.push('-');
            last_was_separator = true;
        }
    }
    let sanitized = sanitized.trim_matches('-').to_owned();
    if sanitized.is_empty() {
        DEFAULT_PROVIDER_ID.to_owned()
    } else {
        sanitized
    }
}

fn wire_api(model_config: &Value) -> String {
    let api_format = non_empty_config(model_config, "api_format")
        .or_else(|| non_empty_config(model_config, "apiFormat"))
        .map(|value| value.to_ascii_lowercase());
    let protocol =
        non_empty_config(model_config, "protocol").map(|value| value.to_ascii_lowercase());
    if api_format.as_deref() == Some("responses") || protocol.as_deref() == Some("openai-responses")
    {
        return "responses".to_owned();
    }
    non_empty_config(model_config, "wire_api")
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "responses".to_owned())
}

fn api_key(request: &Value) -> Option<String> {
    let value = non_empty_config(request, "api_key")?;
    resolve_env_placeholder(&value).filter(|value| !value.trim().is_empty())
}

fn resolve_env_placeholder(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(name) = trimmed
        .strip_prefix("${")
        .and_then(|rest| rest.strip_suffix('}'))
    {
        return env::var(name).ok();
    }
    Some(trimmed.to_owned())
}

fn non_empty_config(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn header_overrides(
    model_provider: &str,
    default_headers: Option<&Value>,
    project_id: Option<&str>,
) -> Vec<String> {
    let Some(project_id) = project_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return Vec::new();
    };

    let mut headers = parse_header_map(default_headers);
    insert_missing_header(&mut headers, "wecode-action", "wegent");
    insert_missing_header(&mut headers, "wecode-source", "wegent-local");
    insert_missing_header(&mut headers, "wecode-executor", "codex");
    insert_header(&mut headers, "wecode-project", project_id);

    headers
        .into_iter()
        .map(|(key, value)| {
            format!(
                "{}={}",
                toml_key_path(&["model_providers", model_provider, "http_headers", &key]),
                toml_value(&value)
            )
        })
        .collect()
}

fn parse_header_map(value: Option<&Value>) -> Vec<(String, String)> {
    match value {
        Some(Value::Object(object)) => object
            .iter()
            .filter_map(|(key, value)| Some((key.clone(), value_string(value)?)))
            .collect(),
        Some(Value::String(value)) => serde_json::from_str::<Value>(value)
            .ok()
            .map(|parsed| parse_header_map(Some(&parsed)))
            .unwrap_or_else(|| parse_header_lines(value)),
        _ => Vec::new(),
    }
}

fn parse_header_lines(value: &str) -> Vec<(String, String)> {
    value
        .lines()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            let key = key.trim();
            if key.is_empty() {
                return None;
            }
            Some((key.to_owned(), value.trim().to_owned()))
        })
        .collect()
}

fn insert_missing_header(headers: &mut Vec<(String, String)>, key: &str, value: &str) {
    if headers
        .iter()
        .any(|(existing, _)| existing.eq_ignore_ascii_case(key))
    {
        return;
    }
    headers.push((key.to_owned(), value.to_owned()));
}

fn insert_header(headers: &mut Vec<(String, String)>, key: &str, value: &str) {
    headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
    headers.push((key.to_owned(), value.to_owned()));
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NormalizedReasoning {
    effort: Option<String>,
    summary: Option<String>,
}

fn normalize_reasoning(value: Option<&Value>) -> NormalizedReasoning {
    let (effort, summary) = match value {
        Some(Value::String(value)) => (Some(value.as_str()), None),
        Some(Value::Object(object)) => {
            let mut effort = object
                .get("effort")
                .or_else(|| object.get("reasoning"))
                .and_then(Value::as_str);
            let mut summary = object.get("summary").and_then(Value::as_str);
            if effort.is_none() {
                if let Some(Value::Object(nested)) = object.get("effort") {
                    effort = nested
                        .get("effort")
                        .or_else(|| nested.get("reasoning"))
                        .and_then(Value::as_str);
                    summary = summary.or_else(|| nested.get("summary").and_then(Value::as_str));
                }
            }
            (effort, summary)
        }
        _ => (None, None),
    };
    let effort = Some(normalize_reasoning_effort(effort));
    let summary = summary
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| matches!(value.as_str(), "auto" | "concise" | "detailed"));
    NormalizedReasoning { effort, summary }
}

fn normalize_reasoning_effort(value: Option<&str>) -> String {
    let normalized = value
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
        .replace(' ', "_");
    let aliased = match normalized.as_str() {
        "" | "none" | "off" | "false" | "disabled" | "关闭" => DEFAULT_REASONING_EFFORT,
        "低" => "low",
        "中" | "中等" => "medium",
        "高" => "high",
        "超高" | "最高" | "extra_high" | "ultra" | "x-high" => "xhigh",
        value => value,
    };
    if matches!(aliased, "minimal" | "low" | "medium" | "high" | "xhigh") {
        aliased.to_owned()
    } else {
        DEFAULT_REASONING_EFFORT.to_owned()
    }
}

fn normalize_service_tier(value: Option<&Value>) -> Option<String> {
    let value = match value {
        Some(Value::Object(object)) => object
            .get("value")
            .or_else(|| object.get("speed"))
            .or_else(|| object.get("service_tier"))
            .and_then(Value::as_str),
        Some(Value::String(value)) => Some(value.as_str()),
        _ => None,
    }?;
    match value.trim().to_ascii_lowercase().as_str() {
        "fast" | "priority" | "快速" | "运行快速" => Some("priority".to_owned()),
        "standard" | "default" | "普通" | "标准" | "运行标准" => Some("default".to_owned()),
        _ => None,
    }
}

fn global_mcp_config_overrides() -> Vec<String> {
    let manifest_path = executor_home().join("capabilities/manifest.json");
    let Ok(manifest) = fs::read_to_string(manifest_path) else {
        return Vec::new();
    };
    let Ok(manifest) = serde_json::from_str::<Value>(&manifest) else {
        return Vec::new();
    };
    let Some(mcps) = manifest.get("mcps").and_then(Value::as_object) else {
        return Vec::new();
    };

    let mut overrides = Vec::new();
    let mut names = mcps.keys().collect::<Vec<_>>();
    names.sort();
    for name in names {
        let Some(server) = mcps
            .get(name)
            .and_then(|record| record.get("server"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        overrides.extend(mcp_server_overrides(name, server));
    }
    overrides
}

fn cdp_browser_mcp_config_overrides(request: &ExecutionRequest) -> Vec<String> {
    let command = executor_home().join("bin/browser-mcp-server");
    let mut overrides = vec![
        format!(
            "developer_instructions={}",
            toml_value(WEWORK_EMBEDDED_BROWSER_DEVELOPER_INSTRUCTIONS)
        ),
        format!(
            "skills.config={}",
            serde_json::to_string(&json!([
                {
                    "name": "browser:control-in-app-browser",
                    "enabled": false,
                },
                {
                    "name": "chrome:control-chrome",
                    "enabled": false,
                },
            ]))
            .unwrap_or_else(|_| "[]".to_owned())
        ),
        "features.non_prefixed_mcp_tool_names=true".to_owned(),
        format!(
            "{}={}",
            toml_key_path(&["mcp_servers", WEWORK_BROWSER_MCP_SERVER_NAME, "command"]),
            toml_value(&command.display().to_string())
        ),
        format!(
            "{}={}",
            toml_key_path(&[
                "mcp_servers",
                WEWORK_BROWSER_MCP_SERVER_NAME,
                "startup_timeout_sec"
            ]),
            15
        ),
        format!(
            "{}={}",
            toml_key_path(&[
                "mcp_servers",
                WEWORK_BROWSER_MCP_SERVER_NAME,
                "tool_timeout_sec"
            ]),
            60
        ),
        format!(
            "{}={}",
            toml_key_path(&[
                "mcp_servers",
                WEWORK_BROWSER_MCP_SERVER_NAME,
                "env",
                "WEWORK_BROWSER_MCP_TARGET"
            ]),
            toml_value("embedded")
        ),
        format!(
            "{}={}",
            toml_key_path(&[
                "mcp_servers",
                WEWORK_BROWSER_MCP_SERVER_NAME,
                "env",
                "WEWORK_EMBEDDED_BROWSER_BRIDGE_URL"
            ]),
            toml_value("http://127.0.0.1:9231")
        ),
    ];

    if let Some(label) = embedded_browser_label(request) {
        overrides.push(format!(
            "{}={}",
            toml_key_path(&[
                "mcp_servers",
                WEWORK_BROWSER_MCP_SERVER_NAME,
                "env",
                "WEWORK_EMBEDDED_BROWSER_LABEL"
            ]),
            toml_value(&label)
        ));
    }

    overrides
}

fn embedded_browser_label(request: &ExecutionRequest) -> Option<String> {
    let task_id = request.task_id.trim();
    if task_id.is_empty() {
        return None;
    }

    Some(format!(
        "workspace-browser-{}",
        task_id
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                    character
                } else {
                    '-'
                }
            })
            .collect::<String>()
    ))
}

fn mcp_server_overrides(name: &str, server: &Map<String, Value>) -> Vec<String> {
    let key = toml_key_path(&["mcp_servers", name]);
    let server_type = server
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if server_type == "stdio" || server.get("command").is_some() {
        let Some(command) = server
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            return Vec::new();
        };
        let mut overrides = vec![format!("{key}.command={}", toml_value(command))];
        if let Some(args) = server.get("args").and_then(Value::as_array) {
            let args = args
                .iter()
                .filter_map(value_string)
                .map(Value::String)
                .collect::<Vec<_>>();
            overrides.push(format!(
                "{key}.args={}",
                toml_json_value(&Value::Array(args))
            ));
        }
        if let Some(env) = server.get("env").and_then(Value::as_object) {
            let mut env_keys = env.keys().collect::<Vec<_>>();
            env_keys.sort();
            for env_key in env_keys {
                if let Some(env_value) = env.get(env_key).and_then(value_string) {
                    overrides.push(format!(
                        "{key}.env.{}={}",
                        toml_key_segment(env_key),
                        toml_value(&env_value)
                    ));
                }
            }
        }
        return overrides;
    }

    let Some(url) = server
        .get("url")
        .or_else(|| server.get("base_url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Vec::new();
    };
    let mut overrides = vec![format!("{key}.url={}", toml_value(url))];
    for (source_key, target_key) in [
        ("bearer_token_env_var", "bearer_token_env_var"),
        ("bearerTokenEnvVar", "bearer_token_env_var"),
        ("oauth_client_id", "oauth_client_id"),
        ("oauthClientId", "oauth_client_id"),
        ("oauth_resource", "oauth_resource"),
        ("oauthResource", "oauth_resource"),
    ] {
        if let Some(value) = server.get(source_key).and_then(value_string) {
            overrides.push(format!("{key}.{target_key}={}", toml_value(&value)));
        }
    }
    overrides
}

fn prepare_codex_execution_request(mut request: ExecutionRequest) -> PreparedCodexExecutionRequest {
    let attachments = attachment_records(&request);
    if attachments.is_empty() {
        return PreparedCodexExecutionRequest {
            request,
            generated_files: Vec::new(),
        };
    }
    log_executor_event(
        "codex attachment payload received",
        &[
            ("task_id", request.task_id.to_string()),
            ("subtask_id", request.subtask_id.to_string()),
            ("attachment_count", attachments.len().to_string()),
            ("attachment_ids", attachment_ids(&attachments)),
            (
                "has_auth_token",
                request
                    .auth_token
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    .to_string(),
            ),
            (
                "backend_url_present",
                request
                    .backend_url
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty())
                    .to_string(),
            ),
        ],
    );

    let mut generated_files = Vec::new();
    let subtask_id = attachment_subtask_id(&attachments, &request.subtask_id);
    let mut success = Vec::new();
    let mut failed = Vec::new();
    let mut local_images = Vec::new();
    for attachment in attachments {
        if let Some(local_path) = attachment
            .local_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let mut success_attachment = attachment.clone();
            if is_image_attachment(&success_attachment) {
                let prepared_path = prepare_local_image_path(
                    local_path,
                    success_attachment
                        .mime_type
                        .as_deref()
                        .unwrap_or("image/png"),
                    &mut generated_files,
                )
                .unwrap_or_else(|| local_path.to_owned());
                success_attachment.local_path = Some(prepared_path.clone());
                local_images.push(Some(CodexLocalImage {
                    path: prepared_path,
                }));
            }
            success.push(success_attachment);
        } else {
            let mut failed_attachment = attachment.clone();
            if failed_attachment.error.is_none() {
                failed_attachment.error = Some("attachment is not available locally".to_owned());
            }
            if is_image_attachment(&failed_attachment) {
                local_images.push(None);
            }
            failed.push(failed_attachment);
        }
    }

    if !success.is_empty() || !failed.is_empty() {
        request.prompt = process_prompt(
            &request.prompt,
            &success,
            &failed,
            Some(request.task_id.clone()),
            Some(subtask_id),
        );
    }
    request.prompt = prompt_with_codex_local_images(&request.prompt, &local_images);
    let text_attachment_context =
        AttachmentPromptProcessor::build_text_attachment_context(&success);
    if !text_attachment_context.is_empty() {
        request.prompt = append_text_attachment_context(&request.prompt, &text_attachment_context);
    }

    PreparedCodexExecutionRequest {
        request,
        generated_files,
    }
}

fn attachment_ids(attachments: &[AttachmentRecord]) -> String {
    attachments
        .iter()
        .map(|attachment| attachment.id.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

fn attachment_records(request: &ExecutionRequest) -> Vec<AttachmentRecord> {
    request
        .extra
        .get("attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(attachment_record)
        .collect()
}

fn attachment_record(value: &Value) -> Option<AttachmentRecord> {
    Some(AttachmentRecord {
        id: value.get("id").and_then(value_i64)?,
        original_filename: value
            .get("original_filename")
            .or_else(|| value.get("originalFilename"))
            .or_else(|| value.get("filename"))
            .or_else(|| value.get("name"))
            .and_then(value_string)
            .unwrap_or_else(|| "attachment".to_owned()),
        status: value.get("status").and_then(value_string),
        local_path: value
            .get("local_path")
            .or_else(|| value.get("localPath"))
            .and_then(value_string),
        file_size: value
            .get("file_size")
            .or_else(|| value.get("fileSize"))
            .and_then(value_u64),
        mime_type: value
            .get("mime_type")
            .or_else(|| value.get("mimeType"))
            .and_then(value_string),
        subtask_id: value
            .get("subtask_id")
            .or_else(|| value.get("subtaskId"))
            .and_then(value_string),
        error: value.get("error").and_then(value_string),
    })
}

fn attachment_subtask_id(attachments: &[AttachmentRecord], fallback: &str) -> String {
    attachments
        .iter()
        .find_map(|attachment| attachment.subtask_id.clone())
        .unwrap_or_else(|| fallback.to_owned())
}

fn is_image_attachment(attachment: &AttachmentRecord) -> bool {
    attachment
        .mime_type
        .as_deref()
        .map(|value| value.to_ascii_lowercase())
        .is_some_and(|mime_type| IMAGE_MIME_TYPES.contains(&mime_type.as_str()))
}

fn prepare_local_image_path(
    path: &str,
    mime_type: &str,
    generated_files: &mut Vec<PathBuf>,
) -> Option<String> {
    let image_data = fs::read(path).ok()?;
    let prepared = prepare_image_bytes_for_model(&image_data, mime_type, None);
    if !prepared.resized {
        return Some(path.to_owned());
    }

    let output_path = model_input_image_path(Path::new(path), &prepared.mime_type);
    if fs::write(&output_path, prepared.data).is_err() {
        return Some(path.to_owned());
    }
    generated_files.push(output_path.clone());
    Some(output_path.display().to_string())
}

fn model_input_image_path(path: &Path, mime_type: &str) -> PathBuf {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("image");
    parent.join(format!("{stem}.model-input{}", image_extension(mime_type)))
}

fn image_extension(mime_type: &str) -> &'static str {
    match mime_type.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".png",
        _ => ".png",
    }
}

fn prompt_with_codex_local_images(
    prompt: &Value,
    local_images: &[Option<CodexLocalImage>],
) -> Value {
    if !local_images.iter().any(Option::is_some) {
        return prompt.clone();
    }

    match prompt {
        Value::Array(blocks) => {
            let mut text_parts = Vec::new();
            let mut output_images = Vec::new();
            let mut local_image_index = 0;
            for block in blocks {
                match block
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "input_text" | "text" => {
                        if let Some(text) = block.get("text").and_then(Value::as_str) {
                            text_parts.push(text.to_owned());
                        }
                    }
                    "input_image" | "image" | "image_url" => {
                        let local_image = local_images.get(local_image_index).cloned().flatten();
                        local_image_index += 1;
                        if let Some(local_image) = local_image {
                            output_images
                                .push(json!({"type": "localImage", "path": local_image.path}));
                        } else {
                            output_images.push(block.clone());
                        }
                    }
                    "localImage" | "local_image" => output_images.push(block.clone()),
                    _ => {}
                }
            }
            let mut output = vec![json!({
                "type": "input_text",
                "text": files_mentioned_text(local_images, &text_parts),
            })];
            output.extend(output_images);
            Value::Array(output)
        }
        Value::String(text) => {
            let mut output = vec![json!({
                "type": "input_text",
                "text": files_mentioned_text(local_images, std::slice::from_ref(text)),
            })];
            output.extend(local_images.iter().filter_map(|local_image| {
                let local_image = local_image.as_ref()?;
                Some(json!({"type": "localImage", "path": local_image.path}))
            }));
            Value::Array(output)
        }
        _ => prompt.clone(),
    }
}

fn files_mentioned_text(local_images: &[Option<CodexLocalImage>], text_parts: &[String]) -> String {
    let file_lines = local_images
        .iter()
        .filter_map(|local_image| local_image.as_ref())
        .map(|local_image| {
            let filename = Path::new(&local_image.path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&local_image.path);
            format!("## {filename}: {}", local_image.path)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let request_text = extract_user_request_text(text_parts);
    format!(
        "\n# Files mentioned by the user:\n\n{file_lines}\n\n## My request for Codex:\n{request_text}\n"
    )
}

fn append_text_attachment_context(prompt: &Value, context: &str) -> Value {
    match prompt {
        Value::String(text) => Value::String(format!("{text}{context}")),
        Value::Array(blocks) => {
            let mut output = blocks.clone();
            if append_context_to_first_text_block(&mut output, context) {
                Value::Array(output)
            } else {
                output.insert(
                    0,
                    json!({"type": "input_text", "text": context.trim_start()}),
                );
                Value::Array(output)
            }
        }
        _ => Value::String(format!("{}{}", prompt_text(prompt), context)),
    }
}

fn append_context_to_first_text_block(blocks: &mut [Value], context: &str) -> bool {
    for block in blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        let block_type = object.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(block_type, "input_text" | "text") {
            continue;
        }
        let Some(text) = object
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            continue;
        };
        object.insert("text".to_owned(), Value::String(format!("{text}{context}")));
        return true;
    }
    false
}

fn extract_user_request_text(text_parts: &[String]) -> String {
    text_parts
        .iter()
        .filter_map(|text| {
            let text = strip_failed_attachment_warning(&strip_attachment_blocks(text))
                .trim()
                .to_owned();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn strip_attachment_blocks(text: &str) -> String {
    let mut remaining = text.to_owned();
    loop {
        let Some(start) = remaining.find("<attachment>") else {
            return remaining;
        };
        let Some(end) = remaining[start..].find("</attachment>") else {
            return remaining;
        };
        let end = start + end + "</attachment>".len();
        remaining.replace_range(start..end, "");
    }
}

fn strip_failed_attachment_warning(text: &str) -> String {
    for marker in [
        "\n\nThe following attachments failed to download and are unavailable:",
        "\n\n⚠️ The following attachments failed to download",
    ] {
        if let Some(index) = text.find(marker) {
            return text[..index].to_owned();
        }
    }
    text.to_owned()
}

fn cleanup_generated_files(paths: &[PathBuf]) {
    for path in paths {
        let _ = fs::remove_file(path);
    }
}

fn project_id(request: &ExecutionRequest) -> Option<String> {
    let standalone = request
        .extra
        .get("standalone_chat_workspace")
        .or_else(|| request.extra.get("standaloneChatWorkspace"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let project_id = request
        .extra
        .get("project_id")
        .or_else(|| request.extra.get("projectId"))
        .and_then(value_string)
        .or_else(|| value_path_string(&request.extra, &["workspace", "project", "project_id"]))
        .or_else(|| value_path_string(&request.extra, &["workspace", "project", "projectId"]))?;
    let project_id = project_id.trim();
    if project_id.is_empty() || (!standalone && project_id == "0") {
        None
    } else {
        Some(project_id.to_owned())
    }
}

fn value_path_string(object: &Map<String, Value>, path: &[&str]) -> Option<String> {
    let mut current = Value::Object(object.clone());
    for segment in path {
        current = current.get(*segment)?.clone();
    }
    value_string(&current)
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(value) => value.as_i64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn value_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(value) => value.as_u64(),
        Value::String(value) => value.trim().parse().ok(),
        _ => None,
    }
}

fn toml_key_path(segments: &[&str]) -> String {
    segments
        .iter()
        .map(|segment| toml_key_segment(segment))
        .collect::<Vec<_>>()
        .join(".")
}

fn toml_key_segment(segment: &str) -> String {
    if !segment.is_empty()
        && segment
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return segment.to_owned();
    }
    toml_value(segment)
}

fn toml_value(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn toml_json_value(value: &Value) -> String {
    match value {
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(toml_json_value)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => toml_value(value),
        _ => toml_value(&value.to_string()),
    }
}

fn config_override_entry(value: &str) -> Option<(String, Value)> {
    let (key, raw_value) = value.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    Some((
        key.to_owned(),
        parse_config_override_value(raw_value.trim()),
    ))
}

fn parse_config_override_value(value: &str) -> Value {
    if value.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if value.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    if let Ok(number) = value.parse::<i64>() {
        return json!(number);
    }
    if let Ok(number) = value.parse::<f64>() {
        return json!(number);
    }
    if value.starts_with('[') && value.ends_with(']') {
        if let Ok(parsed) = serde_json::from_str::<Value>(value) {
            return parsed;
        }
    }
    if value.starts_with('"') && value.ends_with('"') {
        if let Ok(parsed) = serde_json::from_str::<String>(value) {
            return Value::String(parsed);
        }
    }
    Value::String(value.to_owned())
}

fn executor_home() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".wegent-executor")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"))
}

fn resolve_codex_binary(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.contains('/') || trimmed.contains('\\') {
        return trimmed.to_owned();
    }

    if trimmed == "codex" && cfg!(target_os = "macos") && Path::new(MACOS_CODEX_APP_BINARY).exists()
    {
        return MACOS_CODEX_APP_BINARY.to_owned();
    }

    env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .map(|path| path.join(trimmed))
        .find(|path| path.is_file())
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| trimmed.to_owned())
}

fn thread_start_params(request: &ExecutionRequest, launch_config: &CodexLaunchConfig) -> Value {
    let mut params = serde_json::Map::new();
    if let Some(model) = model_id(request) {
        params.insert("model".to_owned(), Value::String(model));
    }
    append_thread_launch_params(&mut params, launch_config);
    if let Some(cwd) = request.cwd() {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    params.insert(
        "approvalPolicy".to_owned(),
        Value::String("never".to_owned()),
    );
    if request.ephemeral {
        params.insert("ephemeral".to_owned(), Value::Bool(true));
    }
    Value::Object(params)
}

fn thread_fork_params(
    thread_id: &str,
    thread_path: Option<&str>,
    request: &ExecutionRequest,
    launch_config: &CodexLaunchConfig,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
    if let Some(path) = thread_path.map(str::trim).filter(|path| !path.is_empty()) {
        params.insert("path".to_owned(), Value::String(path.to_owned()));
    }
    params.insert("excludeTurns".to_owned(), Value::Bool(true));
    if let Some(model) = model_id(request) {
        params.insert("model".to_owned(), Value::String(model));
    }
    append_thread_launch_params(&mut params, launch_config);
    if let Some(cwd) = request.cwd() {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    params.insert(
        "approvalPolicy".to_owned(),
        Value::String("never".to_owned()),
    );
    if request.ephemeral {
        params.insert("ephemeral".to_owned(), Value::Bool(true));
    }
    Value::Object(params)
}

fn side_boundary_inject_params(thread_id: &str) -> Value {
    json!({
        "threadId": thread_id,
        "items": [{
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": SIDE_BOUNDARY_PROMPT,
            }],
        }],
    })
}

fn thread_goal_set_params(thread_id: &str, goal: &Value) -> Result<Value, String> {
    let objective = goal
        .get("objective")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|objective| !objective.is_empty())
        .ok_or_else(|| "initial goal objective is required".to_owned())?;
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
    params.insert("objective".to_owned(), Value::String(objective.to_owned()));
    if let Some(status) = goal
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|status| !status.is_empty())
    {
        params.insert("status".to_owned(), Value::String(status.to_owned()));
    }
    if let Some(token_budget) = goal.get("tokenBudget").or_else(|| goal.get("token_budget")) {
        params.insert("tokenBudget".to_owned(), token_budget.clone());
    }
    Ok(Value::Object(params))
}

fn thread_resume_params(
    thread_id: &str,
    request: &ExecutionRequest,
    launch_config: &CodexLaunchConfig,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
    if let Some(model) = model_id(request) {
        params.insert("model".to_owned(), Value::String(model));
    }
    append_thread_launch_params(&mut params, launch_config);
    if let Some(cwd) = request.cwd() {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    params.insert(
        "approvalPolicy".to_owned(),
        Value::String("never".to_owned()),
    );
    Value::Object(params)
}

fn append_thread_launch_params(
    params: &mut serde_json::Map<String, Value>,
    launch_config: &CodexLaunchConfig,
) {
    if let Some(model_provider) = &launch_config.model_provider {
        params.insert(
            "modelProvider".to_owned(),
            Value::String(model_provider.clone()),
        );
    }
    let mut config = launch_config.thread_config.clone();
    for override_value in &launch_config.config_overrides {
        if let Some((key, value)) = config_override_entry(override_value) {
            config.insert(key, value);
        }
    }
    if !config.is_empty() {
        params.insert("config".to_owned(), Value::Object(config));
    }
}

fn turn_start_params(
    thread_id: &str,
    request: &ExecutionRequest,
    launch_config: &CodexLaunchConfig,
    input: Vec<Value>,
) -> Value {
    let mut params = serde_json::Map::new();
    params.insert("threadId".to_owned(), Value::String(thread_id.to_owned()));
    params.insert("input".to_owned(), Value::Array(input));
    params.insert(
        "approvalPolicy".to_owned(),
        Value::String("never".to_owned()),
    );
    params.insert(
        "sandboxPolicy".to_owned(),
        json!({"type": "dangerFullAccess"}),
    );
    if let Some(cwd) = request.cwd() {
        params.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    if let Some(model) = model_id(request) {
        params.insert("model".to_owned(), Value::String(model));
    }
    if let Some(effort) = &launch_config.effort {
        params.insert("effort".to_owned(), Value::String(effort.clone()));
    }
    if let Some(summary) = &launch_config.summary {
        params.insert("summary".to_owned(), Value::String(summary.clone()));
    }
    if let Some(collaboration_mode) = codex_collaboration_mode_payload(request, launch_config) {
        params.insert("collaborationMode".to_owned(), collaboration_mode);
    }
    Value::Object(params)
}

fn codex_collaboration_mode_payload(
    request: &ExecutionRequest,
    launch_config: &CodexLaunchConfig,
) -> Option<Value> {
    let mode = match codex_collaboration_mode(request)? {
        mode if mode.eq_ignore_ascii_case("plan") => "plan",
        mode if mode.eq_ignore_ascii_case("default") => "default",
        _ => return None,
    };

    Some(json!({
        "mode": mode,
        "settings": {
            "model": model_id(request),
            "reasoningEffort": launch_config.effort,
            "developerInstructions": Value::Null,
        }
    }))
}

fn codex_collaboration_mode(request: &ExecutionRequest) -> Option<&str> {
    request
        .extra
        .get("collaborationMode")
        .or_else(|| request.extra.get("collaboration_mode"))
        .and_then(Value::as_str)
}

fn turn_input(prompt: &Value) -> Vec<Value> {
    let Value::Array(items) = prompt else {
        return text_input_with_structured_mentions(prompt_text(prompt));
    };

    let mut input = items.iter().flat_map(turn_input_item).collect::<Vec<_>>();
    if input.is_empty() {
        input.extend(text_input_with_structured_mentions(prompt_text(prompt)));
    }
    input
}

fn turn_input_item(item: &Value) -> Vec<Value> {
    let Some(kind) = item.get("type").and_then(Value::as_str) else {
        return Vec::new();
    };
    match kind {
        "input_text" | "text" => item
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text_input_with_structured_mentions(text.to_owned())),
        "input_image" => item
            .get("image_url")
            .or_else(|| item.get("url"))
            .and_then(Value::as_str)
            .map(|url| vec![json!({"type": "image", "url": url})]),
        "image" => image_input(item).map(|item| vec![item]),
        "localImage" | "local_image" => item
            .get("path")
            .and_then(Value::as_str)
            .map(|path| vec![json!({"type": "localImage", "path": path})]),
        "skill" => match (
            item.get("name").and_then(Value::as_str),
            item.get("path").and_then(Value::as_str),
        ) {
            (Some(name), Some(path)) => Some(vec![skill_input(name, path)]),
            _ => None,
        },
        "mention" => match (
            item.get("name").and_then(Value::as_str),
            item.get("path").and_then(Value::as_str),
        ) {
            (Some(name), Some(path)) => Some(vec![mention_input(name, path)]),
            _ => None,
        },
        _ => item
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text_input_with_structured_mentions(text.to_owned())),
    }
    .unwrap_or_default()
}

fn image_input(item: &Value) -> Option<Value> {
    if let Some(url) = item.get("url").and_then(Value::as_str) {
        return Some(json!({"type": "image", "url": url}));
    }
    let source = item.get("source")?;
    let data = source.get("data").and_then(Value::as_str)?;
    let media_type = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(json!({
        "type": "image",
        "url": format!("data:{media_type};base64,{data}"),
    }))
}

fn text_input(text: String) -> Value {
    json!({"type": "text", "text": text, "text_elements": []})
}

fn skill_input(name: &str, path: &str) -> Value {
    json!({"type": "skill", "name": name, "path": normalize_skill_path(path)})
}

fn mention_input(name: &str, path: &str) -> Value {
    json!({"type": "mention", "name": name, "path": path})
}

fn text_input_with_structured_mentions(text: String) -> Vec<Value> {
    let (normalized_text, mentions) = extract_structured_mentions(&text);
    let mut input = vec![text_input(normalized_text)];
    input.extend(mentions);
    input
}

fn extract_structured_mentions(text: &str) -> (String, Vec<Value>) {
    let mut output = String::with_capacity(text.len());
    let mut mentions = Vec::new();
    let mut seen_paths = std::collections::BTreeSet::new();
    let mut cursor = 0;

    while let Some(relative_start) = text[cursor..].find("[$") {
        let start = cursor + relative_start;
        let Some(label_end) = text[start + 2..].find("](").map(|index| start + 2 + index) else {
            break;
        };
        let uri_start = label_end + 2;
        let Some(uri_end) = text[uri_start..].find(')').map(|index| uri_start + index) else {
            break;
        };

        let name = &text[start + 2..label_end];
        let uri = &text[uri_start..uri_end];
        let Some(mention) = structured_mention_input(name, uri) else {
            output.push_str(&text[cursor..uri_end + 1]);
            cursor = uri_end + 1;
            continue;
        };

        output.push_str(&text[cursor..start]);
        output.push_str(&visible_mention_text(name, uri));
        if seen_paths.insert(uri.to_owned()) {
            mentions.push(mention);
        }
        cursor = uri_end + 1;
    }

    output.push_str(&text[cursor..]);
    (output, mentions)
}

fn structured_mention_input(name: &str, uri: &str) -> Option<Value> {
    if uri.starts_with("skill://") {
        return Some(skill_input(name, uri));
    }
    if uri.starts_with("app://") || uri.starts_with("plugin://") {
        return Some(mention_input(name, uri));
    }
    None
}

fn visible_mention_text(name: &str, uri: &str) -> String {
    if uri.starts_with("plugin://") {
        format!("@{name}")
    } else {
        format!("${name}")
    }
}

fn normalize_skill_path(path: &str) -> String {
    path.strip_prefix("skill://").unwrap_or(path).to_owned()
}

fn response_id(message: &Value) -> Option<u64> {
    message.get("id").and_then(Value::as_u64)
}

fn response_result(message: Value) -> Result<Value, String> {
    if let Some(error) = message.get("error") {
        return Err(error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string()));
    }
    Ok(message.get("result").cloned().unwrap_or_else(|| json!({})))
}

fn request_user_input_result(response: Value) -> Value {
    if response.get("answers").is_some() {
        return json!({
            "answers": response.get("answers").cloned().unwrap_or_else(|| json!({})),
        });
    }
    response
}

fn message_params(message: &Value) -> &Value {
    message.get("params").unwrap_or(message)
}

fn codex_error_message(params: &Value) -> String {
    let nested_error = params.get("error");
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| {
            nested_error
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| nested_error.and_then(Value::as_str));
    let details = params
        .get("additionalDetails")
        .and_then(Value::as_str)
        .or_else(|| {
            nested_error
                .and_then(|error| error.get("additionalDetails"))
                .and_then(Value::as_str)
        });

    match (
        message.filter(|value| !value.trim().is_empty()),
        details.filter(|value| !value.trim().is_empty()),
    ) {
        (Some(message), Some(details)) if message != details => format!("{message}: {details}"),
        (Some(message), _) => message.to_owned(),
        (_, Some(details)) => details.to_owned(),
        _ => nested_error
            .map(Value::to_string)
            .filter(|value| value != "null")
            .unwrap_or_else(|| "codex app-server error".to_owned()),
    }
}

fn extract_text(item: &Value) -> Option<String> {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        return Some(text.to_owned());
    }
    if let Some(content) = item.get("content").and_then(Value::as_str) {
        return Some(content.to_owned());
    }
    let text = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| {
            part.get("text")
                .or_else(|| part.get("content"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("");
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn wework_codex_home_defaults_to_executor_home_codex() {
        let _lock = crate::test_env::lock();
        let home = unique_test_path("wework-codex-home-default");
        let _executor_home = EnvRestore::capture("WEGENT_EXECUTOR_HOME");
        let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

        env::set_var("WEGENT_EXECUTOR_HOME", &home);
        env::remove_var(WEGENT_CODEX_HOME_ENV);
        env::set_var(
            CODEX_HOME_ENV,
            home.join("user-codex-should-not-be-wework-home"),
        );

        assert_eq!(wework_codex_home(), home.join("codex"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn wework_codex_home_prefers_explicit_wework_home() {
        let _lock = crate::test_env::lock();
        let executor_home = unique_test_path("wework-codex-home-executor");
        let codex_home = unique_test_path("wework-codex-home-explicit");
        let _executor_home = EnvRestore::capture("WEGENT_EXECUTOR_HOME");
        let _wework_codex_home = EnvRestore::capture(WEGENT_CODEX_HOME_ENV);
        let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

        env::set_var("WEGENT_EXECUTOR_HOME", &executor_home);
        env::set_var(WEGENT_CODEX_HOME_ENV, &codex_home);
        env::set_var(CODEX_HOME_ENV, executor_home.join("ignored-codex"));

        assert_eq!(wework_codex_home(), codex_home);

        let _ = fs::remove_dir_all(executor_home);
        let _ = fs::remove_dir_all(codex_home);
    }

    #[test]
    fn prepare_wework_codex_home_links_user_auth() {
        let _lock = crate::test_env::lock();
        let root = unique_test_path("wework-codex-home-auth");
        let user_codex_home = root.join("user-codex");
        let codex_home = root.join("wework-codex");
        let source_auth = user_codex_home.join("auth.json");
        let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

        fs::create_dir_all(source_auth.parent().expect("auth parent should exist"))
            .expect("user Codex home should be created");
        fs::write(&source_auth, br#"{"token":"shared"}"#).expect("auth should be written");
        env::set_var(CODEX_HOME_ENV, &user_codex_home);

        prepare_wework_codex_home(&codex_home).expect("Codex home should be prepared");

        let linked_auth = codex_home.join("auth.json");
        assert!(linked_auth.is_file());
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(&linked_auth).expect("auth should be a symlink"),
            source_auth
        );

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn prepare_wework_codex_home_replaces_stale_auth_link() {
        let _lock = crate::test_env::lock();
        let root = unique_test_path("wework-codex-home-stale-auth");
        let user_codex_home = root.join("user-codex");
        let codex_home = root.join("wework-codex");
        let source_auth = user_codex_home.join("auth.json");
        let stale_source = root.join("missing-auth.json");
        let linked_auth = codex_home.join("auth.json");
        let _codex_home = EnvRestore::capture(CODEX_HOME_ENV);

        fs::create_dir_all(source_auth.parent().expect("auth parent should exist"))
            .expect("user Codex home should be created");
        fs::create_dir_all(&codex_home).expect("WeWork Codex home should be created");
        fs::write(&source_auth, br#"{"token":"shared"}"#).expect("auth should be written");
        std::os::unix::fs::symlink(&stale_source, &linked_auth)
            .expect("stale auth link should be created");
        env::set_var(CODEX_HOME_ENV, &user_codex_home);

        prepare_wework_codex_home(&codex_home).expect("Codex home should be prepared");

        assert_eq!(
            fs::read_link(&linked_auth).expect("auth should be a symlink"),
            source_auth
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_raw_log_preview_summarizes_large_command_output() {
        let output = "x".repeat(4096);
        let message = json!({
            "method": "item/completed",
            "params": {
                "item": {
                    "id": "cmd-1",
                    "type": "commandExecution",
                    "aggregatedOutput": output,
                }
            }
        });

        let preview = codex_raw_log_preview(&message);

        assert!(preview.contains("4096 chars omitted"));
        assert!(!preview.contains(&"x".repeat(512)));
        assert_eq!(
            serialized_json_len(&message).expect("message length should serialize"),
            serde_json::to_string(&message)
                .expect("message should serialize")
                .len()
        );
    }

    #[test]
    fn codex_launch_config_enables_streaming_patch_updates() {
        let request = ExecutionRequest {
            prompt: Value::String("create a file".to_owned()),
            model_config: json!({
                "model_id": "gpt-5.5-codex",
            }),
            ..ExecutionRequest::default()
        };

        let launch_config = build_codex_launch_config(&request);

        assert!(launch_config
            .config_overrides
            .contains(&CODEX_APPLY_PATCH_STREAMING_EVENTS_OVERRIDE.to_owned()));
        assert!(launch_config
            .config_overrides
            .contains(&CODEX_SUPPRESS_UNSTABLE_FEATURES_WARNING_OVERRIDE.to_owned()));
    }

    #[test]
    fn codex_launch_config_forwards_web_search_mode() {
        let request = ExecutionRequest {
            prompt: Value::String("create a file".to_owned()),
            model_config: json!({
                "model_id": "gpt-5.5-codex",
                "web_search": "disabled",
                "image_generation": false,
                "model_context_window": 128000,
            }),
            ..ExecutionRequest::default()
        };

        let launch_config = build_codex_launch_config(&request);
        let params = thread_start_params(&request, &launch_config);
        let config = params
            .get("config")
            .and_then(Value::as_object)
            .expect("thread config should be present");

        assert_eq!(config.get("web_search"), Some(&json!("disabled")));
        assert_eq!(config.get("features.image_generation"), Some(&json!(false)));
        assert_eq!(config.get("model_context_window"), Some(&json!(128000)));
    }

    #[test]
    fn codex_launch_config_routes_marked_responses_models_through_compat_proxy() {
        let request = ExecutionRequest {
            prompt: Value::String("create a file".to_owned()),
            model_config: json!({
                "model_id": "mimo-v2.5-pro",
                "base_url": "http://models.local/v1",
                "api_key": "sk-local",
                "api_format": "responses",
                "codex_responses_compat_proxy": true,
            }),
            ..ExecutionRequest::default()
        };

        let launch_config = build_codex_launch_config(&request);

        assert!(launch_config.config_overrides.iter().any(|override_value| {
            override_value.starts_with("model_providers.wecode-openai.base_url=\"http://127.0.0.1:")
                && override_value.contains("/v1/codex-responses-proxy/codex-")
        }));
        assert!(launch_config.config_overrides.contains(
            &"model_providers.wecode-openai.experimental_bearer_token=\"wegent-codex-responses-proxy\""
                .to_owned()
        ));
    }

    #[test]
    fn codex_launch_config_forwards_runtime_proxy_env() {
        let request = ExecutionRequest {
            prompt: Value::String("create a file".to_owned()),
            model_config: json!({
                "model_id": "gpt-5.5-codex",
                "proxy": {
                    "url": "http://127.0.0.1:7890"
                },
                "runtime_config": {
                    "codex": {
                        "use_proxy": true
                    }
                }
            }),
            ..ExecutionRequest::default()
        };

        let launch_config = build_codex_launch_config(&request);

        assert_eq!(
            launch_config.env.get("HTTP_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            launch_config.env.get("HTTPS_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            launch_config.env.get("ALL_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn codex_launch_config_does_not_forward_task_identity() {
        let request = ExecutionRequest {
            task_id: "task-525".to_owned(),
            auth_token: Some("task-jwt".to_owned()),
            skill_identity_token: Some("skill-jwt".to_owned()),
            user_name: Some("alice".to_owned()),
            prompt: Value::String("create a file".to_owned()),
            model_config: json!({
                "model_id": "gpt-5.5-codex",
            }),
            ..ExecutionRequest::default()
        };

        let launch_config = build_codex_launch_config(&request);
        let params = thread_start_params(&request, &launch_config);
        let config = params
            .get("config")
            .and_then(Value::as_object)
            .expect("thread config should include shell env");

        assert!(!launch_config.env.contains_key("WEGENT_TASK_ID"));
        assert!(!launch_config.env.contains_key("AUTH_TOKEN"));
        assert!(config
            .get("shell_environment_policy.set.WEGENT_TASK_ID")
            .is_none());
        assert!(config
            .get("shell_environment_policy.set.AUTH_TOKEN")
            .is_none());
        assert!(config
            .get("shell_environment_policy.set.WEGENT_SKILL_IDENTITY_TOKEN")
            .is_none());
        assert!(config
            .get("shell_environment_policy.set.WEGENT_SKILL_USER_NAME")
            .is_none());
    }

    #[test]
    fn persistent_codex_app_server_launch_config_keeps_only_process_settings() {
        let request_launch_config = CodexLaunchConfig {
            env: BTreeMap::from([("HTTP_PROXY".to_owned(), "http://127.0.0.1:7890".to_owned())]),
            config_overrides: vec![
                "model_provider=wecode-openai".to_owned(),
                "mcp_servers.wework.command=\"node\"".to_owned(),
            ],
            model_provider: Some("wecode-openai".to_owned()),
            effort: Some("high".to_owned()),
            summary: Some("auto".to_owned()),
            ..CodexLaunchConfig::default()
        };

        let launch_config = persistent_codex_app_server_launch_config(&request_launch_config);

        assert_eq!(
            launch_config.env.get("HTTP_PROXY").map(String::as_str),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(launch_config.config_overrides, vec!["goals=true"]);
        assert!(launch_config.model_provider.is_none());
        assert!(launch_config.effort.is_none());
        assert!(launch_config.summary.is_none());
    }

    #[test]
    fn codex_run_state_keeps_commentary_agent_delta_out_of_final_content() {
        let mut state = CodexRunState::default();

        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "phase": "commentary",
                    "delta": "I will inspect."
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: String::new()
            }
        );
    }

    #[test]
    fn codex_run_state_keeps_commentary_channel_delta_out_of_final_content() {
        let mut state = CodexRunState::default();

        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "channel": "commentary",
                    "delta": "I will inspect."
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: String::new()
            }
        );
    }

    #[test]
    fn codex_run_state_keeps_completed_plan_out_of_final_content() {
        let mut state = CodexRunState::default();

        assert!(state
            .handle_message(&json!({
                "method": "item/completed",
                "params": {
                    "item": {
                        "id": "turn-1-plan",
                        "type": "plan",
                        "text": "# Plan\n\n- Execute the steps."
                    }
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: String::new()
            }
        );
    }

    #[test]
    fn codex_run_state_routes_item_id_deltas_by_started_phase() {
        let mut state = CodexRunState::default();

        assert!(state
            .handle_message(&json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "msg-commentary",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": ""
                    }
                }
            }))
            .is_none());
        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-commentary",
                    "delta": "I will inspect."
                }
            }))
            .is_none());
        assert!(state
            .handle_message(&json!({
                "method": "item/started",
                "params": {
                    "item": {
                        "id": "msg-final",
                        "type": "agentMessage",
                        "phase": "final_answer",
                        "text": ""
                    }
                }
            }))
            .is_none());
        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "itemId": "msg-final",
                    "delta": "Done."
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: "Done.".to_owned()
            }
        );
    }

    #[test]
    fn codex_run_state_keeps_unphased_agent_delta_as_final_content() {
        let mut state = CodexRunState::default();

        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "delta": "Current directory: /tmp/project"
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: "Current directory: /tmp/project".to_owned()
            }
        );
    }

    #[test]
    fn turn_start_params_includes_plan_collaboration_mode_when_requested() {
        let mut request = ExecutionRequest {
            prompt: Value::String("plan this".to_owned()),
            model_config: json!({
                "model_id": "gpt-5.5",
            }),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "collaborationMode".to_owned(),
            Value::String("plan".to_owned()),
        );
        let launch_config = CodexLaunchConfig {
            effort: Some("high".to_owned()),
            ..CodexLaunchConfig::default()
        };

        let params = turn_start_params(
            "thread-1",
            &request,
            &launch_config,
            vec![json!({"type": "text", "text": "plan this"})],
        );

        assert_eq!(params["collaborationMode"]["mode"], "plan");
        assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-5.5");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoningEffort"],
            "high"
        );
        assert!(params["collaborationMode"]["settings"]["developerInstructions"].is_null());
    }

    #[test]
    fn turn_input_expands_skill_markdown_mentions_for_app_server() {
        let input = turn_input(&Value::String(
            "[$linear](skill:///Users/me/.codex/plugins/linear/skills/linear/SKILL.md) triage"
                .to_owned(),
        ));

        assert_eq!(
            input,
            vec![
                json!({"type": "text", "text": "$linear triage", "text_elements": []}),
                json!({
                    "type": "skill",
                    "name": "linear",
                    "path": "/Users/me/.codex/plugins/linear/skills/linear/SKILL.md",
                }),
            ]
        );
    }

    #[test]
    fn turn_input_expands_app_and_plugin_markdown_mentions_for_app_server() {
        let input = turn_input(&Value::String(
            "Use [$calendar](app://google-calendar) and [$sample](plugin://sample@test)".to_owned(),
        ));

        assert_eq!(
            input,
            vec![
                json!({
                    "type": "text",
                    "text": "Use $calendar and @sample",
                    "text_elements": [],
                }),
                json!({
                    "type": "mention",
                    "name": "calendar",
                    "path": "app://google-calendar",
                }),
                json!({
                    "type": "mention",
                    "name": "sample",
                    "path": "plugin://sample@test",
                }),
            ]
        );
    }

    #[test]
    fn codex_launch_config_includes_cdp_browser_mcp_server() {
        let _lock = crate::test_env::lock();
        let home = env::temp_dir().join(format!("codex-browser-mcp-{}", std::process::id()));
        let old_home = env::var_os("WEGENT_EXECUTOR_HOME");
        env::set_var("WEGENT_EXECUTOR_HOME", &home);
        let request = ExecutionRequest {
            task_id: "task:123".to_owned(),
            ..ExecutionRequest::default()
        };

        let launch_config = build_codex_launch_config(&request);
        let params = thread_start_params(&request, &launch_config);
        let config = params
            .get("config")
            .and_then(Value::as_object)
            .expect("thread config should be present");
        let developer_instructions = config["developer_instructions"]
            .as_str()
            .expect("browser routing developer instructions should be present");

        assert!(developer_instructions.contains("browser_navigate"));
        assert!(developer_instructions.contains("browser_take_screenshot"));
        assert!(developer_instructions.contains("Wework 内置浏览器"));
        assert!(!developer_instructions.contains("playwright"));
        assert!(developer_instructions.contains("agent.browsers.get(\"iab\")"));
        assert!(developer_instructions.contains("external Chrome"));
        assert_eq!(
            config["skills.config"],
            json!([
                {
                    "name": "browser:control-in-app-browser",
                    "enabled": false,
                },
                {
                    "name": "chrome:control-chrome",
                    "enabled": false,
                },
            ])
        );
        assert_eq!(config["features.non_prefixed_mcp_tool_names"], true);
        assert_eq!(
            config["mcp_servers.wework_browser.command"],
            home.join("bin/browser-mcp-server").display().to_string()
        );
        assert_eq!(config["mcp_servers.wework_browser.startup_timeout_sec"], 15);
        assert_eq!(config["mcp_servers.wework_browser.tool_timeout_sec"], 60);
        assert_eq!(
            config["mcp_servers.wework_browser.env.WEWORK_BROWSER_MCP_TARGET"],
            "embedded"
        );
        assert_eq!(
            config["mcp_servers.wework_browser.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_URL"],
            "http://127.0.0.1:9231"
        );
        assert_eq!(
            config["mcp_servers.wework_browser.env.WEWORK_EMBEDDED_BROWSER_LABEL"],
            "workspace-browser-task-123"
        );

        if let Some(old_home) = old_home {
            env::set_var("WEGENT_EXECUTOR_HOME", old_home);
        } else {
            env::remove_var("WEGENT_EXECUTOR_HOME");
        }
    }

    #[test]
    fn turn_start_params_includes_default_collaboration_mode_when_requested() {
        let mut request = ExecutionRequest {
            prompt: Value::String("continue this".to_owned()),
            model_config: json!({
                "model_id": "gpt-5.5",
            }),
            ..ExecutionRequest::default()
        };
        request.extra.insert(
            "collaborationMode".to_owned(),
            Value::String("default".to_owned()),
        );
        let launch_config = CodexLaunchConfig {
            effort: Some("medium".to_owned()),
            ..CodexLaunchConfig::default()
        };

        let params = turn_start_params(
            "thread-1",
            &request,
            &launch_config,
            vec![json!({"type": "text", "text": "continue this"})],
        );

        assert_eq!(params["collaborationMode"]["mode"], "default");
        assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-5.5");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoningEffort"],
            "medium"
        );
        assert!(params["collaborationMode"]["settings"]["developerInstructions"].is_null());
    }

    #[test]
    fn thread_goal_set_params_maps_initial_goal() {
        let params = thread_goal_set_params(
            "thread-1",
            &json!({
                "objective": "ship the feature",
                "status": "paused",
                "tokenBudget": 1200,
            }),
        )
        .expect("initial goal should map to Codex goal params");

        assert_eq!(
            params,
            json!({
                "threadId": "thread-1",
                "objective": "ship the feature",
                "status": "paused",
                "tokenBudget": 1200,
            })
        );
    }

    #[test]
    fn thread_goal_set_params_rejects_empty_objective() {
        let error = thread_goal_set_params("thread-1", &json!({"objective": "   "}))
            .expect_err("empty objective should be rejected");

        assert_eq!(error, "initial goal objective is required");
    }

    #[test]
    fn codex_run_state_ignores_subagent_turn_completion() {
        let mut state = CodexRunState::default();

        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "delta": "Still working"
                }
            }))
            .is_none());
        assert!(state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed",
                        "agent_path": "/root/worker"
                    }
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "turn": {
                        "status": "completed",
                        "agent_path": "/root"
                    }
                }
            }))
            .expect("root turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: "Still working".to_owned()
            }
        );
    }

    #[test]
    fn codex_run_state_ignores_cross_thread_final_deltas() {
        let mut state = CodexRunState::default();
        state.set_root_thread_id("root-thread");

        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "child-thread",
                    "turnId": "child-turn",
                    "itemId": "msg-child",
                    "delta": "child"
                }
            }))
            .is_none());
        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "msg-root",
                    "delta": "root"
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "root-thread",
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("root turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: "root".to_owned()
            }
        );
    }

    #[test]
    fn codex_run_state_ignores_cross_thread_turn_completion() {
        let mut state = CodexRunState::default();
        state.set_root_thread_id("root-thread");

        assert!(state
            .handle_message(&json!({
                "method": "item/agentMessage/delta",
                "params": {
                    "threadId": "root-thread",
                    "turnId": "root-turn",
                    "itemId": "msg-root",
                    "delta": "root"
                }
            }))
            .is_none());
        assert!(state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "child-thread",
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .is_none());

        let outcome = state
            .handle_message(&json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "root-thread",
                    "turn": {
                        "status": "completed"
                    }
                }
            }))
            .expect("root turn completion should produce an outcome");

        assert_eq!(
            outcome,
            ExecutionOutcome::Completed {
                content: "root".to_owned()
            }
        );
    }
}
