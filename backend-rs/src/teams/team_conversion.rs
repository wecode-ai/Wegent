// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Response construction for `GET /api/teams`: batched preload of related
//! users, bots, shells, and models, plus the per-team item conversion
//! (`_convert_to_team_dict_with_cache` + `default_for_modes`).
use crate::crd::{CrdDocument, ResourceReference as TeamReference, reference_parts};
use crate::json_compat::OptionalOpaqueJsonExt;
use crate::json_compat::{OpaqueJson, raw_null};
use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDateTime;
use serde_json::value::RawValue;
#[cfg(test)]
use serde_json::{Value, json};

use super::teams_repository as repo;
use super::teams_repository::{KindRow, TeamRow};

/// Batched preload caches for related entities
/// (`get_user_teams` preload stage).
pub(crate) struct Preloaded {
    /// `(user_id, name, namespace)` -> Bot kind.
    bots: HashMap<(i64, String, String), KindRow>,
    /// `(name, namespace)` -> group Bot kind.
    group_bots: HashMap<(String, String), KindRow>,
    /// `(user_id, name, namespace)` -> Shell kind.
    shells: HashMap<(i64, String, String), KindRow>,
    /// name -> public Shell kind.
    public_shells: HashMap<String, KindRow>,
    /// `(user_id, name, namespace)` -> Model kind.
    models: HashMap<(i64, String, String), KindRow>,
    /// name -> public Model kind.
    public_models: HashMap<String, KindRow>,
    /// Team-owner user summaries.
    users: HashMap<i64, String>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamSpecInput {
    members: Option<Vec<Option<TeamMember>>>,
    quick_phrases: Option<Vec<Option<String>>>,
    #[serde(rename = "modeSpec")]
    mode_spec: Option<BTreeMap<String, Option<OpaqueJson>>>,
    #[serde(rename = "displayConfig")]
    display_config: Option<BTreeMap<String, Option<OpaqueJson>>>,
    #[serde(rename = "inputPlaceholder")]
    input_placeholder: Option<BTreeMap<String, Option<OpaqueJson>>>,
    bind_mode: Option<OpaqueJson>,
    description: Option<OpaqueJson>,
    #[serde(rename = "collaborationModel")]
    collaboration_model: Option<String>,
    icon: Option<OpaqueJson>,
    #[serde(rename = "requiresWorkspace")]
    requires_workspace: Option<OpaqueJson>,
    capability: Option<TeamCapabilityInput>,
}

/// The Team document fields used by this endpoint.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamDocumentInput {
    spec: Option<TeamSpecInput>,
}

/// Only the Kind spec fields used by the team-list conversion. `modelConfig`
/// has provider-defined keys, while each value is passed through unchanged.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct KindSpecInput {
    #[serde(rename = "shellRef")]
    shell_ref: Option<TeamReference>,
    #[serde(rename = "shellType")]
    shell_type: Option<String>,
    runtime: Option<String>,
    #[serde(rename = "isCustomConfig")]
    is_custom_config: Option<bool>,
    #[serde(rename = "modelConfig")]
    model_config: Option<BTreeMap<String, OpaqueJson>>,
    protocol: Option<String>,
}

#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct KindDocumentInput {
    spec: Option<KindSpecInput>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamCapabilityInput {
    #[serde(rename = "publishStatus")]
    publish_status: Option<OpaqueJson>,
}
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct TeamMember {
    #[serde(rename = "botRef")]
    bot_ref: Option<TeamReference>,
    prompt: Option<String>,
    role: Option<String>,
    #[serde(rename = "requireConfirmation")]
    require_confirmation: Option<bool>,
    #[serde(rename = "contextPassing")]
    context_passing: Option<String>,
}
/// Filter only top-level nulls. Callers retain their own {} versus null policy.
fn compact_fields(
    fields: &Option<BTreeMap<String, Option<OpaqueJson>>>,
) -> BTreeMap<&str, &OpaqueJson> {
    fields
        .iter()
        .flat_map(|fields| fields.iter())
        .filter_map(|(key, value)| value.as_ref().map(|value| (key.as_str(), value)))
        .collect()
}

/// The Team CRD JSON projection used for member and spec access.
struct TeamCrd {
    document: CrdDocument,
    input: TeamSpecInput,
}

impl TeamCrd {
    fn members(&self) -> impl Iterator<Item = &TeamMember> {
        self.input
            .members
            .iter()
            .flatten()
            .filter_map(|member| member.as_ref())
    }

