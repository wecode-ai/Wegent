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
    ErpContext, accessible_authorization_namespaces, effective_roles, user_group_memberships,
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

/// Parsed query parameters (`page`, `limit`, `scope`, `group_name`,
/// `source_filter`, `mode`).
#[derive(Debug, Deserialize)]
pub struct ListTeamsQuery {
    pub page: Option<String>,
    pub limit: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    pub group_name: Option<String>,
    pub source_filter: Option<String>,
    pub mode: Option<String>,
}

/// Validated pagination, scope, and list filters.
#[derive(Debug)]
struct ListTeamsParams {
    page: i64,
    limit: i64,
    scope: String,
    group_name: Option<String>,
    filters: Vec<repo::TeamListFilter>,
    /// `shared_only` (`source_filter == "group"`).
    shared_only: bool,
}

impl ListTeamsQuery {
    /// Validate the FastAPI query contract: `page >= 1`,
    /// `1 <= limit <= 100`, `scope` in {personal, group, all}, and the
    /// `source_filter` / `mode` literals.
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
        let source_filter = validate_literal(
            "source_filter",
            self.source_filter,
            &["all", "mine", "personal", "group", "system"],
        )?;
        let mode = validate_literal(
            "mode",
            self.mode,
            &["all", "chat", "code", "task", "knowledge", "video", "image"],
        )?;
        // The endpoint derives `shared_only` from the source filter and
        // `filters` from `build_team_list_filters`.
        let shared_only = source_filter.as_deref() == Some("group");
        let filters = repo::TeamListFilter::for_query(source_filter.as_deref(), mode.as_deref());
        Ok(ListTeamsParams {
            page,
            limit,
            scope,
            group_name: self.group_name,
            filters,
            shared_only,
        })
    }
}

/// Reject a value outside the FastAPI `Literal` set with the same 422 status
/// the source returns for a query-parameter validation failure.
fn validate_literal(
    parameter: &str,
    value: Option<String>,
    allowed: &[&str],
) -> Result<Option<String>, HttpError> {
    match value {
        None => Ok(None),
        Some(value) if allowed.contains(&value.as_str()) => Ok(Some(value)),
        Some(_) => Err(HttpError::invalid_literal_parameter(parameter, allowed)),
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
        source_filter: query.source_filter.clone(),
        mode: query.mode.clone(),
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
        filters,
        shared_only,
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
    // (`_get_accessible_authorization_namespace_ids`): group namespaces where
    // the effective role grants team use (`TEAM_USE_ROLE`).
    let accessible_namespaces = accessible_authorization_namespaces(&group_namespaces, &effective);
    let authorized_namespace_ids =
        repo::namespace_ids_by_names(&state.mysql, &accessible_namespaces)
            .await
            .map_err(|error| HttpError::internal(error.to_string()))?;

    // `restricted_group_namespaces`: the group namespaces whose effective role
    // is exactly `RestrictedAnalyst`. The source builds a Python set; the IN
    // list order is not contractual, so sorting keeps the statement stable.
    let mut restricted_namespaces: Vec<String> = effective
        .iter()
        .filter(|(_, role)| role.as_str() == "RestrictedAnalyst")
        .map(|(name, _)| name.clone())
        .collect();
    restricted_namespaces.sort();

    let query = repo::AccessibleTeamsQuery {
        user_id,
        scope,
        group_namespaces: &group_namespaces,
        authorized_namespace_ids: &authorized_namespace_ids,
        restricted_namespaces: &restricted_namespaces,
        filters,
        shared_only: *shared_only,
        skip,
        limit: *limit,
    };

    // Main paginated query. `accessible_query is None` issues no SQL and
    // reports zero items and a zero total.
    let Some(teams) = repo::accessible_teams(&state.mysql, query)
        .await
        .map_err(|error| HttpError::internal(error.to_string()))?
    else {
        return Ok(TeamsResponse {
            total: 0,
            items: Vec::new(),
        });
    };

    // `get_user_teams_page` counts the SAME query object the page used, so the
    // count re-issues the union with `count(*)` and never re-resolves group
    // namespaces: `if len(items) < limit and (items or skip == 0)` is answered
    // from the page itself.
    let total = if (teams.len() as i64) < *limit && (!teams.is_empty() || skip == 0) {
        skip + teams.len() as i64
    } else {
        repo::team_count(&state.mysql, query)
            .await
            .map_err(|error| HttpError::internal(error.to_string()))?
            .unwrap_or(0)
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

    fn query() -> ListTeamsQuery {
        ListTeamsQuery {
            page: None,
            limit: None,
            scope: None,
            group_name: None,
            source_filter: None,
            mode: None,
        }
    }

    #[test]
    fn query_defaults_and_validation() {
        let params = query().validate().unwrap();
        assert_eq!((params.page, params.limit), (1, 10));
        assert_eq!(params.scope, "all");
        assert!(params.filters.is_empty());
        assert!(!params.shared_only);

        let bad = ListTeamsQuery {
            page: Some("x".into()),
            ..query()
        };
        assert_eq!(
            bad.validate().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );

        let over = ListTeamsQuery {
            page: Some("1".into()),
            limit: Some("101".into()),
            ..query()
        };
        assert!(over.validate().is_err());
    }

    #[test]
    fn source_filter_and_mode_build_the_list_filters() {
        let personal = ListTeamsQuery {
            source_filter: Some("personal".into()),
            ..query()
        }
        .validate()
        .unwrap();
        assert_eq!(
            personal.filters,
            vec![
                repo::TeamListFilter::OwnerUserId,
                repo::TeamListFilter::DefaultNamespace
            ]
        );
        assert!(!personal.shared_only);

        let system = ListTeamsQuery {
            source_filter: Some("system".into()),
            ..query()
        }
        .validate()
        .unwrap();
        assert_eq!(system.filters, vec![repo::TeamListFilter::SystemOwner]);

        // `source_filter=group` adds no predicate but restricts the ranked
        // query to shared or non-default teams.
        let group = ListTeamsQuery {
            source_filter: Some("group".into()),
            ..query()
        }
        .validate()
        .unwrap();
        assert!(group.filters.is_empty());
        assert!(group.shared_only);

        let mode = ListTeamsQuery {
            mode: Some("code".into()),
            ..query()
        }
        .validate()
        .unwrap();
        assert_eq!(
            mode.filters,
            vec![
                repo::TeamListFilter::HasBindMode,
                repo::TeamListFilter::BindModeLike("code".into())
            ]
        );

        let all_modes = ListTeamsQuery {
            mode: Some("all".into()),
            ..query()
        }
        .validate()
        .unwrap();
        assert_eq!(all_modes.filters, vec![repo::TeamListFilter::HasBindMode]);
    }

    #[test]
    fn literal_query_parameters_reject_unknown_values() {
        let bad_source = ListTeamsQuery {
            source_filter: Some("bogus".into()),
            ..query()
        };
        assert_eq!(
            bad_source.validate().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let bad_mode = ListTeamsQuery {
            mode: Some("bogus".into()),
            ..query()
        };
        assert_eq!(
            bad_mode.validate().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
}
