// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared `/chat` event plumbing for the migrated control events.
//!
//! Source: the repeated prefix of `app/api/ws/chat_namespace.py`'s handlers —
//! `_check_token_expiry`/`_handle_token_expired`, the `{"error": ...}` ACK
//! shape, and the `can_access_task` guard.

use std::sync::Arc;

use brz_socket_io::ClientError;
use serde_json::{Value, json};

use crate::socketio::chat_session::ChatSession;
use crate::socketio::device_lifecycle::publish_room_event;
use crate::socketio::runtime::{CHAT_NAMESPACE, SocketRuntime};
use crate::state::AppState;

/// The source's generic acknowledgement error shape.
pub(crate) fn error_ack(message: &str) -> Value {
    json!({ "error": message })
}

/// `_handle_token_expired`: emit `auth_error` to the socket and answer.
pub(crate) async fn token_expired(
    state: &AppState,
    runtime: &Arc<SocketRuntime>,
    socket_id: &str,
) -> Value {
    let payload = json!({"error": "Token expired", "code": "TOKEN_EXPIRED"});
    if let Err(error) = runtime
        .emitters()
        .chat_auth_error(socket_id, &payload)
        .await
    {
        tracing::warn!(%error, "auth_error local delivery failed");
    }
    publish_room_event(state, "auth_error", &payload, CHAT_NAMESPACE, socket_id).await;
    error_ack("Token expired")
}

/// The source's unhandled dependency failure surfaced to the client.
pub(crate) fn internal_error() -> ClientError {
    ClientError::new("INTERNAL", "Internal server error")
}

/// `can_access_task` for one authenticated chat caller.
pub(crate) async fn access_denied(
    state: &AppState,
    session: &ChatSession,
    task_id: i64,
    event: &str,
) -> Result<Option<Value>, ClientError> {
    match super::chat_task_join::can_access_task(state, session.user_id(), task_id).await {
        Ok(true) => Ok(None),
        Ok(false) => Ok(Some(error_ack("Access denied"))),
        Err(error) => {
            tracing::error!(%error, task_id, event, "chat event access read failed");
            Err(internal_error())
        }
    }
}

/// The `_handle_token_expired` guard returns `Some(ack)` when expired.
pub(crate) fn expired<'a>(
    session: &ChatSession,
    state: &'a AppState,
    runtime: &'a Arc<SocketRuntime>,
    socket_id: &'a str,
) -> Option<impl std::future::Future<Output = Value> + 'a> {
    session
        .token_expired(chrono::Utc::now().timestamp())
        .then(|| token_expired(state, runtime, socket_id))
}
