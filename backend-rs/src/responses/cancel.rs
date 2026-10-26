// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/responses/{response_id}/cancel` — cancel a running response
//! (`app.api.endpoints.openapi_responses.cancel_response`).
//!
//! Source flow: flexible authentication (`security.get_current_user_flexible`,
//! shared with `get_response`), the `settings.RATE_LIMIT_CANCEL_RESPONSE`
//! fixed-window limit, `resp_{task_id}` parsing, the owner-or-member task
//! lookup (`task_store.get_task_by_states(states=[ACTIVE], owner)`, then the
//! member fallback with `task_access_store.is_member`), the `source=chat_shell`
//! branch (`session_manager.get_streaming_content` + `cancel_stream`, a
//! subtask/task terminal-state write, `db.commit`, then `db.refresh`), the
//! executor branch (`task_kinds_service.cancel_task`), and finally
//! `task_kinds_service.get_task_by_id` + `_task_to_response_object`.

use brz_http_server::StatusCode;
use brz_mysql::MysqlRow;
use chrono::NaiveDateTime;
use serde_json::{Value, json};

use super::auth::ResponsesUser;
use super::error::{ResponseError, rate_limit_exceeded};
use super::http_error::HttpError;
use super::output_builder::{OutputItem, ResponseObject, task_to_response_object};
use super::rate_limit::{self, RateLimit};
use super::responses_repository as repo;
use super::stream_state::{cancel_stream, streaming_content};
use crate::json_compat::python_json_value;
use crate::state::AppState;
use crate::task_store::task_update_timestamp;

/// `resp_` prefix of the response id format.
const RESPONSE_ID_PREFIX: &str = "resp_";
/// `is_wework_response_id`: native wework ids encode a JSON array, whose
/// base64url prefix is always `Wy`.
const WEWORK_RESPONSE_ID_PREFIX: &str = "resp_Wy";
/// `SubtaskStatus` values the source searches for.
const RUNNING_ASSISTANT_STATUSES: [&str; 2] = ["PENDING", "RUNNING"];
/// `TaskStatus` terminal states (`cancel_task`'s `final_states`).
const FINAL_STATES: [&str; 4] = ["COMPLETED", "FAILED", "CANCELLED", "DELETE"];

