// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    future::Future,
    path::Path,
    pin::Pin,
    process::Stdio,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{process::Command, time};

use crate::process_environment;

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

    pub fn error(message: String, duration: f64, timed_out: bool) -> Self {
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