    fn labels(&self) -> Option<&crate::crd::CrdLabels> {
        self.document.metadata.as_ref()?.labels.as_ref()
    }
}

impl From<&OpaqueJson> for TeamCrd {
    fn from(json: &OpaqueJson) -> Self {
        let input = json
            .project::<TeamDocumentInput>()
            .and_then(|document| document.spec)
            .unwrap_or_default();
        Self {
            document: CrdDocument::project_opaque(json),
            input,
        }
    }
}

fn kind_spec(json: &OpaqueJson) -> Option<KindSpecInput> {
    json.project::<KindDocumentInput>()?.spec
}

/// Batch preload related users, bots, shells, and models
/// (`get_user_teams` preload stage).
pub(crate) async fn preload_related<M>(
    mysql: &M,
    teams: &[TeamRow],
) -> Result<Preloaded, brz_mysql::MysqlError>
where
    M: brz_mysql::Mysql,
{
    // Users. The source collects `set(team_data.team_user_id)` — duplicates
    // removed — and passes the set straight into the IN clause. The replay
    // engine matches IN-list contents order-insensitively, so first-seen
    // order with deduplication reproduces the set semantics.
    let mut user_ids: Vec<i64> = Vec::with_capacity(teams.len());
    for team in teams {
        if !user_ids.contains(&team.team_user_id) {
            user_ids.push(team.team_user_id);
        }
    }
    let users: HashMap<i64, String> = repo::users_by_ids(mysql, &user_ids)
        .await?
        .into_iter()
        .map(|user| (user.users_id, user.users_user_name))
        .collect();

    // Bot refs: personal teams use (context_user_id, name, ns) collected in
    // a list (duplicates included, row order); group teams use a set of
    // (name, ns) — the source's set iteration order is hash-seed dependent,
    // so the target keeps first-seen order.
    let mut personal_bot_refs: Vec<(i64, String, String)> = Vec::new();
    let mut group_bot_seen: Vec<(String, String)> = Vec::new();
    for team in teams {
        let crd: TeamCrd = (&team.team_json.0).into();
        let is_group_team = !team.team_namespace.is_empty() && team.team_namespace != "default";
        for member in crd.members() {
            let Some(bot_ref) = member.bot_ref.as_ref() else {
                continue;
            };
            let name = bot_ref.name();
            let namespace = bot_ref.namespace();
            if name.is_empty() {
                continue;
            }
            if is_group_team {
                let entry = (name.to_string(), namespace.to_string());
                if !group_bot_seen.contains(&entry) {
                    group_bot_seen.push(entry);
                }
            } else {
                personal_bot_refs.push((
                    team.context_user_id,
                    name.to_string(),
                    namespace.to_string(),
                ));
            }
        }
    }
    let group_bot_refs = group_bot_seen;

    let bots: HashMap<(i64, String, String), KindRow> = if personal_bot_refs.is_empty() {
        HashMap::new()
    } else {
        repo::kinds_by_refs(mysql, "Bot", &personal_bot_refs, true)
            .await?
            .into_iter()
            .map(|kind| {
                (
                    (
                        kind.kinds_user_id,
                        kind.kinds_name.clone(),
                        kind.kinds_namespace.clone(),
                    ),
                    kind,
                )
            })
            .collect()
    };
    let group_bots: HashMap<(String, String), KindRow> = if group_bot_refs.is_empty() {
        HashMap::new()
    } else {
        let refs: Vec<(i64, String, String)> = group_bot_refs
            .iter()
            .map(|(name, namespace)| (0, name.clone(), namespace.clone()))
            .collect();
        repo::kinds_by_refs(mysql, "Bot", &refs, false)
            .await?
            .into_iter()
            .map(|kind| {
                (
                    (kind.kinds_name.clone(), kind.kinds_namespace.clone()),
                    kind,
                )
            })
            .collect()
    };

    // Shell and model refs from both bot caches. The source collects these
    // into sets and iterates them (hash-seed dependent); the target keeps
    // first-seen order and deduplicates.
    let mut shell_refs: Vec<(i64, String, String)> = Vec::new();
    let mut model_refs: Vec<(i64, String, String)> = Vec::new();
    let mut bot_kinds: Vec<&KindRow> = bots.values().collect();
    bot_kinds.extend(group_bots.values());
    for bot in &bot_kinds {
        let crd = CrdDocument::project_opaque(&bot.kinds_json.0);
        let spec = crd.spec.as_ref();
        if let Some((name, namespace)) = spec.and_then(|spec| reference_parts(&spec.shell_ref)) {
            // `ShellRef.name` is a plain `str` (required, may be empty in
            // stored JSON); the source adds the ref to the set
            // unconditionally.
            let entry = (bot.kinds_user_id, name, namespace);
            if !shell_refs.contains(&entry) {
                shell_refs.push(entry);
            }
        }
        if let Some((name, namespace)) = spec.and_then(|spec| reference_parts(&spec.model_ref)) {
            // `ModelRef.name` is a plain `str` — the pydantic model keeps an
            // empty name and the source adds the (uid, "", ns) ref to the
            // set unconditionally, so an empty name must stay in the query.
            let entry = (bot.kinds_user_id, name, namespace);
            if !model_refs.contains(&entry) {
                model_refs.push(entry);
            }
        }
    }

    // User shells (uid > 0) then public shells by name for misses.
    let user_shell_refs: Vec<(i64, String, String)> = shell_refs
        .iter()
        .filter(|(uid, _, _)| *uid > 0)
        .cloned()
        .collect();
    let shells: HashMap<(i64, String, String), KindRow> = if user_shell_refs.is_empty() {
        HashMap::new()
    } else {
        repo::kinds_by_refs(mysql, "Shell", &user_shell_refs, true)
            .await?
            .into_iter()
            .map(|kind| {
                (
                    (
                        kind.kinds_user_id,
                        kind.kinds_name.clone(),
                        kind.kinds_namespace.clone(),
                    ),
                    kind,
                )
            })
            .collect()
    };
    let mut public_shell_names: Vec<String> = shell_refs
        .iter()
        .filter(|(uid, name, ns)| !shells.contains_key(&(*uid, name.clone(), ns.clone())))
        .map(|(_, name, _)| name.clone())
        .collect();
    dedup_strings(&mut public_shell_names);
    let public_shells: HashMap<String, KindRow> = if public_shell_names.is_empty() {
        HashMap::new()
    } else {
        repo::public_kinds_by_names(mysql, "Shell", &public_shell_names)
            .await?
            .into_iter()
            .map(|kind| (kind.kinds_name.clone(), kind))
            .collect()
    };

    // User models then public models by name for misses.
    let user_model_refs: Vec<(i64, String, String)> = model_refs
        .iter()
        .filter(|(uid, _, _)| *uid > 0)
        .cloned()
        .collect();
    let models: HashMap<(i64, String, String), KindRow> = if user_model_refs.is_empty() {
        HashMap::new()
    } else {
        repo::kinds_by_refs(mysql, "Model", &user_model_refs, true)
            .await?
            .into_iter()
            .map(|kind| {
                (
                    (
                        kind.kinds_user_id,
                        kind.kinds_name.clone(),
                        kind.kinds_namespace.clone(),
                    ),
                    kind,
                )
            })
            .collect()
    };
    let mut public_model_names: Vec<String> = model_refs
        .iter()
        .filter(|(uid, name, ns)| !models.contains_key(&(*uid, name.clone(), ns.clone())))
        .map(|(_, name, _)| name.clone())
        .collect();
    dedup_strings(&mut public_model_names);
    let public_models: HashMap<String, KindRow> = if public_model_names.is_empty() {
        HashMap::new()
    } else {
        repo::public_kinds_by_names(mysql, "Model", &public_model_names)
            .await?
            .into_iter()
            .map(|kind| (kind.kinds_name.clone(), kind))
            .collect()
    };

    Ok(Preloaded {
        bots,
        group_bots,
        shells,
        public_shells,
        models,
        public_models,
        users,
    })
}

