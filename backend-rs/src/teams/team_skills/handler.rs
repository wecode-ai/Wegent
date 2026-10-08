// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/teams/{team_id}/skills`
//! (`app.api.endpoints.adapter.teams.get_team_skills` ->
//! `team_kinds_service.get_team_skills`).
//!
//! Flow, in source order:
//! 1. `get_current_user` resolves the Bearer JWT to a `users` row.
//! 2. `team_share_service.get_resource_for_use` -> `_get_resource` loads the
//!    Team with a direct `db.query(Kind)` by id — it does not go through the
//!    cached kind reader — and enforces access: owner, public
//!    (`user_id == 0`), group membership, or a direct `ResourceMember` share.
//! 3. Walk `team.spec.members`: `kindReader.get_by_name_and_namespace(Bot)`
//!    with the team owner's id (personal -> public fallback for `default`,
//!    group otherwise), then `bot.spec.ghostRef` ->
//!    `kindReader.get_by_name_and_namespace(Ghost)`, collecting
//!    `ghost.spec.skills` and `ghost.spec.preload_skills` into deduplicated
//!    sets.
//! 4. Response: `{team_id, team_namespace, skills: sorted, preload_skills:
//!    sorted}`.
use std::collections::HashSet;

use serde::Deserialize;
use serde::Serialize;

use super::super::group_membership::{
    ErpContext, ResolvedMemberships, effective_roles, user_group_memberships,
};
use super::super::http_error::HttpError;
use super::repository as repo;
use super::repository::KindRow;
use crate::remote_workspace_tree::kinds::{KindRecord, KindStore};
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

/// `GhostRef` (`app.schemas.kind.GhostRef`): the ghost reference inside a
/// bot spec.
#[derive(Debug, Deserialize)]
struct GhostRef {
    name: String,
    #[serde(default = "default_namespace")]
    namespace: String,
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
    #[auth] current_user: crate::teams::auth::TeamsUser,
) -> Result<TeamSkillsResponse, HttpError> {
    team_skills(state, team_id, &current_user).await
}

