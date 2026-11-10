// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app/api/ws/chat_namespace.py::ChatNamespace._event_handlers`.

use std::sync::Arc;

use brz_socket_io::{ClientError, ConnectionContext, Reply};
use serde_json::Value;

use crate::socketio::chat_session::ChatSession;
use crate::socketio::chat_task_join;
use crate::socketio::runtime::SocketRuntime;
use crate::state::AppState;

/// `on_task_join`.
#[brz_socket_io::event("task:join", namespace = "/chat")]
async fn join_task(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    chat_task_join::join_task(app, runtime, session, context.id(), data).await
}

/// `on_chat_send`.
#[brz_socket_io::event("chat:send", namespace = "/chat")]
async fn send(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_send::handle(app, runtime, session, context.id(), data).await
}
/// `on_chat_cancel`.
#[brz_socket_io::event("chat:cancel", namespace = "/chat")]
async fn cancel(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_control::cancel(app, runtime, session, context.id(), data).await
}
/// `on_chat_retry`.
#[brz_socket_io::event("chat:retry", namespace = "/chat")]
async fn retry(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_retry::retry(app, runtime, session, context.id(), data).await
}

/// `on_chat_guide`.
#[brz_socket_io::event("chat:guide", namespace = "/chat")]
async fn guide(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_control::guide(app, runtime, session, context.id(), data).await
}

/// `on_chat_resume`.
#[brz_socket_io::event("chat:resume", namespace = "/chat")]
async fn resume(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_events::resume(app, runtime, session, context.id(), data).await
}
/// `on_task_leave`: leave the task room. The recorded frames carry no ACK id,
/// so only the room action is observable.
#[brz_socket_io::event("task:leave", namespace = "/chat")]
async fn leave_task(#[payload] data: Value) -> Result<Reply<Value>, ClientError> {
    let Some(task_id) = data.get("task_id").and_then(payload_integer) else {
        return Ok(Reply::payload(
            serde_json::json!({"error": "Invalid payload: task_id: Input should be a valid integer"}),
        ));
    };
    Ok(Reply::payload(serde_json::json!({"success": true})).leave(format!("task:{task_id}")))
}

/// Pydantic's lax `int` coercion: integers and integral numeric strings/floats.
fn payload_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|value| value.fract() == 0.0)
                .map(|value| value as i64)
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}
/// `on_task_close_session`.
#[brz_socket_io::event("task:close-session", namespace = "/chat")]
async fn close_session(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_events::close_session(app, runtime, session, context.id(), data).await
}

/// `on_history_sync`.
#[brz_socket_io::event("history:sync", namespace = "/chat")]
async fn history_sync(
    #[payload] data: Value,
    #[session] session: &ChatSession,
    #[inject(app)] app: &Arc<AppState>,
) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_events::history_sync(app, session, data).await
}

/// `on_skill_response`.
#[brz_socket_io::event("skill:response", namespace = "/chat")]
async fn skill_response(#[payload] data: Value) -> Result<Reply<Value>, ClientError> {
    crate::socketio::chat_events::skill_response(data).await
}