/// Deduplicate a string list keeping first-seen order (the source collects
/// these in sets; iteration order there is hash-seed dependent).
fn dedup_strings(values: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    values.retain(|value| seen.insert(value.clone()));
}

#[derive(serde::Serialize)]
pub(crate) struct TeamItem {
    id: i64,
    user_id: i64,
    name: String,
    #[serde(rename = "displayName")]
    display_name: Box<RawValue>,
    namespace: String,
    description: Box<RawValue>,
    bots: Vec<TeamBot>,
    workflow: TeamWorkflow,
    bind_mode: Box<RawValue>,
    mode_spec: Box<RawValue>,
    recommended_mode: &'static str,
    is_mix_team: bool,
    is_active: bool,
    created_at: String,
    updated_at: String,
    agent_type: Option<String>,
    icon: Box<RawValue>,
    display_config: Box<RawValue>,
    quick_phrases: Vec<String>,
    #[serde(rename = "inputPlaceholder")]
    input_placeholder: Box<RawValue>,
    requires_workspace: Box<RawValue>,
    publication_status: Box<RawValue>,
    access_source: String,
    default_for_modes: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    share_status: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<TeamOwner>,
}
#[derive(serde::Serialize)]
struct TeamOwner {
    id: i64,
    user_name: String,
}
#[derive(serde::Serialize)]
struct TeamWorkflow {
    mode: Option<String>,
}
#[derive(serde::Serialize)]
struct TeamBot {
    bot_id: i64,
    bot_prompt: String,
    role: String,
    #[serde(rename = "requireConfirmation")]
    require_confirmation: bool,
    #[serde(rename = "contextPassing")]
    context_passing: String,
    bot: BotSummary,
}
#[derive(serde::Serialize)]
struct BotSummary {
    name: String,
    agent_config: Box<RawValue>,
    shell_type: String,
}

