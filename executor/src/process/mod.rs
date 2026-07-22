// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    future::Future,
    io::Write,
    path::PathBuf,
    pin::Pin,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
    time::Instant,
};

use chrono::{Local, SecondsFormat};
use serde_json::{Map, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::Command,
    sync::mpsc::{unbounded_channel, UnboundedSender},
    sync::oneshot,
    time::timeout,
};

use crate::{
    agents::interactive_mcp::{
        deferred_proxy_exception_failure, deferred_proxy_response_decision,
        proxy_deferred_mcp_tool, ClaudeFollowUpQuery, DeferredMcpResponseAction,
    },
    claude_session,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    stream::{
        collect_claude_stream_summary, compact_claude_stdout_line, extract_claude_child_blocks,
        extract_claude_subagent_update, extract_claude_tool_results, extract_claude_tool_uses,
        extract_reasoning, extract_text, ClaudeAsyncTaskTracker, ClaudeStdoutJsonBuffer,
        ClaudeStdoutJsonError, ClaudeToolUse,
    },
};

const DEFAULT_STREAM_TEXT_CHUNK_CHARS: usize = 256;
const DEFAULT_STREAM_REASONING_CHUNK_CHARS: usize = 4_096;
const MAX_DEFERRED_MCP_RETRIES: usize = 2;
const MAX_API_ERROR_RETRIES: usize = 3;
const DEBUG_CLAUDE_STDOUT_ENV: &str = "WEGENT_DEBUG_CLAUDE_STDOUT";
const STDERR_PREVIEW_MAX_CHARS: usize = 500;

#[derive(Clone, Default)]
struct NoopEventSink;

impl EventSink for NoopEventSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, _event: crate::emitter::EventEnvelope) -> Self::SendFuture {
        std::future::ready(Ok(()))
    }
}

#[derive(Clone)]
struct StreamingEventDispatcher {
    sender: UnboundedSender<QueuedStreamEvent>,
    pending: Arc<AtomicUsize>,
    compact_pending_text: Arc<AtomicBool>,
}

struct QueuedStreamEvent {
    kind: QueuedStreamEventKind,
}

enum QueuedStreamEventKind {
    Callback {
        event: Box<EventEnvelope>,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
        text_delta_chars: usize,
    },
    Flush {
        done: oneshot::Sender<()>,
    },
}

struct CompactedTextDelta {
    event: EventEnvelope,
    text: String,
}

fn compact_text_delta(
    compacted: &mut Option<CompactedTextDelta>,
    event: Box<EventEnvelope>,
) -> Result<(), Box<EventEnvelope>> {
    if event.event_type != "response.output_text.delta" {
        return Err(event);
    }
    let Some(delta) = event
        .data
        .get("delta")
        .and_then(Value::as_str)
        .map(str::to_owned)
    else {
        return Err(event);
    };
    if delta.is_empty() {
        return Ok(());
    }
    if let Some(existing) = compacted.as_mut() {
        existing.text.push_str(&delta);
        return Ok(());
    }
    let event = *event;
    *compacted = Some(CompactedTextDelta { event, text: delta });
    Ok(())
}

async fn send_compacted_text_delta<S>(sink: &S, compacted: &mut Option<CompactedTextDelta>)
where
    S: EventSink,
{
    let Some(mut compacted_text) = compacted.take() else {
        return;
    };
    let text_chars = compacted_text.text.chars().count();
    compacted_text.event.data["delta"] = Value::String(compacted_text.text);
    let task_id = compacted_text.event.task_id.clone();
    let subtask_id = compacted_text.event.subtask_id.clone();
    if let Err(message) = sink.send(compacted_text.event).await {
        let fields = vec![
            ("task_id", task_id.clone()),
            ("subtask_id", subtask_id.clone()),
            ("error_len", message.len().to_string()),
        ];
        log_executor_event("streaming compacted text callback failed", &fields);
    }
    let fields = vec![
        ("task_id", task_id),
        ("subtask_id", subtask_id),
        ("text_chars", text_chars.to_string()),
    ];
    log_executor_event("streaming compacted text emitted", &fields);
}

impl StreamingEventDispatcher {
    fn new<S>(sink: S) -> Self
    where
        S: EventSink,
    {
        let (sender, mut receiver) = unbounded_channel::<QueuedStreamEvent>();
        let pending = Arc::new(AtomicUsize::new(0));
        let worker_pending = Arc::clone(&pending);
        let compact_pending_text = Arc::new(AtomicBool::new(false));
        let worker_compact_pending_text = Arc::clone(&compact_pending_text);
        tokio::spawn(async move {
            let mut compacted_text: Option<CompactedTextDelta> = None;
            while let Some(queued) = receiver.recv().await {
                match queued.kind {
                    QueuedStreamEventKind::Callback {
                        event,
                        log_name,
                        fields,
                        text_delta_chars,
                    } => {
                        let event = if worker_compact_pending_text.load(Ordering::Relaxed)
                            && text_delta_chars > 0
                        {
                            match compact_text_delta(&mut compacted_text, event) {
                                Ok(()) => {
                                    worker_pending.fetch_sub(1, Ordering::Relaxed);
                                    continue;
                                }
                                Err(original_event) => original_event,
                            }
                        } else {
                            event
                        };
                        send_compacted_text_delta(&sink, &mut compacted_text).await;
                        let event = *event;
                        let started = Instant::now();
                        let event_type = event.event_type.clone();
                        let task_id = event.task_id.clone();
                        let subtask_id = event.subtask_id.clone();
                        let message_id = event.message_id.map(|value| value.to_string());
                        if let Err(message) = sink.send(event).await {
                            let mut fields = fields;
                            fields.push(("error_len", message.len().to_string()));
                            log_executor_event(log_name, &fields);
                        }
                        let remaining = worker_pending
                            .fetch_sub(1, Ordering::Relaxed)
                            .saturating_sub(1);
                        let elapsed_ms = started.elapsed().as_millis();
                        if elapsed_ms >= 1_000 {
                            let fields = vec![
                                ("task_id", task_id),
                                ("subtask_id", subtask_id),
                                ("event_type", event_type),
                                ("elapsed_ms", elapsed_ms.to_string()),
                                ("pending_depth", remaining.to_string()),
                                ("message_id", message_id.unwrap_or_default()),
                            ];
                            log_executor_event("streaming callback dispatch slow", &fields);
                        }
                    }
                    QueuedStreamEventKind::Flush { done } => {
                        send_compacted_text_delta(&sink, &mut compacted_text).await;
                        let _ = done.send(());
                    }
                }
            }
        });
        Self {
            sender,
            pending,
            compact_pending_text,
        }
    }

