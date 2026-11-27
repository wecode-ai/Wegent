// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/v1/loop-items/{item_id}/tasks` — the active task bindings of one
//! loop item.
//!
//! Mirrors `app.api.endpoints.deliveries.list_loop_item_tasks`:
//! `external_loop_item_provider.ensure_shadow(db, item_id, current_user.id)`
//! then `loop_item_service.list_task_bindings(db, item_id, current_user.id)`,
//! serialized as `LoopItemTaskBindingResponse` rows.
//!
//! `list_task_bindings` first runs `LoopItemService.get`:
//! `_get_item_row` (absent or deleted -> 404 "TODO not found") followed by
//! `_require_item_access` (`require_cloud_project_role(Viewer)` plus
//! `can_view_item`), then lists the caller-owned binding rows newest first.
use chrono::NaiveDateTime;

use super::http_error::HttpError;
use super::loop_repository::{BindingRow, LoopItemRepository, datetime_is_unset};
use crate::http_compat::FastApiError;
use crate::loop_tasks::auth::FlexibleUser;
use crate::state::AppState;

/// GET /api/v1/loop-items/{item_id}/tasks: the loop-items free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/v1/loop-items/:item_id/tasks")]
async fn list_loop_item_tasks(
    #[inject(state)] state: &AppState,
    item_id: &str,
    #[auth] current_user: FlexibleUser,
) -> Result<Vec<BindingResponse>, FastApiError> {
    loop_item_tasks(state, item_id, current_user.id).await
}

/// Handler body for `GET /api/v1/loop-items/{item_id}/tasks`.
pub(crate) async fn loop_item_tasks(
    state: &AppState,
    item_id: &str,
    user_id: i32,
) -> Result<Vec<BindingResponse>, FastApiError> {
    let scope = super::assignments::load_issue_scope(state, item_id, user_id)
        .await?
        .ok_or_else(HttpError::todo_not_found)?;
    scope.require(&state.mysql, item_id, user_id).await?;

    // `list_task_bindings` rows.
    let bindings = LoopItemRepository::new(&state.mysql)
        .list_task_bindings(item_id, user_id)
        .await
        .map_err(HttpError::internal)?;
    Ok(bindings.iter().map(binding_response).collect())
}

/// Serialize one `LoopItemTaskBindingResponse`.
#[derive(serde::Serialize)]
pub(crate) struct BindingResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    stand_in_pending: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stand_in_conversation_id: Option<String>,
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
    #[serde(rename = "executionContext")]
    execution_context: Option<serde_json::Value>,
    workflow_node_id: Option<String>,
    human_assignment_id: Option<String>,
    dispatch_id: Option<String>,
    dispatch_round_id: Option<String>,
    assignment_id: Option<String>,
    change_requests: Vec<serde_json::Value>,
    linked_by_user_id: i32,
    linked_at: String,
    unlinked_at: Option<String>,
}

