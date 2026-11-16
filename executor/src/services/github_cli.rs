//! Shared GitHub.com credential context and authentication probe.

use std::{collections::HashMap, process::Stdio, time::Duration};

use serde_json::{json, Value};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};

pub(crate) const HEALTH_ARGS: &[&str] = &["api", "user", "--silent", "--hostname", "github.com"];

pub(crate) fn command(args: &[&str], environment: &HashMap<String, String>) -> Command {
    let executable = crate::local::git_commands::resolve_cli_executable("gh", environment)
        .unwrap_or_else(|| "gh".into());
    crate::logging::log_executor_event(
        "github_cli.command",
        &[
            (
                "operation",
                args.iter().take(2).copied().collect::<Vec<_>>().join(" "),
            ),
            ("executable", executable.display().to_string()),
            (
                "config_dir",
                environment
                    .get("GH_CONFIG_DIR")
                    .cloned()
                    .unwrap_or_else(|| "native".into()),
            ),
        ],
    );
    let (program, prefix) = crate::process::spawn_program_parts(&executable.to_string_lossy());
    let mut command = Command::new(program);
    crate::process::hide_windows_console(&mut command);
    command
        .args(prefix)
        .args(args)
        .env_clear()
        .envs(environment);
    command
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    command
}

pub(crate) fn classify_health(exit_code: Option<i32>, stderr: &[u8]) -> Value {
    if exit_code == Some(0) {
        return json!({"status": "ok"});
    }
    let text = String::from_utf8_lossy(stderr).to_lowercase();
    if exit_code == Some(4)
        || text.contains("http 401")
        || (text.contains("to get started with github cli") && text.contains("gh auth login"))
    {
        json!({"status": "need_login"})
    } else {
        json!({"status": "error", "errorCode": "gh_health_failed"})
    }
}

pub(crate) async fn health(
    environment: &HashMap<String, String>,
    timeout: Duration,
    entry: &str,
) -> Value {
    let mut command = command(HEALTH_ARGS, environment);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(cause) => {
            crate::logging::log_executor_event(
                "github_cli.command_spawn_failed",
                &[
                    ("entry", entry.into()),
                    ("error_kind", format!("{:?}", cause.kind())),
                    ("os_error", format!("{:?}", cause.raw_os_error())),
                ],
            );
            return json!({"status":"error", "errorCode": if cause.kind() == std::io::ErrorKind::NotFound {
            "gh_missing"
        } else { "gh_start_failed" }});
        }
    };
    let result = match tokio::time::timeout(timeout, probe(&mut child)).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => json!({"status":"error", "errorCode":"gh_health_failed"}),
        Err(_) => json!({"status":"error", "errorCode":"gh_health_timeout"}),
    };
    crate::logging::log_executor_event(
        "github_cli.health",
        &[
            ("entry", entry.into()),
            (
                "status",
                result["status"].as_str().unwrap_or("error").into(),
            ),
            (
                "error_code",
                result["errorCode"].as_str().unwrap_or("").into(),
            ),
        ],
    );
    result
}

async fn probe(child: &mut Child) -> Result<Value, std::io::Error> {
    // Bound captured output, discard account data, and never return raw output.
    let mut stderr = child.stderr.take().ok_or(std::io::ErrorKind::BrokenPipe)?;
    let mut tail = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let count = stderr.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..count]);
        if tail.len() > 4096 {
            tail.drain(..tail.len() - 4096);
        }
    }
    let status = child.wait().await?;
    Ok(classify_health(status.code(), &tail))
}

#[cfg(test)]
mod tests;
