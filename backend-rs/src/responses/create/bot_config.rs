// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `request_builder._build_bot_config` (the `metadata.bot` entries) and the
//! `metadata.user` projection.
//!
//! The recorded `queued` case pins the bot entry keys in order:
//! `id, name, shell_type, agent_config, system_prompt, mcp_servers, plugins,
//! skills, skill_refs, capability_mode, role, base_image` — `shell_type` and
//! `base_image` come from the Shell CRD (`_resolve_shell_info`), `agent_config`
//! from `build_agent_config_for_bot` (the Model CRD's `modelConfig`),
//! `system_prompt` from `get_bot_system_prompt`, and `mcp_servers`/`skills`/
//! `skill_refs`/`plugins` from the merged ghost capabilities.
use serde_json::{Map, Value};

/// `_build_bot_config`'s resolved inputs for one team member.
pub struct BotConfigInput<'a> {
    pub id: i64,
    pub name: &'a str,
    pub shell_type: &'a str,
    pub agent_config: Value,
    pub system_prompt: &'a str,
    pub mcp_servers: Vec<Value>,
    pub plugins: Vec<Value>,
    pub skills: Vec<Value>,
    pub skill_refs: Value,
    pub capability_mode: &'a str,
    pub role: &'a str,
    pub base_image: Option<&'a str>,
}

/// One `metadata.bot` entry, in the recorded key order.
pub fn build_bot_config(input: &BotConfigInput<'_>) -> Value {
    let mut bot = Map::new();
    bot.insert("id".into(), serde_json::json!(input.id));
    bot.insert("name".into(), serde_json::json!(input.name));
    bot.insert("shell_type".into(), serde_json::json!(input.shell_type));
    bot.insert("agent_config".into(), input.agent_config.clone());
    bot.insert(
        "system_prompt".into(),
        serde_json::json!(input.system_prompt),
    );
    bot.insert(
        "mcp_servers".into(),
        Value::Array(input.mcp_servers.clone()),
    );
    bot.insert("plugins".into(), Value::Array(input.plugins.clone()));
    bot.insert("skills".into(), Value::Array(input.skills.clone()));
    bot.insert("skill_refs".into(), input.skill_refs.clone());
    bot.insert(
        "capability_mode".into(),
        serde_json::json!(input.capability_mode),
    );
    bot.insert("role".into(), serde_json::json!(input.role));
    bot.insert(
        "base_image".into(),
        input
            .base_image
            .map_or(Value::Null, |image| Value::String(image.to_string())),
    );
    Value::Object(bot)
}

/// The `metadata.user` projection: `{id, name, git_domain, git_token, git_id,
/// git_login, git_email}` in the recorded order. A user without a Weibo binding
/// renders nulls.
pub fn build_user_metadata(user: &Value) -> Value {
    let field = |key: &str| user.get(key).cloned().unwrap_or(Value::Null);
    serde_json::json!({
        "id": field("id"),
        "name": field("name"),
        "git_domain": field("git_domain"),
        "git_token": field("git_token"),
        "git_id": field("git_id"),
        "git_login": field("git_login"),
        "git_email": field("git_email"),
    })
}

/// One Team CRD member (`spec.members[]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamMember {
    pub bot_namespace: String,
    pub bot_name: String,
    pub role: String,
}

