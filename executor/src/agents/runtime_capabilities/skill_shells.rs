// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Validate selected Skill compatibility independently of package contents.

use super::*;

pub(super) fn validate_shells(request: &ExecutionRequest) -> Result<(), String> {
    use crate::services::skill_deployer::{
        collect_skill_names_for_deployment, resolve_request_skill_references,
    };

    let Some(bot) = primary_bot(request) else {
        return Ok(());
    };
    let shell = bot.get("shell_type").and_then(Value::as_str).unwrap_or("");
    let selected = collect_skill_names_for_deployment(bot, request);
    for (name, reference) in resolve_request_skill_references(bot, request, &selected) {
        validate_shell(
            &name,
            reference
                .get("bind_shells")
                .or_else(|| reference.get("bindShells")),
            shell,
        )?;
    }
    Ok(())
}

fn validate_shell(name: &str, shells: Option<&Value>, shell: &str) -> Result<(), String> {
    if let Some(shells) = shells.and_then(Value::as_array).filter(|s| !s.is_empty()) {
        if !shells
            .iter()
            .any(|candidate| candidate.as_str() == Some(shell))
        {
            return Err(format!(
                "Skill '{name}' is not compatible with Shell '{shell}'"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "skill_shells_tests.rs"]
mod tests;
