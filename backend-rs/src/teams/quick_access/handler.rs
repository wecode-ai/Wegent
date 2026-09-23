// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/users/quick-access`
//! (source `app.api.endpoints.users.get_user_quick_access`).
//!
//! Flow, in source order:
//! 1. `get_current_user` resolves the Bearer JWT to a `users` row.
//! 2. `system_configs` row `quick_access_recommended` provides
//!    `system_version` and `system_team_ids`.
//! 3. The user's `preferences.quick_access` provides `user_version` and the
//!    saved favorite `teams` order.
//! 4. `kind_service.get_team_by_id` resolves each team id (favorites first
//!    with `is_system = team_id in system_team_ids`, then unseen system ids
//!    with `is_system = true`); missing teams are skipped.
use crate::json_compat::OptionalOpaqueJsonExt;
use std::collections::HashSet;

use crate::crd::CrdDocument;
use crate::json_compat::{JsonProjection, OpaqueJson, raw_null};
#[cfg(test)]
use serde_json::Value;
use serde_json::value::RawValue;

use super::super::auth::TeamsUser;
use super::super::http_error::HttpError;
use super::repository as repo;
use crate::state::AppState;

// The users auth projection keeps `users.preferences` as a string, so this
// typed projection decodes the nested quick-access document here.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct QuickAccessConfig {
    version: Option<i64>,
    teams: Option<Vec<Option<i64>>>,
}

#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct UserPreferences {
    quick_access: Option<QuickAccessConfig>,
}

fn quick_access_config(preferences: Option<&str>) -> QuickAccessConfig {
    preferences
        .and_then(|raw| serde_json::from_str::<JsonProjection<UserPreferences>>(raw).ok())
        .and_then(|projection| projection.value)
        .and_then(|preferences| preferences.quick_access)
        .unwrap_or_default()
}

fn team_ids(field: Option<Vec<Option<i64>>>) -> Vec<i64> {
    field.unwrap_or_default().into_iter().flatten().collect()
}

/// One serialized `QuickAccessTeam` (`get_team_info`): the team's stored JSON
/// drives `display_name`, `recommended_mode`, and `agent_type`, while the
/// caller decides `is_system`.
#[derive(serde::Serialize)]
struct QuickAccessTeam {
    id: i64,
    name: String,
    display_name: Box<RawValue>,
    is_system: bool,
    recommended_mode: Box<RawValue>,
    agent_type: Box<RawValue>,
}

#[derive(serde::Serialize)]
struct QuickAccessResponse {
    system_version: i64,
    system_team_ids: Vec<i64>,
    user_version: Option<i64>,
    show_system_recommended: bool,
    teams: Vec<QuickAccessTeam>,
}

fn quick_access_team(
    id: i64,
    name: &str,
    team_json: &OpaqueJson,
    is_system: bool,
) -> QuickAccessTeam {
    let team = team_json.project::<CrdDocument>().unwrap_or_default();
    QuickAccessTeam {
        id,
        name: name.to_owned(),
        display_name: team
            .metadata
            .as_ref()
            .map(|metadata| metadata.display_name.raw_or(()))
            .unwrap_or_else(raw_null),
        is_system,
        recommended_mode: team
            .spec
            .as_ref()
            .map(|spec| spec.recommended_mode.raw_or("both"))
            .unwrap_or_else(|| serde_json::value::to_raw_value("both").unwrap()),
        agent_type: team.agent_type.raw_or(()),
    }
}

/// GET /api/users/quick-access: the quick-access free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/users/quick-access")]
async fn get_user_quick_access(
    #[inject(state)] state: &AppState,
    #[auth] current_user: TeamsUser,
) -> Result<QuickAccessResponse, HttpError> {
    quick_access(state, current_user).await
}

/// Handler body for `GET /api/users/quick-access`.
async fn quick_access(
    state: &AppState,
    current_user: TeamsUser,
) -> Result<QuickAccessResponse, HttpError> {
    quick_access_response(state, current_user.0.users_preferences.as_str()).await
}

