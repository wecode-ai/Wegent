// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Validate selected Skill compatibility independently of package contents.

use super::*;

pub(super) fn validate_shells(request: &ExecutionRequest) -> Result<(), String> {
    let bots = request
        .bot
        .as_array()
        .map(|bots| bots.iter().collect::<Vec<_>>())
        .unwrap_or_else(|| vec![&request.bot]);
    for bot in bots {
        let shell = bot.get("shell_type").and_then(Value::as_str).unwrap_or("");
        for key in ["skill_refs", "preload_skill_refs"] {
            if let Some(refs) = bot.get(key).and_then(Value::as_object) {
                let selected = crate::services::skill_deployer::collect_skill_names_for_deployment(
                    bot, request,
                );
                for (name, reference) in refs {
                    if selected.iter().any(|selected| selected == name) {
                        validate_shell(name, reference.get("bind_shells"), shell)?;
                    }
                }
            }
        }
    }
    if let Some(bot) = primary_bot(request) {
        let shell = bot.get("shell_type").and_then(Value::as_str).unwrap_or("");
        for key in ["skill_refs", "preload_skill_refs"] {
            if let Some(refs) = request.extra.get(key).and_then(Value::as_object) {
                let selected = crate::services::skill_deployer::collect_skill_names_for_deployment(
                    bot, request,
                );
                for (name, reference) in refs {
                    if selected.iter().any(|selected| selected == name) {
                        validate_shell(name, reference.get("bind_shells"), shell)?;
                    }
                }
            }
        }
        if let Some(configs) = request.extra.get("skill_configs").and_then(Value::as_array) {
            let selected =
                crate::services::skill_deployer::collect_skill_names_for_deployment(bot, request);
            for config in configs {
                let name = config.get("name").and_then(Value::as_str).unwrap_or("");
                if selected.iter().any(|selected| selected == name) {
                    validate_shell(name, config.get("bindShells"), shell)?;
                }
            }
        }
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
