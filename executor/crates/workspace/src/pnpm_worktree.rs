// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::{process::CommandSpec, protocol::ExecutionRequest};

const PNPM_IGNORE_SCRIPTS_ENV: &str = "PNPM_CONFIG_IGNORE_SCRIPTS";
const PNPM_GLOBAL_VIRTUAL_STORE_ENV: &str = "PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE";
const WORKTREE_PNPM_ENV: [(&str, &str); 2] = [
    (PNPM_IGNORE_SCRIPTS_ENV, "true"),
    // Global virtual-store realpaths let TypeScript resolve types from home ancestors.
    // Keep dependency links local; pnpm still reuses its shared content-addressable store.
    (PNPM_GLOBAL_VIRTUAL_STORE_ENV, "false"),
];

pub fn configure_command(request: &ExecutionRequest, mut spec: CommandSpec) -> CommandSpec {
    if !is_git_worktree(request) {
        return spec;
    }
    for (key, value) in WORKTREE_PNPM_ENV {
        if !spec.envs().contains_key(key) {
            spec = spec.env(key, value);
        }
    }
    spec
}

pub fn codex_config_overrides(request: &ExecutionRequest) -> Vec<String> {
    if !is_git_worktree(request) {
        return Vec::new();
    }
    WORKTREE_PNPM_ENV
        .into_iter()
        .map(|(key, value)| {
            format!(
                "shell_environment_policy.set.{key}={}",
                serde_json::to_string(value).expect("static string should serialize")
            )
        })
        .collect()
}

fn is_git_worktree(request: &ExecutionRequest) -> bool {
    request.workspace_source.as_deref() == Some("git_worktree")
}
