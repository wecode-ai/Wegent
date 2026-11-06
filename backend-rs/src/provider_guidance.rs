// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.execution.provider_guidance`: the request-scoped
//! configuration guidance for user-managed provider Skills.
//!
//! `build_provider_configuration_prompt` renders the text a user-mode provider
//! whose service is not configured substitutes for the Skill `prompt`, and
//! `apply_provider_configuration_guidance` appends that text to the request and
//! Bot system prompts so the model tells the user what to configure.
use serde_json::Value;

use crate::mcp_provider_registry::{McpProviderDefinition, McpProviderServiceDefinition};
use crate::responses::create::dispatch::ExecutionRequest;

/// `GUIDANCE_START` / `GUIDANCE_END`: the delimiters of the generated block.
const GUIDANCE_START: &str = "<wegent_provider_configuration>";
const GUIDANCE_END: &str = "</wegent_provider_configuration>";

/// Shells that consume provider Skills. `Dify` runs an external application's
/// tools and configuration, and `Agno` is no longer a supported platform
/// runtime, so neither receives the guide.
fn excludes_provider_guidance(shell_type: &str) -> bool {
    matches!(shell_type, "Dify" | "Agno")
}

/// `build_provider_configuration_prompt`: render only configuration
/// instructions, not unavailable tool instructions. The template is emitted
/// byte-for-byte into the chat-shell request body, so it stays verbatim
/// (including the leading blank line, removed by the source's `.strip()`).
pub fn build_provider_configuration_prompt(
    provider: &McpProviderDefinition,
    service: &McpProviderServiceDefinition,
) -> String {
    let display_name = service.display_name;
    let provider_name = provider.display_name;
    let modal_link = format!(
        "wegent://modal/mcp-provider-config?provider={}&service={}",
        provider.provider_id, service.service_id
    );
    let prompt = format!(
        "
## Configuration Required

The current session does not have a usable {display_name} MCP configured.

Required behavior for requests using this service:
- Do not claim that the capability is ready or pretend to access {provider_name} data.
- Do not probe local files, sandbox commands, or web pages to work around missing configuration.
- Selecting a knowledge source does not configure or authorize this MCP.
- Tell the user that {display_name} MCP is unavailable and provide the configuration link below.
- Keep the guidance brief. If asked how to get the URL, direct the user to the provider MCP page for this service.
- Do not treat these instructions as a restriction on unrelated tasks.

Response template:
当前会话还没有可用的{display_name} MCP，所以我现在不能直接访问这项{provider_name}能力。

请先点击 [打开{display_name} MCP 配置弹窗]({modal_link}) 完成配置。

配置完成后，再让我继续处理你的{provider_name}请求。
"
    );
    prompt.trim().to_string()
}

