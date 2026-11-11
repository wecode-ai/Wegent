// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared native git runner and environment rules.
//!
//! Native git callers across the executor (`git_commands`, commit-message
//! generation, turn-file-changes) must agree on how git is spawned: directly
//! with argv (never through `bash`), with a bounded timeout, with output
//! truncation reporting, and with an environment that cannot be hijacked by
//! ambient git repository-selector variables from the parent process.

use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};

use tokio::{io::AsyncWriteExt, process::Command, time};

use crate::process::{hide_windows_console, ProcessTreeGuard};

/// Environment variables that can redirect git away from the workspace the
/// caller explicitly targets. Device and runtime commands always pass an
/// explicit workspace, so ambient values must not make git read another
/// repository or apply injected configuration.
pub const LOCAL_GIT_ENV_KEYS: &[&str] = &[
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

/// Remove git repository-selector variables from an async child environment.
pub fn sanitize_git_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    env.iter()
        .filter(|(key, _)| !LOCAL_GIT_ENV_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// Remove git repository-selector variables from a synchronous child command.
pub fn clear_local_git_env(command: &mut std::process::Command) {
    for key in LOCAL_GIT_ENV_KEYS {
        command.env_remove(key);
    }
}

/// Captured output of one git invocation.
#[derive(Debug, Clone)]
pub struct GitCapture {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub success: bool,
    pub truncated: bool,
}

/// Spawn or timeout failure for a git invocation.
#[derive(Debug, Clone)]
pub struct GitRunError {
    pub message: String,
    pub timed_out: bool,
}

/// Run Git with directory ownership lasting through process exit and cancellation.
pub async fn run_git_capture(
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<GitCapture, GitRunError> {
    capture_git(args, None, cwd, env, timeout, max_output_bytes).await
}

pub async fn run_git_capture_with_input(
    args: &[String],
    input: &[u8],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<GitCapture, GitRunError> {
    capture_git(args, Some(input), cwd, env, timeout, max_output_bytes).await
}

async fn capture_git(
    args: &[String],
    input: Option<&[u8]>,
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<GitCapture, GitRunError> {
    let deadline = time::Instant::now() + timeout;
    let access = match cwd {
        Some(path) => Some(
            time::timeout_at(deadline, crate::workspace_lifetime::use_directory(path))
                .await
                .map_err(|_| git_error("Git workspace access timed out", true))?
                .map_err(|error| git_error(error, false))?,
        ),
        None => None,
    };
    let mut command = Command::new("git");
    hide_windows_console(&mut command);
    command.args(args).env_clear().envs(sanitize_git_env(env));
    if let Some(path) = cwd {
        command.current_dir(path);
    }
    command.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let child = command
        .spawn()
        .map_err(|error| git_error(error.to_string(), false))?;
    let (cancellation, cancelled) = tokio::sync::oneshot::channel();
    // Dropping the caller signals the owner, which kills and reaps the process
    // before releasing its directory. A dropped wait_with_output cannot do that.
    let result = tokio::spawn(supervise_git(
        child,
        access,
        cwd.map(Path::to_path_buf),
        input.map(Vec::from),
        deadline,
        max_output_bytes,
        cancelled,
    ))
    .await
    .map_err(|error| git_error(error.to_string(), false))?;
    drop(cancellation);
    result
}

async fn supervise_git(
    mut child: tokio::process::Child,
    _access: Option<Vec<tokio::sync::OwnedRwLockReadGuard<()>>>,
    cwd: Option<std::path::PathBuf>,
    input: Option<Vec<u8>>,
    deadline: time::Instant,
    max_output_bytes: usize,
    mut cancelled: tokio::sync::oneshot::Receiver<()>,
) -> Result<GitCapture, GitRunError> {
    let pid = child.id();
    let mut tree = ProcessTreeGuard::new(pid);
    log_git_directory_use("native git directory acquired", cwd.as_deref(), pid);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdin = child.stdin.take();
    let result = {
        let capture = async {
            let (status, stdout, stderr, ()) = tokio::try_join!(
                child.wait(),
                read_pipe(stdout),
                read_pipe(stderr),
                write_input(stdin, input)
            )?;
            let (stdout, truncated) = truncate_bytes(&stdout, max_output_bytes);
            Ok::<_, std::io::Error>(GitCapture {
                stdout,
                stderr: String::from_utf8_lossy(&stderr).into_owned(),
                success: status.success(),
                truncated,
            })
        };
        tokio::select! {
            biased;
            _ = &mut cancelled => Err(git_error("Git request was cancelled", false)),
            _ = time::sleep_until(deadline) => Err(git_error("Git command timed out", true)),
            output = capture => output.map_err(|error| git_error(error.to_string(), false)),
        }
    };
    if let Err(original) = &result {
        if child.try_wait().ok().flatten().is_none() {
            tree.terminate();
        }
        if let Err(error) = child.kill().await {
            if child.try_wait().ok().flatten().is_none() {
                return Err(git_error(
                    format!("{}; failed to stop Git: {error}", original.message),
                    original.timed_out,
                ));
            }
        }
    }
    tree.disarm();
    let event = match &result {
        Err(error) if error.timed_out => "native git directory wait timed out",
        Err(_) => "native git directory wait failed",
        Ok(_) => "native git directory wait finished",
    };
    log_git_directory_use(event, cwd.as_deref(), pid);
    result
}

async fn read_pipe<Reader: tokio::io::AsyncRead + Unpin>(
    pipe: Option<Reader>,
) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut pipe = pipe.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Git output pipe is missing")
    })?;
    let mut output = Vec::new();
    pipe.read_to_end(&mut output).await?;
    Ok(output)
}

async fn write_input(
    mut stdin: Option<tokio::process::ChildStdin>,
    input: Option<Vec<u8>>,
) -> std::io::Result<()> {
    if let Some(input) = input {
        let stdin = stdin.as_mut().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Git stdin is missing")
        })?;
        stdin.write_all(&input).await?;
    }
    Ok(())
}

fn git_error(message: impl Into<String>, timed_out: bool) -> GitRunError {
    GitRunError {
        message: message.into(),
        timed_out,
    }
}

fn log_git_directory_use(event: &str, cwd: Option<&Path>, pid: Option<u32>) {
    // Windows keeps a process's working directory open until the child exits.
    // Record ownership without exposing command arguments or environment values.
    if !cfg!(windows) {
        return;
    }
    crate::logging::log_executor_event(
        event,
        &[
            (
                "cwd",
                cwd.map(|path| path.display().to_string())
                    .unwrap_or_default(),
            ),
            ("pid", pid.map(|pid| pid.to_string()).unwrap_or_default()),
        ],
    );
}

fn truncate_bytes(bytes: &[u8], max_bytes: usize) -> (Vec<u8>, bool) {
    if bytes.len() <= max_bytes {
        (bytes.to_vec(), false)
    } else {
        (bytes[..max_bytes].to_vec(), true)
    }
}

/// Convert an owned argument list into a slice-friendly owned vector.
pub fn owned_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}
