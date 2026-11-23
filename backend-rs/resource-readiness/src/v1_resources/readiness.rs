// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Team execution readiness (`validate_team_execution_readiness`).
//!
//! Mirrors `app/services/execution/readiness_context.py::TeamReadinessContext`
//! and `app/services/execution/team_readiness.py`. The context prefetches the
//! member Bots and their Ghosts in batched `kinds` reads, collects the Shell
//! and Model names those Bots reference, and shares one batched
//! [`CapabilityLookup`] per execution identity. Each Team's status then
//! resolves through those request-local caches without issuing per-member
//! reads.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::ResourceReadinessState;
use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::v1_resources::capability_lookup::CapabilityLookup;
use crate::v1_resources::dependency_reader::{DependencyReader, DependencyRef};
use crate::v1_resources::model_resolution;
use crate::v1_resources::repository::OwnedKindRow;
use wegent_resource_store::kind_rows::KindRow;

/// One member of a Team CRD.
struct TeamView {
    members: Vec<(String, String)>,
}

/// The Bot CRD fields the readiness check consumes.
struct BotView {
    ghost_namespace: String,
    ghost_name: String,
    shell_namespace: String,
    shell_name: String,
    /// `spec.execution_policy is None`.
    no_execution_policy: bool,
    model_ref: Option<String>,
    agent_config_bind: Option<String>,
}

impl BotView {
    /// `_bound_model_names`: `agent_config.bind_model`, then the legacy
    /// `spec.modelRef.name`, deduplicated in that order.
    fn bound_model_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        if let Some(bind_model) = &self.agent_config_bind {
            names.push(bind_model.clone());
        }
        if let Some(model_ref) = &self.model_ref
            && !names.iter().any(|known| known == model_ref)
        {
            names.push(model_ref.clone());
        }
        names
    }
}

/// Request-local readiness state for one catalog read.
pub struct ReadinessContext<'a> {
    state: &'a ResourceReadinessState,
    reader: DependencyReader,
    capabilities: HashMap<i64, CapabilityLookup<'a>>,
    execution_user_id: i64,
}

impl<'a> ReadinessContext<'a> {
    /// Build the prefetched Bot/Ghost dependency state for these Teams and
    /// collect each Bot's Shell and Model names.
    pub async fn build(
        state: &'a ResourceReadinessState,
        teams: &[OwnedKindRow],
        execution_user_id: i64,
    ) -> Result<Self, FastApiError> {
        let mut context = Self {
            state,
            reader: DependencyReader::default(),
            capabilities: HashMap::new(),
            execution_user_id,
        };
        let bot_refs = collect_bot_refs(teams);
        context.reader.load(state, &bot_refs).await?;
        let mut ghost_refs: Vec<DependencyRef> = Vec::new();
        for (owner, _kind, namespace, name) in &bot_refs {
            let Some(bot) = context.reader.get(*owner, "Bot", namespace, name).cloned() else {
                continue;
            };
            let Some(view) = parse_bot(&bot.json.0) else {
                continue;
            };
            ghost_refs.push((
                *owner,
                "Ghost".to_string(),
                view.ghost_namespace.clone(),
                view.ghost_name.clone(),
            ));
            context
                .capability(*owner)
                .add_name("Shell", &view.shell_name);
            if view.no_execution_policy {
                let model_names = view.bound_model_names();
                let lookup = context.capability(execution_user_id);
                for model_name in model_names {
                    lookup.add_name("Model", &model_name);
                }
            }
        }
        ghost_refs.sort();
        ghost_refs.dedup();
        context.reader.load(state, &ghost_refs).await?;
        Ok(context)
    }

    /// `agent_status`: `available` only when the Team is active and every
    /// member dependency resolves.
    pub async fn agent_status(
        &mut self,
        team: &OwnedKindRow,
        user: &UserRow,
    ) -> Result<String, FastApiError> {
        if team.is_active == 0 {
            return Ok("unavailable".to_string());
        }
        if self.is_ready(team, user).await? {
            Ok("available".to_string())
        } else {
            Ok("unavailable".to_string())
        }
    }