/// POST /api/v1/responses/{response_id}/cancel.
#[brz_http_server::post("/api/v1/responses/:response_id/cancel")]
async fn cancel_response(
    #[inject(state)] state: &AppState,
    response_id: &str,
    #[auth] current_user: ResponsesUser,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
) -> Result<ResponseObject, ResponseError> {
    // Rate limit (`@limiter.limit(settings.RATE_LIMIT_CANCEL_RESPONSE)`).
    let limit = RateLimit::cancel_response();
    let client_ip = client_ip(x_forwarded_for);
    let limit_key = current_user
        .rate_limit_key
        .clone()
        .unwrap_or_else(|| format!("ip:{client_ip}"));
    let path = format!("/api/v1/responses/{response_id}/cancel");
    if !rate_limit::hit(state.redis.as_ref(), limit, &limit_key, &path).await {
        return Err(rate_limit_exceeded(limit).into());
    }

    // `is_wework_response_id(response_id)`: the native wework response family
    // (`wework_api.cancel_response`) reads turns from the native runtime
    // transcript and cancels a runtime turn. That subsystem is not migrated
    // here and no recorded case of this API reaches it; it is deferred rather
    // than silently answered with a wrong body.
    if response_id.starts_with(WEWORK_RESPONSE_ID_PREFIX) {
        return Err(HttpError::new(
            StatusCode::NOT_IMPLEMENTED,
            "wework response cancellation is not implemented",
        )
        .into());
    }

    // Extract task_id from response_id.
    let Some(task_id_str) = response_id.strip_prefix(RESPONSE_ID_PREFIX) else {
        return Err(HttpError::invalid_response_id_prefix(response_id).into());
    };
    let Ok(task_id) = task_id_str.parse::<i64>() else {
        return Err(HttpError::invalid_response_id_numeric(response_id).into());
    };

    // `task_store.get_task_by_states(states=[STATE_ACTIVE],
    // owner_user_id=current_user.id)`, then the approved-member fallback.
    let task_kind = match repo::get_task_by_states_active_owned(
        state.task_store.as_ref(),
        task_id,
        current_user.id,
    )
    .await
    .map_err(internal)?
    {
        Some(task) => Some(task),
        None => {
            let member_task = repo::get_accessible_task(state.task_store.as_ref(), task_id)
                .await
                .map_err(internal)?;
            match member_task {
                Some(task)
                    if repo::is_member(
                        state.task_store.as_ref(),
                        &state.mysql,
                        task_id,
                        current_user.id,
                    )
                    .await
                    .map_err(internal)? =>
                {
                    Some(task)
                }
                _ => None,
            }
        }
    };
    let Some(task_kind) = task_kind else {
        return Err(HttpError::response_not_found(response_id).into());
    };

    // `source_label == "chat_shell"`.
    let task_crd = crate::crd::CrdDocument::project_opaque(&task_kind.json.0);
    let source_label = task_crd
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.labels.as_ref())
        .and_then(|labels| labels.source.clone());
    let is_chat_shell = source_label.as_deref() == Some("chat_shell");

    if is_chat_shell {
        cancel_chat_shell_response(state, &task_kind, task_id, current_user.id).await?;
    } else {
        cancel_executor_response(state, &task_kind, response_id).await?;
    }

    // `task_kinds_service.get_task_by_id` -> `convert_to_task_dict` +
    // `subtask_store.list_by_task_for_user_ordered`.
    match load_cancelled_response(state, task_id, current_user.id, response_id).await? {
        Some(response) => Ok(response),
        // `except HTTPException`: a task that vanished after the cancel still
        // returns the source's minimal cancelled object.
        None => Ok(minimal_cancelled_response(response_id)),
    }
}

/// `is_chat_shell` branch of `cancel_response`.
///
/// Finds the running assistant subtask, reads its partial streamed content
/// from Redis, sets the cancellation flag, then writes the subtask and task
/// terminal state and commits. `db.refresh(task)`/`db.refresh(subtask)` follow
/// the commit because SQLAlchemy expires both ORM objects.
async fn cancel_chat_shell_response(
    state: &AppState,
    task_kind: &repo::TaskRow,
    task_id: i64,
    user_id: i32,
) -> Result<(), HttpError> {
    let running = state
        .task_store
        .latest_assistant_for_user_by_statuses(task_id, user_id, &RUNNING_ASSISTANT_STATUSES)
        .await
        .map_err(internal)?;
    let Some(running) = running else {
        return Ok(());
    };
    let subtask_id: i64 = running.get_required("id").map_err(internal)?;

    // `session_manager.get_streaming_content(running_subtask.id)`.
    let partial_content = streaming_content(state.redis.as_ref(), subtask_id)
        .await
        .unwrap_or_default();

    // `session_manager.cancel_stream(running_subtask.id)`.
    cancel_stream(state.redis.as_ref(), subtask_id).await;

    // `subtask_store.update_fields(status=COMPLETED, progress=100,
    // completed_at=now, result={"value": partial_content or ""})`. The session
    // listener also keeps the flush-time clock read (`_before_flush`'s
    // `state_changed_at`) that the after-commit metrics publish consumes.
    let subtask_completed_at = task_update_timestamp();
    let subtask_updated_at = task_update_timestamp();
    let state_changed_at = chrono::Local::now().naive_local();
    let result = json!({ "value": &partial_content });
    let result_json = python_json_value(&result);
    state
        .task_store
        .update_subtask_completed(
            task_id,
            subtask_id,
            &result_json,
            &subtask_updated_at,
            &subtask_completed_at,
        )
        .await
        .map_err(internal)?;

    // `task_crd.status` terminal write + `task_store.update_json`.
    let status_updated_at = crd_timestamp();
    let status_completed_at = crd_timestamp();
    let payload = dump_cancelled_task(
        task_kind,
        &TaskWrite::ChatShell {
            partial_content: &partial_content,
        },
        &status_updated_at,
        &status_completed_at,
    );
    let task_updated_at = task_update_timestamp();
    state
        .task_store
        .update_task_json(
            task_id,
            i64::from(task_kind.user_id),
            &payload,
            &task_updated_at,
        )
        .await
        .map_err(internal)?;

    // `db.commit()`. The `after_commit` session listener publishes the
    // committed subtask state before the endpoint refreshes the ORM objects.
    if let Err(error) = state.mysql.execute("COMMIT", ()).await {
        tracing::error!(%error, "[cancel] task commit failed");
        return Err(internal(error));
    }
    publish_subtask_metric(state, &running, subtask_id, &result, state_changed_at).await;

    // `db.refresh(task_kind)` / `db.refresh(running_subtask)`, then the
    // expired auth-user reload (`current_user.id` read below).
    let _ = state
        .task_store
        .refresh_task(task_id, i64::from(task_kind.user_id))
        .await
        .map_err(internal)?;
    let _ = state
        .task_store
        .refresh_subtask(task_id, subtask_id)
        .await
        .map_err(internal)?;
    super::auth::reload_current_user(&state.mysql, user_id)
        .await
        .map_err(internal)?;
    Ok(())
}

