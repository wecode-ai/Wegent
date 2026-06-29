// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    env, fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use futures_util::future::BoxFuture;
use serde_json::Map;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, Mutex},
    time::timeout,
};

use crate::{
    agents::runtime_capabilities,
    attachments::{process_prompt, AttachmentRecord},
    codex_phase::{codex_phase_is_process, CodexAgentMessagePhaseTracker},
    image_preprocessor::prepare_image_bytes_for_model,
    logging::{log_executor_event, task_fields},
    process::CommandSpec,
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
};

use super::{model_id, prompt_text};

const DEFAULT_CODEX_RPC_TIMEOUT_SECONDS: u64 = 300;
const DEFAULT_PROVIDER_ID: &str = "wecode-openai";
const DEFAULT_PROVIDER_NAME: &str = "wecode openai";
const DEFAULT_REASONING_EFFORT: &str = "medium";
const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1,host.docker.internal";
const MACOS_CODEX_APP_BINARY: &str = "/Applications/Codex.app/Contents/Resources/codex";
const IMAGE_MIME_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/gif",
    "image/webp",
    "image/bmp",
];

pub type CodexNotificationSender = mpsc::UnboundedSender<Value>;

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
            match run_codex_app_server_turn(&binary, request, None, None).await {
                Ok(turn) => turn.outcome,
                Err(message) => ExecutionOutcome::Failed { message },
            }
        })
    }
}

pub fn build_codex_app_server_command(binary: &str) -> CommandSpec {
    CommandSpec::new(binary).arg("app-server").arg("--stdio")
}

#[derive(Clone)]
pub struct CodexAppServerClient {
    binary: String,
    server: Arc<Mutex<Option<CodexAppServerProcess>>>,
}

