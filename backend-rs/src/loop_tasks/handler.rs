// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/tasks` — list task bindings for a
//! loop item.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_tasks`:
//! `external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)`
//! then `loop_item_service.list_task_bindings(db, item_id, current_user.id)`,
//! serialized as `LoopItemTaskBindingResponse` rows.
use chrono::NaiveDateTime;
#[cfg(test)]
use serde_json::{Value, json};

use super::auth::get_current_user;
use super::http_error::HttpError;
use super::loop_repository::{BindingRow, LoopItemRepository, datetime_is_unset, has_permission};
use crate::state::AppState;

/// GET /api/v1/loop-items/{item_id}/tasks: the loop-items free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/loop-items/:item_id/tasks")]
async fn list_loop_item_tasks(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[header] authorization: Option<&str>,
) -> Result<Vec<BindingResponse>, HttpError> {
    loop_item_tasks(state, item_id, authorization).await
}

/// Handler body for `GET /api/v1/loop-items/{item_id}/tasks`.
async fn loop_item_tasks(
    state: &AppState,
    item_id: &str,
    authorization: Option<&str>,
) -> Result<Vec<BindingResponse>, HttpError> {
    let headers = crate::headers::OwnedHeaders::from_pairs([("authorization", authorization)]);
    let current_user = get_current_user(&state.auth, &state.mysql, &headers.view()).await?;

    let bindings = list_bindings(&state.mysql, item_id, current_user.id).await?;
    Ok(bindings.iter().map(binding_response).collect())
}

/// `ensure_shadow` + `list_task_bindings` with the source error mapping.
async fn list_bindings<M>(
    mysql: &M,
    item_id: &str,
    user_id: i32,
) -> Result<Vec<BindingRow>, HttpError>
where
    M: brz_mysql::Mysql,
{
    let repository = LoopItemRepository::new(mysql);

    // `ensure_shadow`: for external-provider items the shadow row must
    // already exist (`find_for_runtime_task`); otherwise the local task row
    // must exist. Both paths resolve through `get`-style access checks.
    let external_project = repository
        .find_external_project(item_id)
        .await
        .map_err(HttpError::internal)?;
    let item = if external_project.is_some() {
        let binding = repository
            .list_task_bindings(item_id)
            .await
            .map_err(HttpError::internal)?
            .into_iter()
            .find(|binding| binding.task_user_id == user_id)
            .ok_or_else(HttpError::linked_todo_not_found)?;
        let item = repository
            .get_task_item(&binding.loop_item_id.clone().unwrap_or_default())
            .await
            .map_err(HttpError::internal)?
            .ok_or_else(HttpError::todo_not_found)?;
        require_item_access(
            mysql,
            &item.cloud_project_id,
            &item.created_by_user_id,
            user_id,
        )
        .await?;
        item
    } else {
        let item = repository
            .get_task_item(item_id)
            .await
            .map_err(HttpError::internal)?
            .ok_or_else(HttpError::todo_not_found)?;
        require_item_access(
            mysql,
            &item.cloud_project_id,
            &item.created_by_user_id,
            user_id,
        )
        .await?;
        item
    };

    // `list_task_bindings` lists by `loop_item_id == item_id` regardless of
    // the shadow/local branch.
    let _ = item;
    repository
        .list_task_bindings(item_id)
        .await
        .map_err(HttpError::internal)
}

/// `require_cloud_project_role` + `_item_permissions` (view path).
async fn require_item_access<M>(
    mysql: &M,
    cloud_project_id: &str,
    item_created_by_user_id: &i32,
    user_id: i32,
) -> Result<(), HttpError>
where
    M: brz_mysql::Mysql,
{
    let repository = LoopItemRepository::new(mysql);
    let project = repository
        .get_project(cloud_project_id)
        .await
        .map_err(HttpError::internal)?
        .ok_or_else(HttpError::cloud_project_not_found)?;

    let role = if project.created_by_user_id == user_id {
        "Owner".to_string()
    } else {
        match repository
            .get_membership(cloud_project_id, user_id)
            .await
            .map_err(HttpError::internal)?
        {
            Some(member)
                if super::loop_repository::has_permission(
                    &member.member_role,
                    "RestrictedAnalyst",
                ) || role_is_known(&member.member_role) =>
            {
                member.member_role
            }
            Some(_) => return Err(HttpError::invalid_cloud_project_role()),
            None => {
                if !project.is_public() {
                    return Err(HttpError::cloud_project_not_found());
                }
                "RestrictedAnalyst".to_string()
            }
        }
    };
    if !has_permission(&role, "RestrictedAnalyst") {
        return Err(HttpError::insufficient_permission());
    }

    // `_item_permissions` view path: public visitors may only view their own
    // items; members always pass the RestrictedAnalyst view gate.
    if role == "RestrictedAnalyst" && *item_created_by_user_id != user_id {
        return Err(HttpError::todo_not_found());
    }
    Ok(())
}

