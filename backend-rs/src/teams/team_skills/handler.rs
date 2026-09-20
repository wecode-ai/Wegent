// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/teams/{team_id}/skills`
//! (`app.api.endpoints.adapter.teams.get_team_skills` ->
//! `team_kinds_service.get_team_skills`).
//!
//! Flow, in source order:
//! 1. `get_current_user` resolves the Bearer JWT to a `users` row.
//! 2. `kindReader.get_by_id(Team, team_id)` loads the Team through the
//!    public direct kinds reader.
//! 3. Access check: owner, public (`user_id == 0`), group membership
//!    (`get_user_groups`), or a direct `ResourceMember` share row.
//! 4. Walk `team.spec.members` -> `kindReader.get_by_name_and_namespace(Bot)`
//!    -> `bot.spec.ghostRef` -> `kindReader.get_by_name_and_namespace(Ghost)`,
//!    collecting `ghost.spec.skills` and `ghost.spec.preload_skills` into
//!    deduplicated sets.
//! 5. Response: `{team_id, team_namespace, skills: sorted, preload_skills:
//!    sorted}`.
use std::collections::HashSet;

use brz_mysql::Json;
use serde::Deserialize;
use serde::Serialize;

use super::super::auth::get_current_user;
use super::super::group_membership::{
    ErpContext, ResolvedMemberships, effective_roles, user_group_memberships,
};
use super::super::http_error::HttpError;
use super::repository as repo;
use super::repository::KindRow;
use crate::remote_workspace_tree::kinds::KindStore;
use crate::state::AppState;

/// `TeamSkillsResponse` (`app.schemas.team.TeamSkillsResponse`).
#[derive(Serialize)]
struct TeamSkillsResponse {
    team_id: i64,
    team_namespace: String,
    skills: Vec<String>,
    preload_skills: Vec<String>,
}

/// `BotTeamRef` (`app.schemas.kind.BotTeamRef`): the bot reference inside a
/// team member.
#[derive(Debug, Deserialize)]
struct BotTeamRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
}

fn default_namespace() -> String {
    "default".to_string()
}

/// `TeamMember` (`app.schemas.kind.TeamMember`): one entry in
/// `Team.spec.members`.
#[derive(Debug, Deserialize)]
struct TeamMember {
    #[serde(rename = "botRef")]
    bot_ref: BotTeamRef,
}

/// `TeamSpec` (`app.schemas.kind.TeamSpec`): only the `members` field is
/// consumed here.
#[derive(Debug, Deserialize, Default)]
struct TeamSpec {
    #[serde(default)]
    members: Vec<TeamMember>,
}

/// `GhostRef` (`app.schemas.kind.GhostRef`): the ghost reference inside a
/// bot spec.
#[derive(Debug, Deserialize)]
struct GhostRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
}

/// `BotSpec` (`app.schemas.kind.BotSpec`): only `ghostRef` is consumed.
#[derive(Debug, Deserialize)]
struct BotSpec {
    #[serde(rename = "ghostRef")]
    ghost_ref: GhostRef,
}

/// `GhostSpec` (`app.schemas.kind.GhostSpec`): `skills` and `preload_skills`.
#[derive(Debug, Deserialize, Default)]
struct GhostSpec {
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    preload_skills: Vec<String>,
}

/// GET /api/teams/{team_id}/skills: the team-skills free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/teams/:team_id/skills")]
async fn get_team_skills(
    #[inject(state)] state: &AppState,
    team_id: i64,
    #[header] authorization: Option<&str>,
) -> Result<TeamSkillsResponse, HttpError> {
    team_skills(state, team_id, authorization).await
}

