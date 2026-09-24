// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, HashMap},
    env, fs,
    future::Future,
    io::Write,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    time::Duration,
    time::Instant,
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

use crate::{
    agent_session,
    agents::interactive_mcp::{
        deferred_proxy_exception_failure, deferred_proxy_response_decision,
        proxy_deferred_mcp_tool, ClaudeFollowUpQuery, DeferredMcpResponseAction,
    },
    emitter::ResponsesEventBuilder,
    logging::{log_executor_event, push_error_fields, task_fields},
    process_environment,
    protocol::ExecutionRequest,
    runner::{streaming::StreamingEventDispatcher, AgentEngine, EventSink, ExecutionOutcome},
    stream::{
        collect_claude_stream_summary, compact_claude_stdout_line, extract_claude_message_blocks,
        extract_claude_result_error, extract_claude_subagent_update, extract_reasoning,
        extract_text, ClaudeAsyncTaskTracker, ClaudeChildBlock, ClaudeMessageBlock,
        ClaudeStdoutJsonBuffer, ClaudeStdoutJsonError, ClaudeToolResult, ClaudeToolUse,
    },
};

#[cfg(windows)]
mod windows_batch;

pub(crate) mod debug_stdout;
use debug_stdout::line as debug_claude_stdout_line;
#[cfg(test)]
use debug_stdout::{
    line_with_timestamp as debug_claude_stdout_line_with_timestamp, ENV as DEBUG_CLAUDE_STDOUT_ENV,
};

const DEFAULT_STREAM_TEXT_CHUNK_CHARS: usize = 256;
const DEFAULT_STREAM_REASONING_CHUNK_CHARS: usize = 4_096;
const MAX_DEFERRED_MCP_RETRIES: usize = 2;
const MAX_API_ERROR_RETRIES: usize = 3;
const STDERR_PREVIEW_MAX_CHARS: usize = 500;

#[derive(Clone, Default)]
struct NoopEventSink;

impl EventSink for NoopEventSink {
    type SendFuture = std::future::Ready<Result<(), String>>;

    fn send(&self, _event: crate::emitter::EventEnvelope) -> Self::SendFuture {
        std::future::ready(Ok(()))
    }
}

#[derive(Default)]
struct ClaudeOutputTextState {
    item_id: Option<String>,
    offset: usize,
    segment_count: usize,
}

impl ClaudeOutputTextState {
    fn item_id(&mut self, task_id: &str, subtask_id: &str) -> String {
        if let Some(item_id) = self.item_id.as_ref() {
            return item_id.clone();
        }
        self.segment_count += 1;
        let item_id = format!(
            "claude-{task_id}-{subtask_id}-output-{}",
            self.segment_count
        );
        self.item_id = Some(item_id.clone());
        item_id
    }

