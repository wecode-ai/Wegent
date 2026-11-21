// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/subtasks` handler
//! (`app/api/endpoints/subtasks.py:list_subtasks`).
//!
//! The handler preserves the source's dependency order: `is_member` for the
//! listing, the ordered id page, then a second `is_member` for the count, then
//! the `count(*)`. Both membership checks re-read the active task and the
//! approved-member row, as `subtask_store.list_by_task` /
//! `count_by_task_for_user` do in the source.
use std::sync::Arc;

use serde::Deserialize;
use serde_json::json;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::item::{SubtaskInDb, build_items};

/// `SubtaskListResponse` (`{"total", "items"}`).
#[derive(Debug, serde::Serialize)]
pub(crate) struct SubtasksResponse {
    total: i64,
    items: Vec<SubtaskInDb>,
}

/// Query parameters: `task_id` is required; `page >= 1` (default 1),
/// `limit` in `1..=100` (default 10), `from_latest` defaults to true, and
/// `before_message_id` is optional.
#[derive(Debug, Deserialize)]
pub(crate) struct SubtasksQuery {
    task_id: Option<i64>,
    page: Option<i64>,
    limit: Option<i64>,
    from_latest: Option<bool>,
    before_message_id: Option<i64>,
}

/// Fully validated query parameters.
#[derive(Debug)]
struct ValidatedQuery {
    task_id: i64,
    page: i64,
    limit: i64,
    from_latest: bool,
    before_message_id: Option<i64>,
}

/// FastAPI's missing-field 422 entry.
fn missing_error(field: &str) -> FastApiError {
    FastApiError::validation(json!([
        {"type": "missing", "loc": ["query", field], "msg": "Field required"}
    ]))
}

/// FastAPI's out-of-range 422 entry (`input` keeps the raw scalar as text).
fn range_error(field: &str, kind: &str, message: &str, input: i64) -> FastApiError {
    FastApiError::validation(json!([
        {"type": kind, "loc": ["query", field], "msg": message, "input": input.to_string()}
    ]))
}

impl SubtasksQuery {
    fn validated(&self) -> Result<ValidatedQuery, FastApiError> {
        let Some(task_id) = self.task_id else {
            return Err(missing_error("task_id"));
        };
        let page = match self.page {
            None => 1,
            Some(page) if page >= 1 => page,
            Some(page) => {
                return Err(range_error(
                    "page",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    page,
                ));
            }
        };
        let limit = match self.limit {
            None => 10,
            Some(limit) if (1..=100).contains(&limit) => limit,
            Some(limit) if limit < 1 => {
                return Err(range_error(
                    "limit",
                    "greater_than_equal",
                    "Input should be greater than or equal to 1",
                    limit,
                ));
            }
            Some(limit) => {
                return Err(range_error(
                    "limit",
                    "less_than_equal",
                    "Input should be less than or equal to 100",
                    limit,
                ));
            }
        };
        Ok(ValidatedQuery {
            task_id,
            page,
            limit,
            from_latest: self.from_latest.unwrap_or(true),
            before_message_id: self.before_message_id,
        })
    }
}

/// GET /api/subtasks: the subtask list free function, injecting the
/// process-lifetime application state.
#[brz_http_server::get("/api/subtasks")]
async fn list_subtasks(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] current_user: crate::auth::SessionUser,
    query: brz_http_server::Query<SubtasksQuery>,
) -> Result<SubtasksResponse, FastApiError> {
    let params = query.validated()?;
    list_subtasks_inner(state, current_user.id, &params).await
}

/// Handler body: `subtask_service.get_by_task` then
/// `subtask_store.count_by_task_for_user`.
async fn list_subtasks_inner(
    state: &AppState,
    user_id: i32,
    params: &ValidatedQuery,
) -> Result<SubtasksResponse, FastApiError> {
    let skip = (params.page - 1) * params.limit;

    // `subtask_store.list_by_task`: membership, then the ordered id page and
    // the id-scoped load.
    let owner_filter = member_filter(state, params.task_id, user_id).await?;
    let rows = state
        .task_store
        .list_subtasks_by_task_for_page(
            params.task_id,
            owner_filter,
            params.before_message_id,
            params.from_latest,
            skip,
            params.limit,
        )
        .await
        .map_err(dependency_error)?;
    let items = build_items(state, &rows).await.map_err(dependency_error)?;

    // `subtask_store.count_by_task_for_user`: the source recomputes membership
    // for the count read, so the task and member rows are read a second time.
    let owner_filter = member_filter(state, params.task_id, user_id).await?;
    let total = state
        .task_store
        .count_subtasks_for_task(params.task_id, owner_filter)
        .await
        .map_err(dependency_error)?;

    Ok(SubtasksResponse { total, items })
}

/// The page's owner filter: `None` when the caller owns the task or is an
/// approved member (the member view), else `Some(user_id)`.
async fn member_filter(
    state: &AppState,
    task_id: i64,
    user_id: i32,
) -> Result<Option<i32>, FastApiError> {
    if is_member(state, task_id, user_id).await? {
        Ok(None)
    } else {
        Ok(Some(user_id))
    }
}

/// `task_access_store.is_member`: the caller owns the active task, or holds an
/// approved membership in it.
async fn is_member(state: &AppState, task_id: i64, user_id: i32) -> Result<bool, FastApiError> {
    let task = state
        .task_store
        .get_accessible_task(task_id)
        .await
        .map_err(dependency_error)?;
    let Some(task) = task else {
        return Ok(false);
    };
    let owner: i64 = task.get_required("user_id").map_err(dependency_error)?;
    if owner == i64::from(user_id) {
        return Ok(true);
    }
    crate::task_detail_api::repository::is_approved_member(
        &state.mysql,
        task_id,
        i64::from(user_id),
    )
    .await
    .map_err(dependency_error)
}

/// The source's unhandled dependency failure renders through the app's
/// `Exception` handler (`app/core/exceptions.py`).
fn dependency_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "subtasks dependency failure");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_http_server::StatusCode;

    fn query(task_id: Option<i64>, page: Option<i64>, limit: Option<i64>) -> SubtasksQuery {
        SubtasksQuery {
            task_id,
            page,
            limit,
            from_latest: None,
            before_message_id: None,
        }
    }

    #[test]
    fn missing_task_id_is_rejected() {
        let error = query(None, None, None).validated().unwrap_err();
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[test]
    fn page_and_limit_bounds_are_enforced() {
        assert!(query(Some(1), Some(0), None).validated().is_err());
        assert!(query(Some(1), None, Some(0)).validated().is_err());
        assert!(query(Some(1), None, Some(101)).validated().is_err());
        assert!(query(Some(1), Some(1), Some(100)).validated().is_ok());
    }

    #[test]
    fn defaults_match_the_source() {
        let params = query(Some(7), None, None).validated().unwrap();
        assert_eq!(
            (params.page, params.limit, params.from_latest),
            (1, 10, true)
        );
    }

    /// The subtask list is registered exactly once in the public route group;
    /// before this repair the path had no handler, so the gateway proxied the
    /// recorded request to the absent Python upstream.
    #[test]
    fn list_subtasks_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .filter(|path| *path == "/api/subtasks")
            .collect();
        assert_eq!(paths, ["/api/subtasks"]);
    }
}
