//
// SPDX-License-Identifier: Apache-2.0

//! Cross-platform Git helpers for the local executor.
//!
//! Wegent's UI relies on a stable set of `git_*` device commands. On macOS and Linux those
//! commands can safely be dispatched as shell one-liners, but on Windows spawning
//! `cmd /C` / `bash -lc` for every Git query is fragile:
//!
//! - Git is frequently installed in a non-default location (e.g. `C:\\Program Files\\Git\\cmd`)
//!   and the executor's sanitised PATH may not contain it.
//! - `cmd /C` creates an intermediate shell that can hang on credential helpers or encoding
//!   mismatches, producing the "command timed out" errors users see after the first call.
//!
//! This module provides a small, synchronous Git runner that executes `git` directly with
//! argv arguments and a PATH that has been pre-filled with common installation directories on
//! Windows.

use std::{
    collections::HashMap,
    process::{Command, Stdio},
    time::Instant,
};
#[cfg(windows)]
use std::path::PathBuf;

use crate::local::command::build_env;

/// Maximum time we are willing to wait for a single Git device command.
/// Common installation directories for Git on Windows. These are appended to the process PATH
/// so that `git` can be resolved even when the executor is started from an environment that
/// does not include them.
#[cfg(windows)]
const WINDOWS_GIT_PATHS: &[&str] = &[
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files (x86)\\Git\\cmd",
    "C:\\ProgramData\\chocolatey\\bin",
];

/// Result of running a Git command.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub duration: f64,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }

    pub fn into_command_result(self, stdout_on_success: bool) -> crate::local::command::CommandResult {
        use crate::local::command::CommandResult;
        if self.success() {
            CommandResult::ok(if stdout_on_success {
                self.stdout
            } else {
                String::new()
            })
        } else {
            CommandResult::error(
                if self.stderr.is_empty() {
                    format!("git exited with code {:?}", self.exit_code)
                } else {
                    self.stderr
                },
                self.duration,
                false,
            )
        }
    }
}

/// Run a Git subcommand in `cwd` with the given argv arguments.
///
/// The first argument is the Git subcommand (e.g. `"branch"`, `"status"`); remaining entries
/// are passed verbatim. The working directory is resolved from the caller-provided `path`.
pub fn run_git(cwd: &str, args: &[&str], extra_env: &HashMap<String, String>) -> GitOutput {
    let started_at = Instant::now();

    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env_clear()
        .envs(build_env(extra_env))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    prepend_windows_git_paths(&mut command);

    let output = match command.output() {
        Ok(output) => output,
        Err(error) => {
            return GitOutput {
                stdout: String::new(),
                stderr: error.to_string(),
                exit_code: None,
                duration: started_at.elapsed().as_secs_f64(),
            };
        }
    };

    GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        duration: started_at.elapsed().as_secs_f64(),
    }
}

/// Run a Git subcommand and return its stdout if it succeeded and produced output.
pub fn git_stdout(cwd: &str, args: &[&str], extra_env: &HashMap<String, String>) -> Option<String> {
    let output = run_git(cwd, args, extra_env);
    if !output.success() {
        return None;
    }
    let trimmed = output.stdout.trim().to_owned();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

/// Check whether `path` points to a Git worktree.
pub fn is_worktree(path: &str, extra_env: &HashMap<String, String>) -> bool {
    git_stdout(path, &["rev-parse", "--is-inside-work-tree"], extra_env)
        .map(|output| output == "true")
        .unwrap_or(false)
        || git_stdout(path, &["rev-parse", "--git-dir"], extra_env).is_some()
}

/// Resolve the best merge-base candidate for branch-diff operations.
///
/// This re-implements the shell logic from `GIT_BRANCH_DIFF_SHORTSTAT_SCRIPT` in a
/// cross-platform way so Windows does not need bash.
pub fn resolve_merge_base(cwd: &str, extra_env: &HashMap<String, String>) -> Option<String> {
    // Try the remote default branch symbolic ref first.
    if let Some(remote_default) = git_stdout(
        cwd,
        &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        extra_env,
    ) {
        if git_rev_parse_verify(cwd, &format!("{remote_default}^{{commit}}"), extra_env) {
            if let Some(base) = git_stdout(cwd, &["merge-base", &remote_default, "HEAD"], extra_env) {
                return Some(base);
            }
        }
    }

    for candidate in ["origin/main", "main", "origin/master", "master"] {
        if git_rev_parse_verify(cwd, &format!("{candidate}^{{commit}}"), extra_env) {
            if let Some(base) = git_stdout(cwd, &["merge-base", candidate, "HEAD"], extra_env) {
                return Some(base);
            }
        }
    }

    None
}

fn git_rev_parse_verify(cwd: &str, reference: &str, extra_env: &HashMap<String, String>) -> bool {
    run_git(cwd, &["rev-parse", "--verify", "--quiet", reference], extra_env).success()
}

#[cfg(windows)]
fn prepend_windows_git_paths(command: &mut Command) {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let mut entries: Vec<PathBuf> = std::env::split_paths(&current_path).collect();

    // Add user-level Git installations as well.
    if let Some(local_app_data) = dirs::data_local_dir() {
        let user_git = local_app_data.join("Programs").join("Git").join("cmd");
        if user_git.is_dir() {
            entries.insert(0, user_git);
        }
    }

    for path in WINDOWS_GIT_PATHS.iter().map(PathBuf::from).rev() {
        if path.is_dir() {
            entries.insert(0, path);
        }
    }

    if let Ok(joined) = std::env::join_paths(entries) {
        command.env("PATH", joined);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use tempfile::TempDir;

    fn run_git_or_panic(cwd: &str, args: &[&str]) -> String {
        run_git(cwd, args, &HashMap::new()).stdout
    }

    #[test]
    fn detects_non_worktree() {
        let tmp = TempDir::new().unwrap();
        assert!(!is_worktree(tmp.path().to_str().unwrap(), &HashMap::new()));
    }

    #[test]
    fn detects_worktree() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        run_git_or_panic(cwd, &["init", "--quiet"]);
        assert!(is_worktree(cwd, &HashMap::new()));
    }

    #[test]
    fn reads_current_branch() {
        let tmp = TempDir::new().unwrap();
        let cwd = tmp.path().to_str().unwrap();
        run_git_or_panic(cwd, &["init", "--quiet"]);
        run_git_or_panic(cwd, &["config", "user.email", "test@example.com"]);
        run_git_or_panic(cwd, &["config", "user.name", "Test"]);
        run_git_or_panic(cwd, &["checkout", "-b", "feature/test"]);
        let output = run_git_or_panic(cwd, &["branch", "--show-current"]);
        assert_eq!(output.trim(), "feature/test");
    }
}
