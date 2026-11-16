// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use sha2::{Digest, Sha256};

use crate::{process::CommandSpec, protocol::ExecutionRequest};

const CARGO_TARGET_DIR_ENV: &str = "CARGO_TARGET_DIR";
const DISABLE_SHARED_CARGO_TARGET_ENV: &str = "WEGENT_DISABLE_SHARED_CARGO_TARGET";
const CARGO_TARGET_ROOT_ENV: &str = "WEGENT_CARGO_TARGET_ROOT";

pub fn configure_command(request: &ExecutionRequest, spec: CommandSpec) -> CommandSpec {
    if spec.envs().contains_key(CARGO_TARGET_DIR_ENV) {
        return spec;
    }
    match shared_cargo_target_dir(request) {
        Some(target_dir) => spec.env(CARGO_TARGET_DIR_ENV, target_dir.display().to_string()),
        None => spec,
    }
}

pub fn codex_config_override(request: &ExecutionRequest) -> Option<String> {
    let target_dir = shared_cargo_target_dir(request)?;
    let value = serde_json::to_string(&target_dir.display().to_string()).ok()?;
    Some(format!(
        "shell_environment_policy.set.{CARGO_TARGET_DIR_ENV}={value}"
    ))
}

fn shared_cargo_target_dir(request: &ExecutionRequest) -> Option<PathBuf> {
    if env::var(DISABLE_SHARED_CARGO_TARGET_ENV).ok().as_deref() == Some("1") {
        return None;
    }
    if should_preserve_cargo_target_dir(
        env::var_os(CARGO_TARGET_DIR_ENV).as_deref(),
        env::var("WEGENT_CARGO_TARGET_DIR_AUTO").ok().as_deref(),
    ) {
        return None;
    }
    let workspace = request.cwd().map(Path::new)?;
    let cache_root = cargo_target_root()?;
    shared_cargo_target_dir_for_workspace(workspace, &cache_root)
}

fn should_preserve_cargo_target_dir(
    cargo_target_dir: Option<&std::ffi::OsStr>,
    automatically_configured: Option<&str>,
) -> bool {
    cargo_target_dir.is_some_and(|value| !value.is_empty()) && automatically_configured != Some("1")
}

fn cargo_target_root() -> Option<PathBuf> {
    non_empty_env_path(CARGO_TARGET_ROOT_ENV)
        .or_else(|| {
            non_empty_env_path("XDG_CACHE_HOME").map(|path| path.join("wegent/cargo-target"))
        })
        .or({
            #[cfg(windows)]
            {
                non_empty_env_path("LOCALAPPDATA")
                    .map(|path| path.join("wegent").join("cargo-target"))
            }
            #[cfg(not(windows))]
            {
                None
            }
        })
        .or_else(|| dirs::home_dir().map(|path| path.join(".cache/wegent/cargo-target")))
}

fn non_empty_env_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn shared_cargo_target_dir_for_workspace(workspace: &Path, cache_root: &Path) -> Option<PathBuf> {
    let git_common_dir = git_common_dir(workspace)?;
    let repository_key = repository_cache_key(&git_common_dir);
    let target_dir = cache_root.join("repositories").join(repository_key);
    fs::create_dir_all(&target_dir).ok()?;
    Some(target_dir)
}

fn git_common_dir(workspace: &Path) -> Option<PathBuf> {
    let mut command = Command::new("git");
    crate::process::hide_windows_console(&mut command);
    let output = command
        .arg("-c")
        .arg("core.bare=false")
        .arg("-C")
        .arg(workspace)
        .args(["rev-parse", "--git-common-dir"])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if value.is_empty() {
        return None;
    }
    let path = PathBuf::from(value);
    let absolute = if path.is_absolute() {
        path
    } else {
        workspace.join(path)
    };
    Some(fs::canonicalize(&absolute).unwrap_or(absolute))
}

fn repository_cache_key(git_common_dir: &Path) -> String {
    let digest = Sha256::digest(git_common_dir.to_string_lossy().as_bytes());
    format!("{digest:x}")[..24].to_owned()
}
