// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, io, path::Path, process::Stdio, time::Duration};

use serde::Serialize;
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

use super::model::{
    CommandHookConfig, CommandHookOutcome, HookCommandResponse, MAX_TIMEOUT_SECONDS,
    OUTPUT_PREVIEW_BYTES,
};

pub async fn execute_command_hook<T: Serialize>(
    config: &CommandHookConfig,
    plugin_dir: &Path,
    cwd: &Path,
    input: &T,
) -> CommandHookOutcome {
    let script = platform_command(config);
    let script = match resolve_command(script, plugin_dir) {
        Ok(script) => script,
        Err(error) => return failed_outcome(error.to_string()),
    };
    let stdin = match serde_json::to_vec(input) {
        Ok(stdin) => stdin,
        Err(error) => return failed_outcome(error.to_string()),
    };
    let timeout_seconds = config.timeout.clamp(1, MAX_TIMEOUT_SECONDS);
    let mut command = shell_command(&script);
    command
        .current_dir(cwd)
        .env_clear()
        .envs(filtered_environment())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return failed_outcome(error.to_string()),
    };
    let child_id = child.id();
    let write_result = match child.stdin.take() {
        Some(mut child_stdin) => child_stdin.write_all(&stdin).await,
        None => Err(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "hook stdin unavailable",
        )),
    };
    if let Err(error) = write_result {
        let _ = child.kill().await;
        return failed_outcome(error.to_string());
    }

    match timeout(
        Duration::from_secs(timeout_seconds),
        child.wait_with_output(),
    )
    .await
    {
        Err(_) => {
            #[cfg(unix)]
            if let Some(child_id) = child_id {
                // The hook owns its process group, so timeout cleanup also reaches grandchildren.
                unsafe {
                    libc::kill(-(child_id as i32), libc::SIGKILL);
                }
            }
            CommandHookOutcome {
                exit_code: None,
                timed_out: true,
                stdout: String::new(),
                stderr: format!("hook timed out after {timeout_seconds}s"),
                stdout_truncated: false,
                stderr_truncated: false,
                response: None,
            }
        }
        Ok(Err(error)) => failed_outcome(error.to_string()),
        Ok(Ok(output)) => outcome_from_output(output),
    }
}

fn platform_command(config: &CommandHookConfig) -> &str {
    if let Some(command) = config.commands.get(&platform_target()) {
        return command;
    }
    #[cfg(windows)]
    return config.command_windows.as_deref().unwrap_or(&config.command);
    #[cfg(not(windows))]
    return &config.command;
}

fn platform_target() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn resolve_command(command: &str, plugin_dir: &Path) -> io::Result<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "hook command is empty",
        ));
    }
    let Some((program, suffix)) = split_program(trimmed) else {
        return Ok(trimmed.to_owned());
    };
    let path = Path::new(program);
    if path.is_absolute() || (!program.contains('/') && !program.contains('\\')) {
        return Ok(trimmed.to_owned());
    }
    let candidate = plugin_dir.join(path);
    let canonical = candidate.canonicalize()?;
    let plugin_root = plugin_dir.canonicalize()?;
    if !canonical.starts_with(&plugin_root) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "relative hook command escapes plugin directory",
        ));
    }
    Ok(format!("{}{}", shell_quote(&canonical), suffix))
}

fn split_program(command: &str) -> Option<(&str, &str)> {
    if command.starts_with(['\'', '"']) {
        return None;
    }
    let end = command.find(char::is_whitespace).unwrap_or(command.len());
    Some((&command[..end], &command[end..]))
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

#[cfg(windows)]
fn shell_quote(path: &Path) -> String {
    format!("\"{}\"", path.to_string_lossy().replace('"', "\\\""))
}

fn shell_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        let mut command = Command::new("cmd");
        command.args(["/S", "/C", script]);
        command
    }
    #[cfg(not(windows))]
    {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }
}

fn filtered_environment() -> BTreeMap<String, String> {
    const ALLOWED: [&str; 8] = [
        "HOME",
        "LANG",
        "LC_ALL",
        "PATH",
        "SHELL",
        "SystemRoot",
        "TEMP",
        "TMP",
    ];
    std::env::vars()
        .filter(|(key, _)| ALLOWED.contains(&key.as_str()))
        .collect()
}

fn outcome_from_output(output: std::process::Output) -> CommandHookOutcome {
    let (stdout, stdout_truncated) = preview(&output.stdout);
    let (stderr, stderr_truncated) = preview(&output.stderr);
    let response = if stdout.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<HookCommandResponse>(&stdout).ok()
    };
    CommandHookOutcome {
        exit_code: output.status.code(),
        timed_out: false,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
        response,
    }
}

fn preview(bytes: &[u8]) -> (String, bool) {
    let truncated = bytes.len() > OUTPUT_PREVIEW_BYTES;
    let bytes = &bytes[..bytes.len().min(OUTPUT_PREVIEW_BYTES)];
    let value = String::from_utf8_lossy(bytes)
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .collect::<String>();
    (value.trim().to_owned(), truncated)
}

fn failed_outcome(error: String) -> CommandHookOutcome {
    CommandHookOutcome {
        exit_code: None,
        timed_out: false,
        stdout: String::new(),
        stderr: error,
        stdout_truncated: false,
        stderr_truncated: false,
        response: None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;

    fn config(command: String) -> CommandHookConfig {
        CommandHookConfig {
            handler_type: "command".to_owned(),
            command,
            command_windows: None,
            commands: BTreeMap::new(),
            timeout: 2,
            asynchronous: false,
            status_message: None,
        }
    }

    #[tokio::test]
    async fn writes_json_and_closes_stdin() {
        let directory = tempdir().unwrap();
        let script = directory.path().join("reader.sh");
        fs::write(
            &script,
            "#!/bin/sh\ninput=$(cat)\nprintf '{\"received\":%s}' \"$input\"\n",
        )
        .unwrap();
        #[cfg(unix)]
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let outcome = execute_command_hook(
            &config("./reader.sh".to_owned()),
            directory.path(),
            directory.path(),
            &json!({"ok": true}),
        )
        .await;
        assert_eq!(outcome.exit_code, Some(0));
        assert!(outcome.response.is_some());
        assert!(outcome.stdout.contains("\"ok\":true"));
    }

    #[tokio::test]
    async fn times_out() {
        let directory = tempdir().unwrap();
        let mut hook = config("sleep 2".to_owned());
        hook.timeout = 1;
        let outcome =
            execute_command_hook(&hook, directory.path(), directory.path(), &json!({})).await;
        assert!(outcome.timed_out);
    }

    #[test]
    fn selects_the_current_os_and_arch_command() {
        let mut hook = config("fallback".to_owned());
        hook.commands
            .insert(platform_target(), "target-command".to_owned());

        assert_eq!(platform_command(&hook), "target-command");
    }
}
