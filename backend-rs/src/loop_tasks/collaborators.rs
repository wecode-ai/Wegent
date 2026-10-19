// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/collaborators` — the collaborators of
//! one loop item.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_collaborators` and
//! its call graph:
//!
//! 1. `loop_item_service.list_collaborators(db, item_id, user_id)` first
//!    calls `self.get(db, item_id, user_id)`: `_get_item_row` reads the task
//!    row (absent or deleted -> 404 "TODO not found"), then
//!    `_require_item_access` runs `require_cloud_project_role(Viewer)` (the
//!    set-based `project_access_query` statement; no grant -> 404 "Cloud
//!    project not found", a role below Viewer -> 403) followed by
//!    `can_view_item` (Maintainer+ sees any item; an `open` item passes;
//!    otherwise `is_related_item` decides, 404 on failure).
//! 2. The collaborator rows are read joined with `users` on
//!    `loop_items.user_id`, ordered by `created_at, id`, and rendered as
//!    `LoopItemCollaboratorResponse` values.
use brz_http_server::StatusCode;
use brz_json::JsonProjection;
use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};
use chrono::NaiveDateTime;
use serde::Serialize;

use crate::cloud_projects::{LOOP_ITEMS_COLUMNS, ProjectListRow, role_for_priority};
use crate::cloud_projects_members::access_project;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::user_reader::users_projection;

use super::loop_repository::{LoopItemRepository, has_permission};
use crate::auth::SessionUser;

/// GET /api/v1/loop-items/{item_id}/collaborators.
#[brz_http_server::get("/api/v1/loop-items/:item_id/collaborators")]
async fn list_loop_item_collaborators(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<Vec<CollaboratorResponse>, FastApiError> {
    collaborators(&state.mysql, item_id, current_user.id).await
}

/// Handler body for `GET /api/v1/loop-items/{item_id}/collaborators`.
async fn collaborators<M>(
    mysql: &M,
    item_id: &str,
    user_id: i32,
) -> Result<Vec<CollaboratorResponse>, FastApiError>
where
    M: Mysql,
{
    // `LoopItemService.get` -> `_get_item_row`.
    let item = find_task_item(mysql, item_id)
        .await
        .map_err(internal)?
        .ok_or_else(todo_not_found)?;

    // `_require_item_access` (view path; no issue action).
    require_item_access(mysql, &item, user_id).await?;

    // `list_collaborators` rows.
    let rows = list_collaborator_rows(mysql, item_id)
        .await
        .map_err(internal)?;
    rows.iter().map(collaborator_response).collect()
}

/// `require_cloud_project_role(Viewer)` + `can_view_item`
/// (`LoopItemService._require_item_access` with no action).
async fn require_item_access<M>(
    mysql: &M,
    item: &TaskItemRow,
    user_id: i32,
) -> Result<(), FastApiError>
where
    M: Mysql,
{
    // `collaboration_permission_service.check` rejects a non-decimal
    // `cloud_project_id` before any statement runs.
    let project_number: i64 = item
        .cloud_project_id
        .as_deref()
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse().ok())
        .ok_or_else(cloud_project_not_found)?;

    // `project_access_query` point form: the project row and the caller's
    // aggregated role priority in one statement.
    let Some((project, priority)) = access_project(mysql, project_number, user_id)
        .await
        .map_err(internal)?
    else {
        return Err(cloud_project_not_found());
    };
    let Some(role) = role_for_priority(priority) else {
        return Err(FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ));
    };
    if !has_permission(role, "Viewer") {
        return Err(FastApiError::forbidden("Insufficient permission"));
    }

    // `can_view_item(db, access, item, user_id)`.
    if !has_permission(role, "Maintainer") && item_security(item, &project) != "open" {
        let related = LoopItemRepository::new(mysql)
            .is_related_item(&item.id, user_id)
            .await
            .map_err(internal)?;
        if !related {
            return Err(todo_not_found());
        }
    }
    Ok(())
}

/// `LoopItemService._get_item_row`: the full labeled `loop_items` task
/// projection, deleted rows excluded, with the implicit `LIMIT 1`.
async fn find_task_item<M>(mysql: &M, item_id: &str) -> MysqlResult<Option<TaskItemRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            &format!(
                "SELECT {LOOP_ITEMS_COLUMNS} \nFROM loop_items \n\
                 WHERE loop_items.id = '{item_id}' \
                 AND (loop_items.deleted_at IS NULL OR loop_items.deleted_at IN \
                     ('1970-01-01 00:00:00', '1970-01-01 00:00:01')) \
                 AND loop_items.resource_type IN ('task') \n LIMIT 1"
            ),
            (),
        )
        .await
}

