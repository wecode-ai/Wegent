// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Python-compatible local rows for authorized external Issue binding flows.

use serde_json::json;

use crate::background_jobs::project::store;
use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::assignments::{internal, require_cloud_project_role, visible_provider_issue};

pub(super) async fn create(
    state: &AppState,
    project_id: &str,
    item_id: &str,
    user_id: i32,
) -> Result<(), FastApiError> {
    let access = require_cloud_project_role(state, project_id, user_id).await?;
    let (issue, response) = visible_provider_issue(state, &access, item_id, user_id).await?;
    let description = issue.description(&access.project.task_provider());
    let item = response.into_loop_items();
    let values = json!({
        "id": item.id,
        "cloud_project_id": item.cloud_project_id,
        "parent_id": item.parent_id,
        "title": item.title,
        "description": description,
        "sequence_number": item.sequence_number,
        "created_by_user_id": item.created_by_user_id,
        "assignee_user_id": item.assignee_user_id,
        "status": item.status,
        "priority": item.priority,
        "sort_order": item.sort_order,
        "metadata": {"tags": item.tags, "external_shadow": true},
        "version": item.version,
    });
    state
        .mysql
        .with_transaction(async |transaction| {
            // The unique Issue id serializes concurrent first readers. Keep
            // the winning row's content, metadata and version on a replay.
            store::insert_once(transaction, "task", values).await
        })
        .await
        .map_err(internal)
}

#[cfg(test)]
#[path = "external_shadow_mysql_tests.rs"]
mod mysql_tests;