    async fn flush(&self) {
        let (done, wait) = oneshot::channel();
        if self
            .sender
            .send(QueuedStreamEvent {
                kind: QueuedStreamEventKind::Flush { done },
            })
            .is_err()
        {
            log_executor_event("streaming callback queue closed", &[]);
            return;
        }
        let _ = wait.await;
    }

    async fn compact_pending_text_and_flush(&self, task_id: &str, subtask_id: &str) {
        self.compact_pending_text.store(true, Ordering::Relaxed);
        let fields = vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            (
                "pending_depth",
                self.pending.load(Ordering::Relaxed).to_string(),
            ),
        ];
        log_executor_event("streaming callback queue compaction requested", &fields);
        self.flush().await;
    }

    fn send(
        &self,
        event: EventEnvelope,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
    ) {
        self.send_internal(event, log_name, fields, 0);
    }

    fn send_text_delta(
        &self,
        event: EventEnvelope,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
        text_delta_chars: usize,
    ) {
        self.send_internal(event, log_name, fields, text_delta_chars);
    }

    fn send_internal(
        &self,
        event: EventEnvelope,
        log_name: &'static str,
        fields: Vec<(&'static str, String)>,
        text_delta_chars: usize,
    ) {
        let depth = self.pending.fetch_add(1, Ordering::Relaxed) + 1;
        if depth % 100 == 0 {
            let mut queue_fields = fields.clone();
            queue_fields.push(("pending_depth", depth.to_string()));
            queue_fields.push(("event_type", event.event_type.clone()));
            log_executor_event("streaming callback queue depth", &queue_fields);
        }
        if self
            .sender
            .send(QueuedStreamEvent {
                kind: QueuedStreamEventKind::Callback {
                    event: Box::new(event),
                    log_name,
                    fields,
                    text_delta_chars,
                },
            })
            .is_err()
        {
            self.pending.fetch_sub(1, Ordering::Relaxed);
            log_executor_event("streaming callback queue closed", &[]);
        }
    }
}

#[derive(Clone)]
enum FollowUpCommandRunner<S>
where
    S: EventSink,
{
    Silent,
    Streaming {
        sink: S,
        builder: Box<ResponsesEventBuilder>,
        task_id: String,
        subtask_id: String,
    },
}

impl<S> FollowUpCommandRunner<S>
where
    S: EventSink,
{
    async fn run(&self, spec: CommandSpec, timeout_seconds: u64) -> CommandOutcome {
        match self {
            FollowUpCommandRunner::Silent => run_command_output(spec, timeout_seconds).await,
            FollowUpCommandRunner::Streaming {
                sink,
                builder,
                task_id,
                subtask_id,
            } => {
                run_streaming_command_output(
                    spec,
                    timeout_seconds,
                    sink.clone(),
                    builder.as_ref().clone(),
                    task_id.clone(),
                    subtask_id.clone(),
                )
                .await
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    program: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    cwd: Option<PathBuf>,
    stdin: Option<String>,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: program.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
            cwd: None,
            stdin: None,
        }
    }

    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    pub fn stdin(mut self, input: impl Into<String>) -> Self {
        self.stdin = Some(input.into());
        self
    }

    pub fn program(&self) -> &str {
        &self.program
    }

    pub fn args(&self) -> &[String] {
        &self.args
    }

    pub fn envs(&self) -> &BTreeMap<String, String> {
        &self.env
    }

    pub fn current_dir(&self) -> Option<&PathBuf> {
        self.cwd.as_ref()
    }

    pub fn stdin_input(&self) -> Option<&str> {
        self.stdin.as_deref()
    }
}

#[derive(Debug, Clone)]
pub struct ProcessEngine {
    spec: CommandSpec,
    timeout_seconds: u64,
}

impl ProcessEngine {
    pub fn new(spec: CommandSpec, timeout_seconds: u64) -> Self {
        assert!(timeout_seconds > 0, "timeout_seconds must be positive");
        Self {
            spec,
            timeout_seconds,
        }
    }
}

impl AgentEngine for ProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
        let spec = self.spec.clone();
        let timeout_seconds = self.timeout_seconds;
        Box::pin(async move { run_command(spec, timeout_seconds).await })
    }
}

#[derive(Debug, Clone)]
pub struct StreamProcessEngine {
    spec: CommandSpec,
    timeout_seconds: u64,
}

impl StreamProcessEngine {
    pub fn new(spec: CommandSpec, timeout_seconds: u64) -> Self {
        assert!(timeout_seconds > 0, "timeout_seconds must be positive");
        Self {
            spec,
            timeout_seconds,
        }
    }
}