/// `TaskRunMetricHooks._after_commit` for the assistant-subtask status change
/// this branch commits: publish the task-run metrics and swallow a store
/// failure, so a Redis error never changes the committed cancel result.
async fn publish_subtask_metric(
    state: &AppState,
    running: &MysqlRow,
    subtask_id: i64,
    result: &Value,
    state_changed_at: NaiveDateTime,
) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let Ok(created_at) = running.get::<NaiveDateTime>("created_at") else {
        return;
    };
    let error_message = running.get::<String>("error_message").ok().flatten();
    let Some(event) = subtask_metric_event(
        created_at,
        subtask_id,
        error_message.as_deref(),
        result,
        state_changed_at,
    ) else {
        return;
    };
    if let Err(error) =
        crate::task_run_metrics::record_events(redis, std::slice::from_ref(&event)).await
    {
        tracing::warn!(%error, "task run metrics publish failed");
    }
}

/// The `TaskRunMetricEvent` a committed subtask update produces
/// (`TaskRunMetricHooks._after_flush_postexec`): the row keeps its creation
/// time and error message, while the committed status and result are the ones
/// `update_fields` just wrote.
fn subtask_metric_event(
    created_at: Option<NaiveDateTime>,
    subtask_id: i64,
    error_message: Option<&str>,
    result: &Value,
    state_changed_at: NaiveDateTime,
) -> Option<crate::task_run_metrics::SubtaskMetricEvent> {
    // The committed status is `COMPLETED`; only `FAILED` sets the flag.
    crate::task_run_metric_hooks::committed_status_change(
        created_at,
        subtask_id,
        false,
        error_message,
        Some(result),
        state_changed_at,
    )
}

