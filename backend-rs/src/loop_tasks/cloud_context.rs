// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/runtime-tasks/cloud-context` — resolve the cloud project and
//! loop item bound to a runtime task.
//!
//! Mirrors `app.api.endpoints.deliveries.find_runtime_task_cloud_context`:
//! `security.get_current_user` (JWT session decode plus the `users` lookup),
//! then `loop_item_service.find_cloud_context(db, current_user.id, device_id,
//! task_id)`, which loads the active `LoopItemTaskBinding`, the bound
//! `CloudProject`, and (when present) the `LoopItem`. The handler returns a
//! `CloudTaskContextBody` built from `binding.__dict__` plus the project
//! (`cloud_project_service.access` role) and the loop item
//! (`loop_item_service.response_values`).
use chrono::NaiveDateTime;
use serde::Serialize;

use super::http_error::HttpError;
use super::item_response::{LoopItemResponse, ProjectFacts, response_values};
use super::loop_repository::{LoopItemRepository, datetime_is_unset};
use crate::auth::SessionUser;
use crate::board_snapshot::repository::BoardSnapshotRepository;
use crate::cloud_projects;
use crate::state::AppState;

/// GET /api/v1/runtime-tasks/cloud-context: the cloud-context free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/runtime-tasks/cloud-context")]
async fn find_runtime_task_cloud_context(
    #[inject(state)] state: &AppState,
    device_id: &str,
    task_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<CloudTaskContextBody, HttpError> {
    cloud_context(state, device_id, task_id, &current_user).await
}

/// Handler body for `GET /api/v1/runtime-tasks/cloud-context`.
async fn cloud_context(
    state: &AppState,
    device_id: &str,
    task_id: &str,
    current_user: &SessionUser,
) -> Result<CloudTaskContextBody, HttpError> {
    let repository = LoopItemRepository::new(&state.mysql);
    let binding = repository
        .find_cloud_context_binding(current_user.id, device_id, task_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_context_not_found)?;

    // `db.get(CloudProject, binding.cloud_project_id)` plus
    // `require_cloud_project_role(db, project.id, user_id, RestrictedAnalyst)`.
    let project = repository
        .get_cloud_project(&binding.cloud_project_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    let project_number: i64 = binding
        .cloud_project_id
        .parse()
        .map_err(|_| HttpError::cloud_project_not_found())?;
    // `find_cloud_context`'s `require_cloud_project_role` guard. The resolved
    // role always satisfies `RestrictedAnalyst`, so this call cannot raise 403.
    let _ = project_access_role(state, project_number, current_user.id).await?;

    // `db.get(LoopItem, binding.loop_item_id) when binding.loop_item_id`.
    // The binding's `loop_item_id` is normalized to `None` for empty strings
    // (source `normalize_empty_text`), matching the source guard.
    let item_row = match normalize_empty_text(binding.loop_item_id.as_deref()) {
        Some(item_id) => repository
            .get_task_item_full(&item_id)
            .await
            .map_err(HttpError::internal)?,
        None => None,
    };

    // `cloud_project_service.access(db, project.id, current_user.id).role` for
    // the response body's `access_role`.
    let role = project_access_role(state, project_number, current_user.id).await?;

    let visibility = project_visibility(&project);
    let facts = ProjectFacts {
        number: project_number,
        visibility: &visibility,
        provider_is_local: project_task_provider(&project) == "local",
        created_by_user_id: project.created_by_user_id,
    };
    let loop_item = match item_row {
        Some(item) => Some(response_values(state, &item, current_user, &facts).await?),
        None => None,
    };

    Ok(CloudTaskContextBody {
        id: binding.id.clone(),
        cloud_project_id: binding.cloud_project_id.clone(),
        loop_item_id: normalize_empty_text(binding.loop_item_id.as_deref()),
        task_user_id: binding.task_user_id,
        device_id: binding.device_id.clone(),
        task_id: binding.task_id.clone(),
        task_title: normalize_empty_text(binding.task_title.as_deref()),
        backend_task_id: normalize_backend_task_id(binding.backend_task_id),
        model_selection: binding.model_selection(),
        workflow_node_id: binding.workflow_node_id(),
        change_requests: binding.change_requests(),
        linked_by_user_id: binding.linked_by_user_id,
        linked_at: datetime_value(binding.linked_at),
        unlinked_at: match binding.unlinked_at {
            Some(value) if !datetime_is_unset(binding.unlinked_at) => datetime_value(Some(value)),
            _ => None,
        },
        project: ProjectProjection::from_body(cloud_projects::CloudProjectBody::from_project(
            &project,
            current_user.id,
            &current_user.user_name,
            &role,
        )),
        loop_item,
    })
}

/// `require_cloud_project_role(db, project_id, user_id, RestrictedAnalyst)`:
/// the set-based `project_access_query`, reduced to one row. Returns `404
/// "Cloud project not found"` when no grant resolves.
async fn project_access_role(
    state: &AppState,
    project_number: i64,
    user_id: i32,
) -> Result<String, HttpError> {
    BoardSnapshotRepository::new(&state.mysql)
        .require_cloud_project_role(project_number, user_id)
        .await
        .map_err(HttpError::internal)?
        .map(|access| access.role)
        .ok_or_else(HttpError::cloud_project_not_found)
}

/// `CloudProject.visibility`: the metadata value within the known set,
/// otherwise `private`.
fn project_visibility(project: &cloud_projects::ProjectListRow) -> String {
    let value = project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.visibility.as_deref());
    match value {
        Some("public") => "public",
        Some("public_restricted") => "public_restricted",
        _ => "private",
    }
    .to_string()
}

/// `CloudProject.task_provider`: the metadata value within the known set,
/// otherwise `local`.
fn project_task_provider(project: &cloud_projects::ProjectListRow) -> String {
    let known = ["local", "github", "gitlab", "dingtalk_aitable"];
    project
        .metadata
        .as_ref()
        .and_then(|json| json.0.value.as_ref())
        .and_then(|metadata| metadata.task_provider.as_deref())
        .filter(|provider| known.contains(provider))
        .unwrap_or("local")
        .to_string()
}

/// `CloudTaskContextResponse` body: the binding fields plus the project and
/// (optional) loop item. Field declaration order follows the source pydantic
/// model (`LoopItemTaskBindingResponse` then the `CloudTaskContextResponse`
/// extras).
#[derive(Debug, Serialize)]
struct CloudTaskContextBody {
    id: String,
    cloud_project_id: String,
    loop_item_id: Option<String>,
    task_user_id: i32,
    device_id: String,
    task_id: String,
    task_title: Option<String>,
    backend_task_id: Option<i64>,
    #[serde(rename = "modelSelection")]
    model_selection: Option<serde_json::Value>,
    workflow_node_id: Option<String>,
    change_requests: Vec<serde_json::Value>,
    linked_by_user_id: i32,
    linked_at: Option<String>,
    unlinked_at: Option<String>,
    project: ProjectProjection,
    loop_item: Option<LoopItemResponse>,
}

/// Reuse the shared typed cloud-project response.
#[derive(Debug, Serialize)]
struct ProjectProjection(cloud_projects::CloudProjectBody);

impl ProjectProjection {
    /// Build the projection from a cloud-projects renderer body.
    fn from_body(body: cloud_projects::CloudProjectBody) -> Self {
        Self(body)
    }
}

/// `normalize_empty_text`: `""` becomes `None`.
fn normalize_empty_text(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

/// `normalize_empty_task_id`: `0` becomes `None` (source field validator).
fn normalize_backend_task_id(value: i64) -> Option<i64> {
    (value != 0).then_some(value)
}

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero.
fn datetime_value(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_empty_text() {
        assert_eq!(normalize_empty_text(Some("")), None);
        assert_eq!(normalize_empty_text(None), None);
        assert_eq!(normalize_empty_text(Some("x")), Some("x".to_string()));
    }

    #[test]
    fn normalizes_zero_backend_task_id() {
        assert_eq!(normalize_backend_task_id(0), None);
        assert_eq!(normalize_backend_task_id(7), Some(7));
    }

    #[test]
    fn renders_linked_at_with_t_separator() {
        let value = NaiveDateTime::parse_from_str("2026-09-04 07:23:14", "%Y-%m-%d %H:%M:%S").ok();
        assert_eq!(
            datetime_value(value),
            Some("2026-09-04T07:23:14".to_string())
        );
    }

    #[test]
    fn project_visibility_and_provider_fall_back_to_defaults() {
        let project = cloud_projects::ProjectListRow {
            id: "1".to_string(),
            public_id: None,
            project_key: None,
            name: None,
            description: None,
            created_by_user_id: 0,
            status: "active".to_string(),
            version: 1,
            created_at: None,
            updated_at: None,
            metadata: None,
        };
        assert_eq!(project_visibility(&project), "private");
        assert_eq!(project_task_provider(&project), "local");
    }
}
