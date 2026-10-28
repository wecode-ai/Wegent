// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/callback` — unified execution callback.
//!
//! Mirrors `app/api/endpoints/internal/callback.py:handle_callback`. The
//! endpoint is public in the source (its router is mounted without an auth
//! dependency), receives OpenAI Responses API events from executors, persists
//! stream state, publishes to Socket.IO, and forwards to IM channel callbacks.
//!
//! Terminal events run the task-completion subsystem inside the request: the
//! `StatusUpdatingEmitter` collects and persists the final result, cleans the
//! streaming state up and publishes `TaskCompletedEvent`. [`completion`] owns
//! that subsystem; the wrapped emitter's `chat:done` and `task:status` frames
//! are emitted from here, in the source's order.
mod channel;
pub(crate) mod completion;
pub(crate) mod emitter;
pub(crate) mod event;
pub(crate) mod parser;
mod pipeline;
pub(crate) mod py_json;
pub(crate) mod session;
mod socketio;

pub(crate) use session::is_cancelled;

#[cfg(test)]
mod tests;

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_http_server::StatusCode;
use emitter::StatusUpdatingEmitter;

/// `CallbackRequest` (`app/api/endpoints/internal/callback.py`).
struct CallbackRequest {
    event_type: String,
    task_id: i64,
    subtask_id: i64,
    message_id: Option<i64>,
    executor_name: Option<String>,
    executor_namespace: Option<String>,
    data: Value,
}

/// `CallbackResponse`.
#[derive(Serialize)]
struct CallbackResponse {
    status: String,
    message: Option<String>,
}

impl CallbackResponse {
    fn ok() -> Self {
        Self {
            status: "ok".to_string(),
            message: None,
        }
    }

    fn skipped() -> Self {
        Self {
            status: "ok".to_string(),
            message: Some("Lifecycle event skipped".to_string()),
        }
    }
}

/// `POST /api/internal/callback`.
///
/// The source route is mounted without an auth dependency, so it is public.
#[brz_http_server::post("/api/internal/callback", access = public)]
async fn handle_callback(
    #[inject(state)] state: &AppState,
    body: serde_json::Value,
) -> Result<CallbackResponse, FastApiError> {
    let request = parse_request(&body)?;

    let parser = parser::shared();
    let Some(mut event) = parser
        .parse(
            request.task_id,
            request.subtask_id,
            request.message_id,
            &request.event_type,
            &request.data,
        )
        .map_err(|error| FastApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, error.0))?
    else {
        return Ok(CallbackResponse::skipped());
    };

    let Some(redis) = state.redis.as_ref() else {
        // The source tolerates an unavailable Redis by swallowing the cache
        // errors and still returning `ok`.
        return Ok(CallbackResponse::ok());
    };

    let terminal_status = completion::terminal_status(&event.event_type);

    let mut emitter =
        StatusUpdatingEmitter::new(redis.to_owned(), request.task_id, request.subtask_id);
    if terminal_status.is_none()
        && let Err(error) = emitter.emit(&mut event).await
    {
        tracing::warn!(%error, "callback stream emit failed");
    }
    emitter.close().await;

    if let Some(status) = terminal_status {
        let ctx = completion::Completion {
            app: Some(state),
            mysql: &state.mysql,
            redis,
            tables: tables(state),
            executor_manager: &state.executor_manager,
        };
        let (final_result, user_id, auto_advance) = completion::complete_terminal_with_advance(
            &ctx,
            request.task_id,
            request.subtask_id,
            status,
            event.result.as_ref(),
            event.error.as_deref(),
            event.error_code.as_deref(),
            request.executor_name.as_deref(),
            request.executor_namespace.as_deref(),
        )
        .await;
        // `_update_task_status_sync` only schedules the next turn when
        // `get_auto_advance_info` produced an intent; every other completion,
        // including a non-pipeline team, stops after persisting its status.
        let advance = if auto_advance {
            state
                .task_store
                .advance_pipeline_stage(&state.mysql, request.task_id, request.subtask_id)
                .await
                .map_err(|error| {
                    tracing::error!(%error, "pipeline advancement failed");
                    FastApiError::internal()
                })?
        } else {
            None
        };
        let result = final_result
            .or_else(|| event.result.clone())
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
        event.result = Some(result.clone());
        // `WebSocketResultEmitter.emit`'s terminal branch: the event's frame
        // (`chat:done` / `chat:error` / `chat:cancelled`) then `task:status`.
        if let Err(error) = emitter::emit_terminal_frames(redis, &event, user_id, &result).await {
            tracing::warn!(%error, "callback terminal frames failed");
        }
        if let Some(advance) = advance {
            pipeline::dispatch_next(state, advance).await?;
        }
    }

    if let Err(error) = session::publish_callback_event(redis, request.subtask_id, &event).await {
        tracing::warn!(%error, "callback channel publish failed");
    }
    channel::forward_event_to_channel_callbacks(redis, request.task_id, &event).await;

    Ok(CallbackResponse::ok())
}

