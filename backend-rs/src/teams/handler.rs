// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/teams` — the user's Team list with scope support
//! (`app.api.endpoints.adapter.teams.list_teams`).
//!
//! Mirrors the source pipeline: source-compatible JWT authentication,
//! accessible-team union query with deduplication and pagination, batched
//! preload of related bots/shells/models, response construction with
//! `default_for_modes` from environment configuration.
use std::collections::HashMap;

use serde::Deserialize;

use super::auth::get_current_user;
use super::group_membership::{
    ErpContext, effective_roles, has_permission, iter_user_groups_with_roles,
    user_group_memberships,
};
use super::http_error::HttpError;
use super::team_conversion::{TeamItem, preload_related, team_item};
use super::teams_repository as repo;
use crate::config::DefaultTeamsConfig;
use crate::state::AppState;

#[derive(serde::Serialize)]
struct TeamsResponse {
    total: i64,
    items: Vec<TeamItem>,
}

/// Parsed query parameters (`page`, `limit`, `scope`, `group_name`).
#[derive(Debug, Deserialize)]
pub struct ListTeamsQuery {
    pub page: Option<String>,
    pub limit: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    pub group_name: Option<String>,
}

/// Validated pagination and scope.
#[derive(Debug)]
struct ListTeamsParams {
    page: i64,
    limit: i64,
    scope: String,
    group_name: Option<String>,
}

impl ListTeamsQuery {
    /// Validate the FastAPI query contract: `page >= 1`,
    /// `1 <= limit <= 100`, `scope` in {personal, group, all}.
    fn validate(self) -> Result<ListTeamsParams, HttpError> {
        let page = match self.page.as_deref() {
            None => 1,
            Some(raw) => raw
                .parse::<i64>()
                .map_err(|_| HttpError::invalid_query_parameter())?,
        };
        let limit = match self.limit.as_deref() {
            None => 10,
            Some(raw) => raw
                .parse::<i64>()
                .map_err(|_| HttpError::invalid_query_parameter())?,
        };
        if page < 1 || !(1..=100).contains(&limit) {
            return Err(HttpError::invalid_query_parameter());
        }
        let scope = self.scope.unwrap_or_else(|| "all".to_string());
        if !matches!(scope.as_str(), "personal" | "group" | "all") {
            // The source raises ValueError -> 500 for an invalid scope.
            return Err(HttpError::internal("invalid scope"));
        }
        Ok(ListTeamsParams {
            page,
            limit,
            scope,
            group_name: self.group_name,
        })
    }
}

/// GET /api/teams: the teams free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/teams")]
async fn list_teams(
    #[inject(state)] state: &AppState,
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<ListTeamsQuery>,
) -> Result<TeamsResponse, super::http_error::HttpError> {
    teams_list(state, authorization, &query).await
}

/// Handler body for `GET /api/teams`.
async fn teams_list(
    state: &AppState,
    authorization: Option<&str>,
    query: &ListTeamsQuery,
) -> Result<TeamsResponse, HttpError> {
    let params = ListTeamsQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
        scope: query.scope.clone(),
        group_name: query.group_name.clone(),
    }
    .validate()?;

    let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
    let current_user = get_current_user(&state.auth, &state.mysql, &headers.view()).await?;

    list_user_teams(state, current_user.users_id as i64, &params).await
}

