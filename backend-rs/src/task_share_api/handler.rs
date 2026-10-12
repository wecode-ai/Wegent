// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/tasks/{task_id}/share`
//! (`app/api/endpoints/adapter/tasks.share_task` ->
//! `SharedTaskService.validate_task_exists` / `share_task`,
//! `app/services/shared_task.py`).
//!
//! The route reads the caller's membership, then re-reads the task to reuse its
//! owner for the encrypted share token. Every task read is the active-task
//! projection (`id = ? AND kind = 'Task' AND is_active IN (1, 2)`): the access
//! store's `_get_accessible_task` and the store's `get_task_by_states` render
//! the same statement, so this handler reuses
//! [`TaskStore::get_accessible_task`](crate::task_store::TaskStore::get_accessible_task)
//! for both.

use brz_http_server::StatusCode;
use tracing::warn;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::models::TaskShareResponse;
use super::token::{generate_share_token, generate_share_url};

/// `401`-independent route details, matching the source's `HTTPException`
/// messages.
const NOT_A_MEMBER: &str = "Task not found or you don't have permission";
const TASK_NOT_FOUND: &str = "Task not found";

/// `_approved_membership_query` (`app/stores/tasks/sqlalchemy_access_store.py`):
/// the approved membership of `entity_id = str(user_id)` for one task,
/// excluding copied rows. The source's `.first()` renders the trailing
/// `LIMIT 1`.
const APPROVED_MEMBERSHIP_QUERY: &str = "SELECT resource_members.id AS resource_members_id \n\
     FROM resource_members \nWHERE resource_members.resource_type = 'Task' \
     AND resource_members.resource_id = ? \nAND resource_members.entity_type = 'user' \
     AND resource_members.entity_id = ? \nAND resource_members.status = 'approved' \
     AND resource_members.copied_resource_id = 0 \n LIMIT 1";

/// `task_member_service.is_member` over `task_access_store.is_member`: the
/// viewer owns the active task, or holds an approved membership in it.
pub(super) async fn is_member(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<bool, FastApiError> {
    let task = state
        .task_store
        .get_accessible_task(task_id)
        .await
        .map_err(|error| internal(&error))?;
    let Some(task) = task else {
        return Ok(false);
    };
    let owner: i64 = task
        .get_required("user_id")
        .map_err(|error| internal(&error))?;
    if owner == user_id {
        return Ok(true);
    }
    let membership: Option<brz_mysql::MysqlRow> = state
        .mysql
        .fetch_optional(APPROVED_MEMBERSHIP_QUERY, (task_id, user_id.to_string()))
        .await
        .map_err(|error| internal(&error))?;
    Ok(membership.is_some())
}

/// `SharedTaskService.validate_task_exists`: the route's first gate. A false
/// result is the route's own `404` detail.
pub(super) async fn validate_task_exists(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<bool, FastApiError> {
    is_member(state, task_id, user_id).await
}

/// `SharedTaskService.share_task`: re-check membership, read the task to reuse
/// its owner, then render the encrypted token and its share link.
pub(super) async fn share_task(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<TaskShareResponse, FastApiError> {
    if !is_member(state, task_id, user_id).await? {
        return Err(not_found(TASK_NOT_FOUND));
    }
    // `task_store.get_task_by_states(states=is_active_query())`: the token uses
    // the task owner's user id, not the viewer's.
    let task = state
        .task_store
        .get_accessible_task(task_id)
        .await
        .map_err(|error| internal(&error))?;
    let Some(task) = task else {
        return Err(not_found(TASK_NOT_FOUND));
    };
    let owner: i64 = task
        .get_required("user_id")
        .map_err(|error| internal(&error))?;
    let share_token =
        generate_share_token(owner, task_id).map_err(|()| FastApiError::unhandled())?;
    let share_url = generate_share_url(&share_token);
    Ok(TaskShareResponse {
        share_url,
        share_token,
    })
}

/// The route's `validate_task_exists` rejection detail.
pub(super) fn not_a_member() -> FastApiError {
    not_found(NOT_A_MEMBER)
}

fn not_found(detail: &'static str) -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, detail)
}

fn internal(error: &impl std::fmt::Display) -> FastApiError {
    warn!(%error, "[task_share] database error");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}