impl AgentEngine for StreamProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let spec = self.spec.clone();
        let timeout_seconds = self.timeout_seconds;
        Box::pin(async move {
            match run_command_output(spec.clone(), timeout_seconds).await {
                CommandOutcome::Success { stdout } => {
                    let summary = collect_claude_stream_summary(&stdout);
                    if let Some(session_id) = &summary.session_id {
                        claude_session::save_session_id(&request, session_id);
                    }
                    let summary = handle_retryable_api_errors(
                        spec.clone(),
                        &request,
                        summary,
                        timeout_seconds,
                        FollowUpCommandRunner::<NoopEventSink>::Silent,
                    )
                    .await;
                    if summary.deferred_tool_use.is_some() {
                        handle_deferred_mcp_loop(
                            spec,
                            request,
                            summary,
                            timeout_seconds,
                            FollowUpCommandRunner::<NoopEventSink>::Silent,
                        )
                        .await
                    } else {
                        summary.outcome
                    }
                }
                CommandOutcome::Failure { stderr, stdout, .. } => ExecutionOutcome::Failed {
                    message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                },
            }
        })
    }

    fn run_with_events<S>(
        &self,
        request: ExecutionRequest,
        sink: S,
        builder: ResponsesEventBuilder,
    ) -> Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>
    where
        S: EventSink,
    {
        let spec = self.spec.clone();
        let timeout_seconds = self.timeout_seconds;
        Box::pin(async move {
            match run_streaming_command_output(
                spec.clone(),
                timeout_seconds,
                sink.clone(),
                builder.clone(),
                request.task_id.clone(),
                request.subtask_id.clone(),
            )
            .await
            {
                CommandOutcome::Success { stdout } => {
                    let summary = collect_claude_stream_summary(&stdout);
                    if let Some(session_id) = &summary.session_id {
                        claude_session::save_session_id(&request, session_id);
                    }
                    let follow_up_runner = FollowUpCommandRunner::Streaming {
                        sink,
                        builder: Box::new(builder),
                        task_id: request.task_id.clone(),
                        subtask_id: request.subtask_id.clone(),
                    };
                    let summary = handle_retryable_api_errors(
                        spec.clone(),
                        &request,
                        summary,
                        timeout_seconds,
                        follow_up_runner.clone(),
                    )
                    .await;
                    if summary.deferred_tool_use.is_some() {
                        handle_deferred_mcp_loop(
                            spec,
                            request,
                            summary,
                            timeout_seconds,
                            follow_up_runner,
                        )
                        .await
                    } else {
                        summary.outcome
                    }
                }
                CommandOutcome::Failure { stderr, stdout, .. } => ExecutionOutcome::Failed {
                    message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                },
            }
        })
    }
}

async fn handle_retryable_api_errors(
    base_spec: CommandSpec,
    request: &ExecutionRequest,
    mut summary: crate::stream::ClaudeStreamSummary,
    timeout_seconds: u64,
    runner: FollowUpCommandRunner<impl EventSink>,
) -> crate::stream::ClaudeStreamSummary {
    let fields = task_fields(&request.task_id, &request.subtask_id);
    let mut retry_count = 0;
    while summary.retryable_api_error && retry_count < MAX_API_ERROR_RETRIES {
        let Some(session_id) = summary.session_id.clone() else {
            return summary;
        };
        retry_count += 1;
        let mut retry_fields = fields.clone();
        retry_fields.push(("retry_count", retry_count.to_string()));
        log_executor_event("claude api error retry started", &retry_fields);
        let retry_spec = claude_follow_up_resume_spec(
            &base_spec,
            &session_id,
            ClaudeFollowUpQuery::Prompt("Retry to proceed".to_owned()),
        );
        match runner.run(retry_spec, timeout_seconds).await {
            CommandOutcome::Success { stdout } => {
                summary = collect_claude_stream_summary(&stdout);
                if let Some(session_id) = &summary.session_id {
                    claude_session::save_session_id(request, session_id);
                }
            }
            CommandOutcome::Failure { stderr, stdout, .. } => {
                return crate::stream::ClaudeStreamSummary {
                    outcome: ExecutionOutcome::Failed {
                        message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                    },
                    session_id: Some(session_id),
                    deferred_tool_use: None,
                    stop_reason: None,
                    usage: Value::Null,
                    retryable_api_error: false,
                };
            }
        }
    }
    summary
}

async fn handle_deferred_mcp_loop(
    base_spec: CommandSpec,
    request: ExecutionRequest,
    mut summary: crate::stream::ClaudeStreamSummary,
    timeout_seconds: u64,
    runner: FollowUpCommandRunner<impl EventSink>,
) -> ExecutionOutcome {
    let mcp_servers = mcp_servers_from_spec(&base_spec).unwrap_or(Value::Null);
    let mut retry_count = 0;
    let mut stale_answer_defer_drained = false;
    let fields = task_fields(&request.task_id, &request.subtask_id);

    loop {
        let Some(deferred_tool_use) = summary.deferred_tool_use.clone() else {
            return summary.outcome;
        };
        // After draining an already answered form, a non-empty final answer is
        // authoritative; a leftover deferred form is stale Claude session state.
        if stale_answer_defer_drained
            && answered_interactive_form_tool_use_id(&request).is_some()
            && completed_with_content(&summary.outcome)
        {
            log_executor_event("ignoring stale deferred form after answered drain", &fields);
            return summary.outcome;
        }
        if !stale_answer_defer_drained
            && answered_interactive_form_tool_use_id(&request)
                .is_some_and(|tool_use_id| tool_use_id == deferred_tool_use.id)
        {
            stale_answer_defer_drained = true;
            log_executor_event("draining stale answered interactive form defer", &fields);
            match runner.run(base_spec.clone(), timeout_seconds).await {
                CommandOutcome::Success { stdout } => {
                    summary = collect_claude_stream_summary(&stdout);
                    if let Some(session_id) = &summary.session_id {
                        claude_session::save_session_id(&request, session_id);
                    }
                    continue;
                }
                CommandOutcome::Failure { stderr, stdout, .. } => {
                    return ExecutionOutcome::Failed {
                        message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                    }
                }
            }
        }
        log_executor_event("deferred mcp proxy started", &fields);
        let proxy_result = match proxy_deferred_mcp_tool(&deferred_tool_use, &mcp_servers).await {
            Ok(proxy_result) => proxy_result,
            Err(error) => {
                let decision = deferred_proxy_exception_failure(&deferred_tool_use, &error);
                let mut failed_fields = fields.clone();
                failed_fields.push(("error_len", error.len().to_string()));
                log_executor_event("deferred mcp proxy failed", &failed_fields);
                return ExecutionOutcome::Failed {
                    message: decision
                        .user_error
                        .unwrap_or_else(|| "交互式表单生成失败".to_owned()),
                };
            }
        };
        let decision = deferred_proxy_response_decision(
            &proxy_result,
            summary.stop_reason.as_deref().unwrap_or("tool_deferred"),
            summary.usage.clone(),
            retry_count,
            MAX_DEFERRED_MCP_RETRIES,
        );
        match decision.action {
            DeferredMcpResponseAction::CompleteWaitingForUser => {
                log_executor_event("deferred mcp proxy waiting for user", &fields);
                return ExecutionOutcome::WaitingForUserInput {
                    stop_reason: decision
                        .done
                        .as_ref()
                        .map(|done| done.stop_reason.clone())
                        .unwrap_or_else(|| "tool_deferred".to_owned()),
                };
            }
            DeferredMcpResponseAction::Fail => {
                log_executor_event("deferred mcp proxy invalid form", &fields);
                return ExecutionOutcome::Failed {
                    message: decision
                        .user_error
                        .unwrap_or_else(|| "模型给出的表单格式不对".to_owned()),
                };
            }
            DeferredMcpResponseAction::Retry => {
                let Some(retry_query) = decision.retry_query else {
                    return ExecutionOutcome::Failed {
                        message: "模型给出的表单格式不对".to_owned(),
                    };
                };
                let Some(session_id) = summary.session_id.clone() else {
                    return ExecutionOutcome::Failed {
                        message: "模型给出的表单格式不对".to_owned(),
                    };
                };
                retry_count += 1;
                log_executor_event("deferred mcp retry started", &fields);
                let retry_spec = claude_follow_up_resume_spec(
                    &base_spec,
                    &session_id,
                    ClaudeFollowUpQuery::ToolResult(retry_query),
                );
                match runner.run(retry_spec, timeout_seconds).await {
                    CommandOutcome::Success { stdout } => {
                        summary = collect_claude_stream_summary(&stdout);
                        if let Some(session_id) = &summary.session_id {
                            claude_session::save_session_id(&request, session_id);
                        }
                        if summary.deferred_tool_use.is_none() {
                            return summary.outcome;
                        }
                    }
                    CommandOutcome::Failure { stderr, stdout, .. } => {
                        return ExecutionOutcome::Failed {
                            message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                        }
                    }
                }
            }
        }
    }
}

