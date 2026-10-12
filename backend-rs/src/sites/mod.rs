// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/sites` — the authenticated list of typed applications owned by or
//! shared with the current user.
//!
//! Source pipeline (`app.api.endpoints.sites.list_sites`):
//!
//! 1. `security.get_current_user` — the bearer-session user;
//! 2. FastAPI query validation: `app_type` (`SiteAppType` literal), `offset`
//!    (`>= 0`), `limit` (`1..=100`); `q` is stripped and empty becomes `None`;
//! 3. `sites_service.list_sites` -> `get_application_type_handler` ->
//!    `_list_platform_sites`: page through `GET /api/v1/projects/search`
//!    (upstream page size 100, cursor pagination), keep projects whose
//!    `app_type` matches the handler and whose title contains `q`, skip
//!    `offset` matches, and collect `limit` items;
//! 4. the page's derived `total` and `next_cursor`.
//!
//! Both recorded cases have empty upstream pages; the item projections mirror
//! `site_application_types` for the non-empty path.
mod application_types;
mod response;
mod upstream;

#[cfg(test)]
mod tests;

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};

use application_types::AppType;
use response::{SiteListItem, SiteListResponse};

pub use upstream::SitesClient;
use upstream::SitesError;

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// The upstream page size `_list_platform_sites` requests (`limit: 100`).
const UPSTREAM_PAGE_LIMIT: i64 = 100;

/// The raw query values. FastAPI parses `app_type` as a literal and
/// `offset`/`limit` as bounded integers; the raw strings are validated here so
/// the `422` bodies match FastAPI's.
#[derive(Debug, Deserialize)]
struct ListSitesQuery {
    app_type: Option<String>,
    q: Option<String>,
    offset: Option<String>,
    limit: Option<String>,
}

/// The validated query parameters handed to the service.
#[derive(Debug)]
struct ListSitesParams {
    app_type: AppType,
    query: Option<String>,
    offset: i64,
    limit: i64,
}

/// GET /api/sites: the authenticated application listing.
#[brz_http_server::get("/api/sites")]
async fn list_sites(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
    query: brz_http_server::Query<ListSitesQuery>,
) -> Result<SiteListResponse, FastApiError> {
    let params = query.validated()?;
    list_platform_sites(&state.sites, &current_user.user_name, params)
        .await
        .map_err(SitesError::into_fastapi_error)
}

impl ListSitesQuery {
    /// FastAPI's query validation, preserving the source's parameter order and
    /// error bodies.
    fn validated(&self) -> Result<ListSitesParams, FastApiError> {
        let mut errors: Vec<Value> = Vec::new();
        let app_type = match self.app_type.as_deref() {
            None => AppType::Web,
            Some(raw) => match app_type_from_literal(raw) {
                Some(app_type) => app_type,
                None => {
                    errors.push(validation_entry(
                        "literal_error",
                        "app_type",
                        "Input should be 'web', 'miniapp', 'site' or 'mini_program'",
                        json!(raw),
                    ));
                    AppType::Web
                }
            },
        };
        let offset = bounded_int(
            self.offset.as_deref(),
            "offset",
            0,
            Some(0),
            None,
            &mut errors,
        );
        let limit = bounded_int(
            self.limit.as_deref(),
            "limit",
            20,
            Some(1),
            Some(100),
            &mut errors,
        );
        if !errors.is_empty() {
            return Err(FastApiError::validation(Value::Array(errors)));
        }
        // `query=q.strip() if q and q.strip() else None`.
        let query = self
            .q
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        Ok(ListSitesParams {
            app_type,
            query,
            offset,
            limit,
        })
    }
}

/// `get_application_type_handler`: the validated `SiteAppType` literal mapped
/// to its registered handler.
fn app_type_from_literal(raw: &str) -> Option<AppType> {
    match raw {
        "web" | "site" => Some(AppType::Web),
        "miniapp" | "mini_program" => Some(AppType::MiniProgram),
        _ => None,
    }
}

