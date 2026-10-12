// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/bots` handler: query validation, scope-driven namespace
//! resolution, the paginated Bot lookup with a batched Ghost/Shell/Model
//! preload, and response assembly
//! (`app/api/endpoints/adapter/bots.py::list_bots`).
use std::collections::HashMap;

use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, effective_roles, user_group_memberships};
use crate::teams::public_model_access::allowed_public_models;
use crate::teams::teams_repository::KindRow;

use super::conversion::{BotItem, RefKey, bot_item, bot_keys, bot_spec, resolve};
use super::repository::{self as repo, BotRow};

/// The `BotListResponse` body.
#[derive(Debug, Serialize)]
pub struct BotsResponse {
    pub total: i64,
    pub items: Vec<BotItem>,
}

/// Query parameters for `GET /api/bots` (`page`, `limit`, `scope`,
/// `group_name`). Defaults mirror `Query(...)`; values are parsed as strings so
/// a FastAPI-invalid literal renders the 422 body instead of a 500.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
pub struct ListBotsQuery {
    pub page: Option<String>,
    pub limit: Option<String>,
    pub scope: Option<String>,
    pub group_name: Option<String>,
}

/// One FastAPI 422 validation entry (`{type, loc, msg, input}`).
#[derive(Debug, Serialize)]
struct QueryValidationError<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    loc: [&'a str; 2],
    msg: &'a str,
    input: &'a str,
}

/// FastAPI-style 422 validation body for one query parameter.
fn validation_error(field: &str, kind: &str, message: &str, input: &str) -> FastApiError {
    FastApiError::validation([QueryValidationError {
        kind,
        loc: ["query", field],
        msg: message,
        input,
    }])
}

/// Validated pagination plus scope.
#[derive(Debug)]
struct ListBotsParams {
    page: i64,
    limit: i64,
    scope: String,
    group_name: Option<String>,
}

impl ListBotsQuery {
    /// Validate the FastAPI query contract: `page >= 1`, `1 <= limit <= 100`,
    /// and the defaulted `scope`.
    fn validated(self) -> Result<ListBotsParams, FastApiError> {
        let page = parse_integer("page", self.page.as_deref(), 1)?;
        if page < 1 {
            return Err(validation_error(
                "page",
                "greater_than_equal",
                "Input should be greater than or equal to 1",
                self.page.as_deref().unwrap_or("1"),
            ));
        }
        let limit = parse_integer("limit", self.limit.as_deref(), 10)?;
        if limit < 1 {
            return Err(validation_error(
                "limit",
                "greater_than_equal",
                "Input should be greater than or equal to 1",
                self.limit.as_deref().unwrap_or("10"),
            ));
        }
        if limit > 100 {
            return Err(validation_error(
                "limit",
                "less_than_equal",
                "Input should be less than or equal to 100",
                self.limit.as_deref().unwrap_or("10"),
            ));
        }
        Ok(ListBotsParams {
            page,
            limit,
            scope: self.scope.unwrap_or_else(|| "personal".to_string()),
            group_name: self.group_name,
        })
    }
}

/// Parse an optional integer query literal, rendering FastAPI's `int_parsing`
/// 422 on failure and applying the default when absent.
fn parse_integer(field: &str, raw: Option<&str>, default: i64) -> Result<i64, FastApiError> {
    match raw {
        None => Ok(default),
        Some(raw) => raw.parse::<i64>().map_err(|_| {
            validation_error(
                field,
                "int_parsing",
                "Input should be a valid integer, unable to parse string as an integer",
                raw,
            )
        }),
    }
}

/// GET /api/bots: the bots free function, injecting the process-lifetime
/// application state.
#[brz_http_server::get("/api/bots")]
async fn list_bots(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<ListBotsQuery>,
) -> Result<BotsResponse, FastApiError> {
    let params = ListBotsQuery {
        page: query.page.clone(),
        limit: query.limit.clone(),
        scope: query.scope.clone(),
        group_name: query.group_name.clone(),
    }
    .validated()?;
    bots_list(state, current_user.id as i64, &params).await
}

