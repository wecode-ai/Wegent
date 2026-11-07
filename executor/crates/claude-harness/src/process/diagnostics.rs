//! Process output and debug diagnostics.
use super::*;

pub(super) async fn read_process_output<R>(output: R) -> String
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

pub(super) async fn join_output(handle: Option<tokio::task::JoinHandle<String>>) -> String {
    match handle {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    }
}

pub(super) async fn join_streaming_stdout(
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

pub(super) fn command_outcome(result: std::io::Result<std::process::Output>) -> CommandOutcome {
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

pub(super) fn command_log_fields(spec: &CommandSpec) -> Vec<(&'static str, String)> {
    let mut fields = vec![
        ("program", spec.program().to_owned()),
        ("arg_count", spec.args().len().to_string()),
    ];
    let (resolved_program, prefix_args) = spawn_program_parts(spec.program());
    if resolved_program.to_string_lossy() != spec.program() || !prefix_args.is_empty() {
        fields.push(("resolved_program", resolved_program.display().to_string()));
        fields.push(("prefix_arg_count", prefix_args.len().to_string()));
    }
    if let Some(cwd) = spec.current_dir() {
        fields.push(("cwd", cwd.display().to_string()));
    }
    fields
}

pub(super) fn command_outcome_fields(outcome: &CommandOutcome) -> Vec<(&'static str, String)> {
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

pub(super) fn preview_log_value(value: &str) -> String {
    let value = value.replace(['\r', '\n'], "\\n");
    let mut chars = value.chars();
    let preview: String = chars.by_ref().take(STDERR_PREVIEW_MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{preview}...")
    } else {
        preview
    }
}

pub(super) fn debug_claude_stdout_fields(
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

pub(super) fn open_debug_claude_stdout_file(path: &PathBuf) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().create(true).append(true).open(path)
}

pub(super) fn append_debug_claude_stdout(path: &PathBuf, stdout: &str) -> std::io::Result<()> {
    let mut file = open_debug_claude_stdout_file(path)?;
    for line in stdout.lines() {
        writeln!(file, "{}", debug_claude_stdout_line(line))?;
    }
    Ok(())
}

pub(super) fn debug_claude_stdout_path_for_spec(
    spec: &CommandSpec,
    task_id: Option<&str>,
    subtask_id: Option<&str>,
) -> Option<PathBuf> {
    (is_claude_program(spec.program()) && debug_stdout::enabled())
        .then(|| debug_claude_stdout_path(task_id, subtask_id))
}

pub(super) fn is_claude_program(program: &str) -> bool {
    Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        == Some("claude")
}

pub(super) fn debug_claude_stdout_path(task_id: Option<&str>, subtask_id: Option<&str>) -> PathBuf {
    let filename = match (task_id, subtask_id) {
        (Some(task_id), Some(subtask_id)) => {
            format!("wegent-claude-stdout-{task_id}-{subtask_id}.jsonl")
        }
        _ => format!("wegent-claude-stdout-{}.jsonl", std::process::id()),
    };
    env::temp_dir().join(filename)
}

pub(super) fn failure_message(stderr: Vec<u8>, stdout: Vec<u8>) -> String {
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
