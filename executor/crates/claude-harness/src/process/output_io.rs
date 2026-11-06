//! Command spawning and bounded output consumption.
use super::*;

pub(super) async fn run_command(
    spec: CommandSpec,
    timeout_seconds: u64,
    environment: &dyn ChildEnvironment,
) -> ExecutionOutcome {
    match run_command_output(spec, timeout_seconds, environment).await {
        CommandOutcome::Success { stdout } => ExecutionOutcome::Completed { content: stdout },
        CommandOutcome::Failure { stderr, stdout, .. } => ExecutionOutcome::Failed {
            message: failure_message(stderr.into_bytes(), stdout.into_bytes()),
        },
    }
}

pub(super) enum StreamingStdoutOutcome {
    Success(String),
    InvalidStream {
        stdout: String,
        message: String,
    },
    InvalidJson {
        stdout: String,
        error: ClaudeStdoutJsonError,
    },
}

pub(super) async fn run_command_output(
    spec: CommandSpec,
    timeout_seconds: u64,
    environment: &dyn ChildEnvironment,
) -> CommandOutcome {
    let mut command = command_from_spec(&spec, environment);
    hide_windows_console(&mut command);
    if let Some(cwd) = spec.current_dir() {
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
        run_prepared_command(command, spec.stdin_input().map(str::to_owned)),
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

pub(super) async fn run_streaming_command_output<S>(
    spec: CommandSpec,
    timeout_seconds: u64,
    sink: S,
    builder: ResponsesEventBuilder,
    task: (String, String),
    session: stream_session::SessionRecorder,
    environment: &dyn ChildEnvironment,
) -> CommandOutcome
where
    S: EventSink,
{
    let (task_id, subtask_id) = task;
    let mut command = command_from_spec(&spec, environment);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_windows_console(&mut command);
    if let Some(cwd) = spec.current_dir() {
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
    fields.extend([
        ("task_id", task_id.clone()),
        ("subtask_id", subtask_id.clone()),
        (
            "include_partial_messages",
            spec.args()
                .iter()
                .any(|arg| arg == "--include-partial-messages")
                .to_string(),
        ),
    ]);
    if let Some(path) = debug_stdout_path.as_ref() {
        fields.push(("debug_stdout_path", path.display().to_string()));
    }
    log_executor_event("process started", &fields);
    let started = Instant::now();
    let outcome = match timeout(
        Duration::from_secs(timeout_seconds),
        run_prepared_streaming_command(
            command,
            spec.stdin_input().map(str::to_owned),
            sink,
            builder,
            (task_id.clone(), subtask_id.clone()),
            debug_stdout_path,
            session,
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

pub(super) fn command_from_spec(spec: &CommandSpec, environment: &dyn ChildEnvironment) -> Command {
    let extra_env = spec
        .envs()
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Vec<_>>();
    let (program, prefix_args) = spawn_program_parts(spec.program());
    let mut command = Command::new(program);
    command
        .args(prefix_args)
        .args(spec.args())
        .env_clear()
        .envs(environment.environment(&extra_env))
        .kill_on_drop(true);
    command
}

pub(super) async fn run_prepared_streaming_command<S>(
    mut command: Command,
    stdin: Option<String>,
    sink: S,
    builder: ResponsesEventBuilder,
    task_ids: (String, String),
    debug_stdout_path: Option<PathBuf>,
    session: stream_session::SessionRecorder,
) -> CommandOutcome
where
    S: EventSink,
{
    let (task_id, subtask_id) = task_ids;
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
            Some(session.clone()),
        ))
    });
    let _stdout_guard = stdout_task
        .as_ref()
        .map(|handle| stream_session::ReaderGuard::new(handle.abort_handle(), session));
    let stderr_task = stderr.map(|stderr| tokio::spawn(read_process_output(stderr)));

    let status = child.wait().await;
    let writer_error = match writer {
        Some(writer) => writer.await.ok().and_then(Result::err),
        None => None,
    };
    let stdout = join_streaming_stdout(stdout_task).await;
    let stderr = join_output(stderr_task).await;
    process_tree.disarm();

    if let Some(error) =
        writer_error.filter(|_| status.as_ref().is_ok_and(|status| status.success()))
    {
        return CommandOutcome::Failure {
            stderr: error.to_string(),
            stdout: String::new(),
            exit_code: None,
        };
    }

    let stdout = match stdout {
        StreamingStdoutOutcome::Success(stdout) => stdout,
        StreamingStdoutOutcome::InvalidStream { stdout, message } => {
            return CommandOutcome::Failure {
                stderr: message,
                stdout,
                exit_code: status.ok().and_then(|status| status.code()),
            };
        }
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

pub(super) async fn read_streaming_stdout<R, S>(
    stdout: R,
    sink: S,
    builder: ResponsesEventBuilder,
    task_id: String,
    subtask_id: String,
    debug_stdout_path: Option<PathBuf>,
    session: Option<stream_session::SessionRecorder>,
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
    let mut diagnostics = stream_diagnostics::ClaudeStreamDiagnostics::new();
    let mut partial_messages = ClaudePartialMessages::default();
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
        if let Some(session) = &session {
            session.observe(&value);
        }
        diagnostics.observe(&value, &task_id, &subtask_id);
        async_tasks.observe(&value);
        let value = match partial_messages.normalize(value) {
            Ok(Some(value)) => value,
            Ok(None) => continue,
            Err(message) => {
                dispatcher.flush().await;
                return StreamingStdoutOutcome::InvalidStream {
                    stdout: output,
                    message,
                };
            }
        };
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
    diagnostics.finish(&task_id, &subtask_id);
    dispatcher
        .compact_pending_and_flush(&task_id, &subtask_id)
        .await;
    StreamingStdoutOutcome::Success(output.trim().to_owned())
}
