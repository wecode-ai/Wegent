// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
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
    emitter::ResponsesEventBuilder,
    interactive_mcp::{
        deferred_proxy_exception_failure, deferred_proxy_response_decision,
        proxy_deferred_mcp_tool, ClaudeFollowUpQuery, DeferredMcpResponseAction,
    },
    logging::{log_executor_event, push_error_fields, task_fields},
    protocol::ExecutionRequest,
    runner::{streaming::StreamingEventDispatcher, AgentEngine, EventSink, ExecutionOutcome},
    stream::{
        collect_claude_stream_summary, compact_claude_stdout_line, extract_claude_message_blocks,
        extract_claude_result_error, extract_claude_subagent_update, extract_reasoning,
        extract_text, ClaudeAsyncTaskTracker, ClaudeChildBlock, ClaudeMessageBlock,
        ClaudePartialMessages, ClaudeStdoutJsonBuffer, ClaudeStdoutJsonError, ClaudeToolResult,
        ClaudeToolUse,
    },
};

use crate::ChildEnvironment;
use std::sync::Arc;
use wegent_subprocess::{decode_output, run_prepared_command, ProcessTreeGuard};
pub use wegent_subprocess::{hide_windows_console, spawn_program_parts};

mod claude_resume;
use wegent_runtime_logging::native_stdout as debug_stdout;
mod stream_diagnostics;
mod stream_session;
use claude_resume::follow_up_spec as claude_follow_up_resume_spec;
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
    segment_start: usize,
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
        // HTTP callbacks use a turn-wide offset; native clients also need the item offset.
        self.segment_start = self.offset;
    }
}

#[derive(Clone)]
enum FollowUpCommandRunner<S>
where
    S: EventSink,
{
    Silent {
        environment: Arc<dyn ChildEnvironment>,
    },
    Streaming {
        environment: Arc<dyn ChildEnvironment>,
        sink: S,
        builder: Box<ResponsesEventBuilder>,
        task_id: String,
        subtask_id: String,
        session: stream_session::SessionRecorder,
    },
}

impl<S> FollowUpCommandRunner<S>
where
    S: EventSink,
{
    async fn run(&self, spec: CommandSpec, timeout_seconds: u64) -> CommandOutcome {
        match self {
            FollowUpCommandRunner::Silent { environment } => {
                run_command_output(spec, timeout_seconds, environment.as_ref()).await
            }
            FollowUpCommandRunner::Streaming {
                environment,
                sink,
                builder,
                task_id,
                subtask_id,
                session,
            } => {
                run_streaming_command_output(
                    spec,
                    timeout_seconds,
                    sink.clone(),
                    builder.as_ref().clone(),
                    task_id.clone(),
                    subtask_id.clone(),
                    session.for_reader(),
                    environment.as_ref(),
                )
                .await
            }
        }
    }
}

use wegent_subprocess::CommandOutcome;
pub use wegent_subprocess::CommandSpec;
mod output_io;
use output_io::*;
mod events;
use events::*;
mod diagnostics;
use diagnostics::*;

#[derive(Debug, Clone)]
pub struct ProcessEngine {
    spec: CommandSpec,
    timeout_seconds: u64,
    environment: Arc<dyn ChildEnvironment>,
}

impl ProcessEngine {
    pub fn new(
        spec: CommandSpec,
        timeout_seconds: u64,
        environment: Arc<dyn ChildEnvironment>,
    ) -> Self {
        assert!(timeout_seconds > 0, "timeout_seconds must be positive");
        Self {
            spec,
            timeout_seconds,
            environment,
        }
    }
}

impl AgentEngine for ProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
        let spec = self.spec.clone();
        let timeout_seconds = self.timeout_seconds;
        let environment = Arc::clone(&self.environment);
        Box::pin(async move { run_command(spec, timeout_seconds, environment.as_ref()).await })
    }
}

#[derive(Debug, Clone)]
pub struct StreamProcessEngine {
    spec: CommandSpec,
    timeout_seconds: u64,
    environment: Arc<dyn ChildEnvironment>,
}

impl StreamProcessEngine {
    pub fn new(
        spec: CommandSpec,
        timeout_seconds: u64,
        environment: Arc<dyn ChildEnvironment>,
    ) -> Self {
        assert!(timeout_seconds > 0, "timeout_seconds must be positive");
        Self {
            spec,
            timeout_seconds,
            environment,
        }
    }
}

