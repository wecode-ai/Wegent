// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/attachments` — list task attachments.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_attachments`:
//! `loop_item_attachment_provider_router.list(db, item_id, current_user.id)`
//! serialized as `LoopItemAttachmentResponse` rows.
use crate::board_snapshot::repository::BoardSnapshotRepository;
use crate::loop_tasks::auth::FlexibleUser;
use crate::loop_tasks::http_error::HttpError;
use crate::loop_tasks::loop_repository::{LoopItemRepository, has_permission};
use crate::state::AppState;

use super::external;
use super::repository::{AttachmentTaskRow, get_task_item, list_attachments};
use super::response::AttachmentResponse;

/// GET /api/v1/loop-items/{item_id}/attachments: the loop-items free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/loop-items/:item_id/attachments")]
async fn list_loop_item_attachments(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<Vec<AttachmentResponse>, HttpError> {
    loop_item_attachments(state, item_id, &current_user).await
}

/// Handler body for `GET /api/v1/loop-items/{item_id}/attachments`.
async fn loop_item_attachments(
    state: &AppState,
    item_id: &str,
    current_user: &FlexibleUser,
) -> Result<Vec<AttachmentResponse>, HttpError> {
    let repository = LoopItemRepository::new(&state.mysql);

    // `loop_item_attachment_provider_router.list`:
    // `external_loop_item_provider.is_external_item(db, item_id)`.
    let external_project = repository
        .find_external_project(item_id)
        .await
        .map_err(HttpError::internal)?;
    if let Some(project) = external_project {
        return external::list_external_attachments(state, item_id, &project, current_user.id)
            .await;
    }

    // `loop_item_service.list_attachments`: `self.get` (the task row plus the
    // view gate) then the attachment rows.
    let item = get_task_item(&state.mysql, item_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::todo_not_found)?;
    require_item_view_access(state, &item, current_user.id).await?;
    let rows = list_attachments(&state.mysql, item_id)
        .await
        .map_err(HttpError::internal)?;
    Ok(rows.iter().map(AttachmentResponse::from_row).collect())
}

/// `LoopItemService._require_item_access` (view path):
/// `require_cloud_project_role(db, item.cloud_project_id, user_id, Viewer)`
/// then `_item_permissions` -> `can_view_item`.
///
/// `can_view_item` passes maintainers unconditionally; every other resolved
/// role passes when the item's effective security is `open`, or when the
/// caller is related to the item.
pub(super) async fn require_item_view_access(
    state: &AppState,
    item: &AttachmentTaskRow,
    user_id: i32,
) -> Result<(), HttpError> {
    let project_number: i64 = item
        .cloud_project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    let access = BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_number, user_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    let role = access.role.as_str();

    if has_permission(role, "Maintainer") {
        return Ok(());
    }

    // `item_security(item, project)`: the item's explicit level when it is a
    // known value, otherwise the project default (`default_issue_security`).
    let default_security = access.project.default_issue_security();
    let security = match item.security_level() {
        Some(level) if level == "open" || level == "related" => level,
        _ => default_security,
    };
    if security == "open" {
        return Ok(());
    }
    if LoopItemRepository::new(&state.mysql)
        .is_related_item(&item.id, user_id)
        .await
        .map_err(HttpError::internal)?
    {
        return Ok(());
    }
    Err(HttpError::todo_not_found())
}