/// Non-`chat_shell` branch: `task_kinds_service.cancel_task`.
///
/// `cancel_task` validates the task state, then `_cancel_executor_task` sets
/// the task `CANCELLED` through `update_task` and queues the executor-manager
/// cancellation call. The endpoint consumes only the raised `HTTPException`
/// (any 404 becomes `Response '...' not found`); the returned dict is ignored.
async fn cancel_executor_response(
    state: &AppState,
    task_kind: &repo::TaskRow,
    response_id: &str,
) -> Result<(), HttpError> {
    // `get_task_detail` -> the task's current status.
    let task_crd = crate::crd::CrdDocument::project_opaque(&task_kind.json.0);
    let status = task_crd
        .status
        .as_ref()
        .and_then(|status| status.status.clone())
        .unwrap_or_else(|| "PENDING".to_owned());

    // `if current_status in final_states` -> 400.
    if FINAL_STATES.contains(&status.as_str()) {
        return Err(HttpError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "Task is already {}, cannot cancel",
                status.to_ascii_lowercase()
            ),
        ));
    }
    // `if current_status == "CANCELLING"` -> return the current status without
    // a state change. `_is_cancellation_stuck` finalization is a chat-shell
    // recovery path and is not reproduced here.
    if status == "CANCELLING" {
        return Ok(());
    }

    // `_cancel_executor_task`: `update_task(status=CANCELLED)`.
    let status_updated_at = crd_timestamp();
    let status_completed_at = crd_timestamp();
    let payload = dump_cancelled_task(
        task_kind,
        &TaskWrite::Cancelled,
        &status_updated_at,
        &status_completed_at,
    );
    let updated_at = task_update_timestamp();
    if let Err(error) = state
        .task_store
        .update_task_json(
            task_kind.id,
            i64::from(task_kind.user_id),
            &payload,
            &updated_at,
        )
        .await
    {
        // `update_task` raises 404 for a missing row; the endpoint maps it to
        // `Response '...' not found`.
        tracing::error!(%error, "[cancel] executor task update failed");
        return Err(HttpError::response_not_found(response_id));
    }
    if let Err(error) = state.mysql.execute("COMMIT", ()).await {
        tracing::error!(%error, "[cancel] executor commit failed");
        return Err(HttpError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Failed to update task status: commit failed",
        ));
    }
    Ok(())
}

/// `task_kinds_service.get_task_by_id` + `_task_to_response_object`.
///
/// Re-resolves the active non-deleted task and its membership, runs
/// `convert_to_task_dict`'s related reads, lists the subtasks, and rebuilds
/// the model string from the task's team reference.
async fn load_cancelled_response(
    state: &AppState,
    task_id: i64,
    user_id: i32,
    _response_id: &str,
) -> Result<Option<ResponseObject>, HttpError> {
    let task_store = state.task_store.as_ref();
    let task = repo::get_active_non_deleted_task(task_store, task_id)
        .await
        .map_err(internal)?;
    let Some(task) = task else {
        return Ok(None);
    };
    if !repo::is_member(task_store, &state.mysql, task_id, user_id)
        .await
        .map_err(internal)?
    {
        return Ok(None);
    }

    // `convert_to_task_dict`: workspace by ref, team resolution, user load.
    let task_crd = crate::crd::CrdDocument::project_opaque(&task.json.0);
    if let Some(workspace_ref) = task_crd
        .spec
        .as_ref()
        .and_then(|spec| spec.workspace_ref.as_ref())
    {
        let _ = repo::get_workspace_by_ref(
            task_store,
            i64::from(task.user_id),
            workspace_ref.name(),
            workspace_ref.namespace(),
        )
        .await
        .map_err(internal)?;
    }
    let _ = repo::resolve_team(&state.mysql, &task, user_id)
        .await
        .map_err(internal)?;
    let _ = super::auth::cached_user_by_id(state.user_reader.as_ref(), i64::from(task.user_id))
        .await
        .map_err(|error| {
            tracing::error!(?error, "responses user reader dependency failure");
            HttpError::internal("database query failed")
        })?;

    // `subtask_store.list_by_task_for_user_ordered`.
    let subtasks = repo::list_subtasks_for_user_ordered(task_store, task_id, user_id)
        .await
        .map_err(internal)?;

    let model_string = repo::model_string_for(Some(&task));
    let response = task_to_response_object(&task, &model_string, &subtasks, None, &state.auth)?;
    Ok(Some(response))
}

