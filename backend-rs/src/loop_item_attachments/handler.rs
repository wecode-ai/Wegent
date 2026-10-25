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
    let repository = BoardSnapshotRepository::new(&state.mysql);
    let access = repository
        .require_cloud_project_role(project_number, user_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    // `db.get(CloudProject, str(project_id))` runs after the role query and
    // before the required-role comparison; the row is request-owned even
    // though only the access role and project metadata are consumed.
    repository
        .project_entity(project_number)
        .await
        .map_err(HttpError::internal)?;
    let role = access.role.as_str();

    // `require_cloud_project_role(..., BaseRole.Viewer)`: a caller below
    // `Viewer` (RestrictedAnalyst) is `403 "Insufficient permission"`.
    if !has_permission(role, "Viewer") {
        return Err(HttpError::insufficient_permission());
    }

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

#[cfg(test)]
mod tests {
    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/v1/loop-items/:item_id/attachments";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(
            !config
                .routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "GET")),
            "GET {PATH} must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(
            &http::Method::GET,
            "/api/v1/loop-items/WEWORK2D8526-22/attachments"
        ));

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let registered = brz_http_server::__private::inventory::iter::<
            crate::__http_registry_http_apis::Entry,
        >()
        .flat_map(|entry| (entry.0.routes)())
        .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }
}