fn completed_with_content(outcome: &ExecutionOutcome) -> bool {
    matches!(outcome, ExecutionOutcome::Completed { content } if !content.trim().is_empty())
}

fn answered_interactive_form_tool_use_id(request: &ExecutionRequest) -> Option<String> {
    request
        .extra
        .get("interactive_form_answer")?
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn claude_follow_up_resume_spec(
    base_spec: &CommandSpec,
    session_id: &str,
    query: ClaudeFollowUpQuery,
) -> CommandSpec {
    let mut spec = CommandSpec::new(base_spec.program.clone());
    spec.env = base_spec.env.clone();
    spec.cwd = base_spec.cwd.clone();
    let mut skip_next = false;
    for arg in &base_spec.args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "-p" || arg == "--print" || arg == "--resume" || arg == "--input-format" {
            skip_next = true;
            continue;
        }
        spec.args.push(arg.clone());
    }
    spec.args.push("--resume".to_owned());
    spec.args.push(session_id.to_owned());
    match query {
        ClaudeFollowUpQuery::Prompt(prompt) => {
            spec.args.push("-p".to_owned());
            spec.args.push(prompt);
        }
        ClaudeFollowUpQuery::ToolResult(value) => {
            spec.args.push("--input-format".to_owned());
            spec.args.push("stream-json".to_owned());
            spec.stdin = Some(format!("{value}\n"));
        }
    }
    spec
}

fn mcp_servers_from_spec(spec: &CommandSpec) -> Option<Value> {
    if let Some(path) = spec.env.get("WEGENT_MCP_CONFIG_PATH") {
        return read_json_file(path);
    }
    spec.args
        .windows(2)
        .find_map(|window| (window[0] == "--mcp-config").then(|| read_json_file(&window[1])))
        .flatten()
}

fn read_json_file(path: &str) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

async fn run_command(spec: CommandSpec, timeout_seconds: u64) -> ExecutionOutcome {
    match run_command_output(spec, timeout_seconds).await {
        CommandOutcome::Success { stdout } => ExecutionOutcome::Completed { content: stdout },
        CommandOutcome::Failure { stderr, stdout, .. } => ExecutionOutcome::Failed {
            message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
        },
    }
}

enum CommandOutcome {
    Success {
        stdout: String,
    },
    Failure {
        stderr: String,
        stdout: String,
        exit_code: Option<i32>,
    },
}

enum StreamingStdoutOutcome {
    Success(String),
    InvalidJson {
        stdout: String,
        error: ClaudeStdoutJsonError,
    },
}

async fn run_command_output(spec: CommandSpec, timeout_seconds: u64) -> CommandOutcome {
    let mut command = Command::new(&spec.program);
    command.args(&spec.args).envs(&spec.env);
    command.kill_on_drop(true);
    if let Some(cwd) = spec.cwd.as_ref() {
        if let Err(error) = fs::create_dir_all(cwd) {
            return CommandOutcome::Failure {
                stderr: format!("failed to create command cwd {}: {error}", cwd.display()),
                stdout: String::new(),
                exit_code: None,
            };
        }
        command.current_dir(cwd);
    }

    let mut fields = command_log_fields(&spec);
    fields.push(("timeout_seconds", timeout_seconds.to_string()));
    log_executor_event("process started", &fields);
    let started = Instant::now();
    let outcome = match timeout(
        Duration::from_secs(timeout_seconds),
        run_prepared_command(command, spec.stdin.clone()),
    )
    .await
    {
        Err(_) => CommandOutcome::Failure {
            stderr: format!("command timed out after {timeout_seconds}s"),
            stdout: String::new(),
            exit_code: None,
        },
        Ok(result) => command_outcome(result),
    };
    fields.push(("elapsed_ms", started.elapsed().as_millis().to_string()));
    fields.extend(command_outcome_fields(&outcome));
    fields.extend(debug_claude_stdout_fields(&spec, &outcome, None, None));
    log_executor_event("process finished", &fields);
    outcome
}