/// The source `list_bots` flow after authentication.
async fn bots_list(
    state: &AppState,
    user_id: i64,
    params: &ListBotsParams,
) -> Result<BotsResponse, FastApiError> {
    let skip = (params.page - 1) * params.limit;
    let namespaces =
        resolve_namespaces(state, user_id, &params.scope, params.group_name.as_deref()).await?;

    // `query_bots_by_namespaces`: default-namespace user Bots (falling back to
    // public Bots when the user has none), then the group-namespace Bots.
    let group_namespaces: Vec<String> = namespaces
        .iter()
        .filter(|namespace| *namespace != "default")
        .cloned()
        .collect();
    let mut bots: Vec<BotRow> = Vec::new();
    if namespaces.iter().any(|namespace| namespace == "default") {
        let user_bots = repo::user_default_bots(&state.mysql, user_id, skip, params.limit)
            .await
            .map_err(database_error)?;
        if user_bots.is_empty() {
            bots.extend(
                repo::public_default_bots(&state.mysql, skip, params.limit)
                    .await
                    .map_err(database_error)?,
            );
        } else {
            bots.extend(user_bots);
        }
    }
    if !group_namespaces.is_empty() {
        bots.extend(
            repo::group_bots(&state.mysql, &group_namespaces, skip, params.limit)
                .await
                .map_err(database_error)?,
        );
    }
    if bots.is_empty() {
        return Ok(BotsResponse {
            total: 0,
            items: Vec::new(),
        });
    }

    let specs: Vec<_> = bots.iter().map(|bot| bot_spec(&bot.json.0)).collect();
    let maps = preload_components(state, user_id, &bots, &specs).await?;

    let items: Vec<BotItem> = bots
        .iter()
        .zip(specs.iter())
        .map(|(bot, spec)| {
            let keys = bot_keys(spec);
            let (ghost, shell, model) = resolve(&maps.ghosts, &maps.shells, &maps.models, &keys);
            bot_item(bot, ghost, shell, model)
        })
        .collect();

    // `if page == 1 and len(bot_dicts) < limit: total = len(bot_dicts)`, else
    // `count_user_bots` re-resolves the scope's namespaces and counts.
    let total = if params.page == 1 && (items.len() as i64) < params.limit {
        items.len() as i64
    } else {
        let count_namespaces =
            resolve_namespaces(state, user_id, &params.scope, params.group_name.as_deref()).await?;
        if count_namespaces.is_empty() {
            0
        } else {
            repo::count_bots(&state.mysql, user_id, &count_namespaces)
                .await
                .map_err(database_error)?
        }
    };

    Ok(BotsResponse { total, items })
}

/// The batch Ghost/Shell/Model caches (`_get_bot_components_batch`).
struct ComponentMaps {
    ghosts: HashMap<RefKey, KindRow>,
    shells: HashMap<RefKey, KindRow>,
    models: HashMap<RefKey, KindRow>,
}

/// Batch-fetch the referenced Ghost/Shell/Model `kinds`
/// (`_get_bot_components_batch`). Statements run in the source order so the
/// recorded dependency sequence matches.
async fn preload_components(
    state: &AppState,
    user_id: i64,
    bots: &[BotRow],
    specs: &[super::conversion::BotSpec],
) -> Result<ComponentMaps, FastApiError> {
    let mut personal_ghost_keys: Vec<RefKey> = Vec::new();
    let mut group_ghost_keys: Vec<RefKey> = Vec::new();
    let mut shell_keys: Vec<RefKey> = Vec::new();
    let mut personal_model_keys: Vec<RefKey> = Vec::new();
    let mut group_model_keys: Vec<RefKey> = Vec::new();
    let mut all_model_keys: Vec<RefKey> = Vec::new();

    for (bot, spec) in bots.iter().zip(specs.iter()) {
        let is_group_resource = !bot.namespace.is_empty() && bot.namespace != "default";
        let (ghost, shell, model) = bot_keys(spec);
        if let Some(key) = ghost {
            let target = if is_group_resource {
                &mut group_ghost_keys
            } else {
                &mut personal_ghost_keys
            };
            push_unique(target, key);
        }
        if let Some(key) = shell {
            push_unique(&mut shell_keys, key);
        }
        if let Some(key) = model {
            push_unique(&mut all_model_keys, key.clone());
            let target = if is_group_resource {
                &mut group_model_keys
            } else {
                &mut personal_model_keys
            };
            push_unique(target, key);
        }
    }

    let mut ghosts: HashMap<RefKey, KindRow> = HashMap::new();
    for row in repo::personal_ghosts(&state.mysql, user_id, &personal_ghost_keys)
        .await
        .map_err(database_error)?
    {
        ghosts.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
    }
    for row in repo::group_ghosts(&state.mysql, &group_ghost_keys)
        .await
        .map_err(database_error)?
    {
        ghosts.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
    }

    let mut shells: HashMap<RefKey, KindRow> = HashMap::new();
    for row in repo::user_shells(&state.mysql, user_id, &shell_keys)
        .await
        .map_err(database_error)?
    {
        shells.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
    }
    let missing_shells: Vec<RefKey> = shell_keys
        .iter()
        .filter(|key| !shells.contains_key(*key))
        .cloned()
        .collect();
    if !missing_shells.is_empty() {
        for row in repo::public_shells(&state.mysql, &missing_shells)
            .await
            .map_err(database_error)?
        {
            shells.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
        }
    }

    let mut models: HashMap<RefKey, KindRow> = HashMap::new();
    for row in repo::personal_models(&state.mysql, user_id, &personal_model_keys)
        .await
        .map_err(database_error)?
    {
        models.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
    }
    for row in repo::group_models(&state.mysql, &group_model_keys)
        .await
        .map_err(database_error)?
    {
        models.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
    }
    let missing_models: Vec<RefKey> = all_model_keys
        .iter()
        .filter(|key| !models.contains_key(*key))
        .cloned()
        .collect();
    if !missing_models.is_empty() {
        let rows = repo::public_models(&state.mysql, &missing_models)
            .await
            .map_err(database_error)?;
        // `is_public_model_allowed_for_user_id` loads the request user per row
        // and keeps only the models the whitelist admits.
        for row in allowed_public_models(&state.mysql, user_id, rows)
            .await
            .map_err(database_error)?
        {
            models.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
        }
    }

    Ok(ComponentMaps {
        ghosts,
        shells,
        models,
    })
}