fn binding_response(binding: &BindingRow) -> BindingResponse {
    BindingResponse {
        stand_in_pending: binding.stand_in_pending(),
        stand_in_conversation_id: binding.stand_in_conversation_id(),
        id: binding.id.clone(),
        cloud_project_id: binding.cloud_project_id.clone().unwrap_or_default(),
        loop_item_id: normalize_empty_text(binding.loop_item_id.as_deref()),
        task_user_id: binding.task_user_id,
        device_id: binding.device_id.clone(),
        task_id: binding.task_id.clone(),
        task_title: normalize_empty_text(binding.task_title.as_deref()),
        backend_task_id: binding.backend_task_id.filter(|value| *value != 0),
        model_selection: binding.model_selection().cloned(),
        execution_context: binding.execution_context().cloned(),
        workflow_node_id: binding.workflow_node_id(),
        human_assignment_id: binding.human_assignment_id(),
        dispatch_id: binding.dispatch_id(),
        dispatch_round_id: binding.dispatch_round_id(),
        assignment_id: binding.assignment_id(),
        change_requests: binding.change_requests(),
        linked_by_user_id: binding.linked_by_user_id,
        linked_at: datetime_value(binding.linked_at).unwrap_or_default(),
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

    fn binding_response(row: &BindingRow) -> serde_json::Value {
        crate::json_contract_tests::serialized(super::binding_response(row)).unwrap()
    }

    fn binding(metadata: serde_json::Value) -> BindingRow {
        BindingRow {
            id: "5147678608484377787".to_string(),
            cloud_project_id: Some("2753648597973755964".to_string()),
            loop_item_id: Some("WEWORK2D8526-6".to_string()),
            task_user_id: 2230,
            device_id: "electron-32a59c25-c738-4261-9eee-f80b14e24aa4".to_string(),
            task_id: "runtime-719076255".to_string(),
            task_title: Some("通用 MCP OAuth Server 支持".to_string()),
            backend_task_id: Some(0),
            linked_by_user_id: 2230,
            linked_at: NaiveDateTime::parse_from_str("2026-10-20 07:11:06", "%Y-%m-%d %H:%M:%S")
                .ok(),
            unlinked_at: NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S")
                .ok(),
            metadata: Some(Json(metadata.into())),
        }
    }

    #[test]
    fn binding_response_preserves_nullable_backend_task_id() {
        for (stored, expected) in [(None, None), (Some(0), None), (Some(42), Some(42))] {
            let mut row = binding(serde_json::json!({}));
            row.backend_task_id = stored;

            assert_eq!(
                binding_response(&row)["backend_task_id"],
                serde_json::json!(expected)
            );
        }
    }

    #[test]
    fn serializes_the_recorded_binding_shape() {
        let value = binding_response(&binding(serde_json::json!({
            "model_selection": {
                "modelName": "gpt-6.1-sol",
                "modelType": "runtime",
                "options": {"collaborationMode": "default"}
            },
            "execution_context": {"device": "electron"},
            "change_requests": [{"id": "cr-1"}, 5],
            "workflow_node_id": "node-1",
            "human_assignment_id": "human-1",
            "dispatch_id": "dispatch-1",
            "dispatch_round_id": "round-1",
            "assignment_id": "assignment-1"
        })));
        assert_eq!(
            value,
            serde_json::json!({
                "id": "5147678608484377787",
                "cloud_project_id": "2753648597973755964",
                "loop_item_id": "WEWORK2D8526-6",
                "task_user_id": 2230,
                "device_id": "electron-32a59c25-c738-4261-9eee-f80b14e24aa4",
                "task_id": "runtime-719076255",
                "task_title": "通用 MCP OAuth Server 支持",
                "backend_task_id": null,
                "modelSelection": {
                    "modelName": "gpt-6.1-sol",
                    "modelType": "runtime",
                    "options": {"collaborationMode": "default"}
                },
                "executionContext": {"device": "electron"},
                "workflow_node_id": "node-1",
                "human_assignment_id": "human-1",
                "dispatch_id": "dispatch-1",
                "dispatch_round_id": "round-1",
                "assignment_id": "assignment-1",
                "change_requests": [{"id": "cr-1"}],
                "linked_by_user_id": 2230,
                "linked_at": "2026-10-20T07:11:06",
                "unlinked_at": null,
            })
        );
    }

    #[test]
    fn empty_metadata_values_render_as_defaults() {
        let value = binding_response(&binding(serde_json::json!({})));
        assert_eq!(value["modelSelection"], serde_json::Value::Null);
        assert_eq!(value["executionContext"], serde_json::Value::Null);
        assert_eq!(value["change_requests"], serde_json::json!([]));
        assert_eq!(value["workflow_node_id"], serde_json::Value::Null);
    }

    #[test]
    fn exposes_an_issue_conversation_reservation_without_changing_ordinary_bindings() {
        let ordinary = binding_response(&binding(serde_json::json!({})));
        assert!(ordinary.get("stand_in_conversation_id").is_none());
        assert!(ordinary.get("stand_in_pending").is_none());
        let reserved = binding_response(&binding(
            serde_json::json!({"stand_in_conversation_id":"issue-role-one"}),
        ));
        assert_eq!(reserved["stand_in_conversation_id"], "issue-role-one");
        let pending = binding_response(&binding(serde_json::json!({"stand_in_pending":true})));
        assert_eq!(pending["stand_in_pending"], true);
        let started = binding_response(&binding(serde_json::json!({"stand_in_pending":false})));
        assert_eq!(started["stand_in_pending"], false);
    }

    #[test]
    fn non_object_metadata_values_are_ignored() {
        let value = binding_response(&binding(serde_json::json!({
            "model_selection": "text",
            "execution_context": [],
            "change_requests": "text",
            "workflow_node_id": 5
        })));
        assert_eq!(value["modelSelection"], serde_json::Value::Null);
        assert_eq!(value["executionContext"], serde_json::Value::Null);
        assert_eq!(value["change_requests"], serde_json::json!([]));
        assert_eq!(value["workflow_node_id"], serde_json::Value::Null);
    }
}
