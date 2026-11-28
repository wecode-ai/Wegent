//! Verify the executable part of an owner-exported Team against project-owned references.
use crate::sql_support::{StatementArg, placeholders};
use crate::{
    responses::create::{ghost, model_config, resolution, shell},
    state::AppState,
};
use brz_mysql::{MysqlResult, MysqlTransaction};
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use wegent_project_coordination::project_store::Node;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PortableTeam {
    #[serde(rename = "name")]
    _name: String,
    collaboration_model: String,
    bot: Vec<PortableBot>,
    #[serde(default)]
    system_prompt: String,
    model_policy: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PortableBot {
    id: Value,
    #[serde(rename = "name")]
    _name: String,
    shell_type: String,
    #[serde(default)]
    system_prompt: String,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    #[serde(rename = "description")]
    _description: String,
    #[serde(alias = "requireConfirmation", default)]
    require_confirmation: bool,
    #[serde(alias = "contextPassing", default = "no_context")]
    context_passing: String,
    model_id: Option<String>,
    model_provider: Option<String>,
}

fn no_context() -> String {
    "none".into()
}

pub(super) fn team_id(agent: &Node) -> Option<i64> {
    let config = &agent.metadata.0;
    match config["runtime"].as_str()? {
        "wegent" => {
            wegent_project_coordination::project_authority::integer(&config["wegent_team_id"])
        }
        "codex" | "claude_code" => config["teamRef"].as_i64(),
        _ => None,
    }
    .filter(|id| *id > 0)
}

#[derive(Default)]
pub(super) struct Preview {
    pub teams: BTreeMap<String, i64>,
    resources: BTreeMap<i64, resolution::KindRow>,
}

impl Preview {
    pub async fn current(&self, tx: &mut impl MysqlTransaction) -> MysqlResult<bool> {
        if self.resources.is_empty() {
            return Ok(true);
        }
        let ids: Vec<_> = self
            .resources
            .keys()
            .copied()
            .map(StatementArg::Int)
            .collect();
        let rows:Vec<resolution::KindRow> = tx.fetch_all(
            format!("SELECT {} FROM kinds WHERE is_active=TRUE AND id IN ({}) ORDER BY id FOR SHARE",resolution::KIND_COLUMNS,placeholders(ids.len())),ids).await?;
        Ok(rows.len() == self.resources.len()
            && rows.iter().all(|row| {
                self.resources.get(&row.id).is_some_and(|prior| {
                    prior.user_id == row.user_id
                        && prior.kind == row.kind
                        && prior.namespace == row.namespace
                        && prior.name == row.name
                        && prior.json.0 == row.json.0
                })
            }))
    }
}

impl PortableTeam {
    pub(super) async fn matches_config(
        &self,
        state: &AppState,
        agent: &Node,
        preview: &mut Preview,
    ) -> MysqlResult<bool> {
        let Some(id) = team_id(agent) else {
            return Ok(false);
        };
        let config = &agent.metadata.0;
        let Some(team) = resolution::team_by_id(&state.mysql, id).await? else {
            return Ok(false);
        };
        if config["runtime"] != "wegent"
            && (team.user_id != agent.created_by_user_id
                || team.namespace != format!("projects/{}", agent.cloud_project_id)
                || team.name != format!("agent-{}", agent.id)
                || team.json.0["metadata"]["migrationSource"] != agent.id)
        {
            return Ok(false);
        }
        let document = &team.json.0;
        let expected_mode = if self.collaboration_model == "single" {
            "solo"
        } else {
            &self.collaboration_model
        };
        let members = document["spec"]["members"].as_array();
        let references = resolution::bot_refs(document);
        if self.bot.is_empty()
            || self.bot.len() > 101
            || ghost::collaboration_model(document) != expected_mode
            || self.system_prompt != document["spec"]["systemPrompt"].as_str().unwrap_or("")
            || references.len() != self.bot.len()
            || members.map(Vec::len) != Some(self.bot.len())
        {
            return Ok(false);
        }
        let resolved_bots = resolution::execution_member_rows(
            &state.mysql,
            team.user_id,
            resolution::ExecutionMemberKind::Bot,
            &references,
        )
        .await?;
        if resolved_bots.len() != references.len() {
            return Ok(false);
        }
        let mut shell_refs = Vec::with_capacity(references.len());
        let mut ghost_refs = Vec::with_capacity(references.len());
        for bot in &resolved_bots {
            let ghost = &bot.json.0["spec"]["ghostRef"];
            ghost_refs.push(resolution::BotRef {
                namespace: ghost["namespace"].as_str().unwrap_or("default").to_owned(),
                name: ghost["name"].as_str().unwrap_or("").to_owned(),
            });
            let reference = &bot.json.0["spec"]["shellRef"];
            shell_refs.push((
                team.user_id,
                reference["name"].as_str().unwrap_or("").to_owned(),
                reference["namespace"]
                    .as_str()
                    .unwrap_or("default")
                    .to_owned(),
            ));
        }
        let ghosts = resolution::execution_member_rows(
            &state.mysql,
            team.user_id,
            resolution::ExecutionMemberKind::PromptGhost,
            &ghost_refs,
        )
        .await?;
        if ghosts.len() != references.len() {
            return Ok(false);
        }
        let resolvers = state.entity_resolvers.for_execution();
        let shells =
            shell::resolve_shells(&state.mysql, &resolvers, state.redis.as_ref(), &shell_refs)
                .await?;
        let mut leader_policy = None;
        for (index, (bot, ghost)) in resolved_bots.into_iter().zip(ghosts).enumerate() {
            let portable = &self.bot[index];
            let member = &members.unwrap()[index];
            let shell_ref = &shell_refs[index];
            if portable.id.as_str() != Some(&bot.name) && portable.id.as_i64() != Some(bot.id) {
                return Ok(false);
            }
            let spec = &bot.json.0["spec"];
            let Some(shell) = shells.get(shell_ref) else {
                return Ok(false);
            };
            let prompt = model_config::wrap_base_prompt(
                ghost.json.0["spec"]["systemPrompt"].as_str().unwrap_or(""),
                member["prompt"].as_str(),
            );
            let expected_prompt =
                model_config::wrap_base_prompt(&portable.system_prompt, Some(&portable.prompt));
            if prompt != expected_prompt
                || portable.shell_type != shell::shell_info(&shell.json.0).0
                || portable.role != member["role"].as_str().unwrap_or("")
                || portable.require_confirmation
                    != member["requireConfirmation"].as_bool().unwrap_or(false)
                || portable.context_passing != member["contextPassing"].as_str().unwrap_or("none")
                || portable
                    .model_id
                    .as_ref()
                    .is_some_and(|id| spec["model_policy"]["model"]["model_id"] != id.as_str())
                || portable
                    .model_provider
                    .as_ref()
                    .is_some_and(|p| spec["model_policy"]["model"]["provider"] != p.as_str())
            {
                return Ok(false);
            }
            if leader_policy.is_none() || member["role"] == "leader" {
                leader_policy = Some(spec["model_policy"].clone());
            }
            for row in [bot, ghost] {
                preview.resources.insert(row.id, row);
            }
        }
        for shell in shells.into_values() {
            preview
                .resources
                .entry(shell.id)
                .or_insert_with(|| std::sync::Arc::unwrap_or_clone(shell));
        }
        preview.resources.insert(team.id, team);
        preview.teams.insert(agent.id.clone(), id);
        Ok(self.model_policy.is_none() || self.model_policy == leader_policy)
    }
}