/// Handler body for `GET /api/teams/{team_id}/skills`.
async fn team_skills(
    state: &AppState,
    team_id: i64,
    current_user: &crate::teams::auth::TeamsUser,
) -> Result<TeamSkillsResponse, HttpError> {
    let user_id = i64::from(current_user.users_id);

    let kinds: KindStore<'_, brz_mysql::MysqlService, brz_redis::RedisService> = KindStore {
        mysql: &state.mysql,
        redis: state.redis.as_ref(),
    };

    // `team_share_service.get_resource_for_use` -> `_get_resource`: a direct
    // `db.query(Kind)` by id. The source does not route this lookup through
    // the cached kind reader, so the target must not read or write the
    // `kind:v2:` cache here either.
    let team = repo::team_by_id(kinds.mysql, team_id)
        .await
        .map_err(|error| HttpError::internal(format!("{error:?}")))?
        .ok_or_else(|| HttpError::not_found("Team not found"))?;

    // Access check: owner, public, group membership, or direct share.
    check_team_access(state, &team, user_id).await?;

    let team_owner_id = team.kinds_user_id;
    let team_namespace = if team.kinds_namespace.is_empty() {
        "default".to_string()
    } else {
        team.kinds_namespace.clone()
    };

    // `for member in team_crd.spec.members`: bot then ghost, per member, with
    // the cached reader so the personal/public index and data documents are
    // read exactly as the source does.
    let mut skills: HashSet<String> = HashSet::new();
    let mut preload_skills: HashSet<String> = HashSet::new();
    for member in team_spec_members(&team) {
        let bot = kinds
            .get_by_name_and_namespace(
                team_owner_id,
                "Bot",
                &member.bot_ref.namespace,
                &member.bot_ref.name,
            )
            .await
            .map_err(|error| HttpError::internal(format!("{error:?}")))?;
        let Some(bot) = bot else {
            continue;
        };

        let Some(ghost_ref) = bot_ghost_ref(&bot) else {
            continue;
        };
        let ghost = kinds
            .get_by_name_and_namespace(
                team_owner_id,
                "Ghost",
                &ghost_ref.namespace,
                &ghost_ref.name,
            )
            .await
            .map_err(|error| HttpError::internal(format!("{error:?}")))?;
        let Some(ghost) = ghost else {
            continue;
        };

        let spec: GhostSpec = serde_json::from_value(
            ghost
                .json
                .0
                .get("spec")
                .cloned()
                .unwrap_or_else(|| serde_json::json!({})),
        )
        .unwrap_or_default();
        for name in spec.skills {
            skills.insert(name);
        }
        for name in spec.preload_skills {
            preload_skills.insert(name);
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

/// `Team.spec.members` from the loaded Team CRD document. The source reads
/// `team_crd.spec.members or []`; a member without a `botRef` is not produced
/// by the typed source model, so a malformed list yields no members.
fn team_spec_members(team: &KindRow) -> Vec<TeamMember> {
    serde_json::from_value(
        team.kinds_json
            .0
            .get("spec")
            .and_then(|spec| spec.get("members"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!([])),
    )
    .unwrap_or_default()
}

/// `bot_crd.spec.ghostRef` from the loaded Bot CRD document.
fn bot_ghost_ref(bot: &KindRecord) -> Option<GhostRef> {
    serde_json::from_value(
        bot.json
            .0
            .get("spec")
            .and_then(|spec| spec.get("ghostRef"))
            .cloned()
            .unwrap_or_else(|| serde_json::json!({})),
    )
    .ok()
}

/// `get_team_skills` access check: owner, public, group membership, or direct
/// share. Raises `403 "Access denied to this team"` on failure.
async fn check_team_access(
    state: &AppState,
    team: &KindRow,
    user_id: i64,
) -> Result<(), HttpError> {
    let is_public_team = team.kinds_user_id == 0;
    let is_author = team.kinds_user_id == user_id;
    let is_group_team = team.kinds_namespace != "default" && team.kinds_namespace != "system";

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
        if group_names.contains(&team.kinds_namespace) {
            return Ok(());
        }
    }

    // Direct share: `ResourceMember` row for this team + user.
    let shared = repo::shared_team_member(&state.mysql, team.kinds_id, user_id)
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
    use brz_mysql::Json;
    use serde_json::json;

    fn team_row(json: serde_json::Value) -> KindRow {
        KindRow {
            kinds_id: 0,
            kinds_user_id: 0,
            kinds_kind: "Team".to_string(),
            kinds_name: String::new(),
            kinds_namespace: "default".to_string(),
            kinds_json: Json(json),
            kinds_is_active: 1,
            kinds_created_at: chrono::NaiveDateTime::default(),
            kinds_updated_at: chrono::NaiveDateTime::default(),
        }
    }

    fn bot_record(json: serde_json::Value) -> KindRecord {
        KindRecord {
            id: 0,
            user_id: 0,
            kind: "Bot".to_string(),
            name: String::new(),
            namespace: "default".to_string(),
            json: Json(json),
            is_active: 1,
            created_at: chrono::NaiveDateTime::default(),
            updated_at: chrono::NaiveDateTime::default(),
        }
    }

    #[test]
    fn team_spec_members_extracts_bot_refs() {
        let team = team_row(json!({
            "spec": {
                "members": [
                    {"botRef": {"name": "wegent-chat", "namespace": "default"}},
                    {"botRef": {"name": "example-bot", "namespace": "example"}}
                ]
            }
        }));
        let refs: Vec<(String, String)> = team_spec_members(&team)
            .into_iter()
            .map(|member| (member.bot_ref.namespace, member.bot_ref.name))
            .collect();
        assert_eq!(
            refs,
            vec![
                ("default".to_string(), "wegent-chat".to_string()),
                ("example".to_string(), "example-bot".to_string())
            ]
        );
    }

    #[test]
    fn team_spec_members_missing_spec_returns_empty() {
        let team = team_row(json!({}));
        assert!(team_spec_members(&team).is_empty());
    }

    #[test]
    fn bot_ghost_ref_reads_spec_ghost_ref() {
        let bot = bot_record(json!({
            "spec": {"ghostRef": {"name": "ghost", "namespace": "default"}}
        }));
        let ghost_ref = bot_ghost_ref(&bot).expect("ghostRef present");
        assert_eq!(
            (ghost_ref.namespace, ghost_ref.name),
            ("default".to_string(), "ghost".to_string())
        );
    }

    #[test]
    fn bot_ghost_ref_missing_spec_is_none() {
        let bot = bot_record(json!({}));
        assert!(bot_ghost_ref(&bot).is_none());
    }
}
