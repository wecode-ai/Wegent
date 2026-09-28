// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/default-teams` — default team configuration per mode.
//!
//! Mirrors `app.api.endpoints.users.get_default_teams`: system-level
//! configuration read from the `DEFAULT_TEAM_{MODE}` environment
//! variables (`name#namespace` format), requiring authentication but
//! performing no database access of its own beyond `get_current_user`.
use serde::Serialize;

use crate::config::DefaultTeamsConfig;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::users_search::UsersSearchUser;

/// `parse_default_team_config` — parse `name#namespace` into a JSON value.
fn parse_default_team_config(value: &str) -> Option<DefaultTeam> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let (name, namespace) = match value.split_once('#') {
        Some((name, namespace)) => (name.trim(), namespace.trim()),
        None => (value, "default"),
    };
    if name.is_empty() {
        return None;
    }
    Some(DefaultTeam {
        name: name.to_owned(),
        namespace: namespace.to_owned(),
    })
}

/// GET /api/users/default-teams: the default-teams free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/users/default-teams")]
async fn get_default_teams(
    #[inject(state)] state: &AppState,
    #[auth] _current_user: UsersSearchUser,
) -> Result<DefaultTeamsResponse, FastApiError> {
    default_teams(state).await
}

/// Handler body for `GET /api/users/default-teams`.
async fn default_teams(_state: &AppState) -> Result<DefaultTeamsResponse, FastApiError> {
    let config = DefaultTeamsConfig::from_env();
    Ok(default_teams_response(&config))
}

#[derive(Serialize)]
struct DefaultTeam {
    name: String,
    namespace: String,
}

#[derive(Serialize)]
struct DefaultTeamsResponse {
    wework: Option<DefaultTeam>,
    chat: Option<DefaultTeam>,
    code: Option<DefaultTeam>,
    knowledge: Option<DefaultTeam>,
    task: Option<DefaultTeam>,
}

fn default_teams_response(config: &DefaultTeamsConfig) -> DefaultTeamsResponse {
    let lookup = |mode: &str| {
        config
            .modes
            .iter()
            .find(|(key, _)| *key == mode)
            .and_then(|(_, value)| parse_default_team_config(value))
    };
    DefaultTeamsResponse {
        wework: lookup("wework"),
        chat: lookup("chat"),
        code: lookup("code"),
        knowledge: lookup("knowledge"),
        task: lookup("task"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_namespace_pairs() {
        let parsed = parse_default_team_config("wegent-chat#default").unwrap();
        assert_eq!(parsed.name, "wegent-chat");
        assert_eq!(parsed.namespace, "default");
    }

    #[test]
    fn missing_namespace_defaults_to_default() {
        let parsed = parse_default_team_config("wegent-chat").unwrap();
        assert_eq!(parsed.name, "wegent-chat");
        assert_eq!(parsed.namespace, "default");
    }

    #[test]
    fn empty_and_nameless_values_return_none() {
        assert!(parse_default_team_config("").is_none());
        assert!(parse_default_team_config("   ").is_none());
        assert!(parse_default_team_config("#ns").is_none());
        assert!(parse_default_team_config("   #ns  ").is_none());
    }

    #[test]
    fn values_are_trimmed() {
        let parsed = parse_default_team_config("  name  #  ns  ").unwrap();
        assert_eq!(parsed.name, "name");
        assert_eq!(parsed.namespace, "ns");
    }

    #[test]
    fn source_defaults_match_recorded_response() {
        let config = DefaultTeamsConfig::from_env();
        let parsed = config.parsed();
        let body = default_teams_response(&config);
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"wework\":{\"name\":\"wegent-wework\",\"namespace\":\"default\"},\
             \"chat\":{\"name\":\"wegent-chat\",\"namespace\":\"default\"},\
             \"code\":null,\
             \"knowledge\":{\"name\":\"wegent-notebook\",\"namespace\":\"default\"},\
             \"task\":{\"name\":\"wegent-wework\",\"namespace\":\"default\"}}"
        );
        assert_eq!(parsed.len(), 4); // code is empty by default
    }
}