/// The source's fallback `ResponseObject` when the refreshed task lookup fails
/// after a successful cancel.
fn minimal_cancelled_response(response_id: &str) -> ResponseObject {
    ResponseObject {
        id: response_id.to_string(),
        object: "response",
        created_at: chrono::Utc::now().timestamp(),
        status: "cancelled",
        error: None,
        model: "unknown".to_string(),
        output: Vec::<OutputItem>::new(),
        pending_user_input: None,
        pending_user_input_payload: None,
        previous_response_id: None,
    }
}

/// `datetime.now()` rendered for a CRD `datetime` field: `mode="json"`
/// serialization of a naive local datetime (`2026-10-10T14:21:49.917575`).
fn crd_timestamp() -> String {
    chrono::Local::now()
        .naive_local()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

/// The terminal write a cancel branch performs on the task CRD.
enum TaskWrite<'a> {
    /// `chat_shell` branch: `status.status = COMPLETED` with the partial
    /// streamed result (`task_crd.model_dump(mode="json")`).
    ChatShell { partial_content: &'a str },
    /// Executor branch: `update_task(status=CANCELLED)`.
    Cancelled,
}

/// `task_crd.model_dump(mode="json")` for the cancel write.
///
/// The source validates the stored JSON into the `Task` model, applies the
/// terminal status fields, and re-serializes every model field in declaration
/// order — unset optional fields become explicit `null` (no `exclude_none`).
fn dump_cancelled_task(
    task_kind: &repo::TaskRow,
    write: &TaskWrite<'_>,
    updated_at: &str,
    completed_at: &str,
) -> String {
    let source = task_kind.json.0.to_value();
    let mut out = serde_json::Map::new();
    out.insert(
        "apiVersion".to_owned(),
        string_or(&source, "apiVersion", "agent.wecode.io/v1"),
    );
    out.insert("kind".to_owned(), string_or(&source, "kind", "Task"));
    out.insert("metadata".to_owned(), render_metadata(&source));
    out.insert("spec".to_owned(), render_spec(&source));
    out.insert(
        "status".to_owned(),
        render_status(&source, write, updated_at, completed_at),
    );
    python_json_value(&Value::Object(out))
}

/// `ObjectMeta` in declaration order: `name`, `namespace`, `displayName`,
/// `labels` (nulls included).
fn render_metadata(source: &Value) -> Value {
    let metadata = source.get("metadata");
    let mut out = serde_json::Map::new();
    out.insert("name".to_owned(), field_or_null(metadata, "name"));
    out.insert(
        "namespace".to_owned(),
        metadata
            .and_then(|value| value.get("namespace"))
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("default".to_owned())),
    );
    out.insert(
        "displayName".to_owned(),
        field_or_null(metadata, "displayName"),
    );
    out.insert("labels".to_owned(), field_or_null(metadata, "labels"));
    Value::Object(out)
}

/// `TaskSpec` in declaration order.
fn render_spec(source: &Value) -> Value {
    let spec = source.get("spec");
    let mut out = serde_json::Map::new();
    out.insert("title".to_owned(), field_or_null(spec, "title"));
    out.insert("prompt".to_owned(), field_or_null(spec, "prompt"));
    out.insert("teamRef".to_owned(), render_team_ref(spec));
    out.insert("workspaceRef".to_owned(), render_workspace_ref(spec));
    out.insert(
        "is_group_chat".to_owned(),
        spec.and_then(|value| value.get("is_group_chat"))
            .and_then(Value::as_bool)
            .map(Value::Bool)
            .unwrap_or(Value::Bool(false)),
    );
    out.insert(
        "knowledgeBaseRefs".to_owned(),
        field_or_null(spec, "knowledgeBaseRefs"),
    );
    out.insert(
        "knowledgeBaseScopes".to_owned(),
        field_or_null(spec, "knowledgeBaseScopes"),
    );
    out.insert(
        "externalKnowledgeRefs".to_owned(),
        spec.and_then(|value| value.get("externalKnowledgeRefs"))
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    );
    out.insert("device_id".to_owned(), field_or_null(spec, "device_id"));
    out.insert("execution".to_owned(), field_or_null(spec, "execution"));
    out.insert("fork".to_owned(), field_or_null(spec, "fork"));
    out.insert(
        "currentStage".to_owned(),
        field_or_null(spec, "currentStage"),
    );
    Value::Object(out)
}

