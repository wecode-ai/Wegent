// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/recent-teams` (source
//! `app.api.endpoints.users.get_user_recent_teams`): five recently used teams
//! for code or non-code tasks
//! (`team_kinds_service.get_recent_accessible_teams`).
use std::collections::{HashMap, HashSet};

#[cfg(test)]
use serde_json::Value;

use super::super::group_membership::{
    ErpContext, accessible_authorization_namespaces, effective_roles, user_group_memberships,
};
use super::super::http_error::HttpError;
use super::super::teams_repository::{AccessibleTeamsQuery, latest_distinct_team_rows};
use super::repository as repo;
use crate::state::AppState;
use brz_json::OpaqueJson;

/// Default result size (`limit: int = 5`).
const LIMIT: usize = 5;
/// Recent-task scan window (`RECENT_TEAM_TASK_SCAN_LIMIT`).
const SCAN_LIMIT: i64 = 50;

/// One serialized `QuickAccessTeam`.
#[derive(serde::Serialize)]
struct RecentTeam {
    id: i64,
    name: String,
    display_name: Option<String>,
    is_system: bool,
    recommended_mode: &'static str,
    agent_type: Option<brz_json::RawJson>,
}

fn quick_access_team(id: i64, user_id: i64, name: &str, team_json: &OpaqueJson) -> RecentTeam {
    let team = team_json
        .project::<crate::crd::CrdDocument>()
        .unwrap_or_default();
    // `team.get("displayName") or team.get("display_name")`: the dict only
    // carries `displayName`, so an empty (or absent) value collapses to null.
    let display_name = team
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.display_name.as_ref())
        .and_then(brz_json::OpaqueJson::project::<String>)
        .filter(|display_name| !display_name.is_empty());
    let modes = team
        .spec
        .as_ref()
        .and_then(|spec| spec.bind_mode.as_ref())
        .and_then(brz_json::OpaqueJson::project::<Vec<Option<String>>>)
        .unwrap_or_default();
    let has_chat = modes.iter().any(|mode| mode.as_deref() == Some("chat"));
    let has_code = modes.iter().any(|mode| mode.as_deref() == Some("code"));
    let recommended_mode = if has_chat && has_code {
        "both"
    } else if has_code {
        "code"
    } else {
        "chat"
    };
    RecentTeam {
        id,
        // `str(team.get("name") or f"Team {team['id']}")`: an empty name falls
        // back to the id-derived label.
        name: if name.is_empty() {
            format!("Team {id}")
        } else {
            name.to_owned()
        },
        display_name,
        is_system: user_id == 0,
        recommended_mode,
        agent_type: None,
    }
}

/// GET /api/users/recent-teams: the recent-teams free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/users/recent-teams")]
async fn get_user_recent_teams(
    #[inject(state)] state: &AppState,
    #[auth] current_user: crate::teams::auth::TeamsUser,
    is_code: Option<bool>,
) -> Result<Vec<RecentTeam>, HttpError> {
    recent_teams(state, &current_user, is_code).await
}

/// Handler body for `GET /api/users/recent-teams`.
async fn recent_teams(
    state: &AppState,
    current_user: &crate::teams::auth::TeamsUser,
    is_code: Option<bool>,
) -> Result<Vec<RecentTeam>, HttpError> {
    let is_code = is_code.unwrap_or(false);
    recent_accessible_teams(state, current_user.users_id as i64, is_code).await
}