    fn finish_segment(&mut self) {
        self.item_id = None;
        self.offset = 0;
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
                        agent_session::save_session_id(&request, session_id);
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
                CommandOutcome::Failure { stderr, stdout, .. } => {
                    let stderr_text = decode_output(stderr.clone().into_bytes());
                    let stdout_text = decode_output(stdout.clone().into_bytes());
                    if is_stale_claude_session_failure(&stderr_text, &stdout_text) {
                        agent_session::delete_saved_session_files(&request);
                        let retry_spec = claude_spec_without_resume(&spec);
                        match run_command_output(retry_spec, timeout_seconds).await {
                            CommandOutcome::Success { stdout } => {
                                let summary = collect_claude_stream_summary(&stdout);
                                if let Some(session_id) = &summary.session_id {
                                    agent_session::save_session_id(&request, session_id);
                                }
                                summary.outcome
                            }
                            CommandOutcome::Failure { stderr, stdout, .. } => {
                                ExecutionOutcome::Failed {
                                    message: failure_message(
                                        stderr.into_bytes(),
                                        stdout.into_bytes(),
                                    ),
                                }
                            }
                        }
                    } else {
                        ExecutionOutcome::Failed {
                            message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                        }
                    }
                }
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
                        agent_session::save_session_id(&request, session_id);
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
                CommandOutcome::Failure { stderr, stdout, .. } => {
                    let stderr_text = decode_output(stderr.clone().into_bytes());
                    let stdout_text = decode_output(stdout.clone().into_bytes());
                    if is_stale_claude_session_failure(&stderr_text, &stdout_text) {
                        agent_session::delete_saved_session_files(&request);
                        let retry_spec = claude_spec_without_resume(&spec);
                        let runner = FollowUpCommandRunner::Streaming {
                            sink: sink.clone(),
                            builder: Box::new(builder.clone()),
                            task_id: request.task_id.clone(),
                            subtask_id: request.subtask_id.clone(),
                        };
                        match runner.run(retry_spec, timeout_seconds).await {
                            CommandOutcome::Success { stdout } => {
                                let summary = collect_claude_stream_summary(&stdout);
                                if let Some(session_id) = &summary.session_id {
                                    agent_session::save_session_id(&request, session_id);
                                }
                                let summary = handle_retryable_api_errors(
                                    spec.clone(),
                                    &request,
                                    summary,
                                    timeout_seconds,
                                    runner.clone(),
                                )
                                .await;
                                if summary.deferred_tool_use.is_some() {
                                    handle_deferred_mcp_loop(
                                        spec,
                                        request,
                                        summary,
                                        timeout_seconds,
                                        runner,
                                    )
                                    .await
                                } else {
                                    summary.outcome
                                }
                            }
                            CommandOutcome::Failure { stderr, stdout, .. } => {
                                ExecutionOutcome::Failed {
                                    message: failure_message(
                                        stderr.into_bytes(),
                                        stdout.into_bytes(),
                                    ),
                                }
                            }
                        }
                    } else {
                        ExecutionOutcome::Failed {
                            message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                        }
                    }
                }
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
                    agent_session::save_session_id(request, session_id);
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
        let answered_tool_use_id = answered_interactive_form_tool_use_id(&request);
        if answered_tool_use_id.as_deref() == Some(deferred_tool_use.id.as_str())
            && crate::agents::interactive_mcp::is_interactive_form_tool(&deferred_tool_use.name)
            && completed_with_content(&summary.outcome)
        {
            log_executor_event("ignoring stale deferred form after answer", &fields);
            return summary.outcome;
        }
        if !stale_answer_defer_drained
            && answered_tool_use_id.as_deref() == Some(deferred_tool_use.id.as_str())
            && crate::agents::interactive_mcp::is_interactive_form_tool(&deferred_tool_use.name)
        {
            stale_answer_defer_drained = true;
            log_executor_event("draining stale answered interactive form defer", &fields);
            match runner.run(base_spec.clone(), timeout_seconds).await {
                CommandOutcome::Success { stdout } => {
                    summary = collect_claude_stream_summary(&stdout);
                    if let Some(session_id) = &summary.session_id {
                        agent_session::save_session_id(&request, session_id);
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
                push_error_fields(&mut failed_fields, &error);
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
                            agent_session::save_session_id(&request, session_id);
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
        if arg == "-p" || arg == "--print" {
            continue;
        }
        if arg == "--resume" || arg == "--input-format" {
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

/// Build a copy of the Claude command spec without `--resume` and `--input-format`.
///
/// Used when the saved Claude session is no longer present in the sandbox and the
/// initial `--resume` execution fails with "No conversation found with session ID".
fn claude_spec_without_resume(base_spec: &CommandSpec) -> CommandSpec {
    let mut spec = CommandSpec::new(base_spec.program.clone());
    spec.env = base_spec.env.clone();
    spec.cwd = base_spec.cwd.clone();
    spec.stdin = base_spec.stdin.clone();
    let mut skip_next = false;
    for arg in &base_spec.args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--resume" || arg == "--input-format" {
            skip_next = true;
            continue;
        }
        spec.args.push(arg.clone());
    }
    spec
}

/// Check whether the process failure is caused by a missing Claude session.
///
/// Claude Code exits with `No conversation found with session ID` when `--resume`
/// references a session that does not exist in the current sandbox.
fn is_stale_claude_session_failure(stderr: &str, stdout: &str) -> bool {
    stderr.contains("No conversation found with session ID")
        || stdout.contains("No conversation found with session ID")
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

pub(crate) struct ProcessTreeGuard {
    #[cfg(windows)]
    pid: Option<u32>,
}

impl ProcessTreeGuard {
    pub(crate) fn new(pid: Option<u32>) -> Self {
        #[cfg(not(windows))]
        let _ = pid;
        Self {
            #[cfg(windows)]
            pid,
        }
    }

    pub(crate) fn disarm(&mut self) {
        #[cfg(windows)]
        {
            self.pid = None;
        }
    }

    pub(crate) fn terminate(&mut self) {
        #[cfg(windows)]
        if let Some(pid) = self.pid.take() {
            kill_windows_process_tree(pid);
        }
    }
}

impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(windows)]
pub(crate) fn kill_windows_process_tree(pid: u32) {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid = pid.to_string();
    let status = std::process::Command::new("taskkill")
        .args(["/PID", pid.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status();
    if let Err(error) = status {
        log_executor_event(
            "windows process tree termination failed",
            &[("pid", pid), ("error", error.to_string())],
        );
    }
}

async fn run_command_output(spec: CommandSpec, timeout_seconds: u64) -> CommandOutcome {
    let mut command = command_from_spec(&spec);
    hide_windows_console(&mut command);
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
    let mut command = command_from_spec(&spec);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_windows_console(&mut command);
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

fn command_from_spec(spec: &CommandSpec) -> Command {
    let extra_env = spec
        .env
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    let (program, prefix_args) = spawn_program_parts(&spec.program);
    let mut command = Command::new(program);
    command
        .args(prefix_args)
        .args(&spec.args)
        .env_clear()
        .envs(process_environment::process_env(&extra_env))
        .kill_on_drop(true);
    command
}

/// Returns the effective program and any prefix arguments for a spawn.
///
/// On Windows, npm/node-style batch shims are resolved to their native
/// executable so that arguments containing newlines (common in agent prompts)
/// can be passed through directly instead of being rejected by `cmd.exe` with
/// `batch file arguments are invalid`. Other platforms return the program
/// unchanged.
pub fn spawn_program_parts(program: &str) -> (PathBuf, Vec<String>) {
    #[cfg(windows)]
    {
        let search_path = env::var_os("PATH");
        let program_path =
            windows_batch::resolve_program_path(Path::new(program), search_path.as_deref());
        if windows_batch::is_batch_file(&program_path) {
            if let Some(target) = windows_batch::resolve_batch_target(&program_path) {
                return (target.program, target.prefix_args);
            }
        }
        return (program_path, Vec::new());
    }
    #[cfg(not(windows))]
    (PathBuf::from(program), Vec::new())
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
    let mut process_tree = ProcessTreeGuard::new(child.id());

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
    let writer_error = match writer {
        Some(writer) => writer.await.ok().and_then(Result::err),
        None => None,
    };
    let stdout = join_streaming_stdout(stdout_task).await;
    let stderr = join_output(stderr_task).await;
    process_tree.disarm();

    if let Some(error) = writer_error.filter(|_| status.is_ok()) {
        return CommandOutcome::Failure {
            stderr: error.to_string(),
            stdout: String::new(),
            exit_code: None,
        };
    }

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
    let mut anonymous_block_count = 0usize;
    let mut output_text_state = ClaudeOutputTextState::default();
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
        if value.get("type").and_then(Value::as_str) == Some("user") {
            output_text_state.finish_segment();
        }
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
        let message_blocks = extract_claude_message_blocks(&value);
        if !message_blocks.is_empty() {
            emit_claude_message_blocks(
                &dispatcher,
                &builder,
                message_blocks,
                &mut tool_uses,
                &mut anonymous_block_count,
                &mut output_text_state,
                !async_tasks.has_active_task(),
                &task_id,
                &subtask_id,
            );
            continue;
        }
        if let Some(reasoning) = extract_reasoning(&value) {
            if !reasoning.is_empty() {
                output_text_state.finish_segment();
                emit_reasoning_chunks(&dispatcher, &builder, &reasoning, &task_id, &subtask_id);
            }
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
        emit_claude_output_text(
            &dispatcher,
            &builder,
            &text,
            &mut output_text_state,
            &task_id,
            &subtask_id,
        );
    }
    dispatcher
        .compact_pending_and_flush(&task_id, &subtask_id)
        .await;
    StreamingStdoutOutcome::Success(output.trim().to_owned())
}

#[allow(clippy::too_many_arguments)]
fn emit_claude_message_blocks(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    blocks: Vec<ClaudeMessageBlock>,
    tool_uses: &mut HashMap<String, ClaudeToolUse>,
    anonymous_block_count: &mut usize,
    output_text_state: &mut ClaudeOutputTextState,
    emit_root_text: bool,
    task_id: &str,
    subtask_id: &str,
) {
    for block in blocks {
        match block {
            ClaudeMessageBlock::Root(block) if block.block_type != "text" || emit_root_text => {
                output_text_state.finish_segment();
                emit_claude_root_block(
                    dispatcher,
                    builder,
                    block,
                    anonymous_block_count,
                    task_id,
                    subtask_id,
                );
            }
            ClaudeMessageBlock::Root(_) => output_text_state.finish_segment(),
            ClaudeMessageBlock::OutputText(text) if emit_root_text => {
                emit_claude_output_text(
                    dispatcher,
                    builder,
                    &text.content,
                    output_text_state,
                    task_id,
                    subtask_id,
                );
            }
            ClaudeMessageBlock::OutputText(_) => output_text_state.finish_segment(),
            ClaudeMessageBlock::ToolUse(tool_use) => {
                output_text_state.finish_segment();
                emit_claude_tool_use(dispatcher, builder, &tool_use, task_id, subtask_id);
                tool_uses.insert(tool_use.id.clone(), tool_use);
            }
            ClaudeMessageBlock::ToolResult(tool_result) => {
                output_text_state.finish_segment();
                emit_claude_tool_result_from_state(
                    dispatcher,
                    builder,
                    tool_uses,
                    tool_result,
                    task_id,
                    subtask_id,
                );
            }
            ClaudeMessageBlock::Child(block) => {
                output_text_state.finish_segment();
                emit_claude_child_block(dispatcher, builder, block, task_id, subtask_id);
            }
        }
    }
}

fn emit_claude_output_text(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    text: &str,
    state: &mut ClaudeOutputTextState,
    task_id: &str,
    subtask_id: &str,
) {
    let item_id = state.item_id(task_id, subtask_id);
    emit_text_chunks_with_log(
        dispatcher,
        builder,
        text,
        &mut state.offset,
        task_id,
        subtask_id,
        Some(&item_id),
    );
}

fn emit_claude_root_block(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    block: crate::stream::ClaudeRootBlock,
    anonymous_block_count: &mut usize,
    task_id: &str,
    subtask_id: &str,
) {
    let block_id = resolve_claude_block_id(
        block.id,
        &block.block_type,
        anonymous_block_count,
        task_id,
        subtask_id,
    );
    let event = builder.response_process_block_created(
        &block_id,
        &block.block_type,
        &block.process_kind,
        &block.content,
    );
    dispatcher.send(
        event,
        "streaming Claude process block callback failed",
        vec![
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("block_id", block_id),
        ],
    );
}

fn resolve_claude_block_id(
    block_id: Option<String>,
    block_type: &str,
    anonymous_block_count: &mut usize,
    task_id: &str,
    subtask_id: &str,
) -> String {
    block_id.unwrap_or_else(|| {
        *anonymous_block_count += 1;
        format!(
            "claude-{task_id}-{subtask_id}-{block_type}-{}",
            *anonymous_block_count
        )
    })
}

fn emit_claude_child_block(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    block: ClaudeChildBlock,
    task_id: &str,
    subtask_id: &str,
) {
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
            ("task_id", task_id.to_owned()),
            ("subtask_id", subtask_id.to_owned()),
            ("parent_tool_use_id", block.parent_tool_use_id),
        ],
    );
}

fn emit_claude_tool_result_from_state(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    tool_uses: &mut HashMap<String, ClaudeToolUse>,
    tool_result: ClaudeToolResult,
    task_id: &str,
    subtask_id: &str,
) {
    let tool_use = tool_uses
        .remove(&tool_result.tool_use_id)
        .unwrap_or_else(|| ClaudeToolUse {
            id: tool_result.tool_use_id.clone(),
            name: "Tool".to_owned(),
            input: Value::Object(Default::default()),
            parent_tool_use_id: tool_result.parent_tool_use_id.clone(),
        });
    emit_claude_tool_result(
        dispatcher,
        builder,
        &tool_use,
        tool_result.content.as_deref(),
        tool_result.is_error,
        task_id,
        subtask_id,
    );
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
            Some(if is_error { "error" } else { "completed" }),
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
    item_id: Option<&str>,
) -> usize {
    let chunks = split_stream_text(text, stream_text_chunk_chars());
    let chunk_count = chunks.len();
    for delta in chunks {
        let event = match item_id {
            Some(item_id) => builder.response_text_delta_for_item(item_id, &delta, *offset),
            None => builder.response_text_delta(&delta, *offset),
        };
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

fn emit_text_chunks_with_log(
    dispatcher: &StreamingEventDispatcher,
    builder: &ResponsesEventBuilder,
    text: &str,
    offset: &mut usize,
    task_id: &str,
    subtask_id: &str,
    item_id: Option<&str>,
) {
    let emitted = emit_text_chunks(
        dispatcher, builder, text, offset, task_id, subtask_id, item_id,
    );
    let fields = vec![
        ("task_id", task_id.to_owned()),
        ("subtask_id", subtask_id.to_owned()),
        ("chunk_count", emitted.to_string()),
        ("text_chars", text.chars().count().to_string()),
    ];
    log_executor_event("streaming text chunks emitted", &fields);
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
    hide_windows_console(&mut command);
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
    let (resolved_program, prefix_args) = spawn_program_parts(&spec.program);
    if resolved_program.to_string_lossy() != spec.program || !prefix_args.is_empty() {
        fields.push(("resolved_program", resolved_program.display().to_string()));
        fields.push(("prefix_arg_count", prefix_args.len().to_string()));
    }
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

fn debug_claude_stdout_path_for_spec(
    spec: &CommandSpec,
    task_id: Option<&str>,
    subtask_id: Option<&str>,
) -> Option<PathBuf> {
    (is_claude_program(&spec.program) && debug_stdout::enabled())
        .then(|| debug_claude_stdout_path(task_id, subtask_id))
}

fn is_claude_program(program: &str) -> bool {
    Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("claude")
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
    let stdout = decode_output(stdout);
    if let Some(message) = extract_claude_result_error(&stdout) {
        return message;
    }
    let stderr = decode_output(stderr);
    if !stderr.is_empty() {
        return stderr;
    }
    stdout
}

fn decode_output(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

#[cfg(windows)]
mod windows_console {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub trait HideConsole {
        fn hide_console(&mut self);
    }

    impl HideConsole for std::process::Command {
        fn hide_console(&mut self) {
            self.creation_flags(CREATE_NO_WINDOW);
        }
    }

    impl HideConsole for tokio::process::Command {
        fn hide_console(&mut self) {
            self.creation_flags(CREATE_NO_WINDOW);
        }
    }
}

#[cfg(windows)]
pub fn hide_windows_console<C: windows_console::HideConsole>(command: &mut C) {
    command.hide_console();
}

#[cfg(not(windows))]
pub fn hide_windows_console<C>(_command: &mut C) {}

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
    fn claude_follow_up_resume_spec_removes_original_stream_json_input_args() {
        let base_spec = CommandSpec::new("claude")
            .arg("-p")
            .arg("--input-format")
            .arg("stream-json")
            .arg("--output-format")
            .arg("stream-json")
            .arg("--verbose")
            .stdin("original query\n");

        let spec = claude_follow_up_resume_spec(
            &base_spec,
            "session-1",
            ClaudeFollowUpQuery::Prompt("Retry to proceed".to_owned()),
        );

        assert_eq!(
            spec.args(),
            &[
                "--output-format",
                "stream-json",
                "--verbose",
                "--resume",
                "session-1",
                "-p",
                "Retry to proceed"
            ]
        );
        assert!(spec.stdin_input().is_none());
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
    fn debug_claude_stdout_accepts_resolved_claude_path() {
        let _lock = env_lock();
        let _debug = EnvGuard::set(DEBUG_CLAUDE_STDOUT_ENV, "1");
        let spec = CommandSpec::new("/usr/bin/claude");

        assert!(debug_claude_stdout_path_for_spec(&spec, Some("1"), Some("2")).is_some());
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

    #[test]
    fn failure_message_extracts_claude_terminal_error_from_stdout() {
        let stdout = concat!(
            r#"{"type":"system","subtype":"hook_started"}"#,
            "\n",
            r#"{"type":"result","subtype":"success","is_error":true,"result":"API Error: 502 Bad Gateway"}"#,
        );

        assert_eq!(
            failure_message(Vec::new(), stdout.as_bytes().to_vec()),
            "API Error: 502 Bad Gateway"
        );
    }

    #[test]
    fn failure_message_keeps_stderr_without_terminal_result() {
        assert_eq!(
            failure_message(
                b"command timed out after 300s".to_vec(),
                br#"{"type":"assistant","message":{"content":[{"text":"partial"}]}}"#.to_vec(),
            ),
            "command timed out after 300s"
        );
    }

    #[test]
    fn failure_message_prefers_terminal_result_over_stderr_warning() {
        let stdout = br#"{"type":"result","is_error":true,"result":"Invalid model ID"}"#.to_vec();

        assert_eq!(
            failure_message(b"startup hook warning".to_vec(), stdout),
            "Invalid model ID"
        );
    }
}
