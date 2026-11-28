//! Compile native job Teams through the existing per-Bot execution compiler.
use super::{
    dispatch::ExecutionRequest,
    request::{self, BuildExecutionRequestInput},
    resolution,
};
use crate::RequestServices;
use serde_json::Value;
use wegent_http_compat::FastApiError;

pub(super) async fn build(
    state: &RequestServices<'_>,
    input: &BuildExecutionRequestInput<'_>,
    is_subscription: bool,
    preload_skills: &[Value],
) -> Result<ExecutionRequest, FastApiError> {
    let mut request =
        request::build_request(state, input, is_subscription, preload_skills, None).await?;
    let mut configs = request.bot.as_array().cloned().unwrap_or_default();
    let leader_id = configs.first().and_then(|bot| bot["id"].as_i64());
    for member in additional_members(&request.collaboration_model, &input.team.json.0) {
        let reference = &member["botRef"];
        let Some(bot) = resolution::resolve_bot(
            state.mysql,
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
        let compiled =
            request::build_request(state, &member_input, is_subscription, preload_skills, None)
                .await?;
        if let Some(config) = compiled.bot.as_array().and_then(|bots| bots.first()) {
            configs.push(config.clone());
        }
    }
    request.bot = Value::Array(configs);
    if request.collaboration_model == "coordinate"
        && request.bot[0]["shell_type"]
            .as_str()
            .is_some_and(crate::skills::is_coding_shell)
    {
        request::coordinate::finalize_bot_grants(&mut request);
    }
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::{BotSkills, append_coding_mcp, is_coding_shell};
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
