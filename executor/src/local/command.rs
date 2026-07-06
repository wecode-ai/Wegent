// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    process::{Command as StdCommand, Stdio},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{process::Command, time};

use crate::{logging::log_executor_event, process_environment};

const DEFAULT_TIMEOUT_SECONDS: f64 = 60.0;
const MAX_TIMEOUT_SECONDS: f64 = 600.0;
const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

pub trait DeviceCommandHandler: Send + Sync {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>>;
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandRequest {
    pub command: String,
    #[serde(default)]
    pub argv: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub timeout_seconds: f64,
    pub max_output_bytes: usize,
}

impl CommandRequest {
    pub fn from_value(value: Value) -> Self {
        let command = string_field(&value, "command").unwrap_or_default();
        let argv = value
            .get("argv")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty() && !items[0].trim().is_empty())
            .unwrap_or_default();
        let cwd = string_field(&value, "cwd").filter(|path| !path.trim().is_empty());
        let env = value
            .get("env")
            .and_then(Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .filter(|(key, _)| !key.is_empty())
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            value
                                .as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| value.to_string()),
                        )
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();

        Self {
            command,
            argv,
            cwd,
            env,
            timeout_seconds: normalized_f64(
                value.get("timeout_seconds"),
                DEFAULT_TIMEOUT_SECONDS,
                MAX_TIMEOUT_SECONDS,
            ),
            max_output_bytes: normalized_usize(
                value.get("max_output_bytes"),
                DEFAULT_MAX_OUTPUT_BYTES,
                MAX_OUTPUT_BYTES,
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: Value,
    pub stderr: String,
    pub duration: f64,
    pub timed_out: bool,
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CommandResult {
    pub fn ok(stdout: impl Into<Value>) -> Self {
        Self {
            success: true,
            exit_code: Some(0),
            stdout: stdout.into(),
            stderr: String::new(),
            duration: 0.0,
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
            error: None,
        }
    }

    fn error(message: String, duration: f64, timed_out: bool) -> Self {
        Self {
            success: false,
            exit_code: None,
            stdout: Value::String(String::new()),
            stderr: String::new(),
            duration,
            timed_out,
            stdout_truncated: false,
            stderr_truncated: false,
            error: Some(message),
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct CommandHandler;

impl DeviceCommandHandler for CommandHandler {
    fn handle_execute_command<'a>(
        &'a self,
        request: CommandRequest,
    ) -> Pin<Box<dyn Future<Output = CommandResult> + Send + 'a>> {
        Box::pin(async move { self.execute(request).await })
    }
}

impl CommandHandler {
    pub async fn execute(&self, request: CommandRequest) -> CommandResult {
        let started_at = Instant::now();
        if request.command.trim().is_empty() {
            return CommandResult::error(
                "command is required".to_owned(),
                elapsed_seconds(started_at),
                false,
            );
        }

        if let Some(cwd) = request.cwd.as_deref() {
            if !Path::new(cwd).is_dir() {
                return CommandResult::error(
                    format!("Working directory does not exist: {cwd}"),
                    elapsed_seconds(started_at),
                    false,
                );
            }
        }

        let git_context = request
            .cwd
            .as_deref()
            .and_then(GitWorktreeCommandContext::from_cwd);
        if let Some(context) = &git_context {
            log_worktree_command_event("local device command worktree started", &request, context);
        }

        let mut command = process_command(&request);
        command.env_clear();
        command.envs(build_env(&request.env));
        if let Some(cwd) = request.cwd.as_deref() {
            command.current_dir(cwd);
        }
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);

        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return CommandResult::error(error.to_string(), elapsed_seconds(started_at), false);
            }
        };

        let timeout = Duration::from_secs_f64(request.timeout_seconds.max(0.001));
        let output = match time::timeout(timeout, child.wait_with_output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(error)) => {
                return CommandResult::error(error.to_string(), elapsed_seconds(started_at), false);
            }
            Err(_) => {
                return CommandResult::error(
                    format!(
                        "Command timed out after {} seconds",
                        request.timeout_seconds.max(0.001)
                    ),
                    elapsed_seconds(started_at),
                    true,
                );
            }
        };

        let (stdout, stdout_truncated) =
            decode_and_truncate(&output.stdout, request.max_output_bytes);
        let (stderr, stderr_truncated) =
            decode_and_truncate(&output.stderr, request.max_output_bytes);
        let exit_code = output.status.code();

        if let Some(context) = &git_context {
            log_worktree_command_finish(&request, context, output.status.success(), exit_code);
        }

        CommandResult {
            success: output.status.success(),
            exit_code,
            stdout: Value::String(stdout),
            stderr,
            duration: elapsed_seconds(started_at),
            timed_out: false,
            stdout_truncated,
            stderr_truncated,
            error: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitWorktreeCommandContext {
    cwd: String,
    top_level: String,
    git_dir: String,
    common_dir: String,
    core_bare_before: Option<String>,
}

impl GitWorktreeCommandContext {
    fn from_cwd(cwd: &str) -> Option<Self> {
        let normalized_cwd = normalize_path_string(Path::new(cwd));
        if !is_managed_worktree_path(&normalized_cwd) {
            return None;
        }

        Some(Self {
            cwd: normalized_cwd,
            top_level: git_output(cwd, &["rev-parse", "--show-toplevel"])
                .unwrap_or_else(|| "<unknown>".to_owned()),
            git_dir: git_output(cwd, &["rev-parse", "--git-dir"])
                .unwrap_or_else(|| "<unknown>".to_owned()),
            common_dir: git_output(cwd, &["rev-parse", "--git-common-dir"])
                .unwrap_or_else(|| "<unknown>".to_owned()),
            core_bare_before: git_output(cwd, &["config", "--get", "core.bare"]),
        })
    }
}

fn log_worktree_command_finish(
    request: &CommandRequest,
    context: &GitWorktreeCommandContext,
    success: bool,
    exit_code: Option<i32>,
) {
    let core_bare_after = git_output(&context.cwd, &["config", "--get", "core.bare"]);
    let core_bare_changed = core_bare_after != context.core_bare_before;
    let core_bare_true = core_bare_after.as_deref() == Some("true");
    let event = if core_bare_true || core_bare_changed {
        "local device command worktree git config changed"
    } else {
        "local device command worktree finished"
    };

    let mut fields = worktree_command_fields(request, context);
    fields.push(("success", success.to_string()));
    fields.push((
        "exit_code",
        exit_code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "none".to_owned()),
    ));
    fields.push((
        "core_bare_before",
        context
            .core_bare_before
            .clone()
            .unwrap_or_else(|| "<unset>".to_owned()),
    ));
    fields.push((
        "core_bare_after",
        core_bare_after.unwrap_or_else(|| "<unset>".to_owned()),
    ));
    fields.push(("core_bare_changed", core_bare_changed.to_string()));
    log_executor_event(event, &fields);
}

fn log_worktree_command_event(
    event: &str,
    request: &CommandRequest,
    context: &GitWorktreeCommandContext,
) {
    let fields = worktree_command_fields(request, context);
    log_executor_event(event, &fields);
}

fn worktree_command_fields(
    request: &CommandRequest,
    context: &GitWorktreeCommandContext,
) -> Vec<(&'static str, String)> {
    vec![
        ("cwd", context.cwd.clone()),
        ("git_top_level", context.top_level.clone()),
        ("git_dir", context.git_dir.clone()),
        ("git_common_dir", context.common_dir.clone()),
        ("command_preview", command_preview(request)),
        ("argv_count", request.argv.len().to_string()),
    ]
}

fn command_preview(request: &CommandRequest) -> String {
    if !request.argv.is_empty() {
        return request
            .argv
            .iter()
            .take(8)
            .map(|item| item.replace('\n', "\\n"))
            .collect::<Vec<_>>()
            .join(" ");
    }
    request
        .command
        .replace('\n', "\\n")
        .chars()
        .take(240)
        .collect()
}

fn git_output(cwd: &str, args: &[&str]) -> Option<String> {
    let output = StdCommand::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env_clear()
        .envs(build_env(&HashMap::new()))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn is_managed_worktree_path(path: &str) -> bool {
    path.contains("/.wecode/wegent-executor/workspace/worktrees/")
        || path.contains("/.wegent-executor/workspace/worktrees/")
}

fn normalize_path_string(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn build_env(extra_env: &HashMap<String, String>) -> HashMap<String, String> {
    process_environment::process_env(
        &extra_env
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<Vec<_>>(),
    )
}

fn process_command(request: &CommandRequest) -> Command {
    if !request.argv.is_empty() {
        let mut command = Command::new(&request.argv[0]);
        command.args(&request.argv[1..]);
        return command;
    }

    shell_command(&request.command)
}

#[cfg(windows)]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("cmd");
    command.args(["/C", command_line]);
    command
}

#[cfg(not(windows))]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("sh");
    command.args(["-c", command_line]);
    command
}

fn decode_and_truncate(data: &[u8], max_bytes: usize) -> (String, bool) {
    let truncated = data.len() > max_bytes;
    let bytes = if truncated { &data[..max_bytes] } else { data };
    (String::from_utf8_lossy(bytes).to_string(), truncated)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn normalized_usize(value: Option<&Value>, default: usize, upper_bound: usize) -> usize {
    normalized_f64(value, default as f64, upper_bound as f64).round() as usize
}

fn normalized_f64(value: Option<&Value>, default: f64, upper_bound: f64) -> f64 {
    let parsed = value
        .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(default);
    if parsed <= 0.0 {
        default
    } else {
        parsed.min(upper_bound)
    }
}

fn elapsed_seconds(started_at: Instant) -> f64 {
    let elapsed = started_at.elapsed().as_secs_f64();
    (elapsed * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_worktree_detection_accepts_wegent_roots() {
        assert!(is_managed_worktree_path(
            "/Users/alice/.wecode/wegent-executor/workspace/worktrees/42/Wegent"
        ));
        assert!(is_managed_worktree_path(
            "/Users/alice/.wegent-executor/workspace/worktrees/runtime-1/Wegent"
        ));
        assert!(!is_managed_worktree_path(
            "/Users/alice/dev/wegent_workspace/Wegent"
        ));
    }

    #[test]
    fn command_preview_prefers_argv_and_limits_shell_text() {
        let argv_request = CommandRequest {
            argv: vec![
                "git".to_owned(),
                "commit".to_owned(),
                "-m".to_owned(),
                "line\nbreak".to_owned(),
            ],
            ..CommandRequest::default()
        };
        assert_eq!(command_preview(&argv_request), "git commit -m line\\nbreak");

        let shell_request = CommandRequest {
            command: "x".repeat(300),
            ..CommandRequest::default()
        };
        assert_eq!(command_preview(&shell_request).len(), 240);
    }
}