async fn run_streaming_command_output<S>(
    spec: CommandSpec,
    timeout_seconds: u64,
    sink: S,
    builder: ResponsesEventBuilder,
    task_id: String,
    subtask_id: String,
) -> CommandOutcome
where
    S: EventSink,
{
    let mut command = Command::new(&spec.program);
    command
        .args(&spec.args)
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(cwd) = spec.cwd.as_ref() {
        if let Err(error) = fs::create_dir_all(cwd) {
            return CommandOutcome::Failure {
                stderr: format!("failed to create command cwd {}: {error}", cwd.display()),
                stdout: String::new(),
                exit_code: None,
            };
        }
        command.current_dir(cwd);
    }

    let mut fields = command_log_fields(&spec);
    fields.push(("timeout_seconds", timeout_seconds.to_string()));
    let debug_stdout_path =
        debug_claude_stdout_path_for_spec(&spec, Some(&task_id), Some(&subtask_id));
    if let Some(path) = debug_stdout_path.as_ref() {
        fields.push(("debug_stdout_path", path.display().to_string()));
    }
    log_executor_event("process started", &fields);
    let started = Instant::now();
    let outcome = match timeout(
        Duration::from_secs(timeout_seconds),
        run_prepared_streaming_command(
            command,
            spec.stdin.clone(),
            sink,
            builder,
            task_id.clone(),
            subtask_id.clone(),
            debug_stdout_path,
        ),
    )
    .await
    {
        Err(_) => CommandOutcome::Failure {
            stderr: format!("command timed out after {timeout_seconds}s"),
            stdout: String::new(),
            exit_code: None,
        },
        Ok(result) => result,
    };
    fields.push(("elapsed_ms", started.elapsed().as_millis().to_string()));
    fields.extend(command_outcome_fields(&outcome));
    if let Some(path) = debug_claude_stdout_path_for_spec(&spec, Some(&task_id), Some(&subtask_id))
    {
        fields.push(("debug_stdout_path", path.display().to_string()));
    }
    log_executor_event("process finished", &fields);
    outcome
}

async fn run_prepared_streaming_command<S>(
    mut command: Command,
    stdin: Option<String>,
    sink: S,
    builder: ResponsesEventBuilder,
    task_id: String,
    subtask_id: String,
    debug_stdout_path: Option<PathBuf>,
) -> CommandOutcome
where
    S: EventSink,
{
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return CommandOutcome::Failure {
                stderr: error.to_string(),
                stdout: String::new(),
                exit_code: None,
            };
        }
    };

    let writer = stdin.and_then(|input| {
        child.stdin.take().map(|mut child_stdin| {
            tokio::spawn(async move { child_stdin.write_all(input.as_bytes()).await })
        })
    });
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_task_id = task_id.clone();
    let stdout_subtask_id = subtask_id.clone();
    let stdout_task = stdout.map(|stdout| {
        tokio::spawn(read_streaming_stdout(
            stdout,
            sink,
            builder,
            stdout_task_id,
            stdout_subtask_id,
            debug_stdout_path,
        ))
    });
    let stderr_task = stderr.map(|stderr| tokio::spawn(read_process_output(stderr)));

    let status = child.wait().await;
    if let Some(writer) = writer {
        if let Ok(Err(error)) = writer.await {
            if status.is_ok() {
                return CommandOutcome::Failure {
                    stderr: error.to_string(),
                    stdout: String::new(),
                    exit_code: None,
                };
            }
        }
    }
    let stdout = join_streaming_stdout(stdout_task).await;
    let stderr = join_output(stderr_task).await;

    let stdout = match stdout {
        StreamingStdoutOutcome::Success(stdout) => stdout,
        StreamingStdoutOutcome::InvalidJson { stdout, error } => {
            let fields = vec![
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
                ("line_number", error.line_number.to_string()),
                ("error", error.message.clone()),
                ("preview", error.preview.clone()),
            ];
            log_executor_event("invalid claude stdout json", &fields);
            return CommandOutcome::Failure {
                stderr: error.failure_message(),
                stdout,
                exit_code: status.ok().and_then(|status| status.code()),
            };
        }
    };

    match status {
        Ok(status) if status.success() => CommandOutcome::Success { stdout },
        Ok(status) => CommandOutcome::Failure {
            stderr,
            stdout,
            exit_code: status.code(),
        },
        Err(error) => CommandOutcome::Failure {
            stderr: error.to_string(),
            stdout,
            exit_code: None,
        },
    }
}

