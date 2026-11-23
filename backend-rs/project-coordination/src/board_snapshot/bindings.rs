// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared Loop task-binding response projections.
use chrono::NaiveDateTime;
use serde::Serialize;

use super::repository::BindingRow;

/// pydantic naive-datetime serialization: `YYYY-MM-DDTHH:MM:SS` plus
/// fractional seconds when nonzero. Returns the string form; callers wrap
/// it in `json!` for serialization.
pub fn datetime_string(value: Option<NaiveDateTime>) -> Option<String> {
    value.map(|value| {
        let base = value.format("%Y-%m-%dT%H:%M:%S").to_string();
        if value.and_utc().timestamp_subsec_nanos() == 0 {
            base
        } else {
            format!("{base}.{:06}", value.and_utc().timestamp_subsec_micros())
        }
    })
}

/// One `LoopItemTaskBindingResponse` row.
#[derive(Debug, Serialize)]
pub struct BindingResponse {
    id: String,
    cloud_project_id: String,
    loop_item_id: Option<String>,
    task_user_id: i32,
    device_id: String,
    task_id: String,
    task_title: Option<String>,
    backend_task_id: Option<i64>,
    /// `modelSelection` (`LoopItemTaskBinding.model_selection`): the metadata
    /// `model_selection` object when present, else `null`.
    #[serde(rename = "modelSelection")]
    model_selection: Option<brz_json::RawJson>,
    /// `executionContext` (`LoopItemTaskBinding.execution_context`): the
    /// metadata `execution_context` object when present, else `null`.
    #[serde(rename = "executionContext")]
    execution_context: Option<brz_json::RawJson>,
    workflow_node_id: Option<String>,
    human_assignment_id: Option<String>,
    dispatch_id: Option<String>,
    dispatch_round_id: Option<String>,
    assignment_id: Option<String>,
    /// `change_requests` (`LoopItemTaskBinding.change_requests`): the metadata
    /// `change_requests` object list (empty when absent).
    change_requests: Vec<brz_json::RawJson>,
    linked_by_user_id: i32,
    linked_at: Option<String>,
    unlinked_at: Option<String>,
}

/// Serialize one `LoopItemTaskBindingResponse`.
pub fn binding_response(binding: &BindingRow) -> BindingResponse {
    BindingResponse {
        id: binding.id.clone(),
        cloud_project_id: binding.cloud_project_id.clone(),
        loop_item_id: normalize_empty_text(binding.loop_item_id.as_deref()),
        task_user_id: binding.task_user_id,
        device_id: binding.device_id.clone(),
        task_id: binding.task_id.clone(),
        task_title: normalize_empty_text(binding.task_title.as_deref()),
        backend_task_id: binding.backend_task_id.filter(|value| *value != 0),
        // `modelSelection`: the metadata `model_selection` mapping when it is
        // a JSON object, else `null` (`LoopItemTaskBinding.model_selection`).
        model_selection: binding.model_selection(),
        // `executionContext`: the metadata `execution_context` mapping when it
        // is a JSON object, else `null` (`LoopItemTaskBinding.execution_context`).
        execution_context: binding.execution_context(),
        workflow_node_id: binding.workflow_node_id(),
        // Dispatch/assignment ids: metadata text when a non-empty string,
        // else `null` (`LoopItemTaskBindingResponse`).
        human_assignment_id: binding.human_assignment_id(),
        dispatch_id: binding.dispatch_id(),
        dispatch_round_id: binding.dispatch_round_id(),
        assignment_id: binding.assignment_id(),
        // `change_requests`: the metadata `change_requests` list entries that
        // are JSON objects (`LoopItemTaskBinding.change_requests`).
        change_requests: binding.change_requests(),
        linked_by_user_id: binding.linked_by_user_id,
        linked_at: datetime_string(binding.linked_at),
        unlinked_at: match binding.unlinked_at {
            Some(value) if !super::repository::datetime_is_unset(binding.unlinked_at) => {
                datetime_string(Some(value))
            }
            _ => None,
        },
    }
}

/// `normalize_empty_text`: `""` becomes `None`.
pub fn normalize_empty_text(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_mysql::Json;
    use serde_json::json;

    #[test]
    fn binding_response_normalizes_null_and_zero_backend_task_ids() {
        let mut binding = BindingRow {
            id: "5336494559207636217".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some(String::new()),
            task_user_id: 52,
            device_id: "dev".to_string(),
            task_id: "t".to_string(),
            task_title: Some(String::new()),
            backend_task_id: Some(0),
            linked_by_user_id: 52,
            linked_at: None,
            unlinked_at: None,
            metadata: None,
        };
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["backend_task_id"], serde_json::Value::Null);
        assert_eq!(value["loop_item_id"], serde_json::Value::Null);
        assert_eq!(value["task_title"], serde_json::Value::Null);
        assert_eq!(value["workflow_node_id"], serde_json::Value::Null);
        for (stored, expected) in [(None, None), (Some(0), None), (Some(42), Some(42))] {
            binding.backend_task_id = stored;
            assert_eq!(binding_response(&binding).backend_task_id, expected);
        }
    }

    #[test]
    fn binding_response_serializes_the_source_camel_case_aliases() {
        // `LoopItemTaskBindingResponse` declares the `modelSelection` and
        // `executionContext` aliases; a missing rename ships a snake_case key
        // the recorded board-snapshot body does not carry.
        let binding = BindingRow {
            id: "1".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some("item".to_string()),
            task_user_id: 1,
            device_id: "d".to_string(),
            task_id: "t".to_string(),
            task_title: None,
            backend_task_id: Some(0),
            linked_by_user_id: 1,
            linked_at: None,
            unlinked_at: None,
            metadata: Some(Json(
                serde_json::from_value(json!({
                    "model_selection": {"model": "m"},
                    "execution_context": {"kind": "local"},
                }))
                .unwrap(),
            )),
        };
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["modelSelection"], json!({"model": "m"}));
        assert_eq!(value["executionContext"], json!({"kind": "local"}));
        assert!(value.get("model_selection").is_none());
        assert!(value.get("execution_context").is_none());
    }

    #[test]
    fn binding_response_keeps_real_unlinked_at() {
        let mut binding = BindingRow {
            id: "1".to_string(),
            cloud_project_id: "p".to_string(),
            loop_item_id: Some("item".to_string()),
            task_user_id: 1,
            device_id: "d".to_string(),
            task_id: "t".to_string(),
            task_title: None,
            backend_task_id: Some(0),
            linked_by_user_id: 1,
            linked_at: None,
            unlinked_at: NaiveDateTime::parse_from_str("2026-09-04 08:00:00", "%Y-%m-%d %H:%M:%S")
                .ok(),
            metadata: None,
        };
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["unlinked_at"], json!("2026-09-04T08:00:00"));
        // Unset sentinel maps to null.
        binding.unlinked_at =
            NaiveDateTime::parse_from_str("1970-01-01 00:00:01", "%Y-%m-%d %H:%M:%S").ok();
        let value = serde_json::to_value(binding_response(&binding)).unwrap();
        assert_eq!(value["unlinked_at"], serde_json::Value::Null);
    }
}
