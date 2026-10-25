// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/tasks/{task_id}/cancel`.
//!
//! Mirrors `cancel_task`
//! (`app/services/adapters/task_kinds/operations.py:1180`) and its route
//! (`app/api/endpoints/adapter/tasks.py:679`): the `get_task_detail`
//! ownership/terminal-state gate, the `chat_shell` branch
//! (`_cancel_chat_shell_task`) and the executor branch
//! (`_cancel_executor_task`).
//!
//! The chat-shell branch commits the running subtask's terminal state first;
//! the session's after-commit metrics hook then publishes the committed
//! subtask state, and `update_task` rewrites the task CRD in a second
//! transaction. The cross-worker cancellation flag is set last, exactly like
//! the route's `BackgroundTasks` entry.

use brz_http_server::StatusCode;
use brz_mysql::Json;
use chrono::NaiveDateTime;
use serde_json::Value;
use tracing::warn;

use super::models::{TaskCancelResponse, TaskUpdateBody};
use super::update_task;
use crate::crd::CrdDocument;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use crate::task_detail_api::assembly::{TaskNotFound, build_task_detail};
use crate::task_store::task_update_timestamp;

/// `cancel_task`'s `final_states`: a task in one of these cannot be cancelled.
const FINAL_STATES: [&str; 4] = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"];

/// `cancel_task` at the route's boundaries.
pub(crate) async fn cancel_task(
    state: &AppState,
    user_id: i64,
    task_id: i64,
) -> Result<TaskCancelResponse, FastApiError> {
    // `get_task_detail(db, task_id, user_id)` with no `client_origin`, then
    // `task_dict.get("status", "")`.
    let status = task_status(state, task_id, user_id).await?;

    if let Some(error) = final_state_error(&status) {
        return Err(error);
    }

    if status == "CANCELLING" {
        // `_is_cancellation_stuck` finalization (`finalize_stuck_cancellation`
        // plus the `TaskCompletedEvent` publish) is a recovery path with no
        // recorded case; this handler keeps the source's in-progress answer
        // and defers that branch.
        return Ok(TaskCancelResponse::already_cancelling());
    }

    if is_chat_shell_task(state, task_id).await? {
        cancel_chat_shell_task(state, task_id, user_id).await
    } else {
        cancel_executor_task(state, task_id, user_id).await
    }
}

/// `get_task_detail` through the shared detail chain; only the status is
/// consumed, but the source issues every related read before the state gate.
async fn task_status(state: &AppState, task_id: i64, user_id: i64) -> Result<String, FastApiError> {
    match build_task_detail(state, task_id, user_id, None).await {
        Ok(outcome) => Ok(outcome.body.status),
        Err(error) => {
            if error.downcast_ref::<TaskNotFound>().is_some() {
                return Err(FastApiError::detail(
                    StatusCode::NOT_FOUND,
                    "Task not found",
                ));
            }
            warn!(%error, %task_id, "[cancel] task detail failed");
            Err(FastApiError::unhandled())
        }
    }
}

/// The source's 400 for a task that already reached a terminal state.
fn final_state_error(status: &str) -> Option<FastApiError> {
    FINAL_STATES.contains(&status).then(|| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!(
                "Task is already {}, cannot cancel",
                status.to_ascii_lowercase()
            ),
        )
    })
}

/// `_is_chat_shell_task`: `task_store.get_active_task` then the stored CRD's
/// `metadata.labels.source`.
async fn is_chat_shell_task(state: &AppState, task_id: i64) -> Result<bool, FastApiError> {
    let Some(row) = state
        .task_store
        .get_active_task(task_id)
        .await
        .map_err(internal)?
    else {
        return Ok(false);
    };
    let json = row.get_required::<Json<Value>>("json").map_err(internal)?.0;
    Ok(is_chat_shell_document(&json))
}

/// `task_crd.metadata.labels.get("source") == "chat_shell"`, with a missing
/// document or label block rendering `False`.
fn is_chat_shell_document(task_json: &Value) -> bool {
    CrdDocument::project(task_json)
        .metadata
        .and_then(|metadata| metadata.labels)
        .and_then(|labels| labels.source)
        .is_some_and(|source| source == "chat_shell")
}