async fn read_streaming_stdout<R, S>(
    stdout: R,
    sink: S,
    builder: ResponsesEventBuilder,
    task_id: String,
    subtask_id: String,
    debug_stdout_path: Option<PathBuf>,
) -> StreamingStdoutOutcome
where
    R: AsyncRead + Unpin,
    S: EventSink,
{
    let mut output = String::new();
    let mut debug_stdout_file =
        debug_stdout_path.and_then(|path| open_debug_claude_stdout_file(&path).ok());
    let mut offset = 0usize;
    let mut tool_uses: HashMap<String, ClaudeToolUse> = HashMap::new();
    let mut lines = BufReader::new(stdout).lines();
    let mut line_number = 0usize;
    let mut json_buffer = ClaudeStdoutJsonBuffer::default();
    let mut async_tasks = ClaudeAsyncTaskTracker::default();
    let dispatcher = StreamingEventDispatcher::new(sink);
    while let Ok(Some(line)) = lines.next_line().await {
        line_number += 1;
        let line = match compact_claude_stdout_line(&line, line_number) {
            Ok(line) => line,
            Err(error) => {
                dispatcher.flush().await;
                return StreamingStdoutOutcome::InvalidJson {
                    stdout: output,
                    error,
                };
            }
        };
        output.push_str(&line);
        output.push('\n');
        if let Some(file) = debug_stdout_file.as_mut() {
            let _ = writeln!(file, "{}", debug_claude_stdout_line(&line));
        }
        let Some(value) = (match json_buffer.push_line(&line, line_number) {
            Ok(value) => value,
            Err(error) => {
                dispatcher.flush().await;
                return StreamingStdoutOutcome::InvalidJson {
                    stdout: output,
                    error,
                };
            }
        }) else {
            continue;
        };
        async_tasks.observe(&value);
        if let Some(update) = extract_claude_subagent_update(&value) {
            let parent_tool_use_id = tool_uses
                .get(&update.tool_use_id)
                .and_then(|tool_use| tool_use.parent_tool_use_id.as_deref());
            emit_claude_subagent_update(
                &dispatcher,
                &builder,
                &update.tool_use_id,
                &update.status,
                None,
                update.summary.as_deref(),
                parent_tool_use_id,
                &task_id,
                &subtask_id,
            );
        }
        for block in extract_claude_child_blocks(&value) {
            let event = builder.response_child_block_created(
                &block.id,
                &block.block_type,
                &block.parent_tool_use_id,
                &block.content,
            );
            dispatcher.send(
                event,
                "streaming child agent block callback failed",
                vec![
                    ("task_id", task_id.clone()),
                    ("subtask_id", subtask_id.clone()),
                    ("parent_tool_use_id", block.parent_tool_use_id),
                ],
            );
        }
        if let Some(reasoning) = extract_reasoning(&value) {
            if !reasoning.is_empty() {
                emit_reasoning_chunks(&dispatcher, &builder, &reasoning, &task_id, &subtask_id);
            }
        }
        for tool_use in extract_claude_tool_uses(&value) {
            emit_claude_tool_use(&dispatcher, &builder, &tool_use, &task_id, &subtask_id);
            tool_uses.insert(tool_use.id.clone(), tool_use);
        }
        for tool_result in extract_claude_tool_results(&value) {
            let tool_use = tool_uses
                .remove(&tool_result.tool_use_id)
                .unwrap_or_else(|| ClaudeToolUse {
                    id: tool_result.tool_use_id.clone(),
                    name: "Tool".to_owned(),
                    input: Value::Object(Default::default()),
                    parent_tool_use_id: tool_result.parent_tool_use_id.clone(),
                });
            emit_claude_tool_result(
                &dispatcher,
                &builder,
                &tool_use,
                tool_result.content.as_deref(),
                tool_result.is_error,
                &task_id,
                &subtask_id,
            );
        }
        if async_tasks.has_active_task() {
            continue;
        }
        let Some(text) = extract_text(&value) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let emitted = emit_text_chunks(
            &dispatcher,
            &builder,
            &text,
            &mut offset,
            &task_id,
            &subtask_id,
        );
        let fields = vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("chunk_count", emitted.to_string()),
            ("text_chars", text.chars().count().to_string()),
        ];
        log_executor_event("streaming text chunks emitted", &fields);
    }
    dispatcher
        .compact_pending_text_and_flush(&task_id, &subtask_id)
        .await;
    StreamingStdoutOutcome::Success(output.trim().to_owned())
}

fn emit_claude_tool_use(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_use: &ClaudeToolUse,
    task_id: &str,
    subtask_id: &str,
) {
    let event = if is_claude_subagent_tool(&tool_use.name) {
        builder.response_subagent_block_created(
            &tool_use.id,
            &tool_use.name,
            &tool_use.input,
            tool_use.parent_tool_use_id.as_deref(),
        )
    } else {
        builder.response_tool_block_created(
            &tool_use.id,
            &tool_use.name,
            &tool_use.input,
            tool_use.parent_tool_use_id.as_deref(),
        )
    };
    dispatcher.send(
        event,
        "streaming tool use callback failed",
        vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("tool_use_id", tool_use.id.clone()),
        ],
    );
}

fn emit_claude_tool_result(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_use: &ClaudeToolUse,
    output: Option<&str>,
    is_error: bool,
    task_id: &str,
    subtask_id: &str,
) {
    let event = if is_claude_subagent_tool(&tool_use.name) {
        builder.response_subagent_block_updated(
            &tool_use.id,
            None,
            output,
            None,
            tool_use.parent_tool_use_id.as_deref(),
        )
    } else {
        builder.response_tool_block_updated(
            &tool_use.id,
            &tool_use.input,
            output,
            is_error,
            tool_use.parent_tool_use_id.as_deref(),
        )
    };
    dispatcher.send(
        event,
        "streaming tool result callback failed",
        vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("tool_use_id", tool_use.id.clone()),
        ],
    );
}

#[allow(clippy::too_many_arguments)]
fn emit_claude_subagent_update(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_use_id: &str,
    status: &str,
    output: Option<&str>,
    summary: Option<&str>,
    parent_tool_use_id: Option<&str>,
    task_id: &str,
    subtask_id: &str,
) {
    let event = builder.response_subagent_block_updated(
        tool_use_id,
        Some(status),
        output,
        summary,
        parent_tool_use_id,
    );
    dispatcher.send(
        event,
        "streaming child agent status callback failed",
        vec![
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("tool_use_id", tool_use_id.to_owned()),
        ],
    );
}

fn is_claude_subagent_tool(name: &str) -> bool {
    name.eq_ignore_ascii_case("Task") || name.eq_ignore_ascii_case("Agent")
}

fn emit_reasoning_chunks(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    reasoning: &str,
    task_id: &str,
    subtask_id: &str,
) {
    let chunks = split_stream_text(reasoning, stream_reasoning_chunk_chars());
    let chunk_count = chunks.len();
    for delta in chunks {
        let event = builder.response_reasoning_delta(&delta);
        dispatcher.send(
            event,
            "streaming reasoning callback failed",
            vec![
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
            ],
        );
    }
    let fields = vec![
        ("task_id", task_id.to_string()),
        ("subtask_id", subtask_id.to_string()),
        ("reasoning_chars", reasoning.chars().count().to_string()),
        ("chunk_count", chunk_count.to_string()),
    ];
    log_executor_event("streaming reasoning chunks emitted", &fields);
}

