// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `previous_response_id` continuation for the create flow
//! (`app/api/endpoints/openapi_responses.py:522-561`,
//! `app/services/chat/storage/task_manager.py:155-212`,
//! `app/services/chat/trigger/lifecycle.py:286-330`, and
//! `app/services/task_status.py:12-25`).
//!
//! A `resp_{task_id}` follow-up reuses the recorded conversation's Task instead
//! of creating one. The source ignores a value without the `resp_` prefix,
//! rejects a non-integer suffix with `400`, rejects an unknown or foreign Task
//! with `404`, refuses a Task that is still `RUNNING`/`PENDING` with `400`, and
//! rewrites that Task's CRD to `PENDING` (plus the requested model labels)
//! before the paired subtasks are appended.
use brz_http_server::StatusCode;
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;
use crate::responses::responses_repository::get_task_by_states_active_owned;
use crate::task_store::TaskStore;

/// `f"resp_{setup.task_id}"`.
const RESPONSE_ID_PREFIX: &str = "resp_";

/// The resumed Task of a `resp_{task_id}` follow-up.
pub struct Continuation {
    pub task_id: i64,
    /// The Task's stored CRD, marked `PENDING` for this turn.
    pub task_json: Value,
}

/// `previous_response_id` -> the Task id it names.
///
/// The source inspects the value only when it starts with `resp_`; anything
/// else leaves `task_id` unset, so the request creates a new Task. A suffix
/// that is not an integer raises the source's
/// `400 Invalid previous_response_id format: '<value>'`.
pub fn continuation_task_id(previous_response_id: &str) -> Result<Option<i64>, FastApiError> {
    let Some(suffix) = previous_response_id.strip_prefix(RESPONSE_ID_PREFIX) else {
        return Ok(None);
    };
    suffix.trim().parse::<i64>().map(Some).map_err(|_| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Invalid previous_response_id format: '{previous_response_id}'"),
        )
    })
}

/// `get_task_with_access_check` + `check_task_status` for a follow-up, with the
/// Task's CRD already marked `PENDING`.
pub async fn resolve(
    store: &dyn TaskStore,
    previous_response_id: &str,
    owner_user_id: i32,
    now: &str,
) -> Result<Option<Continuation>, FastApiError> {
    let Some(task_id) = continuation_task_id(previous_response_id)? else {
        return Ok(None);
    };
    let row = get_task_by_states_active_owned(store, task_id, owner_user_id)
        .await
        .map_err(dependency)?;
    let Some(row) = row else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            format!("Previous response '{previous_response_id}' not found"),
        ));
    };

    let mut task_json = row.json.0.to_value();
    ensure_runnable(&task_json)?;
    mark_pending(&mut task_json, now);
    Ok(Some(Continuation { task_id, task_json }))
}

/// `check_task_status`: a Task that is still `RUNNING`/`PENDING` cannot accept
/// a new message.
fn ensure_runnable(task_json: &Value) -> Result<(), FastApiError> {
    let status = task_json
        .get("status")
        .and_then(|status| status.get("status"))
        .and_then(Value::as_str);
    if matches!(status, Some("RUNNING" | "PENDING")) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Task is still running",
        ));
    }
    Ok(())
}

/// `mark_task_pending_payload` -> `_with_status`: `status.status="PENDING"`,
/// `progress=0`, `errorMessage=""`, `completedAt=null`, `updatedAt=now`.
fn mark_pending(task_json: &mut Value, now: &str) {
    let Value::Object(root) = task_json else {
        return;
    };
    let status = root
        .entry("status".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(status) = status else {
        return;
    };
    status.insert("status".to_string(), Value::String("PENDING".to_string()));
    status.insert("progress".to_string(), Value::from(0));
    status.insert("errorMessage".to_string(), Value::String(String::new()));
    status.insert("completedAt".to_string(), Value::Null);
    status.insert("updatedAt".to_string(), Value::String(now.to_string()));
}

/// `prepare_execution_session`'s label rewrite for a follow-up
/// (`lifecycle.py:308-335`): `labels.modelId` / `labels.forceOverrideBotModel`
/// are set when the request pins a model, and `labels.autoDeleteExecutor` when
/// the caller sent the auto-delete header.
pub fn apply_request_labels(
    task_json: &mut Value,
    model_id: Option<&str>,
    force_override: bool,
    auto_delete_executor: Option<&str>,
) {
    if model_id.is_none() && auto_delete_executor.is_none() {
        return;
    }
    let Value::Object(root) = task_json else {
        return;
    };
    let metadata = root
        .entry("metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(metadata) = metadata else {
        return;
    };
    let labels = metadata
        .entry("labels".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(labels) = labels else {
        return;
    };
    if let Some(model_id) = model_id {
        labels.insert("modelId".to_string(), Value::String(model_id.to_string()));
    }
    if force_override {
        labels.insert(
            "forceOverrideBotModel".to_string(),
            Value::String("true".to_string()),
        );
    }
    if let Some(value) = auto_delete_executor {
        labels.insert(
            "autoDeleteExecutor".to_string(),
            Value::String(value.to_string()),
        );
    }
}

/// A dependency failure: the source propagates it and FastAPI renders the
/// framework's `500`.
fn dependency(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "previous_response_id continuation lookup failed");
    FastApiError::internal()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_foreign_prefix_keeps_the_new_task_path() {
        // The source only inspects a `resp_` value; anything else leaves
        // `task_id` unset.
        assert_eq!(continuation_task_id("task-904623192628201").unwrap(), None);
        assert_eq!(continuation_task_id("").unwrap(), None);
    }

    #[test]
    fn a_response_id_names_its_task() {
        assert_eq!(
            continuation_task_id("resp_893078319868003").unwrap(),
            Some(893_078_319_868_003)
        );
    }

    #[test]
    fn a_non_integer_suffix_is_the_source_400() {
        let error = continuation_task_id("resp_abc").expect_err("must reject");
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn mark_pending_matches_the_source_payload() {
        let mut task = serde_json::json!({
            "kind": "Task",
            "status": {"state": "Available", "status": "COMPLETED", "progress": 100},
        });
        mark_pending(&mut task, "2026-10-16T10:56:11.005870");
        assert_eq!(
            task["status"],
            serde_json::json!({
                "state": "Available",
                "status": "PENDING",
                "progress": 0,
                "errorMessage": "",
                "completedAt": null,
                "updatedAt": "2026-10-16T10:56:11.005870",
            })
        );
    }

    #[test]
    fn request_labels_are_set_in_place() {
        let mut task = serde_json::json!({
            "metadata": {"labels": {"type": "online", "modelId": "old"}},
        });
        apply_request_labels(&mut task, Some("ali-qwen3.7-plus"), true, Some("true"));
        assert_eq!(
            task["metadata"]["labels"],
            serde_json::json!({
                "type": "online",
                "modelId": "ali-qwen3.7-plus",
                "forceOverrideBotModel": "true",
                "autoDeleteExecutor": "true",
            })
        );
    }

    #[test]
    fn an_auto_delete_header_alone_still_rewrites_labels() {
        let mut task = serde_json::json!({"metadata": {"labels": {"type": "online"}}});
        apply_request_labels(&mut task, None, false, Some("false"));
        assert_eq!(
            task["metadata"]["labels"],
            serde_json::json!({"type": "online", "autoDeleteExecutor": "false"})
        );
    }

    #[test]
    fn a_running_task_is_refused() {
        let task = serde_json::json!({"status": {"status": "PENDING"}});
        assert_eq!(
            ensure_runnable(&task).expect_err("must refuse").status(),
            StatusCode::BAD_REQUEST
        );
    }
}
