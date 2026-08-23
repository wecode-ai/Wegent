// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::env;

use crate::{process::CommandSpec, protocol::ExecutionRequest};

const PNPM_IGNORE_SCRIPTS_ENV: &str = "PNPM_CONFIG_IGNORE_SCRIPTS";

pub(super) fn configure_command(request: &ExecutionRequest, spec: CommandSpec) -> CommandSpec {
    if should_skip_install_scripts(request, spec.envs().contains_key(PNPM_IGNORE_SCRIPTS_ENV)) {
        spec.env(PNPM_IGNORE_SCRIPTS_ENV, "true")
    } else {
        spec
    }
}

pub(super) fn codex_config_override(request: &ExecutionRequest) -> Option<String> {
    should_skip_install_scripts(request, false).then(|| {
        format!(
            "shell_environment_policy.set.{PNPM_IGNORE_SCRIPTS_ENV}={}",
            serde_json::to_string("true").expect("static string should serialize")
        )
    })
}

fn should_skip_install_scripts(request: &ExecutionRequest, command_overrides: bool) -> bool {
    request.workspace_source.as_deref() == Some("git_worktree")
        && !command_overrides
        && env::var_os(PNPM_IGNORE_SCRIPTS_ENV).is_none_or(|value| value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configures_git_worktrees_to_skip_implicit_pnpm_install_scripts() {
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
            codex_config_override(&request),
            Some("shell_environment_policy.set.PNPM_CONFIG_IGNORE_SCRIPTS=\"true\"".to_owned())
        );
    }

    #[test]
    fn leaves_non_worktree_commands_unchanged() {
        let configured = configure_command(&ExecutionRequest::default(), CommandSpec::new("codex"));

        assert!(!configured.envs().contains_key(PNPM_IGNORE_SCRIPTS_ENV));
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
    }
}
