// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Native commit-message generation for the `git_generate_commit_message`
//! device command. Collects the staged git context, asks the local Codex CLI
//! for a one-line commit subject, and returns the same JSON shape the previous
//! embedded Python script produced.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

use serde_json::json;
use tokio::{io::AsyncWriteExt, process::Command, time};

use crate::{
    agents::{resolve_codex_binary, resolve_codex_binary_path},
    local::command::{build_env, CommandResult},
};

const MAX_DIFF_BYTES: usize = 200_000;
const MAX_STATUS_BYTES: usize = 20_000;
const MAX_MESSAGE_CHARS: usize = 180;
const GIT_TIMEOUT: Duration = Duration::from_secs(15);
const CODEX_TIMEOUT: Duration = Duration::from_secs(90);

/// Generate a Git commit subject line from the staged changes in `cwd`.
pub async fn generate_commit_message(
    cwd: Option<String>,
    env: HashMap<String, String>,
) -> CommandResult {
    let started_at = Instant::now();
    let process_env = build_env(&env);
    let cwd = cwd.as_deref();

    let (status, status_truncated) =
        match run_git(&["status", "--short"], cwd, &process_env, MAX_STATUS_BYTES).await {
            Ok(value) => value,
            Err(message) => return failure(message, started_at),
        };
    let (diff_stat, stat_truncated) = match run_git(
        &["diff", "--cached", "--stat"],
        cwd,
        &process_env,
        MAX_STATUS_BYTES,
    )
    .await
    {
        Ok(value) => value,
        Err(message) => return failure(message, started_at),
    };
    let (diff, diff_truncated) = match run_git(
        &["diff", "--cached", "--"],
        cwd,
        &process_env,
        MAX_DIFF_BYTES,
    )
    .await
    {
        Ok(value) => value,
        Err(message) => return failure(message, started_at),
    };

    if diff_stat.trim().is_empty() && diff.trim().is_empty() {
        return failure("No staged changes to summarize".to_owned(), started_at);
    }

    let prompt = build_prompt(&status, &diff_stat, &diff);
    let binary = resolve_codex_binary_path(&resolve_codex_binary());
    let output_path = temp_output_path();

    let raw_message = match run_codex(&binary, &prompt, &output_path, cwd, &process_env).await {
        Ok(message) => message,
        Err(message) => {
            remove_temp_file(&output_path);
            return failure(message, started_at);
        }
    };
    remove_temp_file(&output_path);

    let message = sanitize_message(&raw_message);
    if message.is_empty() {
        return failure(
            "Codex returned an empty commit message".to_owned(),
            started_at,
        );
    }

    success(
        message,
        status_truncated || stat_truncated || diff_truncated,
        started_at,
    )
}

async fn run_git(
    args: &[&str],
    cwd: Option<&str>,
    env: &HashMap<String, String>,
    max_bytes: usize,
) -> Result<(String, bool), String> {
    let mut command = Command::new("git");
    command.args(args);
    command.env_clear();
    command.envs(env);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let child = command.spawn().map_err(|error| error.to_string())?;
    let output = match time::timeout(GIT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => return Err("Git command timed out".to_owned()),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            "Git command failed".to_owned()
        } else {
            stderr
        });
    }

    Ok(truncate_utf8(&output.stdout, max_bytes))
}

async fn run_codex(
    binary: &str,
    prompt: &str,
    output_path: &Path,
    cwd: Option<&str>,
    env: &HashMap<String, String>,
) -> Result<String, String> {
    let mut command = Command::new(binary);
    command.args([
        "exec",
        "--ephemeral",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--output-last-message",
    ]);
    command.arg(output_path);
    command.arg("-");
    command.env_clear();
    command.envs(env);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::piped());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| error.to_string())?;

    // Feed the prompt on a separate task so a large prompt cannot deadlock
    // against Codex writing to its own stdout/stderr pipes.
    let stdin = child.stdin.take();
    let prompt_bytes = prompt.as_bytes().to_vec();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(&prompt_bytes).await;
            let _ = stdin.shutdown().await;
        }
    });

    let output = time::timeout(CODEX_TIMEOUT, child.wait_with_output()).await;
    let _ = writer.await;

    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Err(error.to_string()),
        Err(_) => return Err("Codex timed out while generating a commit message".to_owned()),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "Codex failed to generate a commit message".to_owned()
        });
    }

    match std::fs::read(output_path) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(error) => Err(error.to_string()),
    }
}

