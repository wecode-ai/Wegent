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
    process::hide_windows_console,
};

const GIT_CALL_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DIFF_OUTPUT_BYTES: usize = 5 * 1024 * 1024;

/// Run `git` with the executor environment and return its output.
///
/// `argv` excludes the program name. Spawn failures (for example git itself
/// being absent from PATH) surface as a non-success `CommandResult` whose
/// error is the OS message, mirroring `CommandHandler::execute`.
async fn run_git(
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<(Vec<u8>, String, bool), (String, bool)> {
    let mut command = Command::new("git");
    hide_windows_console(&mut command);
    command.args(args);
    command.env_clear();
    command.envs(sanitized_git_env(env));
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let child = command
        .spawn()
        .map_err(|error| (error.to_string(), false))?;
    let output = time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            (
                format!("Git command timed out after {}s", timeout.as_secs()),
                true,
            )
        })?;
    let output = output.map_err(|error| (error.to_string(), false))?;
    let success = output.status.success();
    let stdout = truncate_bytes(&output.stdout, max_output_bytes);
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok((stdout, stderr, success))
}

/// Drop environment variables that would redirect git away from the workspace
/// directory passed as `cwd`. Device commands operate on an explicit
/// workspace, so an ambient `GIT_DIR` or similar variable from the parent
/// process must not make them read another repository.
fn sanitized_git_env(env: &HashMap<String, String>) -> HashMap<String, String> {
    // Keep in sync with the local git environment list used by the native
    // turn-file-changes runner (`services::turn_file_changes`).
    const LOCAL_GIT_ENV_KEYS: &[&str] = &[
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
    env.iter()
        .filter(|(key, _)| !LOCAL_GIT_ENV_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

fn truncate_bytes(bytes: &[u8], max_bytes: usize) -> Vec<u8> {
    if bytes.len() <= max_bytes {
        bytes.to_vec()
    } else {
        bytes[..max_bytes].to_vec()
    }
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
}