/// `apply_provider_configuration_guidance`: replace the single authoritative
/// guide after Skill resolution.
///
/// Every resolved Skill configuration loses a stale `prompt_in_system_prompt`
/// mark. A Skill that requires configuration, is active for this request (it is
/// preloaded or user-selected), still carries a prompt and has no MCP servers
/// contributes its prompt to one block. The block replaces any previously
/// generated block in the request system prompt and in each Bot system prompt,
/// so an earlier resolution's guide never survives a later one.
pub fn apply_provider_configuration_guidance(request: &mut ExecutionRequest) {
    let primary_shell = request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .and_then(|bot| bot.get("shell_type"))
        .and_then(Value::as_str)
        .unwrap_or("Chat")
        .to_string();
    let mut active_skills: Vec<String> = Vec::new();
    for names in [&request.preload_skills, &request.user_selected_skills] {
        for name in names {
            if let Some(name) = name.as_str()
                && !active_skills.iter().any(|active| active == name)
            {
                active_skills.push(name.to_string());
            }
        }
    }

    let shell_excluded = excludes_provider_guidance(&primary_shell);
    let mut guides: Vec<(String, String)> = Vec::new();
    for skill in request.skill_configs.iter_mut() {
        let Some(config) = skill.as_object_mut() else {
            continue;
        };
        let _ = config.remove("prompt_in_system_prompt");
        if shell_excluded || !requires_configuration_guidance(config, &active_skills) {
            continue;
        }
        let name = config
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let prompt = config
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        match guides.iter_mut().find(|(existing, _)| existing == &name) {
            Some(entry) => entry.1 = prompt,
            None => guides.push((name, prompt)),
        }
        config.insert("prompt_in_system_prompt".into(), Value::Bool(true));
    }

    let guidance = guides
        .iter()
        .map(|(_, prompt)| prompt.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    request.system_prompt = replace_guidance(&request.system_prompt, &guidance);

    let Some(bots) = request.bot.as_array_mut() else {
        return;
    };
    for bot in bots.iter_mut() {
        let Some(config) = bot.as_object_mut() else {
            continue;
        };
        let bot_guidance = match config.get("shell_type").and_then(Value::as_str) {
            Some(shell_type) if excludes_provider_guidance(shell_type) => String::new(),
            _ => guidance.clone(),
        };
        let prompt = config
            .get("system_prompt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if !bot_guidance.is_empty() || prompt.contains(GUIDANCE_START) {
            config.insert(
                "system_prompt".into(),
                Value::String(replace_guidance(&prompt, &bot_guidance)),
            );
        }
    }
}

/// The per-Skill gate: `configuration_required is True`, the Skill is active
/// for this request, and the stored `mcpServers` / `prompt` are Python-truthy.
fn requires_configuration_guidance(
    config: &serde_json::Map<String, Value>,
    active_skills: &[String],
) -> bool {
    let name = config
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    config.get("configuration_required") == Some(&Value::Bool(true))
        && active_skills.iter().any(|active| active == name)
        && !config
            .get("mcpServers")
            .is_some_and(brz_json::adapters::python_truthy)
        && config
            .get("prompt")
            .is_some_and(brz_json::adapters::python_truthy)
}

/// `_replace_guidance`: swap only the generated block and keep the rest.
fn replace_guidance(prompt: &str, guidance: &str) -> String {
    let base_prompt = strip_guidance_block(prompt);
    if guidance.is_empty() {
        return base_prompt;
    }
    let block = format!("{GUIDANCE_START}\n{guidance}\n{GUIDANCE_END}");
    [base_prompt.trim_end().to_string(), block]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `GUIDANCE_BLOCK.sub("", prompt)`: remove every generated block, including
/// the blank separator that preceded it.
fn strip_guidance_block(prompt: &str) -> String {
    let mut result = String::with_capacity(prompt.len());
    let mut cursor = 0;
    while let Some(offset) = prompt[cursor..].find(GUIDANCE_START) {
        let start = cursor + offset;
        let Some(offset) = prompt[start..].find(GUIDANCE_END) else {
            break;
        };
        let end = start + offset + GUIDANCE_END.len();
        let separator = prompt.as_bytes()[..start].ends_with(b"\n\n");
        result.push_str(&prompt[cursor..if separator { start - 2 } else { start }]);
        cursor = end;
    }
    result.push_str(&prompt[cursor..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_provider_registry::{get_mcp_provider, get_mcp_provider_service};
    use serde_json::json;

    fn guidance_skill(name: &str, prompt: &str) -> Value {
        json!({
            "name": name,
            "configuration_required": true,
            "prompt": prompt,
        })
    }

    fn request_with_skills(skills: Vec<Value>, preload: &[&str]) -> ExecutionRequest {
        ExecutionRequest {
            bot: json!([{"shell_type": "Chat", "system_prompt": "<base_prompt>\nbody\n</base_prompt>"}]),
            system_prompt: "<base_prompt>\nbody\n</base_prompt>".to_string(),
            skill_configs: skills,
            preload_skills: preload.iter().map(|name| json!(name)).collect(),
            ..ExecutionRequest::default()
        }
    }

    /// The recorded create case appends exactly this block: the `dingtalk-docs`
    /// and `dingtalk-ai-table` prompts joined by one blank line inside the
    /// delimiters, after the `rstrip`ped base prompt. The recorded
    /// `instructions` grew from 6805 to 8886 bytes, so the appended separator
    /// plus block is 2081 bytes (2079 of block, 2 of separator).
    #[test]
    fn the_recorded_provider_pair_renders_the_recorded_block() {
        let provider = get_mcp_provider("dingtalk").expect("provider");
        let docs = build_provider_configuration_prompt(
            provider,
            get_mcp_provider_service("dingtalk", "docs").expect("docs"),
        );
        let ai_table = build_provider_configuration_prompt(
            provider,
            get_mcp_provider_service("dingtalk", "ai_table").expect("ai_table"),
        );
        let mut request = request_with_skills(
            vec![
                guidance_skill("dingtalk-docs", &docs),
                guidance_skill("dingtalk-ai-table", &ai_table),
                json!({"name": "subscription-manager", "prompt": "# subscription"}),
            ],
            &["dingtalk-docs", "dingtalk-ai-table"],
        );
        apply_provider_configuration_guidance(&mut request);

        let base = "<base_prompt>\nbody\n</base_prompt>";
        assert!(request.system_prompt.starts_with(base));
        let appended = &request.system_prompt[base.len()..];
        assert_eq!(appended.len(), 2081);
        assert!(
            appended.starts_with("\n\n<wegent_provider_configuration>\n## Configuration Required")
        );
        assert!(appended.ends_with("</wegent_provider_configuration>"));
        assert!(appended.contains("service=docs"));
        assert!(appended.contains("service=ai_table"));
        // Every Bot prompt carries the same guide.
        assert_eq!(
            request.bot[0]["system_prompt"],
            json!(request.system_prompt)
        );
    }

    #[test]
    fn guided_skills_are_marked_and_others_only_lose_a_stale_mark() {
        let mut request = request_with_skills(
            vec![
                guidance_skill("dingtalk-docs", "# guide"),
                json!({"name": "subscription-manager", "prompt": "# subscription", "prompt_in_system_prompt": true}),
                json!({"name": "inactive-provider", "configuration_required": true, "prompt": "# guide"}),
                json!({"name": "configured-provider", "configuration_required": true, "prompt": "# guide", "mcpServers": {"s": {"url": "https://example.invalid"}}}),
            ],
            &["dingtalk-docs"],
        );
        apply_provider_configuration_guidance(&mut request);
        assert_eq!(
            request.skill_configs[0]["prompt_in_system_prompt"],
            json!(true)
        );
        assert!(
            !request.skill_configs[1]
                .as_object()
                .expect("object")
                .contains_key("prompt_in_system_prompt")
        );
        assert!(
            !request.skill_configs[2]
                .as_object()
                .expect("object")
                .contains_key("prompt_in_system_prompt")
        );
        assert!(
            !request.skill_configs[3]
                .as_object()
                .expect("object")
                .contains_key("prompt_in_system_prompt")
        );
        assert!(request.system_prompt.contains("# guide"));
        assert!(!request.system_prompt.contains("# subscription"));
    }

    #[test]
    fn a_later_resolution_replaces_the_previous_block() {
        let mut request = request_with_skills(vec![guidance_skill("a", "# first")], &["a"]);
        apply_provider_configuration_guidance(&mut request);
        let once = request.system_prompt.clone();

        request.skill_configs = vec![guidance_skill("a", "# second")];
        apply_provider_configuration_guidance(&mut request);
        assert!(
            request
                .system_prompt
                .ends_with("# second\n</wegent_provider_configuration>")
        );
        assert!(!request.system_prompt.contains("# first"));

        // Reapplying the same guidance is idempotent.
        let twice = request.system_prompt.clone();
        apply_provider_configuration_guidance(&mut request);
        assert_eq!(request.system_prompt, twice);
        assert_ne!(once, twice);
    }

    #[test]
    fn an_empty_guide_leaves_the_base_prompt_without_the_block() {
        let mut request = request_with_skills(vec![], &[]);
        request.system_prompt = "<base_prompt>\nbody\n</base_prompt>\n\n\
             <wegent_provider_configuration>\nstale\n</wegent_provider_configuration>"
            .to_string();
        let bot_prompt = request.bot[0]["system_prompt"]
            .as_str()
            .expect("prompt")
            .to_string();
        request.bot[0]["system_prompt"] = json!(format!(
            "{bot_prompt}\n\n<wegent_provider_configuration>\nstale\n</wegent_provider_configuration>"
        ));
        apply_provider_configuration_guidance(&mut request);
        assert_eq!(request.system_prompt, "<base_prompt>\nbody\n</base_prompt>");
        assert_eq!(
            request.bot[0]["system_prompt"],
            json!("<base_prompt>\nbody\n</base_prompt>")
        );
    }

    #[test]
    fn dify_and_agno_bots_receive_no_guide() {
        for shell in ["Dify", "Agno"] {
            let mut request = request_with_skills(
                vec![guidance_skill("dingtalk-docs", "# guide")],
                &["dingtalk-docs"],
            );
            request.bot = json!([{"shell_type": shell, "system_prompt": "base"}]);
            apply_provider_configuration_guidance(&mut request);
            assert_eq!(request.system_prompt, "<base_prompt>\nbody\n</base_prompt>");
            assert_eq!(request.bot[0]["system_prompt"], json!("base"));
            assert!(
                !request.skill_configs[0]
                    .as_object()
                    .expect("object")
                    .contains_key("prompt_in_system_prompt")
            );
        }
    }

    fn rendered_twice(prompt: &str, guidance: &str) -> String {
        replace_guidance(&replace_guidance(prompt, guidance), guidance)
    }

    /// `_replace_guidance` removes only its own generated block and preserves
    /// the surrounding text, including a stale block in the middle.
    #[test]
    fn block_replacement_keeps_the_rest_of_the_prompt() {
        let prompt = "head\n\n<wegent_provider_configuration>\nstale\n</wegent_provider_configuration>\n\nmiddle\n\n<wegent_provider_configuration>\nolder\n</wegent_provider_configuration>\n\ntail";
        assert_eq!(strip_guidance_block(prompt), "head\n\nmiddle\n\ntail");
        assert_eq!(
            replace_guidance(prompt, "fresh"),
            "head\n\nmiddle\n\ntail\n\n<wegent_provider_configuration>\nfresh\n</wegent_provider_configuration>"
        );
        // A block without a closing delimiter is not a match and stays intact.
        let unterminated = "head <wegent_provider_configuration>open";
        assert_eq!(strip_guidance_block(unterminated), unterminated);
        assert_eq!(
            rendered_twice("body", "one"),
            replace_guidance("body", "one")
        );
    }

    /// The recorded `skill_configs` prompts: 836 characters for
    /// `dingtalk-docs`, 837 for `dingtalk-table`, 848 for
    /// `dingtalk-ai-table`. A length mismatch means the template text changed.
    #[test]
    fn rendered_prompts_match_the_recorded_lengths() {
        let provider = get_mcp_provider("dingtalk").expect("provider");
        for (service_id, expected) in [("docs", 836), ("table", 837), ("ai_table", 848)] {
            let service = get_mcp_provider_service("dingtalk", service_id).expect("service");
            let prompt = build_provider_configuration_prompt(provider, service);
            assert_eq!(prompt.chars().count(), expected, "{service_id}");
            assert_eq!(prompt, prompt.trim());
        }
    }

    #[test]
    fn the_prompt_carries_the_provider_modal_link_and_names() {
        let provider = get_mcp_provider("dingtalk").expect("provider");
        let service = get_mcp_provider_service("dingtalk", "docs").expect("service");
        let prompt = build_provider_configuration_prompt(provider, service);
        assert!(prompt.starts_with("## Configuration Required\n"));
        assert!(prompt.contains(
            "[打开钉钉文档 MCP 配置弹窗](wegent://modal/mcp-provider-config\
             ?provider=dingtalk&service=docs)"
        ));
        assert!(prompt.contains("not have a usable 钉钉文档 MCP configured"));
        assert!(prompt.contains("access 钉钉 data"));
        assert!(prompt.ends_with("再让我继续处理你的钉钉请求。"));
    }
}
