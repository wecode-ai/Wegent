// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `_get_bot_skills`' injected Skill references: the prompt-matched provider
//! runtime Skills and the `subscription-manager` available Skill
//! (`request_builder.py:2626` and `:2591`).

use super::*;

/// `_inject_conditional_provider_skills`: preload the runtime Skill of every
/// provider service whose `message_keywords` appear in the prompt.
///
/// The provider's own keywords must match before any service is considered; a
/// provider whose keywords match but whose services do not preloads every
/// service it declares. A matched provider therefore makes its Skills part of
/// `preload_skills`, which adds them to the request metadata and lets
/// `apply_provider_configuration_guidance` find their guidance. The create
/// flow's prompt is a string, so `_extract_prompt_text` is the identity here.
pub fn inject_conditional_provider_skills(prompt: &str, references: &mut Vec<Value>) {
    let text = normalize_provider_keyword_text(prompt);
    if text.is_empty() {
        return;
    }
    let mut existing: Vec<String> = references
        .iter()
        .filter_map(|reference| match reference {
            Value::String(name) => Some(name.clone()),
            Value::Object(_) => reference
                .get("name")
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
        .collect();
    for provider in list_mcp_providers() {
        if provider.message_keywords.is_empty()
            || !matches_any_keyword(provider.message_keywords, &text)
        {
            continue;
        }
        let mut matched: Vec<&crate::mcp_provider_registry::McpProviderServiceDefinition> =
            provider
                .services
                .iter()
                .filter(|service| matches_any_keyword(service.message_keywords, &text))
                .collect();
        if matched.is_empty() {
            matched = provider.services.iter().collect();
        }
        for service in matched {
            let skill_name = service.skill_name;
            if skill_name.is_empty() || existing.iter().any(|name| name == skill_name) {
                continue;
            }
            references.push(serde_json::json!({
                "name": skill_name,
                "namespace": "default",
                "is_public": true,
            }));
            existing.push(skill_name.to_string());
        }
    }
}

/// `_normalize_provider_keyword_text`: remove every whitespace character and
/// case-fold, so a keyword matches regardless of spacing or case.
fn normalize_provider_keyword_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

fn matches_any_keyword(keywords: &[&str], text: &str) -> bool {
    keywords
        .iter()
        .any(|keyword| text.contains(&normalize_provider_keyword_text(keyword)))
}

/// Native Coordinate roles share a Shell turn. Injecting a task-token-backed
/// Skill into only its leader changes the Team's configured role grants.
pub fn inject_subscription_manager_skill(
    is_subscription: bool,
    team: &Value,
    shell: &str,
) -> Vec<Value> {
    let spec = &team["spec"];
    if is_subscription
        || (is_coding_shell(shell)
            && spec["collaborationModel"] == "coordinate"
            && spec["members"]
                .as_array()
                .is_some_and(|members| members.len() > 1))
    {
        return Vec::new();
    }
    vec![serde_json::json!({
        "name": "subscription-manager",
        "namespace": "default",
        "is_public": true,
    })]
}

/// `request_builder.py:373-380`: the collected binding refs are routed by
/// `force_preload` — those join the requested stage (so they are resolved by
/// `find_skill_by_ref` before any available ref), the rest join the available
/// refs after the injected subscription Skill.
pub fn route_binding_refs(
    binding_refs: Vec<Value>,
    requested: &mut Vec<Value>,
    available: &mut Vec<Value>,
) {
    for reference in binding_refs {
        if reference.get("force_preload") == Some(&Value::Bool(true)) {
            requested.push(reference);
        } else {
            available.push(reference);
        }
    }
}