/// `_cancel_chat_shell_task`: cancel the caller's running assistant stream.
async fn cancel_chat_shell_task(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<TaskCancelResponse, FastApiError> {
    let running = state
        .task_store
        .running_assistant_for_user(task_id, user_id)
        .await
        .map_err(internal)?;

    let Some(running) = running else {
        // No running stream: finalize the task as COMPLETED. `update_task`
        // failures are logged and do not change the answer.
        if let Err(error) =
            update_task::update_task(state, user_id, task_id, None, &status_update("COMPLETED"))
                .await
        {
            warn!(%task_id, status = error.status().as_u16(), "[cancel] update failed");
        }
        return Ok(TaskCancelResponse::no_running_stream());
    };

    let subtask_id = running.get_required::<i64>("id").map_err(internal)?;
    // `update_fields` writes `error_message=""`; the ORM only flushes the
    // column when the stored value differs.
    let stored_error_message = running.get::<String>("error_message").map_err(internal)?;
    let result = running
        .get::<Json<Value>>("result")
        .map_err(internal)?
        .map(|json| json.0);
    let created_at = running
        .get::<NaiveDateTime>("created_at")
        .map_err(internal)?;

    // `completed_at=datetime.now()` is bound before `update_fields` stamps
    // `updated_at`; the flush-time clock the metrics hook reads comes last.
    let completed_at = task_update_timestamp();
    let updated_at = task_update_timestamp();
    let state_changed_at = chrono::Local::now().naive_local();

    state
        .task_store
        .update_subtask_cancelled(
            task_id,
            subtask_id,
            &updated_at,
            &completed_at,
            stored_error_message
                .as_deref()
                .is_some_and(|value| !value.is_empty()),
        )
        .await
        .map_err(internal)?;
    state.mysql.execute("COMMIT", ()).await.map_err(internal)?;

    // `TaskRunMetricHooks._after_commit`: the committed subtask state.
    publish_subtask_metric(
        state,
        subtask_id,
        created_at,
        result.as_ref(),
        state_changed_at,
    )
    .await;

    // `update_task(status="CANCELLED")`; its failure is logged, not raised.
    if let Err(error) =
        update_task::update_task(state, user_id, task_id, None, &status_update("CANCELLED")).await
    {
        warn!(%task_id, status = error.status().as_u16(), "[cancel] task update failed");
    }

    // The route's `BackgroundTasks` entry (`_call_chat_shell_cancel`): a Redis
    // flag for the streaming worker, with failures logged inside.
    crate::responses::stream_state::cancel_stream(state.redis.as_ref(), subtask_id).await;

    Ok(TaskCancelResponse::chat_stopped())
}

/// `TaskRunMetricHooks._after_commit` for the committed subtask update: publish
/// the terminal state and swallow a Redis failure, so it cannot change the
/// committed cancel result.
async fn publish_subtask_metric(
    state: &AppState,
    subtask_id: i64,
    created_at: Option<NaiveDateTime>,
    result: Option<&Value>,
    state_changed_at: NaiveDateTime,
) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    // The committed status is `CANCELLED`; only `FAILED` sets the flag. The
    // row's `error_message` was just reset to the empty string.
    let Some(event) = crate::task_run_metric_hooks::committed_status_change(
        created_at,
        subtask_id,
        false,
        Some(""),
        result,
        state_changed_at,
    ) else {
        return;
    };
    if let Err(error) =
        crate::task_run_metrics::record_events(redis, std::slice::from_ref(&event)).await
    {
        warn!(%error, "[cancel] task run metrics publish failed");
    }
}

/// `_cancel_executor_task`: mark the task CANCELLED, then ask executor-manager
/// to stop the runtime. Only the task update can fail the request.
async fn cancel_executor_task(
    state: &AppState,
    task_id: i64,
    user_id: i64,
) -> Result<TaskCancelResponse, FastApiError> {
    if let Err(error) =
        update_task::update_task(state, user_id, task_id, None, &status_update("CANCELLED")).await
    {
        // The source re-raises as `Failed to update task status: {str(e)}`,
        // where `str(HTTPException)` renders `<status>: <detail>`.
        let status = error.status().as_u16();
        let detail = error.detail_message().unwrap_or("Internal Server Error");
        return Err(FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("Failed to update task status: {status}: {detail}"),
        ));
    }
    // The source registers `_call_executor_cancel` as a `BackgroundTasks`
    // entry, which runs after the response. The target has no post-response
    // task facility, so the same bounded call (60-second deadline, failures
    // logged) is awaited inline; the returned body and status are unchanged.
    state.executor_manager.cancel_task(task_id).await;
    Ok(TaskCancelResponse::cancel_accepted())
}