    /// `validate_team_execution_readiness`.
    async fn is_ready(
        &mut self,
        team: &OwnedKindRow,
        user: &UserRow,
    ) -> Result<bool, FastApiError> {
        let Some(team_view) = parse_team(&team.json.0) else {
            return Ok(false);
        };
        if team_view.members.is_empty() {
            return Ok(false);
        }
        let mut checked: HashSet<(String, String)> = HashSet::new();
        for (namespace, name) in &team_view.members {
            if !checked.insert((namespace.clone(), name.clone())) {
                continue;
            }
            let Some(bot) = self
                .reader
                .get(team.user_id, "Bot", namespace, name)
                .cloned()
            else {
                return Ok(false);
            };
            let Some(bot_view) = parse_bot(&bot.json.0) else {
                return Ok(false);
            };
            let Some(ghost) = self
                .reader
                .get(
                    team.user_id,
                    "Ghost",
                    &bot_view.ghost_namespace,
                    &bot_view.ghost_name,
                )
                .cloned()
            else {
                return Ok(false);
            };
            if !ghost_is_valid(&ghost.json.0) {
                return Ok(false);
            }
            let Some(shell) = resolve_shell(
                self,
                team.user_id,
                &bot_view.shell_namespace,
                &bot_view.shell_name,
            )
            .await?
            else {
                return Ok(false);
            };
            if !shell_is_valid(&shell.json.0) {
                return Ok(false);
            }
            if bot_view.no_execution_policy {
                let state = self.state;
                let user_id = self.execution_user_id;
                let lookup = self.capability(user_id);
                let Some(bot_spec) = bot.json.0.get("spec") else {
                    return Ok(false);
                };
                if !model_resolution::model_is_usable(state, lookup, bot_spec, user).await? {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }

    /// `context.capabilities(user_id)`: one lookup per execution identity.
    fn capability(&mut self, user_id: i64) -> &mut CapabilityLookup<'a> {
        let state = self.state;
        self.capabilities
            .entry(user_id)
            .or_insert_with(|| CapabilityLookup::new(state, user_id))
    }
}

/// `get_shell_by_name`: owner Shell, approved reference, authorized group,
/// then public — through the shared batched lookup.
async fn resolve_shell(
    context: &mut ReadinessContext<'_>,
    owner_user_id: i64,
    namespace: &str,
    name: &str,
) -> Result<Option<KindRow>, FastApiError> {
    let lookup = context.capability(owner_user_id);
    if let Some(shell) = lookup.personal("Shell", name, Some(namespace)).await? {
        return Ok(Some(shell));
    }
    if let Some(shell) = lookup.referenced("Shell", name, namespace).await? {
        return Ok(Some(shell));
    }
    if namespace != "default" {
        let groups = lookup.groups().await?;
        if groups.iter().any(|group| group == namespace)
            && let Some(shell) = lookup
                .group("Shell", name, &[namespace.to_string()])
                .await?
        {
            return Ok(Some(shell));
        }
    }
    lookup.public("Shell", name).await
}

/// `agent_display_name`: the Team's `metadata.displayName` when non-blank.
pub fn agent_display_name(team: &OwnedKindRow) -> String {
    agent_catalog_name(&team.name, team.json.0.get("metadata"))
}

/// `agent_catalog_name`: resolve a display name from metadata without loading
/// the execution specification.
pub fn agent_catalog_name(name: &str, metadata: Option<&Value>) -> String {
    let display_name = metadata.and_then(|metadata| metadata.get("displayName"));
    match display_name.and_then(Value::as_str) {
        Some(display_name) if !display_name.trim().is_empty() => display_name.to_string(),
        _ => name.to_string(),
    }
}

/// Collect `(owner, "Bot", namespace, name)` member references from the
/// session's Teams, sorted and deduplicated like the source set.
fn collect_bot_refs(teams: &[OwnedKindRow]) -> Vec<DependencyRef> {
    let mut references: Vec<DependencyRef> = Vec::new();
    for team in teams {
        let Some(team_view) = parse_team(&team.json.0) else {
            continue;
        };
        for (namespace, name) in team_view.members {
            references.push((team.user_id, "Bot".to_string(), namespace, name));
        }
    }
    references.sort();
    references.dedup();
    references
}

/// `Team.model_validate`: metadata name, `spec.members[].botRef`, and the
/// `spec.collaborationModel` field the schema requires.
fn parse_team(json: &Value) -> Option<TeamView> {
    json.get("metadata")?.get("name")?.as_str()?;
    let spec = json.get("spec")?;
    spec.get("collaborationModel")?.as_str()?;
    let members = spec.get("members")?.as_array()?;
    let mut views = Vec::with_capacity(members.len());
    for member in members {
        let bot_ref = member.get("botRef")?;
        let name = bot_ref.get("name")?.as_str()?.to_string();
        let namespace = match bot_ref.get("namespace") {
            Some(namespace) => namespace.as_str()?.to_string(),
            None => "default".to_string(),
        };
        views.push((namespace, name));
    }
    Some(TeamView { members: views })
}

/// `Bot.model_validate`: metadata name plus the required `ghostRef`/
/// `shellRef` references; `modelRef` is optional.
fn parse_bot(json: &Value) -> Option<BotView> {
    json.get("metadata")?.get("name")?.as_str()?;
    let spec = json.get("spec")?;
    let ghost_ref = spec.get("ghostRef")?;
    let ghost_name = ghost_ref.get("name")?.as_str()?.to_string();
    let ghost_namespace = match ghost_ref.get("namespace") {
        Some(namespace) => namespace.as_str()?.to_string(),
        None => "default".to_string(),
    };
    let shell_ref = spec.get("shellRef")?;
    let shell_name = shell_ref.get("name")?.as_str()?.to_string();
    let shell_namespace = match shell_ref.get("namespace") {
        Some(namespace) => namespace.as_str()?.to_string(),
        None => "default".to_string(),
    };
    let model_ref = match spec.get("modelRef") {
        None | Some(Value::Null) => None,
        Some(model_ref) => Some(model_ref.get("name")?.as_str()?.to_string()),
    };
    let no_execution_policy = spec.get("execution_policy").is_none_or(Value::is_null);
    let agent_config_bind = spec
        .get("agent_config")
        .filter(|value| value.is_object())
        .and_then(|config| config.get("bind_model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    Some(BotView {
        ghost_namespace,
        ghost_name,
        shell_namespace,
        shell_name,
        no_execution_policy,
        model_ref,
        agent_config_bind,
    })
}

/// `Ghost.model_validate`: metadata name and the required `spec.systemPrompt`.
fn ghost_is_valid(json: &Value) -> bool {
    json.get("metadata")
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
        .is_some()
        && json
            .get("spec")
            .and_then(|spec| spec.get("systemPrompt"))
            .and_then(Value::as_str)
            .is_some()
}

/// `Shell.model_validate`: metadata name and the required `spec.shellType`
/// (aliased `runtime`).
fn shell_is_valid(json: &Value) -> bool {
    let shell_type = json
        .get("spec")
        .and_then(|spec| spec.get("shellType").or_else(|| spec.get("runtime")))
        .and_then(Value::as_str);
    json.get("metadata")
        .and_then(|metadata| metadata.get("name"))
        .and_then(Value::as_str)
        .is_some()
        && shell_type.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timestamp() -> chrono::NaiveDateTime {
        chrono::NaiveDate::from_ymd_opt(2026, 10, 7)
            .unwrap()
            .and_hms_opt(7, 31, 35)
            .unwrap()
    }

    fn team(document: serde_json::Value) -> OwnedKindRow {
        OwnedKindRow {
            id: 18732,
            user_id: 157,
            kind: "Team".to_string(),
            name: "AI助理".to_string(),
            namespace: "default".to_string(),
            json: brz_mysql::Json(document),
            is_active: 1,
            created_at: timestamp(),
            updated_at: timestamp(),
        }
    }

    /// The member list is read from the Team CRD `spec` object, so a normal
    /// Team exposes its `botRef`.
    #[test]
    fn reads_members_from_spec_level() {
        let row = team(serde_json::json!({
            "apiVersion": "wegent.io/v1alpha1",
            "kind": "Team",
            "metadata": {"name": "AI助理"},
            "spec": {
                "collaborationModel": "solo",
                "members": [{"botRef": {"name": "AI助理", "namespace": "default"}}],
            },
        }));
        let view = parse_team(&row.json.0).expect("valid team");
        assert_eq!(
            view.members,
            vec![("default".to_string(), "AI助理".to_string())]
        );
    }

    /// A Team document without `spec.members` is rejected like
    /// `Team.model_validate`.
    #[test]
    fn missing_members_is_invalid() {
        let row = team(serde_json::json!({
            "kind": "Team",
            "metadata": {"name": "AI助理"},
            "spec": {"collaborationModel": "solo"},
        }));
        assert!(parse_team(&row.json.0).is_none());
    }

    /// A Team without the required `collaborationModel` is invalid, matching
    /// the pydantic schema.
    #[test]
    fn missing_collaboration_model_is_invalid() {
        let row = team(serde_json::json!({
            "kind": "Team",
            "metadata": {"name": "AI助理"},
            "spec": {"members": []},
        }));
        assert!(parse_team(&row.json.0).is_none());
    }

    /// `metadata.displayName` wins for the Agent name when non-blank.
    #[test]
    fn display_name_prefers_metadata() {
        let row = team(serde_json::json!({
            "kind": "Team",
            "metadata": {"name": "AI助理", "displayName": "My Agent"},
            "spec": {"collaborationModel": "solo", "members": []},
        }));
        assert_eq!(agent_display_name(&row), "My Agent");
    }
}