impl AgentEngine for StreamProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let spec = self.spec.clone();
        let timeout_seconds = self.timeout_seconds;
        let environment = Arc::clone(&self.environment);
        Box::pin(async move {
            let runner = FollowUpCommandRunner::<NoopEventSink>::Silent {
                environment: Arc::clone(&environment),
            };
            let (spec, outcome) =
                claude_resume::run(&request, spec, timeout_seconds, &runner).await;
            match outcome {
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
                        FollowUpCommandRunner::<NoopEventSink>::Silent {
                            environment: Arc::clone(&environment),
                        },
                    )
                    .await;
                    if summary.deferred_tool_use.is_some() {
                        handle_deferred_mcp_loop(
                            spec,
                            request,
                            summary,
                            timeout_seconds,
                            FollowUpCommandRunner::<NoopEventSink>::Silent {
                                environment: Arc::clone(&environment),
                            },
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
                        if wegent_native_home::instance_home::request_home(&request).is_some() {
                            return isolated_session_restore_failure();
                        }
                        agent_session::delete_saved_session_files(&request);
                        let retry_spec = claude_spec_without_resume(&spec);
                        match run_command_output(retry_spec, timeout_seconds, environment.as_ref())
                            .await
                        {
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
        let environment = Arc::clone(&self.environment);
        Box::pin(async move {
            let runner = FollowUpCommandRunner::Streaming {
                environment: Arc::clone(&environment),
                sink: sink.clone(),
                builder: Box::new(builder.clone()),
                task_id: request.task_id.clone(),
                subtask_id: request.subtask_id.clone(),
                session: stream_session::SessionRecorder::new(&request),
            };
            let (spec, outcome) =
                claude_resume::run(&request, spec, timeout_seconds, &runner).await;
            match outcome {
                CommandOutcome::Success { stdout } => {
                    let summary = collect_claude_stream_summary(&stdout);
                    if let Some(session_id) = &summary.session_id {
                        agent_session::save_session_id(&request, session_id);
                    }
                    let follow_up_runner = FollowUpCommandRunner::Streaming {
                        environment: Arc::clone(&environment),
                        sink,
                        builder: Box::new(builder),
                        task_id: request.task_id.clone(),
                        subtask_id: request.subtask_id.clone(),
                        session: stream_session::SessionRecorder::new(&request),
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
                        if wegent_native_home::instance_home::request_home(&request).is_some() {
                            return isolated_session_restore_failure();
                        }
                        agent_session::delete_saved_session_files(&request);
                        let retry_spec = claude_spec_without_resume(&spec);
                        let runner = FollowUpCommandRunner::Streaming {
                            environment: Arc::clone(&environment),
                            sink: sink.clone(),
                            builder: Box::new(builder.clone()),
                            task_id: request.task_id.clone(),
                            subtask_id: request.subtask_id.clone(),
                            session: stream_session::SessionRecorder::new(&request),
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
    let mut mcp_servers = mcp_servers_from_spec(&base_spec).unwrap_or(Value::Null);
    // Claude expands these references in its child environment. The executor's
    // deferred HTTP proxy must use the same execution bindings, only in memory.
    if let Err(message) =
        wegent_mcp_runtime::mcp_environment::resolve_context(&mut mcp_servers, base_spec.envs())
    {
        return ExecutionOutcome::Failed { message };
    }
    let mut retry_count = 0;
    let mut stale_answer_defer_drained = false;
    let fields = task_fields(&request.task_id, &request.subtask_id);

    loop {
        let Some(deferred_tool_use) = summary.deferred_tool_use.clone() else {
            return summary.outcome;
        };
        let answered_tool_use_id = answered_interactive_form_tool_use_id(&request);
        if answered_tool_use_id.as_deref() == Some(deferred_tool_use.id.as_str())
            && wegent_mcp_runtime::interactive_mcp::is_interactive_form_tool(
                &deferred_tool_use.name,
            )
            && completed_with_content(&summary.outcome)
        {
            log_executor_event("ignoring stale deferred form after answer", &fields);
            return summary.outcome;
        }
        if !stale_answer_defer_drained
            && answered_tool_use_id.as_deref() == Some(deferred_tool_use.id.as_str())
            && wegent_mcp_runtime::interactive_mcp::is_interactive_form_tool(
                &deferred_tool_use.name,
            )
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
        let mut proxy_fields = fields.clone();
        proxy_fields.push(("tool_use_id", deferred_tool_use.id.clone()));
        proxy_fields.push(("tool_name", deferred_tool_use.name.clone()));
        log_executor_event("deferred mcp proxy started", &proxy_fields);
        let proxy_result = match proxy_deferred_mcp_tool(&deferred_tool_use, &mcp_servers).await {
            Ok(proxy_result) => proxy_result,
            Err(error) => {
                let decision = deferred_proxy_exception_failure(&deferred_tool_use, &error);
                let mut failed_fields = proxy_fields.clone();
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

/// Build a copy of the Claude command spec without `--resume` and `--input-format`.
///
/// Used when the saved Claude session is no longer present in the sandbox and the
/// initial `--resume` execution fails with "No conversation found with session ID".
fn claude_spec_without_resume(base_spec: &CommandSpec) -> CommandSpec {
    let mut spec = base_spec.clone().with_args(Vec::new());
    let mut skip_next = false;
    for arg in base_spec.args() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--resume" || arg == "--input-format" {
            skip_next = true;
            continue;
        }
        spec = spec.arg(arg.clone());
    }
    spec
}

/// Check whether the process failure is caused by a missing Claude session.
///
/// Claude Code exits with `No conversation found with session ID` when `--resume`
/// references a session that does not exist in the current sandbox.
fn isolated_session_restore_failure() -> ExecutionOutcome {
    ExecutionOutcome::Failed {
        message: "The isolated Bot's existing Claude session could not be restored; its session marker was preserved and no new conversation was started".to_owned(),
    }
}

fn is_stale_claude_session_failure(stderr: &str, stdout: &str) -> bool {
    stderr.contains("No conversation found with session ID")
        || stdout.contains("No conversation found with session ID")
}

fn mcp_servers_from_spec(spec: &CommandSpec) -> Option<Value> {
    if let Some(path) = spec.envs().get("WEGENT_MCP_CONFIG_PATH") {
        return read_json_file(path);
    }
    spec.args()
        .windows(2)
        .find_map(|window| (window[0] == "--mcp-config").then(|| read_json_file(&window[1])))
        .flatten()
}

fn read_json_file(path: &str) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
}

#[cfg(test)]
mod output_text_tests;

#[cfg(test)]
mod tests;