impl CodexAppServerClient {
    pub fn new(binary: impl Into<String>) -> Self {
        Self {
            binary: resolve_codex_binary(&binary.into()),
            server: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let result = self.request_once(method, params.clone()).await;
        if result.is_err() && codex_app_server_request_is_retryable(method) {
            return self.request_once(method, params).await;
        }
        result
    }

    async fn request_once(&self, method: &str, params: Value) -> Result<Value, String> {
        let timeout_seconds = codex_rpc_timeout_seconds();
        let mut server = self.server.lock().await;
        if server.is_none() {
            *server = Some(start_persistent_codex_app_server(&self.binary).await?);
        }

        let result = {
            let server = server
                .as_mut()
                .expect("persistent Codex app-server was initialized");
            with_rpc_timeout(
                method,
                timeout_seconds,
                server.rpc.request_ignoring_notifications(method, params),
            )
            .await
        };

        if result.is_err() {
            if let Some(server) = server.take() {
                server.shutdown().await;
            }
        }

        result
    }
}

fn codex_app_server_request_is_retryable(method: &str) -> bool {
    matches!(method, "thread/list" | "thread/read")
}

struct CodexAppServerProcess {
    child: Child,
    rpc: JsonRpcConnection,
}

impl CodexAppServerProcess {
    async fn shutdown(mut self) {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

impl Drop for CodexAppServerProcess {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn start_persistent_codex_app_server(binary: &str) -> Result<CodexAppServerProcess, String> {
    let launch_config = CodexLaunchConfig::default();
    let mut child = spawn_codex_app_server(binary, &launch_config)?;
    let result: Result<JsonRpcConnection, String> = async {
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
        Ok(rpc)
    }
    .await;

    match result {
        Ok(rpc) => Ok(CodexAppServerProcess { child, rpc }),
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            Err(error)
        }
    }
}

pub async fn run_codex_app_server_turn(
    binary: &str,
    request: ExecutionRequest,
    resume_thread_id: Option<String>,
    notifications: Option<CodexNotificationSender>,
) -> Result<CodexAppServerTurn, String> {
    let prepared = prepare_codex_execution_request(request);
    let launch_config = build_codex_launch_config(&prepared.request);
    let mut fields = task_fields(prepared.request.task_id, prepared.request.subtask_id);
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
        let (thread_operation, thread_params) = if let Some(thread_id) = resume_thread_id {
            (
                "thread/resume",
                thread_resume_params(&thread_id, request, &launch_config),
            )
        } else {
            ("thread/start", thread_start_params(request, &launch_config))
        };
        let mut thread_fields = task_fields(request.task_id, request.subtask_id);
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
            .ok_or_else(|| format!("codex app-server {thread_operation} did not return thread.id"))?
            .to_owned();
        thread_fields.push(("thread_id", thread_id.clone()));
        log_executor_event("codex thread request finished", &thread_fields);

        let turn_input = turn_input(&request.prompt);
        let mut turn_fields = task_fields(request.task_id, request.subtask_id);
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
        let outcome = with_rpc_timeout(
            "turn",
            timeout_seconds,
            rpc.read_turn(turn_request_id, &mut state, notifications),
        )
        .await?;
        turn_fields.push(("outcome", codex_outcome_name(&outcome).to_owned()));
        if let ExecutionOutcome::Failed { message } = &outcome {
            turn_fields.push(("error", message.clone()));
            turn_fields.push(("error_len", message.len().to_string()));
        }
        log_executor_event("codex turn request finished", &turn_fields);
        Ok(CodexAppServerTurn { thread_id, outcome })
    }
    .await;

    let _ = child.start_kill();
    let _ = child.wait().await;
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

fn spawn_codex_app_server(
    binary: &str,
    launch_config: &CodexLaunchConfig,
) -> Result<tokio::process::Child, String> {
    let resolved_binary = resolve_codex_binary(binary);
    let mut env_values = launch_config.env.clone();
    prepare_codex_runtime_environment(&mut env_values)?;
    let mut command = Command::new(&resolved_binary);
    for config_override in &launch_config.config_overrides {
        command.arg("-c").arg(config_override);
    }
    command.arg("app-server").arg("--stdio");
    for (key, value) in &env_values {
        command.env(key, value);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start codex app-server: {error}"))
}

fn prepare_codex_runtime_environment(
    env_values: &mut BTreeMap<String, String>,
) -> Result<(), String> {
    let runtime_home = codex_runtime_home();
    prepare_codex_runtime_home(&runtime_home)?;
    env_values.insert("CODEX_HOME".to_owned(), runtime_home.display().to_string());
    Ok(())
}

fn prepare_codex_runtime_home(runtime_home: &Path) -> Result<(), String> {
    fs::create_dir_all(runtime_home).map_err(|error| {
        format!(
            "failed to create isolated Codex home {}: {error}",
            runtime_home.display()
        )
    })?;
    remove_runtime_capability_dir(runtime_home, "skills")?;
    remove_runtime_capability_dir(runtime_home, "plugins")?;
    let source_home = user_codex_home(runtime_home);
    sync_codex_runtime_file(&source_home, runtime_home, "auth.json")?;
    sync_codex_runtime_file(&source_home, runtime_home, "config.toml")?;
    Ok(())
}

fn codex_runtime_home() -> PathBuf {
    env::var_os("WEGENT_CODEX_RUNTIME_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| executor_home().join("codex-runtime"))
}

fn user_codex_home(runtime_home: &Path) -> PathBuf {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path != runtime_home)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".codex")))
        .unwrap_or_else(|| PathBuf::from(".codex"))
}

fn remove_runtime_capability_dir(runtime_home: &Path, name: &str) -> Result<(), String> {
    let path = runtime_home.join(name);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return Ok(());
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        fs::remove_dir_all(&path)
    } else {
        fs::remove_file(&path)
    };
    if let Err(error) = result {
        return Err(format!(
            "failed to remove isolated Codex {} path {}: {error}",
            name,
            path.display()
        ));
    }
    Ok(())
}

fn sync_codex_runtime_file(
    source_home: &Path,
    runtime_home: &Path,
    filename: &str,
) -> Result<(), String> {
    let source = source_home.join(filename);
    let target = runtime_home.join(filename);
    if source == target {
        return Ok(());
    }
    if !source.is_file() {
        if target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove stale isolated Codex file {}: {error}",
                    target.display()
                )
            })?;
        }
        return Ok(());
    }
    fs::copy(&source, &target).map_err(|error| {
        format!(
            "failed to copy Codex {} from {} to {}: {error}",
            filename,
            source.display(),
            target.display()
        )
    })?;
    Ok(())
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
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
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
                return Err(message_params(&message)
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex app-server error")
                    .to_owned());
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
            if let Some(outcome) = state.handle_message(&message) {
                return Ok(outcome);
            }
            if !saw_turn_response {
                continue;
            }
        }
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
}