/// `_build_bot_config`'s team-member iteration source: `spec.members[]` in
/// order, each with its `botRef` and `role`.
pub fn team_members(team_json: &Value) -> Vec<TeamMember> {
    team_json
        .get("spec")
        .and_then(|spec| spec.get("members"))
        .and_then(Value::as_array)
        .map(|members| {
            members
                .iter()
                .filter_map(|member| {
                    let bot = member.get("botRef")?;
                    Some(TeamMember {
                        bot_namespace: bot.get("namespace")?.as_str()?.to_string(),
                        bot_name: bot.get("name")?.as_str()?.to_string(),
                        role: member
                            .get("role")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The `metadata.workspace` projection: the Workspace CRD's `spec.repository`,
/// the task branch, and the workspace path
/// (`{"repository": {gitUrl, gitRepo, gitRepoId, gitDomain, branchName},
/// "branch":…, "path":…}`).
pub fn build_workspace(repository: &Value, branch: &str, path: Option<&str>) -> Value {
    let text = |key: &str| {
        repository
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    serde_json::json!({
        "repository": {
            "gitUrl": text("gitUrl"),
            "gitRepo": text("gitRepo"),
            "gitRepoId": repository.get("gitRepoId").and_then(Value::as_i64).unwrap_or(0),
            "gitDomain": text("gitDomain"),
            "branchName": text("branchName"),
        },
        "branch": branch,
        "path": path.map_or(Value::Null, |path| Value::String(path.to_string())),
    })
}

/// The `metadata.git_*` fields from the workspace repository:
/// `(git_repo, git_url, git_domain, git_repo_id, branch_name)`.
/// `git_domain = repo.get("gitDomain") or extract_git_domain(git_url)`, so an
/// empty `gitDomain` renders null unless the URL names a host.
pub fn git_fields(repository: &Value) -> (String, String, Option<String>, i64, String) {
    let text = |key: &str| {
        repository
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let git_url = text("gitUrl");
    let configured_domain = repository
        .get("gitDomain")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (
        text("gitRepo"),
        git_url.clone(),
        configured_domain.or_else(|| extract_git_domain(&git_url)),
        repository
            .get("gitRepoId")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        text("branchName"),
    )
}

/// `extract_git_domain`: the repository host without credentials.
fn extract_git_domain(git_url: &str) -> Option<String> {
    let value = git_url.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(parsed) = url::Url::parse(value)
        && let Some(host) = parsed.host_str()
    {
        return Some(host.to_string());
    }
    if let Some((_, rest)) = value.split_once('@') {
        let host = rest
            .split([':', '/'])
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        return (!host.is_empty()).then_some(host);
    }
    None
}

/// `settings.BACKEND_INTERNAL_URL` (env `BACKEND_INTERNAL_URL`, source default
/// `http://localhost:8000/api`).
pub fn backend_url() -> String {
    crate::config::env_or_dotenv("BACKEND_INTERNAL_URL")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "http://localhost:8000/api".to_string())
}

/// The `metadata` knowledge fields the recorded dispatch carries. The concrete
/// ids / prompt come from the KB resolution
/// (`app/services/chat/preprocessing/contexts.py` + `selected_knowledge`),
/// which is not yet ported; this projects the resolved values.
pub struct KnowledgeMetadata<'a> {
    pub knowledge_base_ids: Option<Value>,
    pub document_ids: Option<Value>,
    pub knowledge_base_scopes: Value,
    pub external_knowledge_refs: Value,
    pub selected_knowledge_prompt: &'a str,
    pub provider_native_knowledge: bool,
    pub is_user_selected_kb: bool,
    pub kb_tool_access_mode: &'a str,
    pub kb_meta_prompt: &'a str,
}

/// The `settings.BACKEND_INTERNAL_URL`-derived callback URL
/// (`metadata.callback_url`): `None` unless the deployment configures one.
pub fn callback_url() -> Option<String> {
    crate::config::env_or_dotenv("EXECUTOR_CALLBACK_URL").filter(|value| !value.is_empty())
}

/// The executor fields `metadata` carries, from the resolved executor context /
/// settings: `executor_name`, `executor_namespace`, `executor_image`,
/// `executor_type`. All default empty/null for the recorded cases.
pub fn executor_fields(
    name: Option<&str>,
    namespace: Option<&str>,
    image: Option<&str>,
    executor_type: Option<&str>,
) -> (String, String, Option<String>, Option<String>) {
    (
        name.unwrap_or_default().to_string(),
        namespace.unwrap_or_default().to_string(),
        image.map(str::to_string),
        executor_type.map(str::to_string),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bot_config_matches_the_recorded_key_order() {
        let input = BotConfigInput {
            id: 239_728,
            name: "team-alpha-test-bot",
            shell_type: "ClaudeCode",
            agent_config: json!({"env": {"model": "claude"}}),
            system_prompt: "<base_prompt>\nx\n</base_prompt>",
            mcp_servers: vec![json!({"name": "wegent", "url": "http://x"})],
            plugins: Vec::new(),
            skills: vec![json!("wegent-knowledge")],
            skill_refs: json!({"wegent-knowledge": {"skill_id": 128913}}),
            capability_mode: "manual",
            role: "leader",
            base_image: None,
        };
        let bot = build_bot_config(&input);
        let keys: Vec<&str> = bot
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "id",
                "name",
                "shell_type",
                "agent_config",
                "system_prompt",
                "mcp_servers",
                "plugins",
                "skills",
                "skill_refs",
                "capability_mode",
                "role",
                "base_image",
            ]
        );
        assert_eq!(bot["id"], json!(239_728));
        assert_eq!(bot["shell_type"], json!("ClaudeCode"));
        assert_eq!(bot["capability_mode"], json!("manual"));
        assert_eq!(bot["role"], json!("leader"));
        assert_eq!(bot["base_image"], Value::Null);
    }

    #[test]
    fn executor_fields_default_empty_for_the_recorded_cases() {
        assert_eq!(
            executor_fields(None, None, None, None),
            (String::new(), String::new(), None, None)
        );
        assert_eq!(callback_url(), None);
    }

    #[test]
    fn workspace_projects_the_recorded_shape() {
        let repository =
            json!({"gitUrl": "", "gitRepo": "", "gitRepoId": 0, "gitDomain": "", "branchName": ""});
        assert_eq!(
            build_workspace(&repository, "", None),
            json!({
                "repository": {"gitUrl": "", "gitRepo": "", "gitRepoId": 0, "gitDomain": "", "branchName": ""},
                "branch": "",
                "path": null,
            })
        );
        let git = json!({"gitUrl": "https://g/r.git", "gitRepo": "r", "gitRepoId": 5, "gitDomain": "g", "branchName": "main"});
        assert_eq!(
            git_fields(&git),
            (
                "r".to_string(),
                "https://g/r.git".to_string(),
                Some("g".to_string()),
                5,
                "main".to_string()
            )
        );
        // A missing gitDomain renders null.
        assert_eq!(git_fields(&json!({})).2, None);
    }

    #[test]
    fn team_members_keep_member_order_and_roles() {
        let team = json!({
            "spec": {"members": [
                {"botRef": {"name": "bot-a", "namespace": "ns-a"}, "role": "leader"},
                {"botRef": {"name": "bot-b", "namespace": "ns-a"}},
            ]}
        });
        assert_eq!(
            team_members(&team),
            vec![
                TeamMember {
                    bot_namespace: "ns-a".to_string(),
                    bot_name: "bot-a".to_string(),
                    role: "leader".to_string(),
                },
                TeamMember {
                    bot_namespace: "ns-a".to_string(),
                    bot_name: "bot-b".to_string(),
                    role: String::new(),
                },
            ]
        );
        assert!(team_members(&json!({})).is_empty());
    }

    #[test]
    fn user_metadata_projects_the_recorded_fields() {
        let user = json!({"id": 5831, "name": "risk_control_analyze_service"});
        assert_eq!(
            build_user_metadata(&user),
            json!({
                "id": 5831,
                "name": "risk_control_analyze_service",
                "git_domain": null,
                "git_token": null,
                "git_id": null,
                "git_login": null,
                "git_email": null,
            })
        );
    }
}
