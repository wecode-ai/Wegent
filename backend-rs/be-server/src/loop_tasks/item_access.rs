// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `LoopItemService._require_item_access`: the project-role and per-item
//! visibility and native Issue invitation guard shared by the loop-item reads.
//!
//! The guard resolves the caller's effective project role, re-reads the
//! project entity, and applies `can_view_item` (maintainers see every item;
//! everyone else needs an `open` item or a related-item relationship).
use super::http_error::HttpError;
use super::loop_repository::{LoopItemRepository, TaskItemFullRow, has_permission};
use crate::cloud_projects::members;
use crate::cloud_projects::{CloudMetadataInput, project_access_details, role_for_priority};
use crate::state::AppState;

pub(crate) struct ItemReadAccess {
    pub project: members::ProjectEntityRow,
    pub invited_only: bool,
}

/// Resolve project access or a current invitation for this Issue.
pub(crate) async fn require_item_access(
    state: &AppState,
    item: &TaskItemFullRow,
    user_id: i32,
) -> Result<ItemReadAccess, HttpError> {
    // `collaboration_permission_service.check` rejects a non-decimal
    // `cloud_project_id` before any statement runs (404, not 422).
    let project_number: i64 = item
        .cloud_project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;

    // The access point statement plus the caller's permission-source reads.
    let access = project_access_details(&state.mysql, project_number, user_id)
        .await
        .map_err(HttpError::internal)?;
    let role = access
        .map(|access| role_for_priority(access.priority).ok_or_else(HttpError::internal_detail))
        .transpose()?;
    if role.is_some_and(|role| !has_permission(role, "Viewer")) {
        return Err(HttpError::insufficient_permission());
    }

    let invited_only = !role.is_some_and(|role| has_permission(role, "Developer"))
        && super::issue_invitation::permits_read(&state.mysql, &item.id, user_id)
            .await
            .map_err(HttpError::internal)?;
    if !invited_only && role.is_none() {
        return Err(HttpError::cloud_project_not_found());
    }

    // The project metadata feeds `item_security` and the response projection.
    let project = members::project_entity(&state.mysql, project_number)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::internal_detail)?;

    // `can_view_item`: Maintainer+ sees any item; everyone else needs an
    // invitation, an `open` item or a related-item relationship.
    if !invited_only
        && !role.is_some_and(|role| has_permission(role, "Maintainer"))
        && item_security(item, &project) != "open"
        && !LoopItemRepository::new(&state.mysql)
            .is_related_item(&item.id, user_id)
            .await
            .map_err(HttpError::internal)?
    {
        return Err(HttpError::todo_not_found());
    }
    Ok(ItemReadAccess {
        project,
        invited_only,
    })
}

/// `item_security(item, project)`: the item's stored `security_level` when it
/// is one of the known levels, otherwise the project's default.
pub(crate) fn item_security(
    item: &TaskItemFullRow,
    project: &members::ProjectEntityRow,
) -> &'static str {
    let level = item
        .metadata()
        .and_then(|metadata| metadata.security_level.as_ref())
        .and_then(serde_json::Value::as_str);
    match level {
        Some("open") => "open",
        Some("related") => "related",
        _ if default_issue_security(project) == "related" => "related",
        _ => "open",
    }
}

/// `default_issue_security(project)`: `related` only when the project
/// metadata sets it, otherwise `open`.
pub(crate) fn default_issue_security(project: &members::ProjectEntityRow) -> &'static str {
    let value = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata: &CloudMetadataInput| metadata.default_issue_security.as_deref());
    if value == Some("related") {
        "related"
    } else {
        "open"
    }
}

/// `project.visibility`: the metadata value, defaulting to `private`.
pub(crate) fn project_visibility(project: &members::ProjectEntityRow) -> String {
    project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata: &CloudMetadataInput| metadata.visibility.clone())
        .unwrap_or_else(|| "private".to_string())
}

/// `project.task_provider`: the metadata value when it is one of the known
/// providers, otherwise `local`.
pub(crate) fn project_task_provider(project: &members::ProjectEntityRow) -> String {
    const KNOWN: [&str; 4] = ["local", "github", "gitlab", "dingtalk_aitable"];
    project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata: &CloudMetadataInput| metadata.task_provider.as_deref())
        .filter(|provider| KNOWN.contains(provider))
        .unwrap_or("local")
        .to_string()
}