/// `TaskUpdate(status=...)`: only the status field is set, matching
/// `model_dump(exclude_unset=True)`.
fn status_update(status: &str) -> TaskUpdateBody {
    let mut update = TaskUpdateBody::default();
    update.status.set(status.to_owned());
    update
}

fn internal(error: impl std::fmt::Display) -> FastApiError {
    warn!(%error, "[cancel] database error");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::FieldState as _;
    use serde_json::json;

    #[test]
    fn terminal_states_are_rejected_with_the_source_detail() {
        for status in FINAL_STATES {
            let error = final_state_error(status).expect("terminal state rejects");
            let expected = format!(
                "Task is already {}, cannot cancel",
                status.to_ascii_lowercase()
            );
            assert_eq!(error.status(), StatusCode::BAD_REQUEST);
            assert_eq!(error.detail_message(), Some(expected.as_str()));
        }
        for status in ["PENDING", "RUNNING", "CANCELLING"] {
            assert!(final_state_error(status).is_none(), "{status}");
        }
    }

    #[test]
    fn chat_shell_detection_reads_the_source_label() {
        assert!(is_chat_shell_document(&json!({
            "metadata": {"labels": {"source": "chat_shell"}}
        })));
        assert!(!is_chat_shell_document(&json!({
            "metadata": {"labels": {"source": "codex"}}
        })));
        assert!(!is_chat_shell_document(&json!({})));
        assert!(!is_chat_shell_document(
            &json!({"metadata": {"labels": null}})
        ));
    }

    #[test]
    fn status_update_sets_only_the_status_field() {
        let update = status_update("CANCELLED");
        assert_eq!(update.status.value().map(String::as_str), Some("CANCELLED"));
        assert!(!update.title.is_present());
        assert!(!update.prompt.is_present());
        assert!(!update.progress.is_present());
        assert!(!update.result.is_present());
        assert!(!update.error_message.is_present());
        assert!(!update.git_url.is_present());
        assert!(!update.git_repo_id.is_present());
    }

    #[test]
    fn cancel_responses_match_the_source_bodies() {
        let chat = serde_json::to_value(TaskCancelResponse::chat_stopped()).unwrap();
        assert_eq!(
            chat,
            json!({"message": "Chat stopped successfully", "status": "CANCELLED"})
        );
        let none = serde_json::to_value(TaskCancelResponse::no_running_stream()).unwrap();
        assert_eq!(
            none,
            json!({"message": "No running stream to cancel", "status": "COMPLETED"})
        );
        let pending = serde_json::to_value(TaskCancelResponse::already_cancelling()).unwrap();
        assert_eq!(
            pending,
            json!({"message": "Task is already being cancelled", "status": "CANCELLING"})
        );
        let accepted = serde_json::to_value(TaskCancelResponse::cancel_accepted()).unwrap();
        assert_eq!(
            accepted,
            json!({"message": "Cancel request accepted", "status": "CANCELLED"})
        );
    }

    /// Deferred APIs retain Python ownership and registered Rust implementations.
    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/tasks/:task_id/cancel";
        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).unwrap();
        assert!(!config.routes
                .iter()
                .any(|rule| rule.path == PATH && rule.methods.iter().any(|method| method == "POST")),
            "POST {PATH} must remain on Python"
        );
        let table = crate::RouteTable::compile(config).unwrap();
        assert!(!table.matches(&http::Method::POST, "/api/tasks/292195215235945/cancel"));
        for method in [
            http::Method::GET,
            http::Method::PUT,
            http::Method::PATCH,
            http::Method::DELETE,
        ] {
            assert!(!table.matches(&method, "/api/tasks/292195215235945/cancel"));
        }

        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
}