/// `_convert_to_team_dict_with_cache` + `default_for_modes` for one team.
pub(crate) fn team_item(
    team: &TeamRow,
    preloaded: &Preloaded,
    default_config: &[(&'static str, String, String)],
) -> TeamItem {
    let crd: TeamCrd = (&team.team_json.0).into();
    let is_group_resource = !team.team_namespace.is_empty() && team.team_namespace != "default";

    // Members -> bots.
    let mut bots: Vec<TeamBot> = Vec::new();
    let mut shell_types: Vec<String> = Vec::new();
    for member in crd.members() {
        let Some(bot_ref) = member.bot_ref.as_ref() else {
            continue;
        };
        let name = bot_ref.name();
        let namespace = bot_ref.namespace();
        if name.is_empty() {
            continue;
        }
        let bot = if is_group_resource {
            preloaded
                .group_bots
                .get(&(name.to_string(), namespace.to_string()))
        } else {
            preloaded.bots.get(&(
                team.context_user_id,
                name.to_string(),
                namespace.to_string(),
            ))
        };
        let Some(bot) = bot else {
            continue;
        };
        let lookup_user_id = if is_group_resource {
            bot.kinds_user_id
        } else {
            team.context_user_id
        };
        let summary = bot_summary(bot, lookup_user_id, preloaded);
        if !summary.shell_type.is_empty() && !shell_types.contains(&summary.shell_type) {
            shell_types.push(summary.shell_type.clone());
        }
        bots.push(TeamBot {
            bot_id: bot.kinds_id,
            bot_prompt: member.prompt.as_deref().unwrap_or("").to_owned(),
            role: member.role.as_deref().unwrap_or("").to_owned(),
            require_confirmation: member.require_confirmation.unwrap_or(false),
            context_passing: normalize_context_passing(member.context_passing.as_deref())
                .to_owned(),
            bot: summary,
        });
    }

    // agent_type from the first bot's shell.
    let agent_type = bots.first().and_then(|first| {
        let bot_id = first.bot_id;
        let bot = if is_group_resource {
            preloaded
                .group_bots
                .values()
                .find(|bot| bot.kinds_id == bot_id)?
        } else {
            preloaded.bots.values().find(|bot| bot.kinds_id == bot_id)?
        };
        let shell_ref = kind_spec(&bot.kinds_json.0)?.shell_ref?;
        let namespace = shell_ref.namespace().to_owned();
        let name = shell_ref.name?;
        let lookup_user_id = if is_group_resource {
            bot.kinds_user_id
        } else {
            team.context_user_id
        };
        let shell = preloaded
            .shells
            .get(&(lookup_user_id, name.clone(), namespace))
            .or_else(|| preloaded.public_shells.get(&name))?;
        let shell_type = shell_kind_type(&shell.kinds_json.0)?;
        Some(agent_type_from_shell(&shell_type))
    });

    // recommended_mode from bind_mode.
    let recommended_mode = crd
        .input
        .bind_mode
        .as_ref()
        .and_then(OpaqueJson::project::<Vec<Option<String>>>)
        .map(|modes| recommended_mode(&modes))
        .unwrap_or("chat");

    let mode_fields = compact_fields(&crd.input.mode_spec);
    let mode_spec = (!mode_fields.is_empty()).then_some(mode_fields);
    let display_config = compact_fields(&crd.input.display_config);
    let placeholder_fields = compact_fields(&crd.input.input_placeholder);
    let input_placeholder = (!placeholder_fields.is_empty()).then_some(placeholder_fields);
    let quick_phrases = crd
        .input
        .quick_phrases
        .iter()
        .flatten()
        .filter_map(|phrase| phrase.as_deref())
        .map(str::trim)
        .filter(|phrase| !phrase.is_empty())
        .map(str::to_owned)
        .collect();

    // default_for_modes: modes whose configured team matches this identity.
    let team_namespace = if team.team_namespace.is_empty() {
        "default".to_string()
    } else {
        team.team_namespace.clone()
    };
    let default_for_modes: Vec<&str> = default_config
        .iter()
        .filter(|(_, name, namespace)| *name == team.team_name && *namespace == team_namespace)
        .map(|(mode, _, _)| *mode)
        .collect();

    let mut item = TeamItem {
        id: team.team_id,
        user_id: team.team_user_id,
        name: team.team_name.clone(),
        display_name: crd
            .document
            .metadata
            .as_ref()
            .map(|metadata| metadata.display_name.raw_or(()))
            .unwrap_or_else(raw_null),
        namespace: team.team_namespace.clone(),
        description: crd.input.description.raw_or(()),
        bots,
        workflow: TeamWorkflow {
            mode: crd.input.collaboration_model.clone(),
        },
        bind_mode: crd.input.bind_mode.raw_or(()),
        mode_spec: serde_json::value::to_raw_value(&mode_spec)
            .expect("team configuration serializes"),
        recommended_mode,
        is_mix_team: shell_types.len() > 1,
        is_active: true,
        created_at: datetime_value(team.team_created_at),
        updated_at: datetime_value(team.team_updated_at),
        agent_type,
        icon: crd.input.icon.raw_or(()),
        display_config: serde_json::value::to_raw_value(&display_config)
            .expect("team configuration serializes"),
        quick_phrases,
        input_placeholder: serde_json::value::to_raw_value(&input_placeholder)
            .expect("team configuration serializes"),
        requires_workspace: crd.input.requires_workspace.raw_or(()),
        publication_status: crd
            .input
            .capability
            .as_ref()
            .map(|capability| capability.publish_status.raw_or(()))
            .unwrap_or_else(raw_null),
        access_source: team.access_source.clone(),
        default_for_modes,
        share_status: None,
        user: None,
    };

    // share_status: own/public teams expose it only from metadata labels;
    // shared teams always report 2.
    if team.share_status == 0 {
        if let Some(labels) = crd.labels()
            && let Some(status) = labels
                .share_status
                .as_deref()
                .and_then(|value| value.parse::<i64>().ok())
        {
            item.share_status = Some(status);
        }
    } else {
        item.share_status = Some(2);
    }

    // user summary for the team owner.
    if let Some(user_name) = preloaded.users.get(&team.team_user_id) {
        item.user = Some(TeamOwner {
            id: team.team_user_id,
            user_name: user_name.clone(),
        });
    }

    item
}

/// `_get_bot_summary_with_cache`.
fn bot_summary(bot: &KindRow, user_id: i64, preloaded: &Preloaded) -> BotSummary {
    let crd = CrdDocument::project_opaque(&bot.kinds_json.0);
    let spec = crd.spec.as_ref();
    let shell_type = spec
        .and_then(|spec| spec.shell_ref.as_ref())
        .and_then(|shell_ref| {
            let name = shell_ref.name.as_deref()?;
            let namespace = shell_ref.namespace();
            let shell = preloaded
                .shells
                .get(&(user_id, name.to_string(), namespace.to_string()))
                .or_else(|| preloaded.public_shells.get(name))?;
            shell_kind_type(&shell.kinds_json.0)
        })
        .unwrap_or_default();

    // agent_config from modelRef.
    let mut agent_config = BTreeMap::new();
    if spec.is_some_and(|spec| spec.model_ref.is_some()) {
        let model_ref = spec.and_then(|spec| spec.model_ref.as_ref());
        let model_name = model_ref.and_then(|reference| reference.name.as_deref());
        let model_namespace = model_ref.map(TeamReference::namespace).unwrap_or("default");
        if let Some(model_name) = model_name.filter(|name| !name.is_empty()) {
            // Private models resolve by (user, name, namespace); the public
            // fallback resolves by name only and always reports `public`.
            let private_model = preloaded.models.get(&(
                user_id,
                model_name.to_string(),
                model_namespace.to_string(),
            ));
            let public_model = if private_model.is_none() {
                preloaded.public_models.get(model_name)
            } else {
                None
            };
            let Some(model) = private_model.or(public_model) else {
                return json_value(bot, agent_config, shell_type);
            };
            let model_spec = kind_spec(&model.kinds_json.0);
            let is_custom = model_spec
                .as_ref()
                .and_then(|spec| spec.is_custom_config)
                .unwrap_or(false);
            if is_custom {
                if let Some(config) = model_spec
                    .as_ref()
                    .and_then(|spec| spec.model_config.clone())
                {
                    agent_config.extend(config);
                }
                if let Some(protocol) = model_spec.as_ref().and_then(|spec| spec.protocol.as_ref())
                {
                    agent_config.insert(
                        "protocol".to_string(),
                        OpaqueJson::from_serializable(protocol),
                    );
                }
            } else {
                let bind_model_type = if public_model.is_some() {
                    "public"
                } else if model.kinds_user_id == user_id {
                    "user"
                } else {
                    "public"
                };
                agent_config.insert(
                    "bind_model".to_string(),
                    OpaqueJson::from_serializable(model_name),
                );
                agent_config.insert(
                    "bind_model_type".to_string(),
                    OpaqueJson::from_serializable(bind_model_type),
                );
            }
            return json_value(bot, agent_config, shell_type);
        }
        return json_value(bot, agent_config, shell_type);
    }
    // No modelRef (or an empty name): the source returns the summary with an
    // empty agent_config.
    json_value(bot, agent_config, shell_type)
}

/// Render the bot summary value.
fn json_value(
    bot: &KindRow,
    agent_config: BTreeMap<String, OpaqueJson>,
    shell_type: String,
) -> BotSummary {
    BotSummary {
        name: bot.kinds_name.clone(),
        agent_config: serde_json::value::to_raw_value(&agent_config)
            .expect("agent configuration serializes"),
        shell_type,
    }
}

/// Shell kind type: `spec.shellType` with `spec.runtime` as the
/// backward-compatible alias (`ShellSpec.shellType` validation alias).
fn shell_kind_type(kind_json: &OpaqueJson) -> Option<String> {
    let spec = kind_spec(kind_json)?;
    spec.shell_type.or(spec.runtime)
}

/// `_recommended_mode`: `both` when both modes, `code` when code only,
/// otherwise `chat`.
fn recommended_mode(modes: &[Option<String>]) -> &'static str {
    let has = |mode: &str| modes.iter().any(|value| value.as_deref() == Some(mode));
    if has("chat") && has("code") {
        "both"
    } else if has("code") {
        "code"
    } else {
        "chat"
    }
}

/// agent_type mapping (`ClaudeCode`->claude, `Agno`->agno, `Dify`->dify,
/// `Chat`->chat, others lowercase).
fn agent_type_from_shell(shell_type: &str) -> String {
    match shell_type {
        "Agno" => "agno".to_string(),
        "ClaudeCode" => "claude".to_string(),
        "Dify" => "dify".to_string(),
        "Chat" => "chat".to_string(),
        other => other.to_lowercase(),
    }
}

/// `normalize_context_passing`: unsupported values become `none`.
fn normalize_context_passing(value: Option<&str>) -> &str {
    match value {
        Some("none" | "original_user" | "previous_bot" | "original_and_previous") => value.unwrap(),
        _ => "none",
    }
}

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
fn datetime_value(value: NaiveDateTime) -> String {
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        base
    } else {
        format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    fn stored_json(value: Value) -> brz_mysql::Json<OpaqueJson> {
        brz_mysql::Json(value.into())
    }

    fn team_item(
        team: &TeamRow,
        preloaded: &Preloaded,
        config: &[(&'static str, String, String)],
    ) -> Value {
        crate::json_contract_tests::serialized(super::team_item(team, preloaded, config)).unwrap()
    }
    fn bot_summary(bot: &KindRow, user_id: i64, preloaded: &Preloaded) -> Value {
        crate::json_contract_tests::serialized(super::bot_summary(bot, user_id, preloaded)).unwrap()
    }

    #[test]
    fn recommended_mode_matches_source_rules() {
        let mode = |value: Value| {
            let modes = serde_json::from_value::<Vec<Option<String>>>(value).unwrap_or_default();
            recommended_mode(&modes)
        };
        assert_eq!(mode(json!(["chat", "code"])), "both");
        assert_eq!(mode(json!(["code"])), "code");
        assert_eq!(mode(json!(["chat"])), "chat");
        assert_eq!(mode(json!(["task"])), "chat");
        assert_eq!(mode(json!([])), "chat");
        assert_eq!(mode(Value::Null), "chat");
        assert_eq!(mode(json!(["chat", "task", "code"])), "both");
    }
    #[test]
    fn agent_type_mapping() {
        assert_eq!(agent_type_from_shell("ClaudeCode"), "claude");
        assert_eq!(agent_type_from_shell("Agno"), "agno");
        assert_eq!(agent_type_from_shell("Dify"), "dify");
        assert_eq!(agent_type_from_shell("Chat"), "chat");
        assert_eq!(agent_type_from_shell("Custom"), "custom");
    }
    #[test]
    fn context_passing_normalizes_unknown_values() {
        assert_eq!(normalize_context_passing(None), "none");
        assert_eq!(normalize_context_passing(Some("")), "none");
        assert_eq!(normalize_context_passing(Some("bogus")), "none");
        assert_eq!(
            normalize_context_passing(Some("previous_bot")),
            "previous_bot"
        );
    }
    #[test]
    fn datetime_serializes_like_pydantic() {
        let value =
            NaiveDateTime::parse_from_str("2026-01-19 21:00:58", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(datetime_value(value), "2026-01-19T21:00:58");
    }
    #[test]
    fn default_for_modes_matches_identity() {
        let default_config = vec![("wework", "wegent-wework".to_string(), "default".to_string())];
        let mut team = TeamRow {
            team_id: 1,
            team_user_id: 0,
            team_name: "wegent-wework".to_string(),
            team_namespace: "default".to_string(),
            team_json: stored_json(serde_json::json!({
                "metadata": { "name": "wegent-wework", "displayName": "W" },
                "spec": {
                    "members": [],
                    "collaborationModel": "solo",
                    "bind_mode": ["task"],
                    "displayConfig": {},
                }
            })),
            team_created_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
            team_updated_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
            share_status: 0,
            context_user_id: 0,
            access_source: "native".to_string(),
        };
        let preloaded = Preloaded {
            bots: HashMap::new(),
            group_bots: HashMap::new(),
            shells: HashMap::new(),
            public_shells: HashMap::new(),
            models: HashMap::new(),
            public_models: HashMap::new(),
            users: HashMap::new(),
        };
        let item = team_item(&team, &preloaded, &default_config);
        crate::json_contract_tests::assert_fixture(
            &format!("team_list_{}", team.share_status),
            &item,
        );
        assert_eq!(item["default_for_modes"], json!(["wework"]));
        assert_eq!(item["recommended_mode"], "chat");
        assert!(item.get("share_status").is_none());
        assert!(item.get("user").is_none());

        // Shared team reports share_status 2.
        team.share_status = 2;
        let item = team_item(&team, &preloaded, &default_config);
        crate::json_contract_tests::assert_fixture(
            &format!("team_list_{}", team.share_status),
            &item,
        );
        assert_eq!(item["share_status"], json!(2));
    }
    #[test]
    fn own_team_share_status_from_labels() {
        let team = TeamRow {
            team_id: 1,
            team_user_id: 5,
            team_name: "t".to_string(),
            team_namespace: "default".to_string(),
            team_json: stored_json(serde_json::json!({
                "metadata": {
                    "name": "t",
                    "labels": { "share_status": "1" },
                },
                "spec": { "members": [], "collaborationModel": "solo" },
            })),
            team_created_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
            team_updated_at: chrono::DateTime::from_timestamp(0, 0).unwrap().naive_utc(),
            share_status: 0,
            context_user_id: 5,
            access_source: "native".to_string(),
        };
        let preloaded = Preloaded {
            bots: HashMap::new(),
            group_bots: HashMap::new(),
            shells: HashMap::new(),
            public_shells: HashMap::new(),
            models: HashMap::new(),
            public_models: HashMap::new(),
            users: HashMap::new(),
        };
        let item = team_item(&team, &preloaded, &[]);
        crate::json_contract_tests::assert_fixture("team_list_own", &item);
        assert_eq!(item["share_status"], json!(1));
    }
    #[test]
    fn bot_summary_uses_public_model_fallback() {
        let bot = KindRow {
            kinds_id: 2,
            kinds_user_id: 0,
            kinds_name: "bot".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: stored_json(serde_json::json!({
                "spec": {
                    "shellRef": { "name": "Chat", "namespace": "default" },
                    "modelRef": { "name": "m1", "namespace": "default" },
                }
            })),
        };
        let mut public_models = HashMap::new();
        public_models.insert(
            "m1".to_string(),
            KindRow {
                kinds_id: 3,
                kinds_user_id: 0,
                kinds_name: "m1".to_string(),
                kinds_namespace: "default".to_string(),
                kinds_json: stored_json(serde_json::json!({
                    "spec": { "isCustomConfig": false }
                })),
            },
        );
        let mut public_shells = HashMap::new();
        public_shells.insert(
            "Chat".to_string(),
            KindRow {
                kinds_id: 4,
                kinds_user_id: 0,
                kinds_name: "Chat".to_string(),
                kinds_namespace: "default".to_string(),
                kinds_json: stored_json(serde_json::json!({
                    "spec": { "shellType": "Chat" }
                })),
            },
        );
        let preloaded = Preloaded {
            bots: HashMap::new(),
            group_bots: HashMap::new(),
            shells: HashMap::new(),
            public_shells,
            models: HashMap::new(),
            public_models,
            users: HashMap::new(),
        };
        let summary = bot_summary(&bot, 229, &preloaded);
        assert_eq!(summary["shell_type"], "Chat");
        assert_eq!(summary["agent_config"]["bind_model"], "m1");
        assert_eq!(summary["agent_config"]["bind_model_type"], "public");
    }

    #[test]
    fn bot_summary_preserves_custom_model_config() {
        let bot = KindRow {
            kinds_id: 2,
            kinds_user_id: 229,
            kinds_name: "bot".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: stored_json(serde_json::json!({
                "spec": { "modelRef": { "name": "m1", "namespace": "default" } }
            })),
        };
        let mut models = HashMap::new();
        models.insert(
            (229, "m1".to_string(), "default".to_string()),
            KindRow {
                kinds_id: 3,
                kinds_user_id: 229,
                kinds_name: "m1".to_string(),
                kinds_namespace: "default".to_string(),
                kinds_json: stored_json(serde_json::json!({
                    "spec": {
                        "isCustomConfig": true,
                        "modelConfig": {
                            "base_url": "https://models.example.invalid",
                            "retries": 2,
                            "headers": { "x-client": "wegent" }
                        },
                        "protocol": "openai"
                    }
                })),
            },
        );
        let preloaded = Preloaded {
            bots: HashMap::new(),
            group_bots: HashMap::new(),
            shells: HashMap::new(),
            public_shells: HashMap::new(),
            models,
            public_models: HashMap::new(),
            users: HashMap::new(),
        };

        let summary = bot_summary(&bot, 229, &preloaded);
        assert_eq!(
            summary["agent_config"],
            json!({
                "base_url": "https://models.example.invalid",
                "retries": 2,
                "headers": { "x-client": "wegent" },
                "protocol": "openai"
            })
        );
    }

    #[test]
    fn preload_public_shell_names_cover_cache_misses() {
        // Ensures the shell fallback ordering: user shells first, then
        // public shells by name for anything missing.
        let mut shells = HashMap::new();
        shells.insert(
            (229, "ClaudeCode".to_string(), "default".to_string()),
            KindRow {
                kinds_id: 10,
                kinds_user_id: 229,
                kinds_name: "ClaudeCode".to_string(),
                kinds_namespace: "default".to_string(),
                kinds_json: stored_json(
                    serde_json::json!({ "spec": { "shellType": "ClaudeCode" } }),
                ),
            },
        );
        let shell_refs = [
            (229, "ClaudeCode".to_string(), "default".to_string()),
            (0, "Chat".to_string(), "default".to_string()),
        ];
        let names: Vec<String> = shell_refs
            .iter()
            .filter(|(uid, name, ns)| !shells.contains_key(&(*uid, name.clone(), ns.clone())))
            .map(|(_, name, _)| name.clone())
            .collect();
        assert_eq!(names, vec!["Chat".to_string()]);
    }
    #[test]
    fn distinct_shell_types_drive_mix_flag() {
        let types: HashSet<String> = ["Chat", "ClaudeCode"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(types.len() > 1);
        let single: HashSet<String> = ["Chat"].iter().map(|s| s.to_string()).collect();
        assert!(single.len() == 1);
    }
}
