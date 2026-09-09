// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Native Git command implementations for device commands that previously
//! depended on a `bash` or `python3` interpreter. Git for Windows installs
//! `git.exe` in `cmd\` while `bash.exe` lives in `bin\`, so spawning `bash`
//! for every Git query fails on common Windows setups with "program not
//! found" even though `git` itself resolves. Running `git` directly with argv
//! keeps the same behavior on every platform without an interpreter.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use tokio::{process::Command, time};

use crate::{
    local::command::{build_env, CommandResult},
    local::native_git::run_git_capture,
    process::hide_windows_console,
};

const GIT_CALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DIFF_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

async fn run_git(
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<(Vec<u8>, String, bool), (String, bool)> {
    let capture = run_git_capture(args, cwd, env, timeout, max_output_bytes)
        .await
        .map_err(|error| (error.message, error.timed_out))?;
    Ok((capture.stdout, capture.stderr, capture.success))
}

fn stdout_text(stdout: &[u8]) -> String {
    String::from_utf8_lossy(stdout).into_owned()
}

fn trim_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn owned_args(args: &[&str]) -> Vec<String> {
    args.iter().map(|arg| (*arg).to_owned()).collect()
}

/// Probe whether a git command produced a successful result.
async fn git_probe_succeeds(
    args: &[&str],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> bool {
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    match run_git(&args, cwd, env, timeout, 4096).await {
        Ok((_, _, success)) => success,
        Err(_) => false,
    }
}

async fn git_stdout_trimmed(
    args: &[&str],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> Option<String> {
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    match run_git(&args, cwd, env, timeout, 64 * 1024).await {
        Ok((stdout, _, success)) if success => trim_empty(stdout_text(&stdout)),
        _ => None,
    }
}

/// Ordered base candidates for branch diffs.
///
/// Fork workflows compare the fork branch against the parent remote
/// (`upstream/HEAD`, then `upstream/main`/`upstream/master`) before falling
/// back to the fork's own `origin` and finally the local default branches.
/// This mirrors the candidate order the replaced shell scripts used.
fn diff_base_candidates(upstream_head: Option<String>, origin_head: Option<String>) -> Vec<String> {
    let mut candidates = Vec::new();
    for candidate in [
        upstream_head,
        Some("upstream/main".to_owned()),
        Some("upstream/master".to_owned()),
        origin_head,
        Some("origin/main".to_owned()),
        Some("origin/master".to_owned()),
        Some("main".to_owned()),
        Some("master".to_owned()),
    ]
    .into_iter()
    .flatten()
    {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// Resolve the branch base used by diff commands: the fork parent remote's
/// default branch when present, otherwise origin, otherwise a local default
/// branch.
async fn resolve_diff_base(
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> Option<String> {
    let upstream_head = git_stdout_trimmed(
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/upstream/HEAD",
        ],
        cwd,
        env,
        timeout,
    )
    .await;
    let origin_head = git_stdout_trimmed(
        &[
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ],
        cwd,
        env,
        timeout,
    )
    .await;
    for candidate in diff_base_candidates(upstream_head, origin_head) {
        if git_probe_succeeds(
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{candidate}^{{commit}}"),
            ],
            cwd,
            env,
            timeout,
        )
        .await
        {
            return Some(candidate);
        }
    }
    None
}

async fn head_commit_exists(
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> bool {
    git_probe_succeeds(
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        cwd,
        env,
        timeout,
    )
    .await
}

async fn merge_base_of(
    base: &str,
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
) -> Option<String> {
    git_stdout_trimmed(&["merge-base", base, "HEAD"], cwd, env, timeout).await
}

/// Append `git diff --no-index` output for every untracked file so the
/// workspace and branch diffs include new files, matching the shell scripts.
async fn append_untracked_diffs(
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Vec<u8> {
    let args = ["ls-files", "--others", "--exclude-standard", "-z"]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect::<Vec<_>>();
    let Ok((stdout, _, _)) = run_git(&args, cwd, env, timeout, max_output_bytes).await else {
        return Vec::new();
    };

    let mut combined = Vec::new();
    for entry in stdout.split(|byte| *byte == 0) {
        if entry.is_empty() {
            continue;
        }
        let file = stdout_text(entry);
        if file.is_empty() {
            continue;
        }
        let diff_args = ["diff", "--binary", "--no-index", "--", "/dev/null", &file]
            .iter()
            .map(|arg| (*arg).to_owned())
            .collect::<Vec<_>>();
        // Untracked file diffs are best-effort in the original scripts too.
        if let Ok((diff_stdout, _, _)) =
            run_git(&diff_args, cwd, env, timeout, max_output_bytes).await
        {
            combined.extend_from_slice(&diff_stdout);
            if combined.len() >= max_output_bytes {
                combined.truncate(max_output_bytes);
                break;
            }
        }
    }
    combined
}

fn build_result(
    started_at: Instant,
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
    error: Option<String>,
) -> CommandResult {
    CommandResult {
        success,
        exit_code: if success { Some(0) } else { None },
        stdout: Value::String(stdout_text(&stdout)),
        stderr,
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error,
    }
}

fn cwd_error(cwd: Option<&Path>) -> Option<CommandResult> {
    let cwd = cwd?;
    if cwd.is_dir() {
        None
    } else {
        Some(CommandResult::error(
            format!("Working directory does not exist: {}", cwd.display()),
            0.0,
            false,
        ))
    }
}

async fn run_diff_with_timeout<F, T>(timeout_seconds: f64, run: F) -> Result<T, CommandResult>
where
    F: std::future::Future<Output = T>,
{
    let timeout = Duration::from_secs_f64(timeout_seconds.max(0.001));
    match time::timeout(timeout, run).await {
        Ok(value) => Ok(value),
        Err(_) => Err(CommandResult::error(
            format!("Command timed out after {timeout_seconds} seconds"),
            0.0,
            true,
        )),
    }
}

/// Workspace diff: tracked changes against HEAD (or the index when HEAD does
/// not exist yet) plus untracked files.
pub async fn workspace_diff(
    cwd: Option<String>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    let cwd_path = cwd.as_deref().map(Path::new);
    if let Some(error) = cwd_error(cwd_path) {
        return error;
    }
    let process_env = build_env(env);
    let call_timeout = GIT_CALL_TIMEOUT.min(Duration::from_secs_f64(timeout_seconds.max(1.0)));
    let max_output_bytes = max_output_bytes.clamp(1, MAX_DIFF_OUTPUT_BYTES);

    let result = run_diff_with_timeout(timeout_seconds, async {
        let head_exists = head_commit_exists(cwd_path, &process_env, call_timeout).await;
        let tracked_args = if head_exists {
            vec!["diff", "--binary", "HEAD", "--"]
        } else {
            vec!["diff", "--binary", "--"]
        }
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        let (tracked_stdout, tracked_stderr, tracked_success) = run_git(
            &tracked_args,
            cwd_path,
            &process_env,
            call_timeout,
            max_output_bytes,
        )
        .await
        .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        let untracked =
            append_untracked_diffs(cwd_path, &process_env, call_timeout, max_output_bytes).await;

        let mut stdout = tracked_stdout;
        stdout.extend_from_slice(&untracked);
        stdout.truncate(max_output_bytes);
        build_result(
            started_at,
            tracked_success || !untracked.is_empty(),
            stdout,
            tracked_stderr,
            None,
        )
    })
    .await;

    result.unwrap_or_else(|error| error)
}

/// Branch diff: changes on the current branch against its merge base with the
/// primary branch, or against HEAD when no base resolves, plus untracked
/// files.
pub async fn branch_diff(
    cwd: Option<String>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    let cwd_path = cwd.as_deref().map(Path::new);
    if let Some(error) = cwd_error(cwd_path) {
        return error;
    }
    let process_env = build_env(env);
    let call_timeout = GIT_CALL_TIMEOUT.min(Duration::from_secs_f64(timeout_seconds.max(1.0)));
    let max_output_bytes = max_output_bytes.clamp(1, MAX_DIFF_OUTPUT_BYTES);

    let result = run_diff_with_timeout(timeout_seconds, async {
        let base = resolve_diff_base(cwd_path, &process_env, call_timeout).await;
        let merge_base = match base.as_deref() {
            Some(base) => merge_base_of(base, cwd_path, &process_env, call_timeout).await,
            None => None,
        };
        let head_exists = head_commit_exists(cwd_path, &process_env, call_timeout).await;
        let tracked_args = if let Some(merge_base) = merge_base {
            owned_args(&["diff", "--binary", &merge_base, "--"])
        } else if head_exists {
            owned_args(&["diff", "--binary", "HEAD", "--"])
        } else {
            owned_args(&["diff", "--binary", "--"])
        };
        let (tracked_stdout, tracked_stderr, tracked_success) = run_git(
            &tracked_args,
            cwd_path,
            &process_env,
            call_timeout,
            max_output_bytes,
        )
        .await
        .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        let untracked =
            append_untracked_diffs(cwd_path, &process_env, call_timeout, max_output_bytes).await;

        let mut stdout = tracked_stdout;
        stdout.extend_from_slice(&untracked);
        stdout.truncate(max_output_bytes);
        build_result(
            started_at,
            tracked_success || !untracked.is_empty(),
            stdout,
            tracked_stderr,
            None,
        )
    })
    .await;

    result.unwrap_or_else(|error| error)
}

/// Branch diff shortstat used by the environment summary, matching the
/// `git diff --shortstat` shape the UI already parses.
pub async fn branch_diff_shortstat(
    cwd: Option<String>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    let cwd_path = cwd.as_deref().map(Path::new);
    if let Some(error) = cwd_error(cwd_path) {
        return error;
    }
    let process_env = build_env(env);
    let call_timeout = GIT_CALL_TIMEOUT.min(Duration::from_secs_f64(timeout_seconds.max(1.0)));
    let max_output_bytes = max_output_bytes.clamp(1, MAX_DIFF_OUTPUT_BYTES);

    let result = run_diff_with_timeout(timeout_seconds, async {
        let base = resolve_diff_base(cwd_path, &process_env, call_timeout).await;
        let merge_base = match base.as_deref() {
            Some(base) => merge_base_of(base, cwd_path, &process_env, call_timeout).await,
            None => None,
        };
        let args = if let Some(merge_base) = merge_base {
            owned_args(&["diff", "--shortstat", &merge_base, "--"])
        } else {
            owned_args(&["diff", "--shortstat", "HEAD", "--"])
        };
        let (stdout, stderr, success) = run_git(
            &args,
            cwd_path,
            &process_env,
            call_timeout,
            max_output_bytes,
        )
        .await
        .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        build_result(started_at, success, stdout, stderr, None)
    })
    .await;

    result.unwrap_or_else(|error| error)
}

/// Push the current branch to origin, replacing the previous `sh` script.
pub async fn push_current_branch(
    cwd: Option<String>,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    let cwd_path = cwd.as_deref().map(Path::new);
    if let Some(error) = cwd_error(cwd_path) {
        return error;
    }
    let process_env = build_env(env);
    let call_timeout = GIT_CALL_TIMEOUT.min(Duration::from_secs_f64(timeout_seconds.max(1.0)));
    let max_output_bytes = max_output_bytes.clamp(1, MAX_DIFF_OUTPUT_BYTES);

    let result = run_diff_with_timeout(timeout_seconds, async {
        let branch_args = owned_args(&["branch", "--show-current"]);
        let (branch_stdout, _, success) =
            run_git(&branch_args, cwd_path, &process_env, call_timeout, 4096)
                .await
                .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        let Some(branch) = trim_empty(stdout_text(&branch_stdout)).filter(|_| success) else {
            return CommandResult {
                success: false,
                exit_code: Some(64),
                stdout: Value::String(String::new()),
                stderr: "Cannot push detached HEAD".to_owned(),
                duration: started_at.elapsed().as_secs_f64(),
                timed_out: false,
                stdout_truncated: false,
                stderr_truncated: false,
                error: Some("Cannot push detached HEAD".to_owned()),
            };
        };
        let push_args = owned_args(&["push", "-u", "origin", &branch]);
        let (stdout, stderr, success) = run_git(
            &push_args,
            cwd_path,
            &process_env,
            call_timeout,
            max_output_bytes,
        )
        .await
        .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        build_result(started_at, success, stdout, stderr, None)
    })
    .await;

    result.unwrap_or_else(|error| error)
}

/// Add a git worktree, replacing the previous `sh` script. `args` carries
/// `source`, `target` and an optional branch ref.
pub async fn worktree_add(
    args: &[String],
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    if args.len() < 2 {
        return CommandResult::error(
            "source and target worktree paths are required".to_owned(),
            0.0,
            false,
        );
    }
    let source = &args[0];
    let target = &args[1];
    let branch = args.get(2).filter(|value| !value.trim().is_empty());
    let process_env = build_env(env);
    let call_timeout = GIT_CALL_TIMEOUT.min(Duration::from_secs_f64(timeout_seconds.max(1.0)));
    let max_output_bytes = max_output_bytes.clamp(1, MAX_DIFF_OUTPUT_BYTES);
    let target_path = Path::new(target);

    let result = run_diff_with_timeout(timeout_seconds, async {
        if let Some(parent) = target_path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return CommandResult::error(
                    format!("Failed to create worktree parent directory: {error}"),
                    0.0,
                    false,
                );
            }
        }
        let probe_args = owned_args(&["-C", target, "rev-parse", "--show-toplevel"]);
        let (probe_stdout, _, probe_success) =
            run_git(&probe_args, None, &process_env, call_timeout, 4096)
                .await
                .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        // `--is-inside-work-tree` is true for any directory inside a repository,
        // so compare the resolved repository top level with the target itself;
        // only a real worktree root may be reused or force-checked-out.
        let already_worktree = probe_success
            && Path::new(stdout_text(&probe_stdout).trim())
                .canonicalize()
                .ok()
                == target_path.canonicalize().ok();
        if already_worktree {
            if let Some(branch) = branch {
                let checkout_args =
                    owned_args(&["-C", target, "checkout", "--force", "--detach", branch]);
                let (stdout, stderr, success) = run_git(
                    &checkout_args,
                    None,
                    &process_env,
                    call_timeout,
                    max_output_bytes,
                )
                .await
                .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
                return build_result(started_at, success, stdout, stderr, None);
            }
            return build_result(started_at, true, Vec::new(), String::new(), None);
        }
        if target_path.exists() {
            return CommandResult {
                success: false,
                exit_code: Some(64),
                stdout: Value::String(String::new()),
                stderr: "target exists and is not a Git worktree".to_owned(),
                duration: started_at.elapsed().as_secs_f64(),
                timed_out: false,
                stdout_truncated: false,
                stderr_truncated: false,
                error: Some("target exists and is not a Git worktree".to_owned()),
            };
        }
        let mut add_args = vec![
            "-C".to_owned(),
            source.clone(),
            "worktree".to_owned(),
            "add".to_owned(),
            "--detach".to_owned(),
            target.clone(),
        ];
        if let Some(branch) = branch {
            add_args.push(branch.clone());
        }
        let (stdout, stderr, success) = run_git(
            &add_args,
            None,
            &process_env,
            call_timeout,
            max_output_bytes,
        )
        .await
        .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
        build_result(started_at, success, stdout, stderr, None)
    })
    .await;

    result.unwrap_or_else(|error| error)
}

/// Remove a git worktree, replacing the previous `sh` script. The target is
/// passed as the last arg (callers historically repeated the path twice).
pub async fn worktree_remove(
    args: &[String],
    env: &HashMap<String, String>,
    timeout_seconds: f64,
    max_output_bytes: usize,
) -> CommandResult {
    let started_at = Instant::now();
    let target = args
        .last()
        .map(String::as_str)
        .unwrap_or_default()
        .to_owned();
    if target.is_empty() {
        return CommandResult::error("target worktree path is required".to_owned(), 0.0, false);
    }
    let process_env = build_env(env);
    let call_timeout = GIT_CALL_TIMEOUT.min(Duration::from_secs_f64(timeout_seconds.max(1.0)));
    let max_output_bytes = max_output_bytes.clamp(1, MAX_DIFF_OUTPUT_BYTES);
    let args = owned_args(&["-C", &target, "worktree", "remove", "--force", &target]);
    let (stdout, stderr, success) =
        run_git(&args, None, &process_env, call_timeout, max_output_bytes)
            .await
            .unwrap_or_else(|(message, _)| (Vec::new(), message, false));
    build_result(started_at, success, stdout, stderr, None)
}

/// Locate `gh` or `glab` using the executor PATH with Windows PATHEXT
/// handling, mirroring `shutil.which` in the removed Python detection script.
fn resolve_cli_executable(tool: &str, env: &HashMap<String, String>) -> Option<PathBuf> {
    let path = env.get("PATH").map(String::as_str).unwrap_or_default();
    #[cfg(windows)]
    let extensions = env
        .get("PATHEXT")
        .map(|value| {
            value
                .split(';')
                .filter(|entry| !entry.is_empty())
                .map(|entry| entry.to_owned())
                .collect::<Vec<_>>()
        })
        .filter(|entries| !entries.is_empty())
        .unwrap_or_else(|| {
            vec![
                ".COM".to_owned(),
                ".EXE".to_owned(),
                ".BAT".to_owned(),
                ".CMD".to_owned(),
            ]
        });
    #[cfg(not(windows))]
    let extensions: Vec<String> = Vec::new();

    for directory in std::env::split_paths(path) {
        let base = directory.join(tool);
        if extensions.is_empty() {
            if base.is_file() {
                return Some(base);
            }
            continue;
        }
        for extension in &extensions {
            let candidate = PathBuf::from(format!("{}{}", base.display(), extension));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Git hosting CLI status detection previously implemented with an embedded
/// python3 script. Returns the same JSON shape (`git_github_cli_status` /
/// `git_gitlab_cli_status`) without depending on a Python interpreter.
pub async fn hosting_cli_status(
    tool: &'static str,
    env: &HashMap<String, String>,
    timeout_seconds: f64,
) -> CommandResult {
    let started_at = Instant::now();
    let process_env = build_env(env);
    let timeout = Duration::from_secs_f64(timeout_seconds.clamp(1.0, 60.0));

    let Some(executable) = resolve_cli_executable(tool, &process_env) else {
        return CommandResult {
            success: true,
            exit_code: Some(0),
            stdout: json!({
                "tool": tool,
                "installed": false,
                "authenticated": false,
                "executablePath": Value::Null,
                "version": Value::Null,
                "detectionError": Value::Null,
            }),
            stderr: String::new(),
            duration: started_at.elapsed().as_secs_f64(),
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
            error: None,
        };
    };

    let version_value =
        match run_cli_probe(&executable, &process_env, &["--version"], timeout).await {
            Ok(output) => stdout_text(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(str::to_owned),
            Err(probe_error) => {
                if probe_error.1 {
                    return cli_timeout_result(tool, &executable, started_at, None);
                }
                return cli_result(
                    tool,
                    &executable,
                    started_at,
                    false,
                    None,
                    None,
                    probe_error.0,
                );
            }
        };
    let auth_output =
        match run_cli_probe(&executable, &process_env, &["auth", "status"], timeout).await {
            Ok(output) => output,
            Err(probe_error) => {
                if probe_error.1 {
                    return cli_timeout_result(tool, &executable, started_at, version_value);
                }
                return cli_result(
                    tool,
                    &executable,
                    started_at,
                    false,
                    version_value,
                    None,
                    probe_error.0,
                );
            }
        };

    let authenticated = if auth_output.status.success() {
        true
    } else if tool != "glab" {
        false
    } else {
        let output = format!(
            "{}{}",
            stdout_text(&auth_output.stdout),
            String::from_utf8_lossy(&auth_output.stderr)
        );
        regex::Regex::new(r"(?m)^\s*[✓✔]\s+Logged in to\s+")
            .map(|pattern| pattern.is_match(&output))
            .unwrap_or(false)
    };

    cli_result(
        tool,
        &executable,
        started_at,
        authenticated,
        version_value,
        None,
        String::new(),
    )
}

/// Run one `gh`/`glab` probe and return its output.
async fn run_cli_probe(
    executable: &Path,
    env: &HashMap<String, String>,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, (String, bool)> {
    let mut command = Command::new(executable);
    hide_windows_console(&mut command);
    command.args(args);
    command.env_clear();
    command.envs(env);
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let child = command
        .spawn()
        .map_err(|error| (error.to_string(), false))?;
    let output = time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| ("CLI command timed out".to_owned(), true))?;
    output.map_err(|error| (error.to_string(), false))
}

fn cli_timeout_result(
    tool: &str,
    executable: &Path,
    started_at: Instant,
    version: Option<String>,
) -> CommandResult {
    CommandResult {
        success: true,
        exit_code: Some(0),
        stdout: json!({
            "tool": tool,
            "installed": true,
            "authenticated": false,
            "executablePath": executable.display().to_string(),
            "version": version,
            "detectionError": "timeout",
        }),
        stderr: String::new(),
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: true,
        stdout_truncated: false,
        stderr_truncated: false,
        error: None,
    }
}

#[allow(clippy::too_many_arguments)]
fn cli_result(
    tool: &str,
    executable: &Path,
    started_at: Instant,
    authenticated: bool,
    version: Option<String>,
    detection_error: Option<String>,
    stderr: String,
) -> CommandResult {
    CommandResult {
        success: true,
        exit_code: Some(0),
        stdout: json!({
            "tool": tool,
            "installed": true,
            "authenticated": authenticated,
            "executablePath": executable.display().to_string(),
            "version": version,
            "detectionError": detection_error,
        }),
        stderr,
        duration: started_at.elapsed().as_secs_f64(),
        timed_out: false,
        stdout_truncated: false,
        stderr_truncated: false,
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command as StdCommand;

    use super::*;

    fn git_setup_env(home: &Path) -> HashMap<String, String> {
        // Build a minimal environment so ambient GIT_* variables or a parent
        // repository cannot redirect the fixture repository operations.
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_owned(), path);
        }
        env.insert("HOME".to_owned(), home.display().to_string());
        env.insert("GIT_CONFIG_NOSYSTEM".to_owned(), "1".to_owned());
        env
    }

    fn run_git_setup(repo: &Path, args: &[&str]) {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(repo)
            .env_clear()
            .envs(git_setup_env(repo))
            .output()
            .expect("git setup should run");
        assert!(
            output.status.success(),
            "git setup failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo_with_commit(repo: &Path) {
        run_git_setup(repo, &["init", "-q", "-b", "main"]);
        run_git_setup(repo, &["config", "user.email", "executor@test.local"]);
        run_git_setup(repo, &["config", "user.name", "Executor Test"]);
        std::fs::write(repo.join("tracked.txt"), "one\ntwo\nthree\nfour\nfive\n")
            .expect("seed file should be written");
        run_git_setup(repo, &["add", "tracked.txt"]);
        run_git_setup(repo, &["commit", "-q", "-m", "seed"]);
    }

    fn empty_env() -> HashMap<String, String> {
        HashMap::new()
    }

    #[tokio::test]
    async fn branch_diff_shortstat_matches_git_line_counts() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let repo = directory.path();
        init_repo_with_commit(repo);
        std::fs::write(
            repo.join("tracked.txt"),
            "one\ntwo\nthree\nfour\nfive\nsix\n",
        )
        .expect("tracked file should be updated");
        std::fs::write(repo.join("untracked.txt"), "new\n")
            .expect("untracked file should be written");

        let result =
            branch_diff_shortstat(Some(repo.display().to_string()), &empty_env(), 10.0, 4096).await;

        assert!(
            result.success,
            "shortstat should succeed: {:?}",
            result.error
        );
        assert_eq!(
            result.stdout,
            Value::String(" 1 file changed, 1 insertion(+)\n".to_owned())
        );
    }

    #[tokio::test]
    async fn branch_diff_and_workspace_diff_include_untracked_files() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let repo = directory.path();
        init_repo_with_commit(repo);
        std::fs::write(repo.join("untracked.txt"), "brand new\n")
            .expect("untracked file should be written");
        std::fs::write(
            repo.join("tracked.txt"),
            "one\ntwo\nthree\nfour\nfive\nchanged\n",
        )
        .expect("tracked file should be updated");

        for diff in [
            branch_diff(
                Some(repo.display().to_string()),
                &empty_env(),
                10.0,
                1 << 20,
            )
            .await,
            workspace_diff(
                Some(repo.display().to_string()),
                &empty_env(),
                10.0,
                1 << 20,
            )
            .await,
        ] {
            assert!(diff.success, "diff should succeed: {:?}", diff.error);
            let stdout = diff.stdout.as_str().unwrap_or_default();
            assert!(
                stdout.contains("untracked.txt"),
                "missing untracked diff in: {stdout}"
            );
            assert!(
                stdout.contains("tracked.txt"),
                "missing tracked diff in: {stdout}"
            );
        }
    }

    #[tokio::test]
    async fn hosting_cli_status_marks_missing_tool_as_not_installed() {
        let result = hosting_cli_status("wegent-definitely-missing-tool", &empty_env(), 5.0).await;
        assert!(result.success);
        assert_eq!(result.stdout["installed"], Value::Bool(false));
        assert_eq!(
            result.stdout["tool"],
            Value::String("wegent-definitely-missing-tool".to_owned())
        );
    }

    #[test]
    fn diff_base_prefers_fork_parent_remote_before_origin() {
        let candidates = diff_base_candidates(
            Some("upstream/main".to_owned()),
            Some("origin/main".to_owned()),
        );
        let upstream = candidates
            .iter()
            .position(|candidate| candidate == "upstream/main")
            .expect("upstream/main should be a candidate");
        let origin = candidates
            .iter()
            .position(|candidate| candidate == "origin/main")
            .expect("origin/main should be a candidate");
        let local = candidates
            .iter()
            .position(|candidate| candidate == "main")
            .expect("main should be a candidate");
        assert!(
            upstream < origin,
            "fork parent remote must be checked first"
        );
        assert!(origin < local, "origin must be checked before local main");
        assert_eq!(
            candidates.len(),
            6,
            "duplicated symbolic defaults should be deduplicated"
        );
    }

    #[test]
    fn diff_base_keeps_upstream_remotes_even_without_symbolic_heads() {
        let candidates = diff_base_candidates(None, None);
        assert_eq!(
            candidates,
            vec![
                "upstream/main",
                "upstream/master",
                "origin/main",
                "origin/master",
                "main",
                "master"
            ]
        );
    }

    #[tokio::test]
    async fn worktree_add_does_not_force_checkout_a_nested_repository_directory() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let repo = directory.path().join("repo");
        std::fs::create_dir_all(&repo).expect("repo directory should be created");
        let setup = |args: &[&str]| {
            let output = StdCommand::new("git")
                .args(args)
                .current_dir(&repo)
                .env_clear()
                .envs(git_setup_env(&repo))
                .output()
                .expect("git setup should run");
            assert!(
                output.status.success(),
                "git setup failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        setup(&["init", "-q", "-b", "main"]);
        setup(&["config", "user.email", "executor@test.local"]);
        setup(&["config", "user.name", "Executor Test"]);
        std::fs::write(repo.join("tracked.txt"), "one\n").expect("seed file should be written");
        setup(&["add", "tracked.txt"]);
        setup(&["commit", "-q", "-m", "seed"]);

        // A nested directory inside the source repository is not a worktree
        // root; the add must reject it instead of force-checking out the
        // enclosing repository.
        let nested = repo.join("nested");
        std::fs::create_dir_all(&nested).expect("nested directory should be created");
        std::fs::write(nested.join("untracked.txt"), "keep me\n")
            .expect("nested content should be written");
        let args = vec![repo.display().to_string(), nested.display().to_string()];
        let result = worktree_add(&args, &empty_env(), 10.0, 1 << 20).await;
        assert!(!result.success);
        assert_eq!(
            result.error.as_deref(),
            Some("target exists and is not a Git worktree")
        );
        assert!(
            std::fs::read_to_string(nested.join("untracked.txt"))
                .map(|content| content == "keep me\n")
                .unwrap_or(false),
            "nested repository content must not be force-checked out"
        );
    }
}
