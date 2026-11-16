// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Share-token authentication for the attachment download exit
//! (`app/api/endpoints/adapter/attachments.py:_validate_share_token_access`
//! and `app/services/shared_task.py:decode_share_token`).
//!
//! A share token is a 256-bit opaque value issued by
//! `SharedTaskService.generate_share_token` and persisted in `share_links`.
//! Its SHA-256 hash resolves the owner and task, then the code re-reads the
//! owning active `users` row and the active `Task` row before the caller checks
//! the attachment's task/subtask linkage.
//!
//! Every decode, parse, or lookup failure collapses to "no access" (the source
//! returns `False`, which the handler renders as its 404); only a MySQL failure
//! propagates.

use std::sync::Arc;

use brz_mysql::{MysqlResult, MysqlRow};

use super::auth::UserRow;
use super::context_store;
use super::handler::internal_error;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `ContextType.ATTACHMENT`.
const CONTEXT_TYPE_ATTACHMENT: &str = "attachment";

/// `db.query(User).filter(User.id == user_id, User.is_active == True).first()`:
/// every mapped column, aliased `users_<column>` like SQLAlchemy's labeled
/// rendering.
const USER_BY_ID_QUERY: &str = "SELECT users.id AS users_id, \
     users.user_name AS users_user_name, \
     users.password_hash AS users_password_hash, users.email AS users_email, \
     users.git_info AS users_git_info, users.is_active AS users_is_active, \
     users.`role` AS users_role, users.auth_source AS users_auth_source, \
     users.preferences AS users_preferences, users.created_at AS users_created_at, \
     users.updated_at AS users_updated_at \
     FROM users \
     WHERE users.id = ? AND users.is_active = true \
     LIMIT 1";

/// The `decode_share_token` result fields `_validate_share_token_access`
/// consumes (`TaskShareInfo.user_id` / `.task_id`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShareInfo {
    pub user_id: i64,
    pub task_id: i64,
}

/// `_validate_share_token_access`: the same attachment access the source
/// applies for a public shared-task viewer.
///
/// `Ok(true)` grants access; `Ok(false)` is the source's `False` (rendered as
/// the handler's 404); `Err` is a MySQL failure the source leaves unhandled.
pub(super) async fn validate_share_token_access(
    state: &Arc<AppState>,
    attachment_id: i64,
    share_token: &str,
    viewer_id: Option<i64>,
) -> Result<bool, FastApiError> {
    let Some(share_info) = decode_share_token(state, share_token, viewer_id).await? else {
        return Ok(false);
    };

    let context = context_store::get_context_optional(&state.mysql, attachment_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token context lookup failed");
            internal_error()
        })?;
    let Some(context) = context else {
        return Ok(false);
    };
    if context.context_type != CONTEXT_TYPE_ATTACHMENT {
        return Ok(false);
    }

    // An unlinked upload is not part of this shared task, even with the same owner.
    if context.subtask_id <= 0 {
        return Ok(false);
    }

    // `subtask_store.get_by_id`: the full projection; a returned row then
    // triggers the source's `subqueryload(Subtask.contexts)` batch (an
    // inline-id read against the base `subtask_contexts` table).
    let subtask = context_store::get_subtask_by_id(&*state.task_store, context.subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token subtask lookup failed");
            internal_error()
        })?;
    let Some(subtask) = subtask else {
        return Ok(false);
    };
    load_subtask_contexts(&state.mysql, context.subtask_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token subtask context load failed");
            internal_error()
        })?;
    if subtask.task_id != share_info.task_id {
        return Ok(false);
    }

    // `task_store.get_owned_task_by_state`: the active task owned by the token
    // user.
    let owned = state
        .task_store
        .get_active_task_owned(share_info.task_id, share_info.user_id as i32)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token task ownership lookup failed");
            internal_error()
        })?;
    Ok(owned.is_some())
}

/// `SharedTaskService.decode_share_token(share_token, db)`: `Ok(None)` for
/// every decode/parse or user/task lookup failure; `Err` only when a lookup
/// itself fails.
async fn decode_share_token(
    state: &Arc<AppState>,
    share_token: &str,
    viewer_id: Option<i64>,
) -> Result<Option<ShareInfo>, FastApiError> {
    let share_link = crate::share_access::find_task_share_link(state, share_token)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token link lookup failed");
            internal_error()
        })?;
    let Some(link) = share_link else {
        return Ok(None);
    };
    crate::share_access::require_task_access(
        state,
        link.token_version,
        link.resource_id,
        viewer_id,
    )
    .await?;
    let info = ShareInfo {
        user_id: link.created_by_user_id,
        task_id: link.resource_id,
    };

    let user: Option<UserRow> = state
        .mysql
        .fetch_optional(USER_BY_ID_QUERY, (info.user_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token user lookup failed");
            internal_error()
        })?;
    let task = state
        .task_store
        .get_active_task(info.task_id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "share-token task lookup failed");
            internal_error()
        })?;
    if user.is_none() || task.is_none() {
        return Ok(None);
    }
    Ok(Some(info))
}

/// `subqueryload(Subtask.contexts)`: the contexts of one subtask, the source
/// renders the subtask id as an inline literal inside a comma-separated list
/// (as `ShardedSubtaskStore` does), ordered by `id`.
async fn load_subtask_contexts(
    mysql: &brz_mysql::MysqlService,
    subtask_id: i64,
) -> MysqlResult<()> {
    let sql = format!(
        "SELECT {} \
         FROM subtask_contexts \nWHERE subtask_contexts.subtask_id IN ({subtask_id}) \
         ORDER BY subtask_contexts.id ASC",
        crate::task_store::subtask_context_columns()
    );
    let _: Vec<MysqlRow> = mysql.fetch_all(&sql, ()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn hashes_the_raw_token_with_sha256() {
        assert_eq!(
            crate::share_access::token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