/// `db.query(LoopItemCollaborator, User).join(User, User.id ==
/// LoopItemCollaborator.user_id)` ordered by `created_at, id`.
async fn list_collaborator_rows<M>(mysql: &M, item_id: &str) -> MysqlResult<Vec<CollaboratorRow>>
where
    M: Mysql,
{
    mysql
        .fetch_all(
            &format!(
                "SELECT {LOOP_ITEMS_COLUMNS}, {} \nFROM loop_items INNER JOIN users \
                 ON users.id = loop_items.user_id \n\
                 WHERE loop_items.loop_item_id = '{item_id}' \
                 AND loop_items.resource_type IN ('collaborator') \
                 ORDER BY loop_items.created_at, loop_items.id",
                users_projection(),
            ),
            (),
        )
        .await
}

/// `item_security(item, project)` (`app.services.loop_items.access`): the
/// item's explicit `security_level` when it is one of the known levels,
/// otherwise the project default.
fn item_security(item: &TaskItemRow, project: &ProjectListRow) -> &'static str {
    let level = item
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.security_level.as_deref());
    match level {
        Some("open") => "open",
        Some("related") => "related",
        _ if default_issue_security(project) == "related" => "related",
        _ => "open",
    }
}

/// `default_issue_security(project)`: `related` only when the project
/// metadata sets it, otherwise `open`.
fn default_issue_security(project: &ProjectListRow) -> &'static str {
    let value = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.default_issue_security.as_deref());
    if value == Some("related") {
        "related"
    } else {
        "open"
    }
}

/// `LoopItemCollaboratorResponse` (`app.schemas.delivery`).
#[derive(Debug, Serialize)]
struct CollaboratorResponse {
    id: String,
    loop_item_id: String,
    user_id: i32,
    user_name: String,
    email: Option<String>,
    source: String,
    added_by_user_id: i32,
    created_at: String,
}

/// Render one collaborator row.
fn collaborator_response(row: &CollaboratorRow) -> Result<CollaboratorResponse, FastApiError> {
    Ok(CollaboratorResponse {
        id: row.id.clone(),
        loop_item_id: row.loop_item_id.clone().unwrap_or_default(),
        user_id: row.user_id.unwrap_or(0),
        user_name: row.user_name.clone(),
        email: row.email.clone(),
        source: row.source.clone().unwrap_or_default(),
        added_by_user_id: row.added_by_user_id.unwrap_or(0),
        created_at: datetime_value(row.created_at)?,
    })
}

/// Pydantic naive-`datetime` serialization: `isoformat()` without an offset,
/// with microseconds only when nonzero.
fn datetime_value(value: Option<NaiveDateTime>) -> Result<String, FastApiError> {
    let Some(value) = value else {
        return Err(FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal server error",
        ));
    };
    let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    if value.and_utc().timestamp_subsec_nanos() == 0 {
        Ok(base)
    } else {
        Ok(format!(
            "{base}.{:06}",
            value.and_utc().timestamp_subsec_micros()
        ))
    }
}

/// The `loop_items` task row fields consumed by the access check.
#[derive(Debug, FromMysqlRow)]
struct TaskItemRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_cloud_project_id")]
    cloud_project_id: Option<String>,
    #[mysql(rename = "loop_items_metadata")]
    metadata: Option<Json<JsonProjection<SecurityMetadata>>>,
}

/// `LoopItem.metadata_json` fields read by `item_security`.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default)]
struct SecurityMetadata {
    security_level: Option<String>,
}

/// One `db.query(LoopItemCollaborator, User)` row: the full labeled
/// `loop_items` and `users` projections; only the response fields are typed.
#[derive(Debug, FromMysqlRow)]
struct CollaboratorRow {
    #[mysql(rename = "loop_items_id")]
    id: String,
    #[mysql(rename = "loop_items_loop_item_id")]
    loop_item_id: Option<String>,
    #[mysql(rename = "loop_items_user_id")]
    user_id: Option<i32>,
    #[mysql(rename = "loop_items_added_by_user_id")]
    added_by_user_id: Option<i32>,
    #[mysql(rename = "loop_items_source")]
    source: Option<String>,
    #[mysql(rename = "loop_items_created_at")]
    created_at: Option<NaiveDateTime>,
    #[mysql(rename = "users_user_name")]
    user_name: String,
    #[mysql(rename = "users_email")]
    email: Option<String>,
}

fn todo_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "TODO not found")
}

fn cloud_project_not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Cloud project not found")
}

fn internal(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "loop-items collaborators dependency failure");
    FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

#[cfg(test)]
#[path = "collaborators_tests.rs"]
mod tests;
