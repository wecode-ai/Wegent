// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/admin/plugins/publication-requests` implementation.
//!
//! Source: `app/api/endpoints/admin/plugin_publications.py`
//! (`list_plugin_publication_requests`) -> `PluginPublicationService.list_requests`
//! -> `PluginPublicationService._summary`. The router prefix
//! `/plugins/publication-requests` is mounted under `/api/admin`.
//!
//! Request order matches the source: the session principal
//! (`get_current_user`) is resolved first, then the `get_admin_user` role
//! check, then FastAPI query validation. A non-admin session is rejected with
//! `403 {"detail": "Permission denied. Admin access required."}`.
//!
//! For the recorded case the query runs `count(*)`, the ordered page, and then
//! per row `plugins`, the current revision, the submitter, and the revision
//! checks; `_summary` projects the response fields from those rows. The
//! `_summary` projection and the row statements are shared with the submitter
//! route through the parent module.

pub(super) mod query;

use brz_mysql::{Mysql, MysqlResult};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::sql::{self, Filters};
use super::summary::{ListResponse, summary};
pub(super) use query::ListParams;
pub use query::ListQuery;

/// `get_admin_user` rejection detail (`app/core/security.py`).
const ADMIN_REQUIRED_DETAIL: &str = "Permission denied. Admin access required.";

/// GET /api/admin/plugins/publication-requests: the list free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/admin/plugins/publication-requests")]
async fn list_plugin_publication_requests(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    query: brz_http_server::Query<ListQuery>,
) -> Result<ListResponse, FastApiError> {
    list_requests(state, &user, &query).await
}

/// Handler body for `GET /api/admin/plugins/publication-requests`.
async fn list_requests(
    state: &AppState,
    user: &SessionUser,
    query: &ListQuery,
) -> Result<ListResponse, FastApiError> {
    require_admin(&user.role)?;
    let params = query.validated()?;
    match list(&state.mysql, &params).await {
        Ok(response) => Ok(response),
        Err(error) => {
            tracing::error!(%error, "admin plugin publication list failed");
            Err(FastApiError::internal())
        }
    }
}

/// `get_admin_user`: the session principal must carry the `admin` role.
fn require_admin(role: &str) -> Result<(), FastApiError> {
    if role == "admin" {
        Ok(())
    } else {
        Err(FastApiError::forbidden(ADMIN_REQUIRED_DETAIL))
    }
}

/// `list_requests`: count, page, then project each row through `_summary`.
async fn list<M: Mysql>(mysql: &M, params: &ListParams) -> MysqlResult<ListResponse> {
    let filters = resolve_filters(mysql, params).await?;
    let total = sql::count_requests(mysql, params, &filters).await?;
    let rows = sql::select_requests(mysql, params, &filters).await?;
    let mut items = Vec::with_capacity(rows.len());
    let now = chrono::Utc::now().naive_utc();
    for row in &rows {
        items.push(summary(mysql, row, now).await?);
    }
    Ok(ListResponse {
        items,
        total,
        page: params.page,
        limit: params.limit,
    })
}

/// Resolve the `submitter` and `query` text filters into id lists, in the
/// source order (`users` lookup, then `plugins` lookup).
async fn resolve_filters<M: Mysql>(mysql: &M, params: &ListParams) -> MysqlResult<Filters> {
    let submitter_ids = match &params.submitter {
        Some(value) => Some(sql::user_ids_like(mysql, &like_pattern(value)).await?),
        None => None,
    };
    let plugin_ids = match &params.query {
        Some(value) => Some(sql::plugin_ids_like(mysql, &like_pattern(value)).await?),
        None => None,
    };
    Ok(Filters {
        submitter_ids,
        plugin_ids,
    })
}

/// `f"%{value.strip()}%"`.
fn like_pattern(value: &str) -> String {
    format!("%{}%", value.trim())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
