// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap, env, fs, future::Future, path::PathBuf, pin::Pin, process::Stdio,
    time::Duration, time::Instant,
};

use serde_json::Value;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

use crate::{
    agents::interactive_mcp::{
        deferred_proxy_exception_failure, deferred_proxy_response_decision,
        proxy_deferred_mcp_tool, ClaudeFollowUpQuery, DeferredMcpResponseAction,
    },
    claude_session,
    logging::{log_executor_event, task_fields},
    protocol::ExecutionRequest,
    runner::{AgentEngine, ExecutionOutcome},
    stream::collect_claude_stream_summary,
};

const DEFAULT_PROCESS_TIMEOUT_SECONDS: u64 = 300;
const MAX_DEFERRED_MCP_RETRIES: usize = 2;
const MAX_API_ERROR_RETRIES: usize = 3;

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
}

impl ProcessEngine {
    pub fn new(spec: CommandSpec) -> Self {
        Self { spec }
    }
}

impl AgentEngine for ProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
        let spec = self.spec.clone();
        Box::pin(async move { run_command(spec).await })
    }
}

#[derive(Debug, Clone)]
pub struct StreamProcessEngine {
    spec: CommandSpec,
}

impl StreamProcessEngine {
    pub fn new(spec: CommandSpec) -> Self {
        Self { spec }
    }
}

impl AgentEngine for StreamProcessEngine {
    type RunFuture = Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture {
        let spec = self.spec.clone();
        Box::pin(async move {
            match run_command_output(spec.clone()).await {
                CommandOutcome::Success { stdout } => {
                    let summary = collect_claude_stream_summary(&stdout);
                    if let Some(session_id) = &summary.session_id {
                        claude_session::save_session_id(&request, &session_id);
                    }
                    let summary =
                        handle_retryable_api_errors(spec.clone(), &request, summary).await;
                    if summary.deferred_tool_use.is_some() {
                        handle_deferred_mcp_loop(spec, request, summary).await
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
) -> crate::stream::ClaudeStreamSummary {
    let fields = task_fields(request.task_id, request.subtask_id);
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
        match run_command_output(retry_spec).await {
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
) -> ExecutionOutcome {
    let mcp_servers = mcp_servers_from_spec(&base_spec).unwrap_or(Value::Null);
    let mut retry_count = 0;
    let mut stale_answer_defer_drained = false;
    let fields = task_fields(request.task_id, request.subtask_id);

    loop {
        let Some(deferred_tool_use) = summary.deferred_tool_use.clone() else {
            return summary.outcome;
        };
        if !stale_answer_defer_drained
            && answered_interactive_form_tool_use_id(&request)
                .is_some_and(|tool_use_id| tool_use_id == deferred_tool_use.id)
        {
            stale_answer_defer_drained = true;
            log_executor_event("draining stale answered interactive form defer", &fields);
            match run_command_output(base_spec.clone()).await {
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
                match run_command_output(retry_spec).await {
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

async fn run_command(spec: CommandSpec) -> ExecutionOutcome {
    match run_command_output(spec).await {
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

async fn run_command_output(spec: CommandSpec) -> CommandOutcome {
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

    let timeout_seconds = process_timeout_seconds();
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
    log_executor_event("process finished", &fields);
    outcome
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
            fields
        }
    }
}

fn process_timeout_seconds() -> u64 {
    env::var("WEGENT_EXECUTOR_PROCESS_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_PROCESS_TIMEOUT_SECONDS)
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