/// Handler body for `GET /api/teams/{team_id}/skills`.
async fn team_skills(
    state: &AppState,
    team_id: i64,
    authorization: Option<&str>,
) -> Result<TeamSkillsResponse, HttpError> {
    let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
    let current_user = get_current_user(&state.auth, &state.mysql, &headers.view()).await?;
    let user_id = i64::from(current_user.users_id);

    let kinds: KindStore<'_, brz_mysql::MysqlService, brz_redis::RedisService> = KindStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
    };

    // `kindReader.get_by_id(Team, team_id)`: direct public kinds query.
    let team = kinds
        .get_by_id("Team", team_id)
        .await
        .map_err(|error| HttpError::internal(format!("{error:?}")))?
        .ok_or_else(|| HttpError::not_found("Team not found"))?;

    // Access check: owner, public, group membership, or direct share.
    check_team_access(state, &team, user_id).await?;

    // Walk team -> bots -> ghosts -> skills.
    let team_owner_id = team.user_id;
    let team_namespace = if team.namespace.is_empty() {
        "default".to_string()
    } else {
        team.namespace.clone()
    };
    let bot_refs = team_bot_refs(&team);
    let bots = batch_load_kinds(&kinds, team_owner_id, "Bot", &bot_refs).await?;

    let ghost_refs = bot_ghost_refs(&bots);
    let ghosts = batch_load_kinds(&kinds, team_owner_id, "Ghost", &ghost_refs).await?;

    let mut skills: HashSet<String> = HashSet::new();
    let mut preload_skills: HashSet<String> = HashSet::new();
    for ghost in &ghosts {
        let spec: GhostSpec = serde_json::from_value(
            ghost
                .kinds_json
                .0
                .pointer("/spec")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .unwrap_or_default();
        for name in &spec.skills {
            skills.insert(name.clone());
        }
        for name in &spec.preload_skills {
            preload_skills.insert(name.clone());
        }
    }

    let mut skills: Vec<String> = skills.into_iter().collect();
    skills.sort();
    let mut preload_skills: Vec<String> = preload_skills.into_iter().collect();
    preload_skills.sort();

    Ok(TeamSkillsResponse {
        team_id,
        team_namespace,
        skills,
        preload_skills,
    })
}

/// `kindReader.get_by_name_and_namespace` for the Bot/Ghost chain: default
/// namespace uses personal -> public fallback; non-default uses group. The
/// source calls the reader once per member; the public implementation keeps
/// the same lookup order with direct SQL.
async fn batch_load_kinds(
    kinds: &KindStore<'_, brz_mysql::MysqlService, impl brz_redis::Redis>,
    user_id: i64,
    kind: &str,
    refs: &[(String, String)],
) -> Result<Vec<KindRow>, HttpError> {
    if refs.is_empty() {
        return Ok(Vec::new());
    }
    let mut loaded: Vec<KindRow> = Vec::new();
    let mut default_refs: Vec<(String, String)> = Vec::new();
    let mut group_refs: Vec<(String, String)> = Vec::new();
    for (namespace, name) in refs {
        if namespace == "default" {
            if !default_refs.contains(&(namespace.clone(), name.clone())) {
                default_refs.push((namespace.clone(), name.clone()));
            }
        } else if !group_refs.contains(&(namespace.clone(), name.clone())) {
            group_refs.push((namespace.clone(), name.clone()));
        }
    }

    // Default namespace: personal -> public fallback (like
    // `get_by_name_and_namespace` for non-Team kinds).
    if !default_refs.is_empty() && user_id != 0 {
        loaded.extend(
            repo::kinds_by_names(kinds.mysql, user_id, kind, &default_refs)
                .await
                .map_err(|error| HttpError::internal(format!("{error:?}")))?,
        );
    }
    let resolved: HashSet<(String, String)> = loaded
        .iter()
        .map(|row| (row.kinds_namespace.clone(), row.kinds_name.clone()))
        .collect();
    let missing: Vec<(String, String)> = default_refs
        .into_iter()
        .filter(|r| !resolved.contains(r))
        .collect();
    if !missing.is_empty() {
        // Public fallback uses the direct public kinds query.
        for (namespace, name) in &missing {
            if let Some(row) = kinds
                .get_public(kind, namespace, name)
                .await
                .map_err(|error| HttpError::internal(format!("{error:?}")))?
            {
                loaded.push(kind_record_to_row(&row));
            }
        }
    }

    // Group namespace: `get_group` through the direct public kinds query.
    for (namespace, name) in &group_refs {
        if let Some(row) = kinds
            .get_group(kind, namespace, name)
            .await
            .map_err(|error| HttpError::internal(format!("{error:?}")))?
        {
            loaded.push(kind_record_to_row(&row));
        }
    }

    Ok(loaded)
}

/// Convert a `KindRecord` from the remote-workspace-tree cache to the
/// team-skills `KindRow` shape.
fn kind_record_to_row(record: &crate::remote_workspace_tree::kinds::KindRecord) -> KindRow {
    KindRow {
        kinds_id: record.id,
        kinds_user_id: record.user_id,
        kinds_kind: record.kind.clone(),
        kinds_name: record.name.clone(),
        kinds_namespace: record.namespace.clone(),
        kinds_json: Json(record.json.0.clone()),
        kinds_is_active: record.is_active,
        kinds_created_at: record.created_at,
        kinds_updated_at: record.updated_at,
    }
}