/// The deployment's task/subtask table templates.
pub(crate) fn tables(state: &AppState) -> completion::Tables {
    let templates = state.task_store.table_templates();
    completion::Tables {
        tasks: templates.tasks,
        subtasks: templates.subtasks,
    }
}

/// Validate the request like the source's `CallbackRequest` pydantic model.
fn parse_request(body: &Value) -> Result<CallbackRequest, FastApiError> {
    let Some(object) = body.as_object() else {
        return Err(validation_error(vec![json!({
            "type": "model_attributes_type",
            "loc": ["body"],
            "msg": "Input should be a valid dictionary or object to extract fields from",
            "input": body,
        })]));
    };

    let mut errors: Vec<Value> = Vec::new();
    let event_type = required_string(object, "event_type", &mut errors);
    let task_id = required_int(object, "task_id", &mut errors);
    let subtask_id = required_int(object, "subtask_id", &mut errors);
    let message_id = optional_int(object, "message_id", &mut errors);
    let executor_name = optional_string(object, "executor_name", &mut errors);
    let executor_namespace = optional_string(object, "executor_namespace", &mut errors);
    if !errors.is_empty() {
        return Err(validation_error(errors));
    }
    let data = match object.get("data") {
        Some(Value::Object(_)) | None => object.get("data").cloned().unwrap_or_else(|| json!({})),
        Some(other) => {
            return Err(validation_error(vec![json!({
                "type": "dict_type",
                "loc": ["body", "data"],
                "msg": "Input should be a valid dictionary",
                "input": other,
            })]));
        }
    };

    Ok(CallbackRequest {
        event_type: event_type.expect("validated"),
        task_id: task_id.expect("validated"),
        subtask_id: subtask_id.expect("validated"),
        message_id,
        executor_name,
        executor_namespace,
        data,
    })
}

fn optional_string(
    object: &Map<String, Value>,
    field: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    match object.get(field) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            errors.push(json!({
                "type": "string_type",
                "loc": ["body", field],
                "msg": "Input should be a valid string",
                "input": other,
            }));
            None
        }
    }
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    errors: &mut Vec<Value>,
) -> Option<String> {
    match object.get(field) {
        Some(Value::String(text)) => Some(text.clone()),
        Some(other) => {
            errors.push(json!({
                "type": "string_type",
                "loc": ["body", field],
                "msg": "Input should be a valid string",
                "input": other,
            }));
            None
        }
        None => {
            errors.push(json!({
                "type": "missing",
                "loc": ["body", field],
                "msg": "Field required",
                "input": Value::Object(object.clone()),
            }));
            None
        }
    }
}

fn required_int(object: &Map<String, Value>, field: &str, errors: &mut Vec<Value>) -> Option<i64> {
    match object.get(field) {
        Some(value) => match coerce_int(value) {
            Some(number) => Some(number),
            None => {
                errors.push(json!({
                    "type": "int_parsing",
                    "loc": ["body", field],
                    "msg": "Input should be a valid integer, unable to parse string as an integer",
                    "input": value,
                }));
                None
            }
        },
        None => {
            errors.push(json!({
                "type": "missing",
                "loc": ["body", field],
                "msg": "Field required",
                "input": Value::Object(object.clone()),
            }));
            None
        }
    }
}

fn optional_int(object: &Map<String, Value>, field: &str, errors: &mut Vec<Value>) -> Option<i64> {
    match object.get(field) {
        None | Some(Value::Null) => None,
        Some(value) => coerce_int(value).or_else(|| {
            errors.push(json!({
                "type": "int_parsing",
                "loc": ["body", field],
                "msg": "Input should be a valid integer",
                "input": value,
            }));
            None
        }),
    }
}

fn coerce_int(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn validation_error(detail: Vec<Value>) -> FastApiError {
    FastApiError::validation(detail)
}