/// The source `list_teams` flow after authentication.
async fn list_user_teams(
    state: &AppState,
    user_id: i64,
    params: &ListTeamsParams,
) -> Result<TeamsResponse, HttpError> {
    let ListTeamsParams {
        page,
        limit,
        scope,
        group_name,
    } = params;
    let skip = (page - 1) * limit;

    // Resolve group namespaces by scope. `personal` queries only the default
    // namespace; `group` uses the requested group (or all the user's groups
    // when unnamed); `all` adds every group the user can access.
    let resolved = if scope == "personal" {
        None
    } else {
        let erp = ErpContext {
            erp: state.erp.as_ref(),
            redis: state.redis.as_ref(),
        };
        Some(
            user_group_memberships(&state.mysql, &erp, user_id)
                .await
                .map_err(|error| HttpError::internal(error.to_string()))?,
        )
    };
    // `get_user_group_roles` resolves effective roles for EVERY active
    // namespace name, so parent-group inheritance pulls in child namespaces
    // (e.g. membership in `kunkka` grants roles in `kunkka/sub`), and
    // `namespaces_to_query = ["default", *sorted(effective_roles)]`.
    let (memberships, active_names) = match resolved {
        Some(resolved) => (resolved.memberships, resolved.active_names),
        None => (Vec::new(), Vec::new()),
    };
    let (group_namespaces, effective) = match scope.as_str() {
        "personal" => (Vec::new(), HashMap::new()),
        "group" => {
            let names = match group_name {
                Some(name) => vec![name.clone()],
                None => {
                    let mut names: Vec<String> = effective_roles(&memberships, &active_names)
                        .into_keys()
                        .collect();
                    names.sort();
                    names
                }
            };
            let effective = effective_roles(&memberships, &names);
            (names, effective)
        }
        _ => {
            let mut names: Vec<String> = effective_roles(&memberships, &active_names)
                .into_keys()
                .collect();
            names.sort();
            let effective = effective_roles(&memberships, &names);
            (names, effective)
        }
    };

    // Namespace ids that can activate Team namespace grants
    // (`_get_accessible_authorization_namespace_ids`): group namespaces
    // where the effective role is at least Reporter.
    let accessible_namespaces: Vec<String> = group_namespaces
        .iter()
        .filter(|name| {
            effective
                .get(*name)
                .is_some_and(|role| has_permission(role, "Reporter"))
        })
        .cloned()
        .collect();
    let authorized_namespace_ids =
        repo::namespace_ids_by_names(&state.mysql, &accessible_namespaces)
            .await
            .map_err(|error| HttpError::internal(error.to_string()))?;

    // Main paginated query.
    let teams = repo::accessible_teams(
        &state.mysql,
        user_id,
        scope,
        &group_namespaces,
        &authorized_namespace_ids,
        skip,
        *limit,
    )
    .await
    .map_err(|error| HttpError::internal(error.to_string()))?;

    // Total: the page-1 short-circuit avoids the count query, matching the
    // source (`if page == 1 and len(items) < limit`).
    let total = if *page == 1 && (teams.len() as i64) < *limit {
        teams.len() as i64
    } else {
        // `count_user_teams` re-resolves namespaces from scratch: scope
        // `personal` counts only the default namespace; `group` uses the
        // requested `group_name` directly (`get_user_groups` is only called
        // when no group name is given); `all` calls `get_user_groups` (a
        // fresh `get_user_group_roles` pass with its own active-namespace
        // listing). `_get_accessible_authorization_namespace_ids` then runs
        // `get_effective_roles_in_groups` over the count's group namespaces
        // (another `iter_user_groups_with_roles` pass, without the
        // namespace-name query). Every pass re-issues the same dependency
        // chain — the source does not reuse the list-flow resolution.
        let count_erp = ErpContext {
            erp: state.erp.as_ref(),
            redis: state.redis.as_ref(),
        };
        let count_group_namespaces: Vec<String> = match scope.as_str() {
            "personal" => Vec::new(),
            "group" => match group_name {
                Some(name) => vec![name.clone()],
                None => {
                    let resolved = user_group_memberships(&state.mysql, &count_erp, user_id)
                        .await
                        .map_err(|error| HttpError::internal(error.to_string()))?;
                    let mut names: Vec<String> =
                        effective_roles(&resolved.memberships, &resolved.active_names)
                            .into_keys()
                            .collect();
                    names.sort();
                    names
                }
            },
            _ => {
                let resolved = user_group_memberships(&state.mysql, &count_erp, user_id)
                    .await
                    .map_err(|error| HttpError::internal(error.to_string()))?;
                let mut names: Vec<String> =
                    effective_roles(&resolved.memberships, &resolved.active_names)
                        .into_keys()
                        .collect();
                names.sort();
                names
            }
        };
        let count_accessible: Vec<String> = if count_group_namespaces.is_empty() {
            Vec::new()
        } else {
            let memberships = iter_user_groups_with_roles(&state.mysql, &count_erp, user_id)
                .await
                .map_err(|error| HttpError::internal(error.to_string()))?;
            let effective = effective_roles(&memberships, &count_group_namespaces);
            count_group_namespaces
                .iter()
                .filter(|name| {
                    effective
                        .get(*name)
                        .is_some_and(|role| has_permission(role, "Reporter"))
                })
                .cloned()
                .collect()
        };
        let authorized_namespace_ids =
            repo::namespace_ids_by_names(&state.mysql, &count_accessible)
                .await
                .map_err(|error| HttpError::internal(error.to_string()))?;
        repo::count_user_teams(
            &state.mysql,
            user_id,
            scope,
            &count_group_namespaces,
            &authorized_namespace_ids,
        )
        .await
        .map_err(|error| HttpError::internal(error.to_string()))?
    };

    // Batch preload related users, bots, shells, and models.
    let preloaded = preload_related(&state.mysql, &teams)
        .await
        .map_err(|error| HttpError::internal(error.to_string()))?;

    // Convert to response items.
    let default_config = DefaultTeamsConfig::from_env().parsed();
    let items: Vec<TeamItem> = teams
        .iter()
        .map(|team| team_item(team, &preloaded, &default_config))
        .collect();

    Ok(TeamsResponse { total, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;
    #[test]
    fn query_defaults_and_validation() {
        let query = ListTeamsQuery {
            page: None,
            limit: None,
            scope: None,
            group_name: None,
        };
        let params = query.validate().unwrap();
        assert_eq!((params.page, params.limit), (1, 10));
        assert_eq!(params.scope, "all");

        let bad = ListTeamsQuery {
            page: Some("x".into()),
            limit: None,
            scope: None,
            group_name: None,
        };
        assert_eq!(
            bad.validate().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let over = ListTeamsQuery {
            page: Some("1".into()),
            limit: Some("101".into()),
            scope: None,
            group_name: None,
        };
        assert!(over.validate().is_err());
    }
}