/// Extract `(namespace, name)` bot refs from the team's spec.members list.
fn team_bot_refs(
    team_json: &crate::remote_workspace_tree::kinds::KindRecord,
) -> Vec<(String, String)> {
    let spec: TeamSpec = serde_json::from_value(
        team_json
            .json
            .0
            .get("spec")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .unwrap_or_default();
    spec.members
        .into_iter()
        .filter(|member| !member.bot_ref.name.is_empty())
        .map(|member| (member.bot_ref.namespace, member.bot_ref.name))
        .collect()
}

/// Extract `(namespace, name)` ghost refs from the loaded bots' spec.ghostRef.
fn bot_ghost_refs(bots: &[KindRow]) -> Vec<(String, String)> {
    let mut refs: Vec<(String, String)> = Vec::new();
    for bot in bots {
        let spec: Option<BotSpec> = serde_json::from_value(
            bot.kinds_json
                .0
                .get("spec")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .ok();
        if let Some(spec) = spec
            && !spec.ghost_ref.name.is_empty()
        {
            let entry = (spec.ghost_ref.namespace, spec.ghost_ref.name);
            if !refs.contains(&entry) {
                refs.push(entry);
            }
        }
    }
    refs
}

/// `get_team_skills` access check: owner, public, group membership, or direct
/// share. Raises `403 "Access denied to this team"` on failure.
async fn check_team_access(
    state: &AppState,
    team: &crate::remote_workspace_tree::kinds::KindRecord,
    user_id: i64,
) -> Result<(), HttpError> {
    let is_public_team = team.user_id == 0;
    let is_author = team.user_id == user_id;
    let is_group_team = team.namespace != "default" && team.namespace != "system";

    if is_author || is_public_team {
        return Ok(());
    }

    if is_group_team {
        // `get_user_groups(db, user_id)` — the source's
        // `group_permission.get_user_groups` resolves the user's effective
        // group namespaces.
        let erp = ErpContext {
            erp: state.erp.as_ref(),
            redis: state.redis.as_ref(),
        };
        let resolved: ResolvedMemberships = user_group_memberships(&state.mysql, &erp, user_id)
            .await
            .map_err(|error| HttpError::internal(format!("{error:?}")))?;
        let group_names: Vec<String> =
            effective_roles(&resolved.memberships, &resolved.active_names)
                .into_keys()
                .collect();
        if group_names.contains(&team.namespace) {
            return Ok(());
        }
    }

    // Direct share: `ResourceMember` row for this team + user.
    let shared = repo::shared_team_member(&state.mysql, team.id, user_id)
        .await
        .map_err(|error| HttpError::internal(format!("{error:?}")))?;
    if shared {
        return Ok(());
    }

    Err(HttpError::forbidden("Access denied to this team"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_workspace_tree::kinds::KindRecord;
    use brz_mysql::Json;
    use serde_json::json;

    fn record(json: serde_json::Value) -> KindRecord {
        KindRecord {
            id: 0,
            user_id: 0,
            kind: "Team".to_string(),
            name: String::new(),
            namespace: "default".to_string(),
            json: Json(json),
            is_active: 1,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn team_bot_refs_extracts_members() {
        let team = record(json!({
            "spec": {
                "members": [
                    {"botRef": {"name": "wegent-chat", "namespace": "default"}},
                    {"botRef": {"name": "example-bot", "namespace": "example"}}
                ]
            }
        }));
        let refs = team_bot_refs(&team);
        assert_eq!(
            refs,
            vec![
                ("default".to_string(), "wegent-chat".to_string()),
                ("example".to_string(), "example-bot".to_string())
            ]
        );
    }

    #[test]
    fn team_bot_refs_skips_empty_names() {
        let team = record(json!({
            "spec": {
                "members": [
                    {"botRef": {"name": "", "namespace": "default"}},
                    {"botRef": {"name": "bot", "namespace": "default"}}
                ]
            }
        }));
        let refs = team_bot_refs(&team);
        assert_eq!(refs, vec![("default".to_string(), "bot".to_string())]);
    }

    #[test]
    fn team_bot_refs_missing_spec_returns_empty() {
        let team = record(json!({}));
        assert!(team_bot_refs(&team).is_empty());
    }

    #[test]
    fn bot_ghost_refs_dedupes() {
        let bots = vec![KindRow {
            kinds_id: 1,
            kinds_user_id: 0,
            kinds_kind: "Bot".to_string(),
            kinds_name: "bot".to_string(),
            kinds_namespace: "default".to_string(),
            kinds_json: Json(json!({
                "spec": {"ghostRef": {"name": "ghost", "namespace": "default"}}
            })),
            kinds_is_active: 1,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        }];
        let refs = bot_ghost_refs(&bots);
        assert_eq!(refs, vec![("default".to_string(), "ghost".to_string())]);
    }
}