/// FastAPI `Query(ge=..., le=...)` for one integer parameter, recording the
/// `int_parsing` / `greater_than_equal` / `less_than_equal` error when it fails.
fn bounded_int(
    raw: Option<&str>,
    field: &str,
    default: i64,
    minimum: Option<i64>,
    maximum: Option<i64>,
    errors: &mut Vec<Value>,
) -> i64 {
    let Some(raw) = raw else {
        return default;
    };
    let Some(value) = parse_int(raw) else {
        errors.push(validation_entry(
            "int_parsing",
            field,
            "Input should be a valid integer, unable to parse string as an integer",
            json!(raw),
        ));
        return default;
    };
    if let Some(minimum) = minimum
        && value < minimum
    {
        errors.push(validation_entry(
            "greater_than_equal",
            field,
            &format!("Input should be greater than or equal to {minimum}"),
            json!(value),
        ));
        return default;
    }
    if let Some(maximum) = maximum
        && value > maximum
    {
        errors.push(validation_entry(
            "less_than_equal",
            field,
            &format!("Input should be less than or equal to {maximum}"),
            json!(value),
        ));
        return default;
    }
    value
}

/// Python `int()` for a decimal string.
fn parse_int(raw: &str) -> Option<i64> {
    raw.trim().parse::<i64>().ok()
}

/// One FastAPI `422` validation entry.
fn validation_entry(kind: &str, field: &str, message: &str, input: Value) -> Value {
    json!({
        "type": kind,
        "loc": ["query", field],
        "msg": message,
        "input": input,
    })
}

/// `SitesService._list_platform_sites`: the cursor-paginated listing.
async fn list_platform_sites(
    client: &SitesClient,
    username: &str,
    params: ListSitesParams,
) -> Result<SiteListResponse, SitesError> {
    let ListSitesParams {
        app_type,
        query,
        offset,
        limit,
    } = params;
    let query_value = query.as_deref().map(str::to_lowercase);
    let mut cursor: Option<String> = None;
    let mut skipped: i64 = 0;
    let mut items: Vec<SiteListItem> = Vec::new();
    let mut has_more = false;
    let mut seen_cursors: HashSet<String> = HashSet::new();

    while (items.len() as i64) < limit {
        let mut search: Vec<(&str, String)> = vec![
            ("username", username.to_owned()),
            ("limit", UPSTREAM_PAGE_LIMIT.to_string()),
        ];
        if app_type != AppType::Web {
            search.push(("app_type", app_type.as_str().to_owned()));
        }
        if let Some(query) = &query {
            search.push(("sitename", query.clone()));
        }
        if let Some(value) = cursor.as_deref().filter(|value| !value.is_empty()) {
            if !seen_cursors.insert(value.to_owned()) {
                return Err(SitesError::UpstreamUnavailable);
            }
            search.push(("cursor", value.to_owned()));
        }
        let payload = client
            .get_json("/api/v1/projects/search", &search, username)
            .await?;
        for project in page_items(payload.as_ref())? {
            if !app_type.matches(project) {
                continue;
            }
            if query_value
                .as_deref()
                .is_some_and(|query| !project_matches_query(project, query))
            {
                continue;
            }
            if skipped < offset {
                skipped += 1;
                continue;
            }
            if (items.len() as i64) < limit {
                items.push(
                    app_type
                        .parse(project)
                        .map_err(|()| SitesError::UpstreamUnavailable)?,
                );
            } else {
                has_more = true;
                break;
            }
        }
        cursor = next_cursor(payload.as_ref())?;
        if has_more || !cursor.as_deref().is_some_and(|value| !value.is_empty()) {
            break;
        }
    }

    let has_cursor = cursor.as_deref().is_some_and(|value| !value.is_empty());
    let appended = offset + items.len() as i64;
    Ok(SiteListResponse {
        items,
        total: appended + i64::from(has_more || has_cursor),
        offset,
        limit,
        next_cursor: (has_more || has_cursor).then(|| appended.to_string()),
    })
}

/// `payload.get("items", [])` guarded by the `isinstance(page_items, list)`
/// check: a missing key is an empty page, a present non-array is an error.
fn page_items(payload: Option<&Value>) -> Result<&[Value], SitesError> {
    let Some(Value::Object(object)) = payload else {
        return Ok(&[]);
    };
    match object.get("items") {
        None => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        Some(_) => Err(SitesError::UpstreamUnavailable),
    }
}

/// `payload.get("next_cursor")` guarded by its `isinstance(cursor, str)` check.
fn next_cursor(payload: Option<&Value>) -> Result<Option<String>, SitesError> {
    let Some(Value::Object(object)) = payload else {
        return Ok(None);
    };
    match object.get("next_cursor") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(SitesError::UpstreamUnavailable),
    }
}

/// `_project_matches_query`: a case-insensitive substring match on the title.
fn project_matches_query(payload: &Value, query: &str) -> bool {
    payload
        .get("title")
        .and_then(Value::as_str)
        .is_some_and(|title| title.to_lowercase().contains(query))
}
