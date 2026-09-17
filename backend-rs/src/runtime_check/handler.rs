// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/tasks/{task_id}/runtime-check` mirroring
//! `Wegent/backend/app/api/endpoints/adapter/tasks.py:get_task_runtime_check`.
//!
//! Order of operations matches the recorded source traffic:
//! 1. authenticate the Bearer user (MySQL `users` lookup),
//! 2. load the active non-deleted task (base `tasks` table),
//! 3. verify membership via the access store,
//! 4. resolve the workspace ref and team (public task tables, kinds),
//! 5. read the task streaming status (Redis),
//! 6. return the lightweight checkpoint; message content is excluded.
use anyhow::Result;
use brz_mysql::Mysql;
use serde::Serialize;

use super::auth::token::get_current_user;
use super::state::AppState;
use super::tasks::{self, TaskResourceRow};
use crate::crd::CrdDocument;

/// Mirror of `TaskRuntimeActiveStream` (`app/schemas/task.py`).
#[derive(Debug, Serialize)]
pub(crate) struct TaskRuntimeActiveStream {
    pub subtask_id: i64,
    pub cursor: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
}

/// Mirror of `TaskRuntimeCheck` (`app/schemas/task.py`): pydantic always
/// emits `active_stream` (null when absent), so no skip-serialization.
#[derive(Debug, Serialize)]
pub(crate) struct TaskRuntimeCheck {
    pub task_id: i64,
    pub task_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[header] authorization: Option<&str>,
) -> Result<TaskRuntimeCheck, crate::http_compat::FastApiError> {
    runtime_check(state, task_id, authorization)
        .await
        .map_err(error_response)
}

/// Map an endpoint error to the source's `HTTPException` JSON shape.
fn error_response(error: EndpointError) -> crate::http_compat::FastApiError {
    let status = brz_http_server::StatusCode::from_u16(error.status)
        .unwrap_or(brz_http_server::StatusCode::INTERNAL_SERVER_ERROR);
    // The source lets unexpected dependency errors surface as plain 500s
    // from the framework; keep a JSON body for observability.
    crate::http_compat::FastApiError::detail(status, error.detail)
}

/// Core endpoint logic, separated from axum extraction for tests.
pub(crate) async fn runtime_check(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task_id: i64,
    authorization: Option<&str>,
) -> Result<TaskRuntimeCheck, EndpointError> {
    let user = get_current_user(state, authorization)
        .await
        .map_err(|(status, detail)| EndpointError { status, detail })?;

    // task_kinds_service.get_task_by_id -> 404 when absent.
    let task = tasks::get_active_non_deleted_task(&state.mysql, state.task_policy, task_id)
        .await
        .map_err(internal_error)?;
    let task = task.ok_or_else(EndpointError::not_found)?;
    // task_access_store.is_member -> 404 when not a member.
    if !tasks::is_task_member(&state.mysql, state.task_policy, task_id, user.id)
        .await
        .map_err(internal_error)?
    {
        return Err(EndpointError::not_found());
    }

    // convert_to_task_dict resolves the workspace ref, team, and owner user;
    // none of those values is part of the runtime-check response, but the
    // source performs every lookup, so the target keeps the same call
    // topology.
    resolve_task_refs(state, &task)
        .await
        .map_err(internal_error)?;

    // Redis streaming state is best-effort: a missing client (Redis was
    // unavailable at startup) reads as no active stream.
    let active_stream = match state.redis.as_ref() {
        Some(redis) => super::streaming::get_active_stream(redis, task_id)
            .await
            .map_err(internal_error)?,
        None => None,
    };
    let checkpoint = tasks::task_checkpoint(&task).map_err(internal_error)?;

    Ok(TaskRuntimeCheck {
        task_id,
        task_status: checkpoint.status,
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

/// The workspace, team, and owner-user lookups performed by
/// `convert_to_task_dict`. The recorded task CRD carries
/// `workspaceRef {name, namespace}` and a public `teamRef` with
/// `user_id = 0`; the owner user is resolved through the public reader.
async fn resolve_task_refs(
    state: &AppState<impl Mysql, impl brz_redis::Redis>,
    task: &TaskResourceRow,
) -> Result<()> {
    let crd = CrdDocument::project_opaque(&task.json);
    let spec = crd.spec.as_ref();
    if let Some(workspace_ref) = spec.and_then(|spec| spec.workspace_ref.as_ref()) {
        let name = workspace_ref.name();
        let namespace = workspace_ref.namespace();
        if !name.is_empty() {
            tasks::get_workspace_by_ref(&state.mysql, task.user_id, name, namespace).await?;
        }
    }
    if let Some(team_ref) = spec.and_then(|spec| spec.team_ref.as_ref()) {
        let name = team_ref.name();
        let namespace = team_ref.namespace();
        // `resolve_task_ref_team`: an explicit `teamRef.user_id` (the
        // recorded public teams use `0`) selects the direct owner query;
        // a null/missing field resolves through the public kinds reader
        // (`kindReader.get_by_name_and_namespace`'s Team branch).
        match team_ref.user_id.as_ref() {
            Some(value) if !value.is_null() => {
                let team_user_id = value.json_integer().unwrap_or(0);
                if !name.is_empty() {
                    tasks::resolve_team_id(&state.mysql, team_user_id, namespace, name).await?;
                }
            }
            _ => {
                // `convert_to_task_dict` passes the task owner as the
                // viewer; the public reader resolves the owner's personal
                // team through direct SQL.
                let kinds_cache = crate::task_skills::kinds::KindCacheStore {
                    mysql: &state.mysql,
                    redis: state.redis.as_ref(),
                    // The share-permission fallbacks (entity bindings, group
                    // role) require the ERP directory and the entity
                    // resolvers, which this state does not retain; only the
                    // direct member-row pass runs here.
                    erp: None,
                    resolvers: None,
                };
                kinds_cache
                    .resolve_team(task.user_id, namespace, name)
                    .await?;
            }
        }
    }
    // `userReader.get_by_id` uses the public direct SQL reader.
    tasks::get_user_by_id(&state.mysql, task.user_id).await?;
    Ok(())
}

fn internal_error(error: anyhow::Error) -> EndpointError {
    tracing::error!(%error, "runtime-check dependency failure");
    EndpointError {
        status: 500,
        detail: "Internal server error",
    }
}

/// Render a naive datetime exactly like pydantic's default serialization:
/// `YYYY-MM-DDTHH:MM:SS.ffffff` with microsecond precision.
fn format_python_datetime(value: &chrono::NaiveDateTime) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn datetime_matches_python_format() {
        let parsed = chrono::NaiveDateTime::parse_from_str(
            "2026-07-14T14:47:41.807109",
            "%Y-%m-%dT%H:%M:%S%.f",
        )
        .unwrap();
        assert_eq!(
            format_python_datetime(&parsed),
            "2026-07-14T14:47:41.807109"
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
}