fn build_prompt(status: &str, diff_stat: &str, diff: &str) -> String {
    format!(
        "Generate a Git commit subject line from the staged changes.\n\
Return exactly one line.\n\
Use Conventional Commits when a clear type is available, such as feat:, fix:, refactor:, docs:, test:, chore:, or style:.\n\
Do not include Markdown, quotes, bullets, explanations, or a body.\n\
Keep the line under 72 characters when possible.\n\
\n\
Git status:\n\
{status}\n\
\n\
Staged diff stat:\n\
{diff_stat}\n\
\n\
Staged diff:\n\
{diff}\n"
    )
}

fn sanitize_message(raw: &str) -> String {
    for line in raw.lines() {
        let stripped = line.trim();
        if stripped.is_empty() || stripped.starts_with("```") {
            continue;
        }
        let candidate = clean_candidate(stripped);
        if !candidate.is_empty() {
            return candidate.chars().take(MAX_MESSAGE_CHARS).collect();
        }
    }
    String::new()
}

fn clean_candidate(line: &str) -> String {
    let value = line
        .trim()
        .trim_start_matches(['-', '*', ' '])
        .trim();
    let lowered = value.to_lowercase();
    let mut result = value;
    for prefix in ["commit message:", "message:", "subject:"] {
        if lowered.starts_with(prefix) {
            result = value[prefix.len()..].trim();
            break;
        }
    }
    result
        .trim_matches(['"', '\'', '`'])
        .trim()
        .to_owned()
}

fn truncate_utf8(data: &[u8], max_bytes: usize) -> (String, bool) {
    let truncated = data.len() > max_bytes;
    let slice = if truncated { &data[..max_bytes] } else { data };
    (String::from_utf8_lossy(slice).into_owned(), truncated)
}

fn temp_output_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    std::env::temp_dir().join(format!(
        "wegent-commit-message-{}-{}-{}.txt",
        std::process::id(),
        nanos,
        counter
    ))
}

fn remove_temp_file(path: &Path) {
    let _ = std::fs::remove_file(path);
}

fn failure(message: String, started_at: Instant) -> CommandResult {
    CommandResult {
        success: false,
        exit_code: Some(1),
        stdout: json!({ "success": false, "error": message.clone() }),
        stderr: String::new(),
        duration: elapsed_seconds(started_at),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: Some(message),
    }
}

fn success(message: String, diff_truncated: bool, started_at: Instant) -> CommandResult {
    CommandResult {
        success: true,
        exit_code: Some(0),
        stdout: json!({
            "success": true,
            "message": message,
            "diff_truncated": diff_truncated,
        }),
        stderr: String::new(),
        duration: elapsed_seconds(started_at),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: None,
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
    fn sanitize_message_takes_first_meaningful_line() {
        let raw = "```\nfeat: add commit message generator\nsecond line ignored\n```";
        assert_eq!(
            sanitize_message(raw),
            "feat: add commit message generator"
        );
    }

    #[test]
    fn sanitize_message_strips_prefixes_bullets_and_quotes() {
        assert_eq!(
            sanitize_message("- Subject: \"fix: handle empty diff\""),
            "fix: handle empty diff"
        );
        assert_eq!(
            sanitize_message("* Commit message: `chore: bump deps`"),
            "chore: bump deps"
        );
    }

    #[test]
    fn sanitize_message_returns_empty_when_no_content() {
        assert_eq!(sanitize_message("```\n\n```"), "");
        assert_eq!(sanitize_message(""), "");
    }

    #[test]
    fn sanitize_message_truncates_to_max_chars() {
        let long = "x".repeat(MAX_MESSAGE_CHARS + 50);
        assert_eq!(sanitize_message(&long).chars().count(), MAX_MESSAGE_CHARS);
    }

    #[test]
    fn truncate_utf8_flags_truncation() {
        let (value, truncated) = truncate_utf8(b"hello world", 5);
        assert_eq!(value, "hello");
        assert!(truncated);

        let (value, truncated) = truncate_utf8(b"hi", 5);
        assert_eq!(value, "hi");
        assert!(!truncated);
    }

    #[test]
    fn build_prompt_embeds_all_sections() {
        let prompt = build_prompt("STATUS", "STAT", "DIFF");
        assert!(prompt.contains("Git status:\nSTATUS"));
        assert!(prompt.contains("Staged diff stat:\nSTAT"));
        assert!(prompt.contains("Staged diff:\nDIFF"));
    }
}
