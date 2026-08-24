// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::{process::CommandSpec, protocol::ExecutionRequest};

const PNPM_IGNORE_SCRIPTS_ENV: &str = "PNPM_CONFIG_IGNORE_SCRIPTS";
const PNPM_GLOBAL_VIRTUAL_STORE_ENV: &str = "PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE";
const WORKTREE_PNPM_ENV: [(&str, &str); 2] = [
    (PNPM_IGNORE_SCRIPTS_ENV, "true"),
    (PNPM_GLOBAL_VIRTUAL_STORE_ENV, "true"),
];

pub(super) fn configure_command(request: &ExecutionRequest, mut spec: CommandSpec) -> CommandSpec {
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

pub(super) fn codex_config_overrides(request: &ExecutionRequest) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configures_git_worktree_pnpm_environment() {
        let request = ExecutionRequest {
            workspace_source: Some("git_worktree".to_owned()),
            ..ExecutionRequest::default()
        };

        let configured = configure_command(&request, CommandSpec::new("codex"));

        assert_eq!(
            configured.envs().get(PNPM_IGNORE_SCRIPTS_ENV),
            Some(&"true".to_owned())
        );
        assert_eq!(
            configured.envs().get(PNPM_GLOBAL_VIRTUAL_STORE_ENV),
            Some(&"true".to_owned())
        );
        assert_eq!(
            codex_config_overrides(&request),
            vec![
                "shell_environment_policy.set.PNPM_CONFIG_IGNORE_SCRIPTS=\"true\"".to_owned(),
                "shell_environment_policy.set.PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=\"true\""
                    .to_owned(),
            ]
        );
    }

    #[test]
    fn leaves_non_worktree_commands_unchanged() {
        let configured = configure_command(&ExecutionRequest::default(), CommandSpec::new("codex"));

        assert!(!configured.envs().contains_key(PNPM_IGNORE_SCRIPTS_ENV));
        assert!(!configured
            .envs()
            .contains_key(PNPM_GLOBAL_VIRTUAL_STORE_ENV));
        assert!(codex_config_overrides(&ExecutionRequest::default()).is_empty());
    }

    #[test]
    fn preserves_command_level_pnpm_script_preference() {
        let request = ExecutionRequest {
            workspace_source: Some("git_worktree".to_owned()),
            ..ExecutionRequest::default()
        };
        let configured = configure_command(
            &request,
            CommandSpec::new("codex").env(PNPM_IGNORE_SCRIPTS_ENV, "false"),
        );

        assert_eq!(
            configured.envs().get(PNPM_IGNORE_SCRIPTS_ENV),
            Some(&"false".to_owned())
        );
        assert_eq!(
            configured.envs().get(PNPM_GLOBAL_VIRTUAL_STORE_ENV),
            Some(&"true".to_owned())
        );
    }
}