/// Append a key if not already present, preserving first-seen order (the
/// source collects these into Python sets, whose iteration order is hash-seed
/// dependent).
fn push_unique(keys: &mut Vec<RefKey>, key: RefKey) {
    if !keys.contains(&key) {
        keys.push(key);
    }
}

/// Resolve the namespaces a scope expands to (`get_user_bots` prelude). An
/// unknown scope is a source `ValueError` -> 500.
async fn resolve_namespaces(
    state: &AppState,
    user_id: i64,
    scope: &str,
    group_name: Option<&str>,
) -> Result<Vec<String>, FastApiError> {
    match scope {
        "personal" => Ok(vec!["default".to_string()]),
        "group" => match group_name {
            Some(name) => Ok(vec![name.to_string()]),
            None => Ok(sorted_group_names(state, user_id).await?),
        },
        "all" => {
            let mut namespaces = vec!["default".to_string()];
            namespaces.extend(sorted_group_names(state, user_id).await?);
            Ok(namespaces)
        }
        _ => Err(FastApiError::unhandled()),
    }
}

/// `sorted(get_user_group_roles(db, user_id))`: every group the user can
/// access, including inherited and entity-derived memberships.
async fn sorted_group_names(state: &AppState, user_id: i64) -> Result<Vec<String>, FastApiError> {
    let erp = ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    let resolved = user_group_memberships(&state.mysql, &erp, user_id)
        .await
        .map_err(database_error)?;
    let mut names: Vec<String> = effective_roles(&resolved.memberships, &resolved.active_names)
        .into_keys()
        .collect();
    names.sort();
    Ok(names)
}

/// The application's `python_exception_handler` 500 body for an unexpected
/// dependency failure.
fn database_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "bots database dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    #[test]
    fn defaults_match_the_source_query_contract() {
        let params = ListBotsQuery::default().validated().unwrap();
        assert_eq!(params.page, 1);
        assert_eq!(params.limit, 10);
        assert_eq!(params.scope, "personal");
        assert!(params.group_name.is_none());
    }

    #[test]
    fn non_integer_and_out_of_range_values_render_422() {
        let bad_page = ListBotsQuery {
            page: Some("x".into()),
            ..ListBotsQuery::default()
        };
        assert_eq!(
            bad_page.validated().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let zero = ListBotsQuery {
            page: Some("0".into()),
            ..ListBotsQuery::default()
        };
        assert_eq!(
            zero.validated().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let over = ListBotsQuery {
            limit: Some("101".into()),
            ..ListBotsQuery::default()
        };
        assert_eq!(
            over.validated().unwrap_err().status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn invalid_scope_is_an_internal_error_like_the_source_value_error() {
        // The source `scope` is a plain `str`; `get_user_bots` raises
        // `ValueError`, which the app renders as a 500.
        assert_eq!(
            ListBotsQuery {
                scope: Some("bogus".into()),
                ..ListBotsQuery::default()
            }
            .validated()
            .unwrap()
            .scope,
            "bogus"
        );
    }

    #[test]
    fn push_unique_keeps_first_seen_order() {
        let mut keys: Vec<RefKey> = Vec::new();
        push_unique(&mut keys, ("a".to_string(), "default".to_string()));
        push_unique(&mut keys, ("b".to_string(), "default".to_string()));
        push_unique(&mut keys, ("a".to_string(), "default".to_string()));
        assert_eq!(
            keys,
            vec![
                ("a".to_string(), "default".to_string()),
                ("b".to_string(), "default".to_string()),
            ]
        );
    }
}
