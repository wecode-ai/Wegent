// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/plugins/publication-requests` implementation.
//!
//! Source: `app/api/endpoints/plugin_publications.py`
//! (`list_plugin_publication_requests`, router mounted with the
//! `/plugins` prefix under `/api`) -> `PluginPublicationService.list_requests`
//! (`is_admin=False`) -> `PluginPublicationService._summary`.
//!
//! Request order matches the source: the flexible principal
//! (`get_current_user_jwt_apikey_tasktoken`) is resolved first, then FastAPI
//! query validation. The route never applies the admin filter: every row is
//! filtered by `submitter_user_id == current_user.id`.
//!
//! The bearer session resolves through the labeled by-name user projection.
//! The service runs the `count(*)` subquery over the submitter filter, the ordered page
//! query returning no rows, and two trailing `ROLLBACK` session cleanups,
//! producing `{"items":[],"total":0,"page":1,"limit":100}`.

pub(super) mod query;

pub(crate) use query::ListQuery as USER_LIST_QUERY;

use brz_mysql::{Mysql, MysqlResult};

use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::state::AppState;

use super::summary::{ListResponse, summary};
pub(super) use query::ListParams;

/// GET /api/plugins/publication-requests: the list free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/plugins/publication-requests")]
async fn list_plugin_publication_requests(
    #[inject(state)] state: &AppState,
    #[auth] user: FlexibleUser,
    query: brz_http_server::Query<USER_LIST_QUERY>,
) -> Result<ListResponse, FastApiError> {
    list_requests(state, &user, &query).await
}

/// Handler body for `GET /api/plugins/publication-requests`.
async fn list_requests(
    state: &AppState,
    user: &FlexibleUser,
    query: &USER_LIST_QUERY,
) -> Result<ListResponse, FastApiError> {
    let params = query.validated()?;
    match list(&state.mysql, user.id, &params).await {
        Ok(response) => Ok(response),
        Err(error) => {
            tracing::error!(%error, "plugin publication list failed");
            Err(FastApiError::internal())
        }
    }
}

/// `list_requests` with `is_admin=False`: count the caller's requests, read
/// the ordered page, then project each row through `_summary`.
async fn list<M: Mysql>(mysql: &M, user_id: i32, params: &ListParams) -> MysqlResult<ListResponse> {
    let total = super::sql::count_user_requests(mysql, user_id, params).await?;
    let rows = super::sql::select_user_requests(mysql, user_id, params).await?;
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

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