/// Whether the membership role is one of the known base roles.
fn role_is_known(role: &str) -> bool {
    matches!(
        role,
        "Owner" | "Maintainer" | "Developer" | "Reporter" | "RestrictedAnalyst"
    )
}

/// Serialize one `LoopItemTaskBindingResponse`.
#[derive(serde::Serialize)]
struct BindingResponse {
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
}

fn binding_response(binding: &BindingRow) -> BindingResponse {
    BindingResponse {
        id: binding.id.clone(),
        cloud_project_id: binding.cloud_project_id.clone(),
        loop_item_id: normalize_empty_text(binding.loop_item_id.as_deref()),
        task_user_id: binding.task_user_id,
        device_id: binding.device_id.clone(),
        task_id: binding.task_id.clone(),
        task_title: normalize_empty_text(binding.task_title.as_deref()),
        backend_task_id: (binding.backend_task_id != 0).then_some(binding.backend_task_id),
        workflow_node_id: binding.workflow_node_id(),
        linked_by_user_id: binding.linked_by_user_id,
        linked_at: datetime_value(binding.linked_at),
        unlinked_at: if datetime_is_unset(binding.unlinked_at) {
            None
        } else {
            datetime_value(binding.unlinked_at)
        },
    }
}

fn normalize_empty_text(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_owned)
}

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
    use crate::loop_tasks::loop_repository::BindingRow;
    use brz_mysql::Json;

    fn binding_response(row: &BindingRow) -> Value {
        crate::json_contract_tests::serialized(super::binding_response(row)).unwrap()
    }

    fn binding() -> BindingRow {
        BindingRow {
            id: "5336494559207636217".to_string(),
            cloud_project_id: "8869148083931743937".to_string(),
            loop_item_id: Some("WEWORKC2FA61-507".to_string()),
            task_user_id: 52,
            device_id: "electron-3ba971c3-9897-42ce-90f7-14ee023d4191".to_string(),
            task_id: "runtime-746911929".to_string(),
            task_title: Some("wework, example task title".to_string()),
            backend_task_id: 0,
            linked_by_user_id: 52,
            linked_at: NaiveDateTime::parse_from_str("2026-09-04 07:23:14", "%Y-%m-%d %H:%M:%S")
                .ok(),
            unlinked_at: NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S")
                .ok(),
            metadata: Some(Json(serde_json::json!({}).into())),
        }
    }

    #[test]
    fn serializes_the_recorded_binding_shape() {
        let value = binding_response(&binding());
        assert_eq!(
            value,
            serde_json::json!({
                "id": "5336494559207636217",
                "cloud_project_id": "8869148083931743937",
                "loop_item_id": "WEWORKC2FA61-507",
                "task_user_id": 52,
                "device_id": "electron-3ba971c3-9897-42ce-90f7-14ee023d4191",
                "task_id": "runtime-746911929",
                "task_title": "wework, example task title",
                "backend_task_id": null,
                "workflow_node_id": null,
                "linked_by_user_id": 52,
                "linked_at": "2026-09-04T07:23:14",
                "unlinked_at": null,
            })
        );
    }

    #[test]
    fn normalizes_empty_text_and_zero_backend_task_id() {
        let mut row = binding();
        row.loop_item_id = Some(String::new());
        row.task_title = Some(String::new());
        row.backend_task_id = 7;
        let value = binding_response(&row);
        assert_eq!(value["loop_item_id"], serde_json::Value::Null);
        assert_eq!(value["task_title"], serde_json::Value::Null);
        assert_eq!(value["backend_task_id"], json!(7));
    }

    #[test]
    fn keeps_a_real_unlinked_at() {
        let mut row = binding();
        row.unlinked_at =
            NaiveDateTime::parse_from_str("2026-09-04 08:00:00", "%Y-%m-%d %H:%M:%S").ok();
        let value = binding_response(&row);
        assert_eq!(value["unlinked_at"], json!("2026-09-04T08:00:00"));
    }
}
