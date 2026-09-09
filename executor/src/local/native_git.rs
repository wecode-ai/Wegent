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

use tokio::{process::Command, time};

use crate::process::hide_windows_console;

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

/// Run `git` directly with argv and the executor environment.
pub async fn run_git_capture(
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<GitCapture, GitRunError> {
    let mut command = Command::new("git");
    hide_windows_console(&mut command);
    command.args(args);
    command.env_clear();
    command.envs(sanitize_git_env(env));
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    command.stdin(Stdio::null());
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    command.kill_on_drop(true);

    let child = command.spawn().map_err(|error| GitRunError {
        message: error.to_string(),
        timed_out: false,
    })?;
    let output = time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| GitRunError {
            message: format!("Git command timed out after {}s", timeout.as_secs()),
            timed_out: true,
        })?;
    let output = output.map_err(|error| GitRunError {
        message: error.to_string(),
        timed_out: false,
    })?;
    let success = output.status.success();
    let (stdout, truncated) = truncate_bytes(&output.stdout, max_output_bytes);
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    Ok(GitCapture {
        stdout,
        stderr,
        success,
        truncated,
    })
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
