// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Current Issue reads and participation checks for human requests.

use super::{
    AppState, FastApiError, Issue, StatusCode, error, internal, require_cloud_project_role,
    require_issue_read_for_user,
};
use crate::loop_tasks::loop_repository::has_permission;
use brz_mysql::MysqlTransaction as _;

pub(super) async fn read_issue(
    state: &AppState,
    item: &str,
    user: i32,
) -> Result<Issue, FastApiError> {
    require_issue_read_for_user(state, item, user).await?;
    state
        .mysql
        .with_transaction(async |transaction| {
            transaction
                .fetch_optional(
                    "SELECT id,cloud_project_id,title,status,assignee_user_id,created_by_user_id,metadata \
                     FROM loop_items WHERE id=? AND resource_type='task' \
                     AND (deleted_at IS NULL OR deleted_at IN \
                     ('1970-01-01 00:00:00','1970-01-01 00:00:01'))",
                    (item,),
                )
                .await
        })
        .await
        .map_err(internal)?
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "Issue not found"))
}

pub(super) fn require_participation(issue: &Issue, role: &str) -> Result<(), FastApiError> {
    if !has_permission(role, "Developer") {
        return Err(error(
            StatusCode::FORBIDDEN,
            "Issue participation requires Developer access",
        ));
    }
    if matches!(
        issue.status.as_deref(),
        Some("completed" | "cancelled" | "archived")
    ) {
        return Err(error(StatusCode::CONFLICT, "Issue has ended"));
    }
    Ok(())
}

pub(super) async fn require_write(
    state: &AppState,
    issue: &Issue,
    user: i32,
) -> Result<(), FastApiError> {
    let access = require_cloud_project_role(state, &issue.cloud_project_id, user).await?;
    require_participation(issue, &access.role)
}