impl CodexRunState {
    fn handle_message(&mut self, message: &Value) -> Option<ExecutionOutcome> {
        match message.get("method").and_then(Value::as_str) {
            Some("item/started") => {
                self.agent_message_phases
                    .observe_item(message_params(message));
                None
            }
            Some("item/agentMessage/delta") => {
                self.append_delta(message_params(message));
                None
            }
            Some("item/completed") => {
                let params = message_params(message);
                self.append_completed_message(params);
                self.agent_message_phases.forget_item(params);
                None
            }
            Some("turn/completed") => Some(self.completed(message_params(message))),
            Some("error") => {
                let params = message_params(message);
                log_codex_run_state_error(params);
                Some(ExecutionOutcome::Failed {
                    message: params
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("codex app-server error")
                        .to_owned(),
                })
            }
            _ => None,
        }
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

fn log_codex_run_state_text(
    source: &str,
    action: &str,
    resolved_phase: Option<&str>,
    params: &Value,
    item: &Value,
    text: &str,
) {
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
    let params_json = serde_json::to_string(params)
        .unwrap_or_else(|error| format!("failed to serialize codex error params: {error}"));
    log_executor_event(
        "codex run state error",
        &[
            ("message", json_string_field(params, "message")),
            ("code", json_string_field(params, "code")),
            ("params_len", params_json.len().to_string()),
            ("params_preview", truncate_log_text(&params_json, 500)),
        ],
    );
}

fn log_codex_raw_turn_message(message: &Value) {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
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
    let raw = serde_json::to_string(message)
        .unwrap_or_else(|error| format!("failed to serialize codex raw message: {error}"));
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
            ("raw_len", raw.len().to_string()),
            ("raw_preview", truncate_log_text(&raw, 1200)),
        ],
    );
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
                toml_value(base_url.trim_end_matches('/'))
            ),
            format!(
                "model_providers.{model_provider}.wire_api={}",
                toml_value(&wire_api(&request.model_config))
            ),
            format!(
                "model_providers.{model_provider}.experimental_bearer_token={}",
                toml_value(&api_key)
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
        .extend(runtime_capabilities::request_mcp_config_overrides(request));
    launch_config
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
    let Some(proxy_url) = model_config
        .get("proxy")
        .and_then(|proxy| proxy.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
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

    let mut generated_files = Vec::new();
    let subtask_id = attachment_subtask_id(&attachments, request.subtask_id);
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
            Some(request.task_id),
            Some(subtask_id),
        );
    }
    request.prompt = prompt_with_codex_local_images(&request.prompt, &local_images);

    PreparedCodexExecutionRequest {
        request,
        generated_files,
    }
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
            .and_then(value_i64),
        error: value.get("error").and_then(value_string),
    })
}

fn attachment_subtask_id(attachments: &[AttachmentRecord], fallback: i64) -> i64 {
    attachments
        .iter()
        .find_map(|attachment| attachment.subtask_id)
        .unwrap_or(fallback)
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
    Value::Object(params)
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
    if !launch_config.thread_config.is_empty() {
        params.insert(
            "config".to_owned(),
            Value::Object(launch_config.thread_config.clone()),
        );
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
    Value::Object(params)
}

fn turn_input(prompt: &Value) -> Vec<Value> {
    let Value::Array(items) = prompt else {
        return vec![text_input(prompt_text(prompt))];
    };

    let mut input = items.iter().filter_map(turn_input_item).collect::<Vec<_>>();
    if input.is_empty() {
        input.push(text_input(prompt_text(prompt)));
    }
    input
}

fn turn_input_item(item: &Value) -> Option<Value> {
    let kind = item.get("type").and_then(Value::as_str)?;
    match kind {
        "input_text" | "text" => item
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text_input(text.to_owned())),
        "input_image" => item
            .get("image_url")
            .or_else(|| item.get("url"))
            .and_then(Value::as_str)
            .map(|url| json!({"type": "image", "url": url})),
        "image" => image_input(item),
        "localImage" | "local_image" => item
            .get("path")
            .and_then(Value::as_str)
            .map(|path| json!({"type": "localImage", "path": path})),
        _ => item
            .get("text")
            .and_then(Value::as_str)
            .map(|text| text_input(text.to_owned())),
    }
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

fn message_params(message: &Value) -> &Value {
    message.get("params").unwrap_or(message)
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
}