/// `get_recent_accessible_teams`: recent refs from the owner's recent
/// non-group-chat tasks, then the accessible-teams fallback for the remaining
/// slots.
async fn recent_accessible_teams(
    state: &AppState,
    user_id: i64,
    is_code: bool,
) -> Result<Vec<RecentTeam>, HttpError> {
    let internal = |error: brz_mysql::MysqlError| HttpError::internal(error.to_string());

    // `_get_recent_team_refs`: recent owner-only tasks projected to their
    // `taskType` label and `spec.teamRef`, filtered by taskType against
    // `is_code`, extracting `(name, namespace, user_id)` team refs in
    // first-seen order.
    let recent_refs = state
        .task_store
        .list_recent_task_team_refs(user_id, SCAN_LIMIT)
        .await
        .map_err(internal)?
        .iter()
        .map(repo::decode_recent_task_team_ref)
        .collect::<brz_mysql::MysqlResult<Vec<_>>>()
        .map_err(internal)?;
    let mut refs: Vec<repo::TeamRef> = Vec::new();
    let mut seen_refs: HashSet<repo::TeamRef> = HashSet::new();
    for row in &recent_refs {
        // `str(task.task_type or "chat")`: an absent or empty label is "chat".
        let task_type = row
            .task_type
            .as_ref()
            .and_then(|value| value.project::<String>())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "chat".to_owned());
        if (task_type == "code") != is_code {
            continue;
        }
        // `isinstance(team_ref, dict)`: a non-object extract is skipped.
        let Some(team_ref) = row
            .team_ref
            .as_ref()
            .and_then(|value| value.project::<crate::crd::ResourceReference>())
        else {
            continue;
        };
        let name = team_ref.name();
        if name.is_empty() {
            continue;
        }
        let namespace = team_ref.namespace();
        let owner_id = team_ref.user_id.as_ref().and_then(|id| id.integer());
        let reference = repo::TeamRef {
            name: name.to_string(),
            namespace: namespace.to_string(),
            owner_id,
        };
        if seen_refs.insert(reference.clone()) {
            refs.push(reference);
        }
    }

    // `_query_recent_team_kinds`: active Teams matching the refs; keep the
    // ref order, one team per (name, namespace) identity.
    let kind_rows = if refs.is_empty() {
        Vec::new()
    } else {
        repo::query_recent_team_kinds(&state.mysql, &refs)
            .await
            .map_err(internal)?
    };
    let mut exact_index: HashMap<(String, String, i64), &repo::RecentKindRow> = HashMap::new();
    let mut identity_index: HashMap<(String, String), Vec<&repo::RecentKindRow>> = HashMap::new();
    for row in &kind_rows {
        exact_index.insert(
            (
                row.kinds_name.clone(),
                row.kinds_namespace.clone(),
                row.kinds_user_id,
            ),
            row,
        );
        identity_index
            .entry((row.kinds_name.clone(), row.kinds_namespace.clone()))
            .or_default()
            .push(row);
    }
    let mut selected: Vec<repo::RecentKindRow> = Vec::new();
    let mut selected_ids: HashSet<i64> = HashSet::new();
    let mut selected_identities: Vec<(String, String)> = Vec::new();
    for reference in &refs {
        let identity = (reference.name.clone(), reference.namespace.clone());
        if selected_identities.contains(&identity) {
            continue;
        }
        let team = match reference.owner_id {
            Some(owner_id) => exact_index
                .get(&(
                    reference.name.clone(),
                    reference.namespace.clone(),
                    owner_id,
                ))
                .copied(),
            None => identity_index.get(&identity).and_then(|candidates| {
                candidates
                    .iter()
                    .find(|candidate| candidate.kinds_user_id == user_id)
                    .or_else(|| candidates.first())
                    .copied()
            }),
        };
        let Some(team) = team.filter(|team| !selected_ids.contains(&team.kinds_id)) else {
            continue;
        };
        selected_identities.push(identity);
        selected_ids.insert(team.kinds_id);
        selected.push(repo::RecentKindRow {
            kinds_id: team.kinds_id,
            kinds_user_id: team.kinds_user_id,
            kinds_name: team.kinds_name.clone(),
            kinds_namespace: team.kinds_namespace.clone(),
            kinds_json: team.kinds_json.clone(),
        });
        if selected.len() == LIMIT {
            break;
        }
    }

    // Fallback for the remaining slots: the deduplicated accessible-team
    // union with the already-selected identities excluded.
    let mut teams: Vec<RecentTeam> = selected
        .iter()
        .map(|team| {
            quick_access_team(
                team.kinds_id,
                team.kinds_user_id,
                &team.kinds_name,
                &team.kinds_json.0,
            )
        })
        .collect();
    if selected.len() < LIMIT {
        // `_build_accessible_teams_query(scope="all")` resolves group roles
        // first (`get_user_group_roles`), producing the recorded
        // membership-resolution dependency sequence.
        let erp = ErpContext {
            erp: state.erp.as_ref(),
            redis: state.redis.as_ref(),
        };
        let resolved = user_group_memberships(&state.mysql, &erp, user_id)
            .await
            .map_err(|error| HttpError::internal(error.to_string()))?;
        // `_build_accessible_teams_query(scope="all")`: namespaces_to_query
        // is ["default", *sorted(effective_roles)] and the group namespaces
        // drive both the group-branch IN list and the Reporter-eligible
        // authorized-namespace resolution
        // (`_get_accessible_authorization_namespace_ids`), whose id lookup
        // is part of the recorded dependency sequence.
        let group_namespaces: Vec<String> = {
            let mut names: Vec<String> =
                effective_roles(&resolved.memberships, &resolved.active_names)
                    .into_keys()
                    .collect();
            names.sort();
            names
        };
        let effective = effective_roles(&resolved.memberships, &group_namespaces);
        let accessible_namespaces =
            accessible_authorization_namespaces(&group_namespaces, &effective);
        let authorized_namespace_ids = super::super::teams_repository::namespace_ids_by_names(
            &state.mysql,
            &accessible_namespaces,
        )
        .await
        .map_err(internal)?;
        // `restricted_group_namespaces`: the group namespaces whose effective
        // role is exactly `RestrictedAnalyst`. Empty in the recorded flow, so
        // the union's `restricted_guest_access` label renders its
        // always-false `IN (NULL) AND (1 != 1)` form.
        let mut restricted_namespaces: Vec<String> = effective
            .iter()
            .filter(|(_, role)| role.as_str() == "RestrictedAnalyst")
            .map(|(name, _)| name.clone())
            .collect();
        restricted_namespaces.sort();
        // The fallback reuses the shared accessible-team union renderer
        // (`_build_accessible_teams_query(scope="all")` +
        // `_query_latest_distinct_team_rows`).
        let fallback_query = AccessibleTeamsQuery {
            user_id,
            scope: "all",
            group_namespaces: &group_namespaces,
            authorized_namespace_ids: &authorized_namespace_ids,
            restricted_namespaces: &restricted_namespaces,
            filters: &[],
            shared_only: false,
            skip: 0,
            limit: (LIMIT - selected.len()) as i64,
        };
        let fallback =
            latest_distinct_team_rows(&state.mysql, fallback_query, &selected_identities)
                .await
                .map_err(internal)?
                .unwrap_or_default();
        for row in fallback {
            teams.push(quick_access_team(
                row.team_id,
                row.team_user_id,
                &row.team_name,
                &row.team_json.0,
            ));
        }
    }

    Ok(teams)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn quick_access_team(id: i64, user_id: i64, name: &str, payload: &Value) -> Value {
        let payload = OpaqueJson::from(payload.clone());
        crate::json_contract_tests::serialized(super::quick_access_team(
            id, user_id, name, &payload,
        ))
        .unwrap()
    }
    #[test]
    fn team_legacy_json_baseline() {
        let output: Vec<_> = [json!({}), Value::Null, json!([]),
            json!({"metadata":{"displayName":null},"spec":{"recommended_mode":null,"bind_mode":[]},"agent_type":{}}),
            json!({"metadata":{"displayName":42},"spec":{"recommended_mode":[],"bind_mode":["code","chat"]},"agent_type":false}),
            json!({"metadata":{"displayName":""},"spec":{"recommended_mode":"","bind_mode":["code"]}})
        ].into_iter().map(|payload| quick_access_team(1, 0, "team", &payload)).collect();
        crate::json_contract_tests::assert_fixture("recent_teams", output);
    }

    #[test]
    fn quick_access_team_maps_bind_mode() {
        let team_json = json!({
            "metadata": {"displayName": "AI Video Editor"},
            "spec": {"bind_mode": ["chat"]},
        });
        let team = quick_access_team(273383, 0, "Video AI Editing Assistant", &team_json);
        assert_eq!(team["display_name"], "AI Video Editor");
        assert_eq!(team["is_system"], true);
        assert_eq!(team["recommended_mode"], "chat");
        assert_eq!(team["agent_type"], Value::Null);
    }

    #[test]
    fn quick_access_team_recommended_mode_combinations() {
        let both = json!({"spec": {"bind_mode": ["chat", "code"]}});
        assert_eq!(
            quick_access_team(1, 7, "t", &both)["recommended_mode"],
            "both"
        );
        let code = json!({"spec": {"bind_mode": ["code"]}});
        assert_eq!(
            quick_access_team(1, 7, "t", &code)["recommended_mode"],
            "code"
        );
        let none = json!({"spec": {}});
        assert_eq!(
            quick_access_team(1, 7, "t", &none)["recommended_mode"],
            "chat"
        );
        let missing_display = json!({"metadata": {}});
        assert_eq!(
            quick_access_team(1, 7, "t", &missing_display)["display_name"],
            Value::Null
        );
    }

    #[test]
    fn empty_display_name_and_name_use_source_fallbacks() {
        // `_quick_access_team_from_data`: an empty `displayName` collapses to
        // null, and an empty team name falls back to `Team {id}`.
        let payload = json!({"metadata": {"displayName": ""}, "spec": {"bind_mode": ["chat"]}});
        let team = quick_access_team(77, 0, "", &payload);
        assert_eq!(team["display_name"], Value::Null);
        assert_eq!(team["name"], "Team 77");
    }
}
