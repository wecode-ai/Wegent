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

use serde_json::Value;
use tokio::{process::Command, time};

use crate::process_environment;

pub(crate) const GIT_CURRENT_BRANCH_ARGV: &[&str] =
    &["git", "symbolic-ref", "--quiet", "--short", "HEAD"];
pub(crate) const GIT_BRANCH_LIST_ARGV: &[&str] = &[
    "git",
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
];

fn prepare_git_branch_query(request: &mut CommandRequest) -> bool {
    let (legacy, portable): (&[&str], &[&str]) = match request.command_key.as_deref() {
        Some("git_branch") => (
            &["git", "branch", "--show-current"],
            GIT_CURRENT_BRANCH_ARGV,
        ),
        Some("git_branch_list") => (
            &["git", "branch", "--format=%(refname:short)"],
            GIT_BRANCH_LIST_ARGV,
        ),
        _ => return false,
    };
    // Backend-forwarded built-ins and local IPC use the same portable query.
    // Preserve explicitly configured commands instead of overriding their argv.
    if request.argv == legacy
        || (request.argv.is_empty()
            && (request.command == legacy.join(" ") || request.command == portable.join(" ")))
    {
        request.argv = portable.iter().map(|arg| (*arg).to_owned()).collect();
        request.command = portable.join(" ");
    }
    request.command_key.as_deref() == Some("git_branch") && request.argv == portable
}

pub use wegent_execution_contracts::command::{
    CommandRequest, CommandResult, DeviceCommandHandler,
};

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
    pub async fn execute(&self, mut request: CommandRequest) -> CommandResult {
        let started_at = Instant::now();
        log_directory_command_phase(&request, "execute_enter", started_at);
        let current_branch_query = prepare_git_branch_query(&mut request);
        if request.command_key.as_deref() == Some("project_workspace_root") {
            return CommandResult::ok(
                crate::workspace_paths::projects_root()
                    .display()
                    .to_string(),
            );
        }
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

        #[cfg(windows)]
        if let Some(result) = execute_windows_builtin_command(&request) {
            return result;
        }

        if let Some(result) = execute_directory_command(&request).await {
            return result;
        }

        log_directory_command_phase(&request, "prepare_environment", started_at);
        let mut command = process_command(&request);
        command.env_clear();
        command.envs(build_env(&request.env));
        log_directory_command_phase(&request, "environment_ready", started_at);
        if let Some(cwd) = request.cwd.as_deref() {
            command.current_dir(cwd);
        }
        command.stdin(Stdio::null());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.kill_on_drop(true);

        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                return CommandResult::error(error.to_string(), elapsed_seconds(started_at), false);
            }
        };
        log_directory_command_phase(&request, "spawned", started_at);

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
        log_directory_command_phase(&request, "exited", started_at);

        let (stdout, stdout_truncated) =
            decode_and_truncate(&output.stdout, request.max_output_bytes);
        let (stderr, stderr_truncated) =
            decode_and_truncate(&output.stderr, request.max_output_bytes);
        let mut exit_code = output.status.code();
        // symbolic-ref exits 1 for detached HEAD; branch --show-current returns
        // successful empty output. Other failures retain their original status.
        if current_branch_query
            && exit_code == Some(1)
            && !stdout_truncated
            && !stderr_truncated
            && stdout.is_empty()
            && stderr.is_empty()
        {
            exit_code = Some(0);
        }

        CommandResult {
            success: exit_code == Some(0),
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

fn log_directory_command_phase(request: &CommandRequest, phase: &str, started_at: Instant) {
    let Some(command_key @ ("home_dir" | "ls_dirs")) = request.command_key.as_deref() else {
        return;
    };
    crate::logging::log_executor_event(
        "device directory command phase",
        &[
            ("command_key", command_key.to_owned()),
            ("phase", phase.to_owned()),
            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
        ],
    );
}

async fn execute_directory_command(request: &CommandRequest) -> Option<CommandResult> {
    let expected: &[&str] = match request.command_key.as_deref() {
        Some("home_dir") => &["printenv", "HOME"],
        Some("ls_dirs") => &["ls", "-a", "-p"],
        _ => return None,
    };
    // Explicit custom command definitions retain their command execution path.
    if request.command != expected.join(" ")
        || (!request.argv.is_empty() && request.argv != expected)
    {
        return None;
    }
    let started_at = Instant::now();
    let output = if request.command_key.as_deref() == Some("home_dir") {
        match build_env(&request.env).get("HOME") {
            Some(home) => Ok(format!("{home}\n")),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "HOME is not configured",
            )),
        }
    } else {
        directory_command_output(request.cwd.as_deref().unwrap_or(".")).await
    };
    let mut result = match output {
        Ok(output) => {
            let (text, truncated) =
                decode_and_truncate(output.as_bytes(), request.max_output_bytes);
            let mut result = CommandResult::ok(text);
            result.stdout_truncated = truncated;
            result
        }
        Err(error) => CommandResult::error(error.to_string(), 0.0, false),
    };
    result.duration = elapsed_seconds(started_at);
    log_directory_command_phase(request, "native_completed", started_at);
    Some(result)
}

async fn directory_command_output(path: &str) -> std::io::Result<String> {
    let mut entries = tokio::fs::read_dir(path).await?;
    let mut names = vec!["./".to_owned(), "../".to_owned()];
    while let Some(entry) = entries.next_entry().await? {
        let mut name = entry.file_name().to_string_lossy().into_owned();
        // Like `ls -p`, symbolic links are not treated as directories.
        if entry.file_type().await?.is_dir() {
            name.push('/');
        }
        names.push(name);
    }
    names.sort();
    Ok(format!("{}\n", names.join("\n")))
}

pub(crate) use wegent_runtime_config::home::configured_home_dir;
#[cfg(test)]
use wegent_runtime_config::home::normalize_windows_home_path;

#[cfg(windows)]
fn execute_windows_builtin_command(request: &CommandRequest) -> Option<CommandResult> {
    match request.command_key.as_deref() {
        Some("home_dir") => Some(CommandResult::ok(
            configured_home_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| ".".to_owned()),
        )),
        Some("pwd") => Some(CommandResult::ok(request.cwd.clone().unwrap_or_else(
            || {
                std::env::current_dir()
                    .map(|path| path.display().to_string())
                    .unwrap_or_else(|_| ".".to_owned())
            },
        ))),
        _ => None,
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
        let (program, prefix_args) = crate::process::spawn_program_parts(&request.argv[0]);
        let mut command = Command::new(program);
        crate::process::hide_windows_console(&mut command);
        command.args(prefix_args);
        command.args(&request.argv[1..]);
        return command;
    }

    shell_command(&request.command)
}

#[cfg(windows)]
fn shell_command(command_line: &str) -> Command {
    wegent_subprocess::windows_shell_command(command_line)
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

fn elapsed_seconds(started_at: Instant) -> f64 {
    let elapsed = started_at.elapsed().as_secs_f64();
    (elapsed * 1_000_000.0).round() / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::normalize_windows_home_path;
    use std::path::PathBuf;

    #[test]
    fn windows_home_path_converts_msys_drive_paths() {
        assert_eq!(
            normalize_windows_home_path(PathBuf::from("/d/a/Wegent/Wegent")),
            PathBuf::from(r"D:\a\Wegent\Wegent")
        );
    }

    #[test]
    fn windows_home_path_preserves_native_paths() {
        assert_eq!(
            normalize_windows_home_path(PathBuf::from(r"D:\a\Wegent\Wegent")),
            PathBuf::from(r"D:\a\Wegent\Wegent")
        );
    }
}
