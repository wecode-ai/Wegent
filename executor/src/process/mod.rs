// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap, env, fs, future::Future, path::PathBuf, pin::Pin, process::Stdio,
    time::Duration, time::Instant,
};

use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader},
    process::Command,
    time::timeout,
};

use crate::{
    claude_session,
    emitter::ResponsesEventBuilder,
    logging::log_executor_event,
    protocol::ExecutionRequest,
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    stream::{collect_ndjson_outcome, extract_claude_session_id, extract_reasoning, extract_text},
};

const DEFAULT_PROCESS_TIMEOUT_SECONDS: u64 = 300;
const DEFAULT_STREAM_CHUNK_CHARS: usize = 80;
const DEFAULT_STREAM_CHUNK_DELAY_MS: u64 = 12;

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
            match run_command_output(spec).await {
                CommandOutcome::Success { stdout } => {
                    if let Some(session_id) = extract_claude_session_id(&stdout) {
                        claude_session::save_session_id(&request, &session_id);
                    }
                    collect_ndjson_outcome(&stdout)
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
        Box::pin(async move {
            match run_streaming_command_output(
                spec,
                sink,
                builder,
                request.task_id,
                request.subtask_id,
            )
            .await
            {
                CommandOutcome::Success { stdout } => {
                    if let Some(session_id) = extract_claude_session_id(&stdout) {
                        claude_session::save_session_id(&request, &session_id);
                    }
                    collect_ndjson_outcome(&stdout)
                }
                CommandOutcome::Failure { stderr, stdout, .. } => ExecutionOutcome::Failed {
                    message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
                },
            }
        })
    }
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

async fn run_streaming_command_output<S>(
    spec: CommandSpec,
    sink: S,
    builder: ResponsesEventBuilder,
    task_id: i64,
    subtask_id: i64,
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

    let timeout_seconds = process_timeout_seconds();
    let mut fields = command_log_fields(&spec);
    fields.push(("timeout_seconds", timeout_seconds.to_string()));
    log_executor_event("process started", &fields);
    let started = Instant::now();
    let outcome = match timeout(
        Duration::from_secs(timeout_seconds),
        run_prepared_streaming_command(
            command,
            spec.stdin.clone(),
            sink,
            builder,
            task_id,
            subtask_id,
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
    log_executor_event("process finished", &fields);
    outcome
}

async fn run_prepared_streaming_command<S>(
    mut command: Command,
    stdin: Option<String>,
    sink: S,
    builder: ResponsesEventBuilder,
    task_id: i64,
    subtask_id: i64,
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
    let stdout_task = stdout.map(|stdout| {
        tokio::spawn(read_streaming_stdout(
            stdout, sink, builder, task_id, subtask_id,
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
    let stdout = join_output(stdout_task).await;
    let stderr = join_output(stderr_task).await;

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
    task_id: i64,
    subtask_id: i64,
) -> String
where
    R: AsyncRead + Unpin,
    S: EventSink,
{
    let mut output = String::new();
    let mut offset = 0usize;
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        output.push_str(&line);
        output.push('\n');
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if let Some(reasoning) = extract_reasoning(&value) {
            if !reasoning.is_empty() {
                emit_reasoning_chunk(&sink, &builder, &reasoning, task_id, subtask_id).await;
            }
        }
        let Some(text) = extract_text(&value) else {
            continue;
        };
        if text.is_empty() {
            continue;
        }
        let emitted =
            emit_text_chunks(&sink, &builder, &text, &mut offset, task_id, subtask_id).await;
        let fields = vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("chunk_count", emitted.to_string()),
            ("text_chars", text.chars().count().to_string()),
        ];
        log_executor_event("streaming text chunks emitted", &fields);
    }
    output.trim().to_owned()
}

async fn emit_reasoning_chunk<S>(
    sink: &S,
    builder: &ResponsesEventBuilder,
    reasoning: &str,
    task_id: i64,
    subtask_id: i64,
) where
    S: EventSink,
{
    let event = builder.response_reasoning_delta(reasoning);
    if let Err(message) = sink.send(event).await {
        let fields = vec![
            ("task_id", task_id.to_string()),
            ("subtask_id", subtask_id.to_string()),
            ("error_len", message.len().to_string()),
        ];
        log_executor_event("streaming reasoning callback failed", &fields);
        return;
    }
    let fields = vec![
        ("task_id", task_id.to_string()),
        ("subtask_id", subtask_id.to_string()),
        ("reasoning_chars", reasoning.chars().count().to_string()),
    ];
    log_executor_event("streaming reasoning chunk emitted", &fields);
}

async fn emit_text_chunks<S>(
    sink: &S,
    builder: &ResponsesEventBuilder,
    text: &str,
    offset: &mut usize,
    task_id: i64,
    subtask_id: i64,
) -> usize
where
    S: EventSink,
{
    let chunks = split_stream_text(text, stream_chunk_chars());
    let delay = Duration::from_millis(stream_chunk_delay_ms());
    let should_delay = chunks.len() > 1 && !delay.is_zero();
    let chunk_count = chunks.len();
    for (index, delta) in chunks.into_iter().enumerate() {
        let event = builder.response_text_delta(&delta, *offset);
        *offset += delta.chars().count();
        if let Err(message) = sink.send(event).await {
            let fields = vec![
                ("task_id", task_id.to_string()),
                ("subtask_id", subtask_id.to_string()),
                ("error_len", message.len().to_string()),
            ];
            log_executor_event("streaming chunk callback failed", &fields);
        }
        if should_delay && index + 1 < chunk_count {
            tokio::time::sleep(delay).await;
        }
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

fn stream_chunk_chars() -> usize {
    env::var("WEGENT_EXECUTOR_STREAM_CHUNK_CHARS")
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_STREAM_CHUNK_CHARS)
}

fn stream_chunk_delay_ms() -> u64 {
    env::var("WEGENT_EXECUTOR_STREAM_CHUNK_DELAY_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_STREAM_CHUNK_DELAY_MS)
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
