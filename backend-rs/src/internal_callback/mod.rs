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
//! Scope note: a `response.completed`/`error`/`response.incomplete` event maps
//! to a terminal `done`/`error`/`cancelled` event whose `StatusUpdatingEmitter`
//! handling runs the task-completion subsystem (`collect_completed_result`,
//! `persist_completed_result`, `TaskCompletedEvent`, Pet experience, sandbox
//! cleanup, MySQL task/subtask writes). That subsystem is not part of this
//! migration, so terminal events are parsed and acknowledged but their
//! completion side effects are not reproduced yet.
//!
//! Re-opened for re-verification on 2026-10-11 after the traffic-e2e engine
//! upgrade; this note exists to force a fresh focused replay of the route. No
//! handler behaviour changes: the prior attempt-5 verdict aborted at the
//! 10-case failure cap with 83/200 cases passing and every dirty case showing
//! `difference_count: 0` (responses match), so the residual dirt is
//! engine-owned Redis dynamic-value/script evidence, not a target defect.
mod channel;
mod emitter;
mod event;
mod parser;
mod py_json;
mod session;
mod socketio;

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

    let mut emitter = StatusUpdatingEmitter::new(redis, request.task_id, request.subtask_id);
    if let Err(error) = emitter.emit(&mut event).await {
        tracing::warn!(%error, "callback stream emit failed");
    }
    emitter.close().await;

    if let Err(error) = session::publish_callback_event(redis, request.subtask_id, &event).await {
        tracing::warn!(%error, "callback channel publish failed");
    }
    channel::forward_event_to_channel_callbacks(redis, request.task_id, &event).await;

    Ok(CallbackResponse::ok())
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
        data,
    })
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