fn emit_text_chunks(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    text: &str,
    offset: &mut usize,
    task_id: &str,
    subtask_id: &str,
) -> usize {
    let chunks = split_stream_text(text, stream_text_chunk_chars());
    let chunk_count = chunks.len();
    for delta in chunks {
        let event = builder.response_text_delta(&delta, *offset);
        let delta_chars = delta.chars().count();
        *offset += delta_chars;
        dispatcher.send_text_delta(
            event,
            "streaming chunk callback failed",
            vec![
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
            ],
            delta_chars,
        );
    }
    chunk_count
}

fn split_stream_text(text: &str, chunk_chars: usize) -> Vec<String> {
    let chunk_chars = chunk_chars.max(1);
    let mut chunks = Vec::new();
    let mut current = String::new();
    for character in text.chars() {
        current.push(character);
        if current.chars().count() >= chunk_chars {
            chunks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

fn stream_text_chunk_chars() -> usize {
    env::var("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_STREAM_TEXT_CHUNK_CHARS)
}

fn stream_reasoning_chunk_chars() -> usize {
    env::var("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_STREAM_REASONING_CHUNK_CHARS)
}

async fn read_process_output<R>(output: R) -> String
where
    R: AsyncRead + Unpin,
{
    let mut text = String::new();
    let mut lines = BufReader::new(output).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        text.push_str(&line);
        text.push('\n');
    }
    text.trim().to_owned()
}

async fn join_output(handle: Option<tokio::task::JoinHandle<String>>) -> String {
    match handle {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    }
}

async fn join_streaming_stdout(
    handle: Option<tokio::task::JoinHandle<StreamingStdoutOutcome>>,
) -> StreamingStdoutOutcome {
    match handle {
        Some(handle) => handle
            .await
            .unwrap_or_else(|error| StreamingStdoutOutcome::InvalidJson {
                stdout: String::new(),
                error: ClaudeStdoutJsonError {
                    line_number: 0,
                    message: format!("stdout reader task failed: {error}"),
                    preview: String::new(),
                },
            }),
        None => StreamingStdoutOutcome::Success(String::new()),
    }
}

async fn run_prepared_command(
    mut command: Command,
    stdin: Option<String>,
) -> std::io::Result<std::process::Output> {
    let Some(input) = stdin else {
        return command.output().await;
    };

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let writer = child.stdin.take().map(|mut child_stdin| {
        tokio::spawn(async move { child_stdin.write_all(input.as_bytes()).await })
    });
    let output = child.wait_with_output().await;
    if let Some(writer) = writer {
        if let Ok(Err(error)) = writer.await {
            if output.is_ok() {
                return Err(error);
            }
        }
    }
    output
}

fn command_outcome(result: std::io::Result<std::process::Output>) -> CommandOutcome {
    match result {
        Ok(output) if output.status.success() => CommandOutcome::Success {
            stdout: decode_output(output.stdout),
        },
        Ok(output) => CommandOutcome::Failure {
            stderr: decode_output(output.stderr),
            stdout: decode_output(output.stdout),
            exit_code: output.status.code(),
        },
        Err(error) => CommandOutcome::Failure {
            stderr: error.to_string(),
            stdout: String::new(),
            exit_code: None,
        },
    }
}

fn command_log_fields(spec: &CommandSpec) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("program", spec.program.clone()),
        ("arg_count", spec.args.len().to_string()),
    ];
    if let Some(cwd) = spec.cwd.as_ref() {
        fields.push(("cwd", cwd.display().to_string()));
    }
    fields
}

fn command_outcome_fields(outcome: &CommandOutcome) -> Vec<(&'static str, String)> {
    match outcome {
        CommandOutcome::Success { stdout } => vec![
            ("status", "success".to_owned()),
            ("stdout_len", stdout.len().to_string()),
            ("stderr_len", "0".to_owned()),
        ],
        CommandOutcome::Failure {
            stderr,
            stdout,
            exit_code,
        } => {
            let mut fields = vec![
                ("status", "failed".to_owned()),
                ("stdout_len", stdout.len().to_string()),
                ("stderr_len", stderr.len().to_string()),
            ];
            if let Some(exit_code) = exit_code {
                fields.push(("exit_code", exit_code.to_string()));
            }
            if !stderr.is_empty() {
                fields.push(("stderr_preview", preview_log_value(stderr)));
            }
            fields
        }
    }
}

fn preview_log_value(value: &str) -> String {
    let value = value.replace(['\r', '\n'], "\\n");
    let mut chars = value.chars();
    let preview: String = chars.by_ref().take(STDERR_PREVIEW_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

fn debug_claude_stdout_fields(
    spec: &CommandSpec,
    outcome: &CommandOutcome,
    task_id: Option<&str>,
    subtask_id: Option<&str>,
) -> Vec<(&'static str, String)> {
    let Some(path) = debug_claude_stdout_path_for_spec(spec, task_id, subtask_id) else {
        return Vec::new();
    };

    let stdout = match outcome {
        CommandOutcome::Success { stdout } | CommandOutcome::Failure { stdout, .. } => stdout,
    };
    if stdout.is_empty() {
        return Vec::new();
    }

    match append_debug_claude_stdout(&path, stdout) {
        Ok(()) => vec![("debug_stdout_path", path.display().to_string())],
        Err(error) => vec![("debug_stdout_error", error.to_string())],
    }
}

fn open_debug_claude_stdout_file(path: &PathBuf) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().create(true).append(true).open(path)
}

fn append_debug_claude_stdout(path: &PathBuf, stdout: &str) -> std::io::Result<()> {
    let mut file = open_debug_claude_stdout_file(path)?;
    for line in stdout.lines() {
        writeln!(file, "{}", debug_claude_stdout_line(line))?;
    }
    Ok(())
}

fn debug_claude_stdout_line(line: &str) -> String {
    debug_claude_stdout_line_with_timestamp(
        line,
        Local::now().to_rfc3339_opts(SecondsFormat::Millis, false),
    )
}

fn debug_claude_stdout_line_with_timestamp(line: &str, received_at: String) -> String {
    match serde_json::from_str::<Value>(line.trim()) {
        Ok(Value::Object(mut object)) => {
            object.insert("received_at".to_owned(), Value::String(received_at));
            Value::Object(object).to_string()
        }
        Ok(value) => {
            let mut object = Map::new();
            object.insert("received_at".to_owned(), Value::String(received_at));
            object.insert("value".to_owned(), value);
            Value::Object(object).to_string()
        }
        Err(_) => {
            let mut object = Map::new();
            object.insert("received_at".to_owned(), Value::String(received_at));
            object.insert("raw".to_owned(), Value::String(line.to_owned()));
            Value::Object(object).to_string()
        }
    }
}

fn debug_claude_stdout_path_for_spec(
    spec: &CommandSpec,
    task_id: Option<&str>,
    subtask_id: Option<&str>,
) -> Option<PathBuf> {
    (spec.program == "claude" && env_flag_enabled(DEBUG_CLAUDE_STDOUT_ENV))
        .then(|| debug_claude_stdout_path(task_id, subtask_id))
}

fn env_flag_enabled(name: &str) -> bool {
    env::var(name)
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            !matches!(value.as_str(), "0" | "false" | "no" | "off")
        })
        .unwrap_or(false)
}

fn debug_claude_stdout_path(task_id: Option<&str>, subtask_id: Option<&str>) -> PathBuf {
    let filename = match (task_id, subtask_id) {
        (Some(task_id), Some(subtask_id)) => {
            format!("wegent-claude-stdout-{task_id}-{subtask_id}.jsonl")
        }
        _ => format!("wegent-claude-stdout-{}.jsonl", std::process::id()),
    };
    env::temp_dir().join(filename)
}

fn failure_message(stderr: Vec<u8>, stdout: Vec<u8>) -> String {
    let stderr = decode_output(stderr);
    if !stderr.is_empty() {
        return stderr;
    }
    decode_output(stdout)
}

fn decode_output(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard, OnceLock};

    use super::*;

    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn remove(key: &'static str) -> Self {
            let previous = std::env::var(key).ok();
            std::env::remove_var(key);
            Self { key, previous }
        }

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

    #[test]
    fn stream_chunk_defaults_are_tuned_for_callback_backpressure() {
        let _lock = env_lock();
        let _chunk_chars = EnvGuard::remove("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS");
        let _reasoning_chunk_chars =
            EnvGuard::remove("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS");

        assert_eq!(stream_text_chunk_chars(), 256);
        assert_eq!(stream_reasoning_chunk_chars(), 4_096);
    }

    #[test]
    fn stream_chunk_env_overrides_defaults() {
        let _lock = env_lock();
        let _chunk_chars = EnvGuard::set("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS", "128");
        let _reasoning_chunk_chars =
            EnvGuard::set("WEGENT_EXECUTOR_STREAM_REASONING_CHUNK_CHARS", "256");

        assert_eq!(stream_text_chunk_chars(), 128);
        assert_eq!(stream_reasoning_chunk_chars(), 256);
    }

    #[test]
    fn debug_claude_stdout_appends_existing_task_log() {
        let _lock = env_lock();
        let _debug = EnvGuard::set(DEBUG_CLAUDE_STDOUT_ENV, "1");
        let task_id = std::process::id().to_string();
        let subtask_id = "987654321".to_owned();
        let spec = CommandSpec::new("claude");
        let path = debug_claude_stdout_path(Some(&task_id), Some(&subtask_id));
        let _ = fs::remove_file(&path);

        debug_claude_stdout_fields(
            &spec,
            &CommandOutcome::Success {
                stdout: "first".to_owned(),
            },
            Some(&task_id),
            Some(&subtask_id),
        );
        debug_claude_stdout_fields(
            &spec,
            &CommandOutcome::Success {
                stdout: "second".to_owned(),
            },
            Some(&task_id),
            Some(&subtask_id),
        );

        let content = fs::read_to_string(&path).unwrap();
        let lines: Vec<Value> = content
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["raw"], "first");
        assert!(has_timezone_offset(
            lines[0]["received_at"].as_str().unwrap()
        ));
        assert_eq!(lines[1]["raw"], "second");
        assert!(has_timezone_offset(
            lines[1]["received_at"].as_str().unwrap()
        ));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn debug_claude_stdout_line_adds_received_at_to_json_object() {
        let line = debug_claude_stdout_line_with_timestamp(
            r#"{"type":"assistant","message":{"content":[{"text":"done"}]}}"#,
            "2026-07-06T03:33:26.000Z".to_owned(),
        );

        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "assistant");
        assert_eq!(value["message"]["content"][0]["text"], "done");
        assert_eq!(value["received_at"], "2026-07-06T03:33:26.000Z");
    }

    #[test]
    fn debug_claude_stdout_line_wraps_non_json_line_with_received_at() {
        let line = debug_claude_stdout_line_with_timestamp(
            "plain output",
            "2026-07-06T03:33:26.000Z".to_owned(),
        );

        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["raw"], "plain output");
        assert_eq!(value["received_at"], "2026-07-06T03:33:26.000Z");
    }

    fn has_timezone_offset(value: &str) -> bool {
        let Some(offset) = value.get(value.len().saturating_sub(6)..) else {
            return false;
        };
        let bytes = offset.as_bytes();
        matches!(bytes.first(), Some(b'+' | b'-'))
            && bytes.get(3) == Some(&b':')
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 0 || index == 3 || byte.is_ascii_digit())
    }

    #[test]
    fn debug_claude_stdout_is_disabled_by_default() {
        let _lock = env_lock();
        let _debug = EnvGuard::remove(DEBUG_CLAUDE_STDOUT_ENV);
        let spec = CommandSpec::new("claude");

        assert!(debug_claude_stdout_path_for_spec(&spec, Some("1"), Some("2")).is_none());
    }

    #[test]
    fn command_outcome_fields_include_stderr_preview_on_failure() {
        let fields = command_outcome_fields(&CommandOutcome::Failure {
            stderr: "first line\nsecond line".to_owned(),
            stdout: String::new(),
            exit_code: Some(1),
        });

        assert!(fields.contains(&("stderr_preview", "first line\\nsecond line".to_owned())));
    }
}