/// `TeamTaskRef` in declaration order: `name`, `namespace`, `user_id`.
fn render_team_ref(spec: Option<&Value>) -> Value {
    let Some(team_ref) = spec.and_then(|value| value.get("teamRef")) else {
        return Value::Null;
    };
    let mut out = serde_json::Map::new();
    out.insert("name".to_owned(), field_or_null(Some(team_ref), "name"));
    out.insert(
        "namespace".to_owned(),
        team_ref
            .get("namespace")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("default".to_owned())),
    );
    out.insert(
        "user_id".to_owned(),
        field_or_null(Some(team_ref), "user_id"),
    );
    Value::Object(out)
}

/// `WorkspaceTaskRef` in declaration order: `name`, `namespace`.
fn render_workspace_ref(spec: Option<&Value>) -> Value {
    let Some(workspace_ref) = spec.and_then(|value| value.get("workspaceRef")) else {
        return Value::Null;
    };
    let mut out = serde_json::Map::new();
    out.insert(
        "name".to_owned(),
        field_or_null(Some(workspace_ref), "name"),
    );
    out.insert(
        "namespace".to_owned(),
        workspace_ref
            .get("namespace")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("default".to_owned())),
    );
    Value::Object(out)
}

/// `TaskStatus` in declaration order. A task without a stored status object
/// keeps `status: null` (the source only mutates a present status).
fn render_status(
    source: &Value,
    write: &TaskWrite<'_>,
    updated_at: &str,
    completed_at: &str,
) -> Value {
    let Some(status) = source.get("status").filter(|value| value.is_object()) else {
        return Value::Null;
    };
    let mut out = serde_json::Map::new();
    out.insert(
        "state".to_owned(),
        status
            .get("state")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| Value::String("Available".to_owned())),
    );
    out.insert("message".to_owned(), field_or_null(Some(status), "message"));
    match write {
        TaskWrite::ChatShell { partial_content } => {
            out.insert("status".to_owned(), Value::String("COMPLETED".to_owned()));
            out.insert("progress".to_owned(), progress_or_zero(status));
            out.insert("result".to_owned(), json!({ "value": partial_content }));
            out.insert("errorMessage".to_owned(), Value::String(String::new()));
        }
        TaskWrite::Cancelled => {
            out.insert("status".to_owned(), Value::String("CANCELLED".to_owned()));
            out.insert("progress".to_owned(), progress_or_zero(status));
            out.insert("result".to_owned(), field_or_null(Some(status), "result"));
            out.insert(
                "errorMessage".to_owned(),
                field_or_null(Some(status), "errorMessage"),
            );
        }
    }
    out.insert(
        "createdAt".to_owned(),
        field_or_null(Some(status), "createdAt"),
    );
    out.insert("updatedAt".to_owned(), Value::String(updated_at.to_owned()));
    out.insert(
        "completedAt".to_owned(),
        Value::String(completed_at.to_owned()),
    );
    out.insert(
        "subTasks".to_owned(),
        field_or_null(Some(status), "subTasks"),
    );
    out.insert("app".to_owned(), field_or_null(Some(status), "app"));
    out.insert("archive".to_owned(), field_or_null(Some(status), "archive"));
    Value::Object(out)
}

/// `TaskStatus.progress` (`int`, default `0`).
fn progress_or_zero(status: &Value) -> Value {
    status
        .get("progress")
        .filter(|value| !value.is_null())
        .cloned()
        .unwrap_or_else(|| Value::from(0))
}

