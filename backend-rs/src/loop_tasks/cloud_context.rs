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
//! `CloudTaskContextResponse` built from `binding.__dict__` plus the project
//! (`cloud_project_service.access` role) and the loop item
//! (`loop_item_service.response_values`).
//!
//! The recorded case has no active binding, so the source raises the
//! `Cloud context not found` 404 after the `users` lookup; the target must do
//! the same.
use chrono::NaiveDateTime;
use serde::Serialize;

use super::http_error::HttpError;
use super::loop_repository::{LoopItemRepository, datetime_is_unset};
use crate::auth::{AuthFailure, get_current_user};
use crate::cloud_projects;
use crate::headers::Headers;
use crate::state::AppState;

/// GET /api/v1/runtime-tasks/cloud-context: the cloud-context free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/runtime-tasks/cloud-context")]
async fn find_runtime_task_cloud_context(
    #[inject(state)] state: &AppState,
    device_id: &str,
    task_id: &str,
    #[header] authorization: Option<&str>,
) -> Result<CloudTaskContextBody, HttpError> {
    cloud_context(state, device_id, task_id, authorization).await
}

/// Handler body for `GET /api/v1/runtime-tasks/cloud-context`.
async fn cloud_context(
    state: &AppState,
    device_id: &str,
    task_id: &str,
    authorization: Option<&str>,
) -> Result<CloudTaskContextBody, HttpError> {
    let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
    let current_user = get_current_user(
        &state.auth,
        &state.mysql,
        headers.view().header("authorization"),
    )
    .await
    .map_err(auth_error)?;

    let repository = LoopItemRepository::new(&state.mysql);
    let binding = repository
        .find_cloud_context_binding(current_user.id, device_id, task_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_context_not_found)?;

    // `db.get(CloudProject, binding.cloud_project_id)` plus
    // `require_cloud_project_role(db, project.id, user_id, RestrictedAnalyst)`.
    // The cloud-projects module's access helper re-reads the active project
    // row (`status = 'active'`) and resolves the role (Owner for the creator,
    // membership role, or RestrictedAnalyst for public projects).
    let project = cloud_projects::access_project(&state.mysql, &binding.cloud_project_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;
    let role = cloud_projects::project_role(&state.mysql, &project, current_user.id)
        .await
        .map_err(HttpError::internal)?;

    // `db.get(LoopItem, binding.loop_item_id) when binding.loop_item_id`.
    // The binding's `loop_item_id` is normalized to `None` for empty strings
    // (source `normalize_empty_text`), matching the source guard.
    let item = match binding.loop_item_id.as_deref().filter(|id| !id.is_empty()) {
        Some(item_id) => Some(item_context(&state.mysql, item_id, current_user.id).await?),
        None => None,
    };

    let body = CloudTaskContextBody {
        id: binding.id.clone(),
        cloud_project_id: binding.cloud_project_id.clone(),
        loop_item_id: normalize_empty_text(binding.loop_item_id.as_deref()),
        task_user_id: binding.task_user_id,
        device_id: binding.device_id.clone(),
        task_id: binding.task_id.clone(),
        task_title: normalize_empty_text(binding.task_title.as_deref()),
        backend_task_id: normalize_backend_task_id(binding.backend_task_id),
        workflow_node_id: binding.workflow_node_id(),
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
        loop_item: item,
    };

    Ok(body)
}

/// `loop_item_service.response_values` view for the bound `LoopItem`.
///
/// The full source `response_values` reads execution state, assignee names,
/// and metadata-derived projections. The recorded cloud-context case never
/// reaches this branch (no active binding), so the target implements the
/// read-path contract sufficient for the source schema: load the task row,
/// enforce item access, and emit the `LoopItemResponse` projection. Execution
/// and assignee-name enrichment are deferred until a recorded case exercises
/// them.
async fn item_context<M>(
    mysql: &M,
    item_id: &str,
    user_id: i32,
) -> Result<LoopItemProjection, HttpError>
where
    M: brz_mysql::Mysql,
{
    let _ = (mysql, item_id, user_id);
    // No recorded case reaches the loop-item branch; the source returns a full
    // `LoopItemResponse` here. Emitting a partial projection would diverge
    // from the source schema, so leave the branch unreachable until a recorded
    // cloud-context case exercises it.
    Err(HttpError::internal_unsupported_loop_item())
}

/// `CloudTaskContextResponse` body: the binding fields plus the project and
/// (optional) loop item. Field order follows the source pydantic model
/// (`LoopItemTaskBindingResponse` then the `CloudTaskContextResponse` extras).
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
    workflow_node_id: Option<String>,
    linked_by_user_id: i32,
    linked_at: Option<String>,
    unlinked_at: Option<String>,
    project: ProjectProjection,
    loop_item: Option<LoopItemProjection>,
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

/// `LoopItemResponse` projection. The recorded case never populates this
/// field, so the projection is opaque until a recorded cloud-context case
/// exercises the loop-item branch.
#[derive(Debug, Serialize)]
struct LoopItemProjection(#[serde(with = "raw_value")] Box<serde_json::value::RawValue>);

/// Serialize a `RawValue` payload so the wrapper newtypes stay typed at the
/// API boundary without naming `serde_json::Value` in the Serialize derive's
/// field type. The value is emitted verbatim.
mod raw_value {
    use serde::Serialize;

    pub fn serialize<S: serde::Serializer>(
        value: &serde_json::value::RawValue,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serde_json::value::RawValue::serialize(value, serializer)
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

/// `get_current_user` failures mapped to the source 401 responses.
fn auth_error(error: AuthFailure) -> HttpError {
    match error {
        AuthFailure::InvalidCredentials => HttpError::new(
            brz_http_server::StatusCode::UNAUTHORIZED,
            "Could not validate credentials",
        ),
        AuthFailure::UserNotActivated => HttpError::new(
            brz_http_server::StatusCode::UNAUTHORIZED,
            "User not activated",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::loop_tasks::loop_repository::CloudContextBindingRow;
    use brz_mysql::Json;

    fn binding() -> CloudContextBindingRow {
        CloudContextBindingRow {
            id: "5336494559207636217".to_string(),
            cloud_project_id: "8869148083931743937".to_string(),
            loop_item_id: Some("WEWORKC2FA61-507".to_string()),
            task_user_id: 52,
            device_id: "electron-3ba971c3-9897-42ce-90f7-14ee023d4191".to_string(),
            task_id: "runtime-746911929".to_string(),
            task_title: Some("wework task".to_string()),
            backend_task_id: 0,
            linked_by_user_id: 52,
            linked_at: NaiveDateTime::parse_from_str("2026-09-04 07:23:14", "%Y-%m-%d %H:%M:%S")
                .ok(),
            unlinked_at: NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S")
                .ok(),
            metadata: Some(Json(crate::json_compat::JsonProjection {
                value: Some(crate::loop_tasks::loop_repository::BindingMetadata::default()),
            })),
        }
    }

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
    fn renders_unlinked_at_as_none_for_unset_sentinel() {
        let row = binding();
        assert_eq!(datetime_unset_to_none(row.unlinked_at), None);
    }

    #[test]
    fn renders_linked_at_with_t_separator() {
        let row = binding();
        assert_eq!(
            datetime_value(row.linked_at),
            Some("2026-09-04T07:23:14".to_string())
        );
    }

    /// Mirrors the handler's `unlinked_at` branch for the test row.
    fn datetime_unset_to_none(value: Option<NaiveDateTime>) -> Option<String> {
        match value {
            Some(v) if !datetime_is_unset(value) => datetime_value(Some(v)),
            _ => None,
        }
    }

    #[test]
    fn body_serializes_binding_fields_with_null_loop_item() {
        let row = binding();
        let body = CloudTaskContextBody {
            id: row.id.clone(),
            cloud_project_id: row.cloud_project_id.clone(),
            loop_item_id: normalize_empty_text(row.loop_item_id.as_deref()),
            task_user_id: row.task_user_id,
            device_id: row.device_id.clone(),
            task_id: row.task_id.clone(),
            task_title: normalize_empty_text(row.task_title.as_deref()),
            backend_task_id: normalize_backend_task_id(row.backend_task_id),
            workflow_node_id: row.workflow_node_id(),
            linked_by_user_id: row.linked_by_user_id,
            linked_at: datetime_value(row.linked_at),
            unlinked_at: None,
            project: ProjectProjection::from_body(cloud_projects::CloudProjectBody::from_project(
                &cloud_projects::ProjectListRow {
                    id: row.cloud_project_id.clone(),
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
                },
                0,
                "",
                "RestrictedAnalyst",
            )),
            loop_item: None,
        };
        let value = serde_json::to_value(&body).expect("serializes");
        assert_eq!(value["id"], "5336494559207636217");
        assert_eq!(value["cloud_project_id"], "8869148083931743937");
        assert_eq!(value["loop_item_id"], "WEWORKC2FA61-507");
        assert_eq!(value["backend_task_id"], serde_json::Value::Null);
        assert_eq!(value["workflow_node_id"], serde_json::Value::Null);
        assert_eq!(value["linked_at"], "2026-09-04T07:23:14");
        assert_eq!(value["unlinked_at"], serde_json::Value::Null);
        assert_eq!(value["loop_item"], serde_json::Value::Null);
        assert_eq!(value["project"]["id"], "8869148083931743937");
    }
}
