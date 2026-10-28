//! Compile native job Teams through the existing per-Bot execution compiler.
use super::{
    dispatch::ExecutionRequest,
    request::{self, BuildExecutionRequestInput},
    resolution,
    skills::{BotSkills, append_coding_mcp, is_coding_shell},
};
use crate::{AppState, http_compat::FastApiError};
use serde_json::Value;
use std::collections::BTreeSet;

pub(super) async fn build(
    state: &AppState,
    input: &BuildExecutionRequestInput<'_>,
    is_subscription: bool,
    preload_skills: &[Value],
) -> Result<ExecutionRequest, FastApiError> {
    let mut request = request::build_request(
        state,
        input,
        is_subscription,
        preload_skills,
        // The leader's resolved Skill set grows with the member merges below, so
        // `finalize` compiles its coding MCP servers from the merged set.
        false,
    )
    .await?;
    let mut configs = request.bot.as_array().cloned().unwrap_or_default();
    let leader_id = configs.first().and_then(|bot| bot["id"].as_i64());
    for member in additional_members(&request.collaboration_model, &input.team.json.0) {
        let reference = &member["botRef"];
        let Some(bot) = resolution::resolve_bot(
            &state.mysql,
            input.team.user_id,
            reference["namespace"].as_str().unwrap_or("default"),
            reference["name"].as_str().unwrap_or(""),
        )
        .await
        .map_err(request::dependency)?
        else {
            continue;
        };
        if Some(bot.id) == leader_id {
            continue;
        }
        let ids = [bot.id];
        let member_input = BuildExecutionRequestInput {
            bot: &bot,
            bot_ids: &ids,
            bot_role: member["role"].as_str().unwrap_or("worker"),
            team_member_prompt: member["prompt"].as_str(),
            ..*input
        };
        let compiled = request::build_request(
            state,
            &member_input,
            is_subscription,
            preload_skills,
            // Only the leader is a coding executor in the source's merge; a
            // member's Servers reach it through `merge_leader_capabilities`.
            false,
        )
        .await?;
        if let Some(config) = compiled.bot.as_array().and_then(|bots| bots.first()) {
            configs.push(config.clone());
        }
        if request.collaboration_model == "coordinate" && coding(configs.first()) {
            merge_skills(&mut request, &compiled);
        }
    }
    finalize(&mut request, &mut configs);
    request.bot = Value::Array(configs);
    Ok(request)
}

