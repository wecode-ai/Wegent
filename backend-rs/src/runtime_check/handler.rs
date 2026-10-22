// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/runtime-check` mirroring
//! `Wegent/backend/app/api/endpoints/adapter/task_runtime.py`.
//!
//! Order of operations matches the recorded source traffic:
//! 1. authenticate the Bearer user (MySQL `users` lookup),
//! 2. read the authorized runtime checkpoint in one statement
//!    (`task_access_store.get_runtime_state`), answering 404 when the task is
//!    absent, inactive, deleted, or not visible to the viewer,
//! 3. read the task streaming status (Redis),
//! 4. return the lightweight checkpoint; message content is excluded.
use anyhow::Result;
use brz_mysql::Mysql;
use serde::Serialize;

use super::state::AppState;
use super::tasks;

/// Mirror of `TaskRuntimeActiveStream` (`app/schemas/task.py`).
#[derive(Debug, Serialize)]
pub(crate) struct TaskRuntimeActiveStream {
    pub subtask_id: i64,
    pub cursor: usize,
    pub last_activity_at: Option<String>,
}

/// Mirror of `TaskRuntimeCheck` (`app/schemas/task.py`): pydantic emits every
/// field, `status_updated_at` and `active_stream` as `null` when absent, so no
/// field is skipped during serialization.
#[derive(Debug, Serialize)]
pub(crate) struct TaskRuntimeCheck {
    pub task_id: i64,
    pub task_status: String,
    pub status_updated_at: Option<String>,
    pub active_stream: Option<TaskRuntimeActiveStream>,
}

/// Error mapped to the source's `HTTPException` responses.
pub(crate) struct EndpointError {
    pub status: u16,
    pub detail: &'static str,
}

impl EndpointError {
    fn not_found() -> Self {
        Self {
            status: 404,
            detail: "Task not found",
        }
    }

    fn internal() -> Self {
        Self {
            status: 500,
            detail: "Internal server error",
        }
    }
}

/// GET /api/tasks/{task_id}/runtime-check: the runtime-check free function,
/// injecting the module's own dependency state.
#[brz_http_server::get(
    "/api/tasks/:task_id/runtime-check",
    group = runtime_check
)]
async fn get_task_runtime_check(
    #[inject(rc)] state: &crate::startup::RuntimeCheckState,
    task_id: i64,
    #[auth] current_user: crate::auth::SessionUser,
) -> Result<TaskRuntimeCheck, crate::http_compat::FastApiError> {
    runtime_check(state, task_id, i64::from(current_user.id))
        .await
        .map_err(error_response)
}

/// Map an endpoint error to the source's `HTTPException` JSON shape.
fn error_response(error: EndpointError) -> crate::http_compat::FastApiError {
    let status = brz_http_server::StatusCode::from_u16(error.status)
        .unwrap_or(brz_http_server::StatusCode::INTERNAL_SERVER_ERROR);
    crate::http_compat::FastApiError::detail(status, error.detail)
}

/// Core endpoint logic, separated from axum extraction for tests.
pub(crate) async fn runtime_check(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    user_id: i64,
) -> Result<TaskRuntimeCheck, EndpointError> {
    // `task_access_store.get_runtime_state` -> None becomes the source's
    // `HTTPException(404, "Task not found")`. The owner/approved-member policy
    // runs inside that one statement.
    let checkpoint = tasks::get_runtime_state(&*state.task_store, task_id, user_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(EndpointError::not_found)?;
    // `TaskRuntimeCheck.task_status` is a required `TaskStatus`: the source's
    // response model rejects a checkpoint without one.
    let Some(task_status) = checkpoint.status else {
        tracing::error!(task_id, "runtime-check checkpoint has no task status");
        return Err(EndpointError::internal());
    };

    // Redis streaming state is best-effort: a missing client (Redis was
    // unavailable at startup) reads as no active stream.
    let active_stream = match state.redis.as_ref() {
        Some(redis) => super::streaming::get_active_stream(redis, task_id)
            .await
            .map_err(internal_error)?,
        None => None,
    };

    Ok(TaskRuntimeCheck {
        task_id,
        task_status,
        status_updated_at: checkpoint
            .updated_at
            .map(|updated_at| format_python_datetime(&updated_at)),
        active_stream: active_stream.map(|stream| TaskRuntimeActiveStream {
            subtask_id: stream.subtask_id,
            cursor: stream.cursor,
            last_activity_at: stream.last_activity_at,
        }),
    })
}

fn internal_error(error: anyhow::Error) -> EndpointError {
    tracing::error!(%error, "runtime-check dependency failure");
    EndpointError::internal()
}

/// Render a naive datetime exactly like pydantic's default serialization of
/// `datetime.isoformat()`: `YYYY-MM-DDTHH:MM:SS` with a six-digit fraction
/// only when the microsecond field is non-zero.
fn format_python_datetime(value: &chrono::NaiveDateTime) -> String {
    if value.and_utc().timestamp_subsec_micros() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn naive(value: &str) -> chrono::NaiveDateTime {
        chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f").unwrap()
    }

    #[test]
    fn datetime_matches_python_format() {
        assert_eq!(
            format_python_datetime(&naive("2026-07-14T14:47:41.807109")),
            "2026-07-14T14:47:41.807109"
        );
        // `datetime.isoformat()` drops a zero microsecond field, which is what
        // the source's own unit test expects for a whole-second timestamp.
        assert_eq!(
            format_python_datetime(&naive("2026-09-18T11:50:00")),
            "2026-09-18T11:50:00"
        );
        // A non-zero microsecond field keeps all six digits, trailing zeros
        // included.
        assert_eq!(
            format_python_datetime(&naive("2026-09-23T16:33:25.120000")),
            "2026-09-23T16:33:25.120000"
        );
    }

    #[test]
    fn body_serializes_expected_shape() {
        let body = TaskRuntimeCheck {
            task_id: 4823952,
            task_status: "COMPLETED".to_string(),
            status_updated_at: Some("2026-07-14T14:47:41.807109".to_string()),
            active_stream: None,
        };
        let encoded = serde_json::to_string(&body).unwrap();
        assert_eq!(
            encoded,
            r#"{"task_id":4823952,"task_status":"COMPLETED","status_updated_at":"2026-07-14T14:47:41.807109","active_stream":null}"#
        );
    }

    #[test]
    fn absent_checkpoint_fields_serialize_as_null() {
        // pydantic always emits optional response fields; only their value can
        // be `null`. The recorded bodies carry every key.
        let body = TaskRuntimeCheck {
            task_id: 42,
            task_status: "RUNNING".to_string(),
            status_updated_at: None,
            active_stream: Some(TaskRuntimeActiveStream {
                subtask_id: 77,
                cursor: 3,
                last_activity_at: None,
            }),
        };
        let encoded = serde_json::to_string(&body).unwrap();
        assert_eq!(
            encoded,
            r#"{"task_id":42,"task_status":"RUNNING","status_updated_at":null,"active_stream":{"subtask_id":77,"cursor":3,"last_activity_at":null}}"#
        );
    }
}