/// The top-level `apiVersion`/`kind` string, defaulting when absent.
fn string_or(source: &Value, key: &str, default: &str) -> Value {
    source
        .get(key)
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or_else(|| Value::String(default.to_owned()))
}

/// A nested field value when present, else JSON `null` (pydantic's default
/// dump keeps every optional field as an explicit null).
fn field_or_null(parent: Option<&Value>, key: &str) -> Value {
    parent
        .and_then(|value| value.get(key))
        .cloned()
        .unwrap_or(Value::Null)
}

/// The client IP used by the rate-limit fallback key.
fn client_ip(x_forwarded_for: Option<&str>) -> String {
    x_forwarded_for
        .and_then(|value| value.split(',').next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn internal(error: impl std::fmt::Display) -> HttpError {
    tracing::error!(%error, "[cancel] dependency failure");
    HttpError::internal("database query failed")
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_json::OpaqueJson;

    /// The stored task JSON in the source's pre-dump order (spec/status/
    /// metadata/apiVersion), as read from the shard table.
    fn stored_chat_shell_task() -> Value {
        json!({
            "spec": {
                "title": "t", "prompt": "p",
                "teamRef": {"name": "team", "user_id": 7, "namespace": "ns"},
                "device_id": null, "execution": null, "currentStage": null,
                "workspaceRef": {"name": "ws", "namespace": "default"},
                "is_group_chat": false, "knowledgeBaseRefs": null,
                "knowledgeBaseScopes": null, "externalKnowledgeRefs": []
            },
            "status": {
                "app": null, "state": "Available", "result": null,
                "status": "RUNNING", "archive": null, "message": null,
                "progress": 0, "subTasks": null,
                "createdAt": "2026-10-10T14:15:07.650588",
                "updatedAt": "2026-10-10T14:21:49.693191",
                "completedAt": null, "errorMessage": ""
            },
            "metadata": {
                "name": "task-1", "labels": {"source": "chat_shell"},
                "namespace": "default", "displayName": null
            },
            "apiVersion": "agent.wecode.io/v1"
        })
    }

    fn task_row(json: Value) -> repo::TaskRow {
        repo::TaskRow {
            id: 893_078_319_851_631,
            user_id: 6498,
            json: brz_mysql::Json(OpaqueJson::from(json)),
            created_at: None,
        }
    }

    #[test]
    fn chat_shell_dump_reorders_into_model_declaration_order_with_nulls() {
        let payload = dump_cancelled_task(
            &task_row(stored_chat_shell_task()),
            &TaskWrite::ChatShell {
                partial_content: "",
            },
            "2026-10-10T14:21:49.917575",
            "2026-10-10T14:21:49.917577",
        );
        // `Task.model_dump(mode="json")` starts with apiVersion/kind/metadata.
        assert!(
            payload.starts_with(
                "{\"apiVersion\": \"agent.wecode.io/v1\", \"kind\": \"Task\", \"metadata\": {"
            ),
            "{payload}"
        );
        // `TeamTaskRef` is re-ordered to name, namespace, user_id.
        assert!(
            payload.contains(
                "\"teamRef\": {\"name\": \"team\", \"namespace\": \"ns\", \"user_id\": 7}"
            ),
            "{payload}"
        );
        // Optional model fields absent from the stored document become null.
        assert!(
            payload.contains(
                "\"device_id\": null, \"execution\": null, \"fork\": null, \"currentStage\": null"
            ),
            "{payload}"
        );
        assert!(payload.contains("\"displayName\": null"), "{payload}");
        // The terminal status fields.
        assert!(payload.contains("\"status\": \"COMPLETED\""), "{payload}");
        assert!(
            payload.contains("\"result\": {\"value\": \"\"}"),
            "{payload}"
        );
        assert!(payload.contains("\"errorMessage\": \"\""), "{payload}");
        assert!(
            payload.contains("\"updatedAt\": \"2026-10-10T14:21:49.917575\""),
            "{payload}"
        );
        assert!(
            payload.contains("\"completedAt\": \"2026-10-10T14:21:49.917577\""),
            "{payload}"
        );
        // `subTasks`/`app`/`archive` stay explicit nulls.
        assert!(
            payload.contains("\"subTasks\": null, \"app\": null, \"archive\": null}"),
            "{payload}"
        );
    }

    #[test]
    fn chat_shell_dump_keeps_partial_content_in_the_result() {
        let payload = dump_cancelled_task(
            &task_row(stored_chat_shell_task()),
            &TaskWrite::ChatShell {
                partial_content: "hello 世界",
            },
            "2026-10-10T14:21:49.917575",
            "2026-10-10T14:21:49.917577",
        );
        assert!(
            payload.contains("\"result\": {\"value\": \"hello \\u4e16\\u754c\"}"),
            "{payload}"
        );
    }

    #[test]
    fn executor_dump_marks_cancelled_and_keeps_the_stored_result() {
        let payload = dump_cancelled_task(
            &task_row(stored_chat_shell_task()),
            &TaskWrite::Cancelled,
            "2026-10-10T14:21:49.917575",
            "2026-10-10T14:21:49.917577",
        );
        assert!(payload.contains("\"status\": \"CANCELLED\""), "{payload}");
        // `update_task(status=CANCELLED)` does not rewrite result/errorMessage.
        assert!(
            payload.contains("\"result\": null, \"errorMessage\": \"\""),
            "{payload}"
        );
    }

    #[test]
    fn missing_status_renders_as_null() {
        let mut stored = stored_chat_shell_task();
        stored["status"] = Value::Null;
        let payload = dump_cancelled_task(
            &task_row(stored),
            &TaskWrite::Cancelled,
            "2026-10-10T14:21:49.917575",
            "2026-10-10T14:21:49.917577",
        );
        assert!(payload.ends_with("\"status\": null}"), "{payload}");
    }

    fn metric_time(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f").expect("valid metric time")
    }

    /// The recorded cancel case's committed subtask event: the row keeps its
    /// creation time and empty error message, and the completed status syncs
    /// the failure bucket without recording a run total.
    #[test]
    fn cancel_metric_event_publishes_the_committed_completion() {
        let created_at = metric_time("2026-10-16 11:04:21");
        let state_changed_at = metric_time("2026-10-16 11:04:22.453259");
        let event = subtask_metric_event(
            Some(created_at),
            893_078_319_868_054,
            Some(""),
            &json!({ "value": "" }),
            state_changed_at,
        )
        .expect("committed row produces an event");
        assert_eq!(event.subtask_id, 893_078_319_868_054);
        assert_eq!(event.created_at, created_at);
        assert!(!event.failed);
        assert_eq!(event.state_changed_at, state_changed_at);
        assert_eq!(event.message, None);
        assert!(!event.record_total);
        assert!(event.sync_failure);
    }

    /// `task_run_failure_message` falls back to `result["value"]`, so a
    /// non-empty partial stream becomes the published reason.
    #[test]
    fn cancel_metric_event_uses_partial_content_for_the_failure_message() {
        let event = subtask_metric_event(
            Some(metric_time("2026-10-16 11:04:21")),
            1,
            None,
            &json!({ "value": "half done" }),
            metric_time("2026-10-16 11:04:22.453259"),
        )
        .expect("committed row produces an event");
        assert_eq!(event.message.as_deref(), Some("half done"));
    }

    /// `_after_flush_postexec` skips rows without a creation time.
    #[test]
    fn cancel_metric_event_requires_the_row_creation_time() {
        assert!(
            subtask_metric_event(
                None,
                1,
                None,
                &json!({ "value": "" }),
                metric_time("2026-10-16 11:04:22.453259"),
            )
            .is_none()
        );
    }
}