fn additional_members<'a>(mode: &str, team: &'a Value) -> Vec<&'a Value> {
    if mode == "pipeline" {
        return Vec::new();
    }
    team["spec"]["members"]
        .as_array()
        .into_iter()
        .flatten()
        .collect()
}
fn coding(bot: Option<&Value>) -> bool {
    bot.and_then(|bot| bot["shell_type"].as_str())
        .is_some_and(is_coding_shell)
}
fn merge_skills(request: &mut ExecutionRequest, member: &ExecutionRequest) {
    for skill in &member.skill_configs {
        if !request
            .skill_configs
            .iter()
            .any(|existing| existing["name"] == skill["name"])
        {
            request.skill_configs.push(skill.clone());
            if let Some(name) = skill.get("name") {
                request.skill_names.push(name.clone());
            }
        }
    }
    if let (Some(target), Some(source)) = (
        request.skill_refs.as_object_mut(),
        member.skill_refs.as_object(),
    ) {
        for (name, reference) in source {
            target
                .entry(name.clone())
                .or_insert_with(|| reference.clone());
        }
    }
}
fn finalize(request: &mut ExecutionRequest, configs: &mut [Value]) {
    if configs.is_empty() {
        return;
    }
    let is_coding = coding(configs.first());
    if is_coding && request.collaboration_model == "coordinate" {
        merge_leader_capabilities(configs);
    }
    for config in configs.iter_mut() {
        let names = config["skills"].as_array().cloned().unwrap_or_default();
        for name in names.iter().filter_map(Value::as_str) {
            if let Some(reference) = request.skill_refs.get(name) {
                config["skill_refs"][name] = reference.clone();
            }
        }
    }
    if is_coding {
        let leader = &mut configs[0];
        let shell = leader["shell_type"].as_str().unwrap_or("").to_owned();
        let mut servers = leader["mcp_servers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        append_coding_mcp(
            &mut servers,
            &BotSkills {
                skills: request.skill_configs.clone(),
                ..Default::default()
            },
            &shell,
        );
        leader["mcp_servers"] = Value::Array(servers);
    }
}
fn merge_leader_capabilities(configs: &mut [Value]) {
    let mut servers = configs[0]["mcp_servers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut skills = configs[0]["skills"].as_array().cloned().unwrap_or_default();
    let mut server_names: BTreeSet<_> = servers
        .iter()
        .filter_map(|entry| entry["name"].as_str().map(str::to_owned))
        .collect();
    let mut skill_names: BTreeSet<_> = skills
        .iter()
        .filter_map(|entry| entry.as_str().map(str::to_owned))
        .collect();
    for config in &configs[1..] {
        for server in config["mcp_servers"].as_array().into_iter().flatten() {
            if let Some(name) = server["name"].as_str().filter(|name| !name.is_empty())
                && server_names.insert(name.into())
            {
                servers.push(server.clone());
            }
        }
        for skill in config["skills"].as_array().into_iter().flatten() {
            if let Some(name) = skill.as_str()
                && skill_names.insert(name.into())
            {
                skills.push(skill.clone());
            }
        }
    }
    configs[0]["mcp_servers"] = Value::Array(servers);
    configs[0]["skills"] = Value::Array(skills);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reviewed_team_keeps_writer_and_reviewer_while_pipeline_stays_on_current_bot() {
        let team =
            json!({"spec":{"members":[{"role":"leader"},{"role":"writer"},{"role":"reviewer"}]}});
        let members = additional_members("coordinate", &team);
        assert_eq!(members.len(), 3);
        assert_eq!(members[1]["role"], "writer");
        assert_eq!(members[2]["role"], "reviewer");
        assert!(additional_members("pipeline", &team).is_empty());
    }
    #[test]
    fn coding_coordinator_receives_member_capabilities_without_overriding_leader_identity() {
        let mut request = ExecutionRequest {
            collaboration_model: "coordinate".into(),
            skill_configs: vec![
                json!({"name":"writer-skill","mcpServers":{"tool":{"type":"streamable-http","url":"https://skill.invalid"}}}),
            ],
            skill_refs: json!({"writer-skill":{"skill_id":8}}),
            ..Default::default()
        };
        let mut configs = vec![
            json!({"id":1,"name":"leader","shell_type":"ClaudeCode","skills":[],"skill_refs":{},"mcp_servers":[{"name":"shared","type":"http","url":"https://leader.invalid"}]}),
            json!({"id":2,"name":"writer","role":"writer","skills":["writer-skill"],"skill_refs":{},"mcp_servers":[{"name":"shared","url":"https://member.invalid"},{"name":"member","type":"stdio","command":"tool"}]}),
            json!({"id":3,"name":"reviewer","role":"reviewer","skills":[],"skill_refs":{},"mcp_servers":[]}),
        ];
        finalize(&mut request, &mut configs);
        assert_eq!(configs.len(), 3);
        assert_eq!(configs[0]["id"], 1);
        assert_eq!(configs[0]["skills"], json!(["writer-skill"]));
        assert_eq!(configs[1]["skill_refs"]["writer-skill"]["skill_id"], 8);
        assert_eq!(
            configs[0]["mcp_servers"][0]["url"],
            "https://leader.invalid"
        );
        assert!(
            configs[0]["mcp_servers"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["name"] == "writer-skill_tool" && entry["type"] == "http")
        );
        // Source order after `_merge_coordinate_capabilities_into_leader` and
        // `_prepare_mcp_for_coding_executor`: the leader's own servers, then the
        // members' servers (a shared name is kept once), then the compiled
        // Skill servers of the merged Skill set. Compiling a Bot before its
        // final Skill set is known would place `writer-skill_tool` before the
        // member servers and leave the leader without it.
        let names: Vec<&str> = configs[0]["mcp_servers"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|entry| entry["name"].as_str())
            .collect();
        assert_eq!(names, ["shared", "member", "writer-skill_tool"]);
        assert_eq!(
            configs[0]["mcp_servers"][0]["url"],
            json!("https://leader.invalid"),
            "the member's same-named server must not replace the leader's"
        );
    }

    /// Only ClaudeCode and Codex run `_prepare_mcp_for_coding_executor`; the
    /// Chat shell keeps the Ghost servers untouched.
    #[test]
    fn only_coding_shells_compile_skill_mcp_servers() {
        assert!(is_coding_shell("ClaudeCode"));
        assert!(is_coding_shell("Codex"));
        assert!(!is_coding_shell("Chat"));
        assert!(!is_coding_shell("Dify"));
        assert!(!is_coding_shell("Agno"));
        assert!(!is_coding_shell(""));

        let skills = BotSkills {
            skills: vec![json!({
                "name": "svg-skill",
                "mcpServers": {"tool": {"type": "streamable-http", "url": "https://svg.invalid"}},
            })],
            ..Default::default()
        };
        let mut chat =
            vec![json!({"name": "ghost", "type": "http", "url": "https://ghost.invalid"})];
        // The compile is gated by the caller, so an uncompiled Chat shell keeps
        // exactly its Ghost server.
        assert_eq!(chat.len(), 1);
        append_coding_mcp(&mut chat, &skills, "Chat");
        assert_eq!(chat.len(), 2);
        assert_eq!(chat[1]["type"], json!("streamable-http"));
        let mut codex = Vec::new();
        append_coding_mcp(&mut codex, &skills, "Codex");
        assert_eq!(codex[0]["type"], json!("streamable-http"));
        let mut claude = Vec::new();
        append_coding_mcp(&mut claude, &skills, "ClaudeCode");
        assert_eq!(claude[0]["type"], json!("http"));
    }
}
