// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/bots` handler: query validation, scope-driven namespace
//! resolution, the paginated Bot lookup with a batched Ghost/Shell/Model
//! preload, and response assembly
//! (`app/api/endpoints/adapter/bots.py::list_bots`).
use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::teams::group_membership::{ErpContext, effective_roles, user_group_memberships};
use crate::teams::public_model_access::allowed_public_models;
use crate::teams::teams_repository::KindRow;
use crate::v1_resources::repository::OwnedKindRow;
use crate::v1_resources::shell_resolution;

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
            let (ghost, shell, model) =
                resolve(&maps.ghosts, &maps.shells, &maps.models, &keys, bot.user_id);
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
    shells: HashMap<(i64, String, String), KindRow>,
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
    let mut shell_keys: Vec<(i64, String, String)> = Vec::new();
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
            let owned_key = (bot.user_id, key.0, key.1);
            if !shell_keys.contains(&owned_key) {
                shell_keys.push(owned_key);
            }
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

    let mut shell_keys_by_owner: HashMap<i64, Vec<RefKey>> = HashMap::new();
    for (owner_id, name, namespace) in &shell_keys {
        shell_keys_by_owner
            .entry(*owner_id)
            .or_default()
            .push((name.clone(), namespace.clone()));
    }
    let mut shells: HashMap<(i64, String, String), KindRow> = HashMap::new();
    for (owner_id, owner_keys) in &shell_keys_by_owner {
        for row in repo::user_shells(&state.mysql, *owner_id, owner_keys)
            .await
            .map_err(database_error)?
        {
            shells.insert(
                (
                    *owner_id,
                    row.kinds_name.clone(),
                    row.kinds_namespace.clone(),
                ),
                row,
            );
        }
    }
    let missing_shells: Vec<(i64, String, String)> = shell_keys
        .iter()
        .filter(|key| !shells.contains_key(*key))
        .cloned()
        .collect();
    resolve_missing_shell_references(&state.mysql, &missing_shells, &mut shells).await?;

    let missing_group_shells: Vec<(i64, String, String)> = shell_keys
        .iter()
        .filter(|(_, _, namespace)| namespace != "default")
        .filter(|key| !shells.contains_key(*key))
        .cloned()
        .collect();
    if !missing_group_shells.is_empty() {
        let owners: HashSet<i64> = missing_group_shells
            .iter()
            .map(|(owner_id, _, _)| *owner_id)
            .collect();
        let mut owner_groups: HashMap<i64, HashSet<String>> = HashMap::new();
        for owner_id in owners {
            owner_groups.insert(
                owner_id,
                sorted_group_names(state, owner_id)
                    .await?
                    .into_iter()
                    .collect(),
            );
        }
        let mut group_keys: Vec<RefKey> = Vec::new();
        for (owner_id, name, namespace) in &missing_group_shells {
            if owner_groups
                .get(owner_id)
                .is_some_and(|groups| groups.contains(namespace))
            {
                let key = (name.clone(), namespace.clone());
                if !group_keys.contains(&key) {
                    group_keys.push(key);
                }
            }
        }
        let mut group_rows: HashMap<RefKey, KindRow> = HashMap::new();
        if !group_keys.is_empty() {
            for row in repo::group_shells(&state.mysql, &group_keys)
                .await
                .map_err(database_error)?
            {
                group_rows.insert((row.kinds_name.clone(), row.kinds_namespace.clone()), row);
            }
        }
        insert_group_shell_rows(
            &missing_group_shells,
            &owner_groups,
            &group_rows,
            &mut shells,
        );
    }

    let missing_public_shells: Vec<(i64, String, String)> = shell_keys
        .iter()
        .filter(|key| !shells.contains_key(*key))
        .cloned()
        .collect();
    let mut seen_public_names = HashSet::new();
    let mut public_names = Vec::new();
    for (_, name, _) in &missing_public_shells {
        if seen_public_names.insert(name.clone()) {
            public_names.push(name.clone());
        }
    }
    if !public_names.is_empty() {
        for row in repo::public_shells_by_names(&state.mysql, &public_names)
            .await
            .map_err(database_error)?
        {
            for (owner_id, name, namespace) in &missing_public_shells {
                if name == &row.kinds_name {
                    shells.insert((*owner_id, name.clone(), namespace.clone()), row.clone());
                }
            }
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

/// Populate each owner's group fallback without inheriting another owner's access.
fn insert_group_shell_rows(
    missing_keys: &[(i64, String, String)],
    owner_groups: &HashMap<i64, HashSet<String>>,
    group_rows: &HashMap<RefKey, KindRow>,
    shells: &mut HashMap<(i64, String, String), KindRow>,
) {
    for (owner_id, name, namespace) in missing_keys {
        if owner_groups
            .get(owner_id)
            .is_some_and(|groups| groups.contains(namespace))
            && let Some(row) = group_rows.get(&(name.clone(), namespace.clone()))
        {
            shells.insert((*owner_id, name.clone(), namespace.clone()), row.clone());
        }
    }
}

/// Resolve Shell capability references for keys that have no direct Shell row
/// in their requested namespace.
async fn resolve_missing_shell_references<M>(
    mysql: &M,
    missing_keys: &[(i64, String, String)],
    shells: &mut HashMap<(i64, String, String), KindRow>,
) -> Result<(), FastApiError>
where
    M: brz_mysql::Mysql,
{
    let mut names_by_owner_namespace: HashMap<(i64, String), HashSet<&str>> = HashMap::new();
    for (owner_id, name, namespace) in missing_keys {
        names_by_owner_namespace
            .entry((*owner_id, namespace.clone()))
            .or_default()
            .insert(name.as_str());
    }
    for ((owner_id, namespace), names) in names_by_owner_namespace {
        let referenced_shells = shell_resolution::referenced_shells(mysql, owner_id, &namespace)
            .await
            .map_err(database_error)?;
        for row in referenced_shells {
            if names.contains(row.name.as_str()) {
                shells
                    .entry((owner_id, row.name.clone(), namespace.clone()))
                    .or_insert_with(|| kind_row_from_referenced_shell(row));
            }
        }
    }
    Ok(())
}

/// Convert a referenced Shell row into the Bot list response row.
fn kind_row_from_referenced_shell(row: OwnedKindRow) -> KindRow {
    KindRow {
        kinds_id: row.id,
        kinds_user_id: row.user_id,
        kinds_name: row.name,
        kinds_namespace: row.namespace,
        kinds_json: brz_mysql::Json(brz_json::OpaqueJson::from(row.json.0)),
    }
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
    let resolved = user_group_memberships(&state.mysql, &erp, &state.entity_resolvers, user_id)
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

    #[tokio::test]
    async fn missing_shell_references_use_capability_reference_lookup() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let missing = vec![
            (74, "group-claude".to_string(), "default".to_string()),
            (74, "other-claude".to_string(), "default".to_string()),
        ];
        let mut shells = HashMap::new();

        resolve_missing_shell_references(&mysql, &missing, &mut shells)
            .await
            .unwrap();

        let queries = mysql.queries();
        assert_eq!(
            queries
                .iter()
                .filter(|query| query
                    .sql
                    .contains("resource_members.resource_type = 'Shell'"))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn shell_references_are_scoped_by_bot_owner() {
        let mysql = crate::sql_test_support::KindQueryCapture::default();
        let missing = vec![
            (74, "group-claude".to_string(), "default".to_string()),
            (75, "group-claude".to_string(), "default".to_string()),
        ];
        let mut shells = HashMap::new();

        resolve_missing_shell_references(&mysql, &missing, &mut shells)
            .await
            .unwrap();

        let queries = mysql.queries();
        assert_eq!(
            queries
                .iter()
                .filter(|query| query
                    .sql
                    .contains("resource_members.resource_type = 'Shell'"))
                .count(),
            2
        );
    }

    #[test]
    fn referenced_shell_conversion_preserves_source_payload() {
        let timestamp = chrono::NaiveDate::from_ymd_opt(2026, 1, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap();
        let row = OwnedKindRow {
            id: 10,
            user_id: 74,
            kind: "Shell".to_string(),
            name: "group-claude".to_string(),
            namespace: "source-group".to_string(),
            json: brz_mysql::Json(serde_json::json!({
                "spec": {"shellType": "ClaudeCode"}
            })),
            is_active: 1,
            created_at: timestamp,
            updated_at: timestamp,
        };

        let converted = kind_row_from_referenced_shell(row);

        assert_eq!(converted.kinds_id, 10);
        assert_eq!(converted.kinds_name, "group-claude");
        assert_eq!(converted.kinds_namespace, "source-group");
        assert_eq!(
            converted.kinds_json.0.to_value()["spec"]["shellType"],
            "ClaudeCode"
        );
    }

    /// One authorized owner must not expose a same-key group Shell to other owners.
    #[test]
    fn group_shell_rows_do_not_share_owner_permissions() {
        let key = ("shared-shell".to_string(), "shell-group".to_string());
        let missing: Vec<_> = [74, 75, 76]
            .into_iter()
            .map(|owner| (owner, key.0.clone(), key.1.clone()))
            .collect();
        let owner_groups =
            HashMap::from([(74, HashSet::from([key.1.clone()])), (75, HashSet::new())]);
        let row = KindRow {
            kinds_id: 10,
            kinds_user_id: 77,
            kinds_name: key.0.clone(),
            kinds_namespace: key.1.clone(),
            kinds_json: brz_mysql::Json(brz_json::OpaqueJson::from(serde_json::json!({
                "spec": {"shellType": "Agno"}
            }))),
        };
        let group_rows = HashMap::from([(key.clone(), row)]);
        let mut shells = HashMap::new();

        insert_group_shell_rows(&missing, &owner_groups, &group_rows, &mut shells);

        assert_eq!(shells.len(), 1);
        assert_eq!(shells[&missing[0]].kinds_id, 10);
        assert!(!shells.contains_key(&missing[1]));
        assert!(!shells.contains_key(&missing[2]));
        // Denied owners remain unresolved so the caller can apply the public fallback.
        let unresolved: Vec<_> = missing
            .iter()
            .filter(|key| !shells.contains_key(*key))
            .map(|key| key.0)
            .collect();
        assert_eq!(unresolved, [75, 76]);
    }
}