/// Build the `QuickAccessResponse` body.
async fn quick_access_response(
    state: &AppState,
    preferences: &str,
) -> Result<QuickAccessResponse, HttpError> {
    let internal = |error: brz_mysql::MysqlError| HttpError::internal(error.to_string());

    // System config: `system_version` and `system_team_ids`.
    let system_config = repo::quick_access_system_config(&state.mysql)
        .await
        .map_err(internal)?;
    let (system_version, system_team_ids) = match &system_config {
        Some(config) => (
            config.system_configs_version,
            config
                .system_configs_config_value
                .0
                .project::<QuickAccessConfig>()
                .map(|config| team_ids(config.teams))
                .unwrap_or_default(),
        ),
        None => (0, Vec::new()),
    };

    // User preferences: `user_version` and the saved favorite team order.
    let config = quick_access_config(Some(preferences));
    let user_version = config.version;
    let user_team_ids = team_ids(config.teams);
    let show_system_recommended =
        user_version.is_none() || user_version.unwrap_or(0) < system_version;

    // Favorites in saved order, then unseen system ids.
    let system_team_id_set: HashSet<i64> = system_team_ids.iter().copied().collect();
    let mut seen_team_ids: HashSet<i64> = HashSet::new();
    let mut result_teams: Vec<QuickAccessTeam> = Vec::new();
    let mut append_team = |team: repo::TeamKindRow, is_system: bool| {
        result_teams.push(quick_access_team(
            team.kinds_id,
            &team.kinds_name,
            &team.kinds_json.0,
            is_system,
        ));
    };
    for team_id in user_team_ids.iter().chain(system_team_ids.iter()) {
        if !seen_team_ids.insert(*team_id) {
            continue;
        }
        // Favorites keep `is_system = team_id in system_team_ids`; the
        // system pass always passes `true`, but any id already seen in the
        // favorites pass is skipped above.
        let is_system = system_team_id_set.contains(team_id);
        let team = repo::team_kind_by_id(&state.mysql, *team_id)
            .await
            .map_err(internal)?;
        if let Some(team) = team {
            append_team(team, is_system);
        }
    }

    Ok(QuickAccessResponse {
        system_version,
        system_team_ids,
        user_version,
        show_system_recommended,
        teams: result_teams,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn quick_access_team(id: i64, name: &str, payload: &Value, is_system: bool) -> Value {
        let payload = OpaqueJson::from(payload.clone());
        crate::json_contract_tests::serialized(super::quick_access_team(
            id, name, &payload, is_system,
        ))
        .unwrap()
    }
    fn team_json() -> Value {
        json!({
            "metadata": {"name": "wegent-chat", "displayName": "Wegent Assistant"},
            "spec": {"recommended_mode": "both"},
            "agent_type": null,
        })
    }

    #[test]
    fn preferences_decode_nested_quick_access() {
        let preferences = json!({
            "company_profile": {"name": "Bob"},
            "quick_access": {"version": 1, "teams": [110467, 110600]}
        })
        .to_string();
        let config = quick_access_config(Some(&preferences));
        assert_eq!(config.version, Some(1));
        assert_eq!(team_ids(config.teams), vec![110467, 110600]);
    }

    #[test]
    fn preferences_fallback_to_empty() {
        assert!(quick_access_config(Some("not json")).version.is_none());
        assert!(quick_access_config(None).version.is_none());
        let preferences = json!({"quick_access": "not an object"}).to_string();
        assert!(quick_access_config(Some(&preferences)).version.is_none());
        let preferences = json!({"company_profile": {}}).to_string();
        assert!(quick_access_config(Some(&preferences)).version.is_none());
    }

    #[test]
    fn quick_access_team_maps_stored_json() {
        let team = quick_access_team(110467, "wegent-chat", &team_json(), true);
        assert_eq!(team["display_name"], "Wegent Assistant");
        assert_eq!(team["is_system"], true);
        assert_eq!(team["recommended_mode"], "both");
        assert_eq!(team["agent_type"], Value::Null);
    }

    #[test]
    fn quick_access_team_defaults() {
        let team = quick_access_team(7, "t", &json!({}), false);
        assert_eq!(team["display_name"], Value::Null);
        assert_eq!(team["is_system"], false);
        assert_eq!(team["recommended_mode"], "both");
        assert_eq!(team["agent_type"], Value::Null);
    }
}
