// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication is business policy; the framework owns its session lifetime.

use std::sync::Arc;

use brz_socket_io::{Accept, ClientError, ConnectionContext};
use serde_json::Value;

use crate::socketio::auth::{self, Identity};
use crate::socketio::chat_session::{CLIENT_ORIGIN_WEWORK, ChatSession};
use crate::socketio::device_lifecycle;
use crate::socketio::runtime::SocketRuntime;
use crate::socketio::session::DeviceSession;
use crate::state::AppState;

#[derive(Debug)]
pub(super) struct AuthenticatedUser {
    identity: Identity,
}

impl AuthenticatedUser {
    /// The authenticated connection identity.
    pub(super) fn identity(&self) -> &Identity {
        &self.identity
    }
}

#[brz_socket_io::middleware]
async fn authorize_jwt(
    #[payload] credential: Value,
    #[inject(app)] app: &AppState,
) -> Result<AuthenticatedUser, ClientError> {
    ensure_running(app)?;
    let token = token(&credential)?;
    let identity = auth::verify_jwt(app, token)
        .await
        .map_err(|error| ClientError::new("UNAUTHENTICATED", error.message()))?;
    let _ = &credential;
    Ok(AuthenticatedUser { identity })
}

#[brz_socket_io::middleware]
async fn authorize_device(
    #[payload] credential: Value,
    #[inject(app)] app: &AppState,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
    #[context] context: &ConnectionContext,
) -> Result<AuthenticatedUser, ClientError> {
    ensure_running(app)?;
    // `on_connect` rate-limits the connection before verifying the token.
    let peer = context.peer_addr().map(|address| address.ip().to_string());
    if !runtime.allow_connection(peer.as_deref()) {
        return Err(ClientError::new(
            "CONNECT_REJECTED",
            "Too many device connection attempts",
        ));
    }
    let identity = auth::verify(app, token(&credential)?)
        .await
        .map_err(|error| ClientError::new("UNAUTHENTICATED", error.message()))?;
    Ok(AuthenticatedUser { identity })
}

fn token(credential: &Value) -> Result<&str, ClientError> {
    credential
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| ClientError::new("UNAUTHENTICATED", "Missing authentication token"))
}

fn ensure_running(app: &AppState) -> Result<(), ClientError> {
    if app.shutdown.is_shutting_down() {
        return Err(ClientError::new("SHUTTING_DOWN", "Server is shutting down"));
    }
    Ok(())
}

#[brz_socket_io::namespace("/chat", middleware = authorize_jwt)]
async fn chat(
    #[payload] credential: Value,
    #[auth] user: &AuthenticatedUser,
) -> Result<Accept<ChatSession>, ClientError> {
    let token = credential.get("token").and_then(Value::as_str);
    let client_origin = (credential.get("client_origin").and_then(Value::as_str)
        == Some(CLIENT_ORIGIN_WEWORK))
    .then_some(CLIENT_ORIGIN_WEWORK);
    let session = ChatSession::new(user.identity(), token, client_origin);
    let room = if session.is_wework() {
        format!("wework:user:{}", session.user_id())
    } else {
        format!("user:{}", session.user_id())
    };
    Ok(Accept::new(session).join(room))
}

#[brz_socket_io::namespace("/local-executor", middleware = authorize_device)]
async fn device(
    #[auth] user: &AuthenticatedUser,
    #[context] context: &ConnectionContext,
) -> Result<Accept<DeviceSession>, ClientError> {
    let client_ip = context.peer_addr().map(|address| address.ip().to_string());
    Ok(Accept::new(DeviceSession::new(user.identity(), client_ip))
        .join(format!("user:{}", user.identity().user_id)))
}

#[brz_socket_io::namespace("/terminal", middleware = authorize_jwt)]
async fn terminal(#[auth] user: &AuthenticatedUser) -> Result<Accept<()>, ClientError> {
    Ok(Accept::default().join(format!("user:{}", user.identity.user_id)))
}

#[brz_socket_io::namespace("/wework-runtime", middleware = authorize_jwt)]
async fn runtime(#[auth] user: &AuthenticatedUser) -> Result<Accept<()>, ClientError> {
    Ok(Accept::default().join(format!("wework-runtime:user:{}", user.identity.user_id)))
}

/// Source business cleanup hooks. Framework session/room cleanup runs even
/// while these application hooks are still empty.
#[brz_socket_io::disconnect(namespace = "/chat")]
async fn chat_disconnected(#[auth] _user: &AuthenticatedUser) -> Result<(), ClientError> {
    Ok(())
}

#[brz_socket_io::disconnect(namespace = "/local-executor")]
async fn device_disconnected(
    #[session] session: &DeviceSession,
    #[context] context: &ConnectionContext,
    #[inject(app)] app: &Arc<AppState>,
    #[inject(runtime)] runtime: &Arc<SocketRuntime>,
) -> Result<(), ClientError> {
    device_lifecycle::disconnect(app, runtime, session, context.id()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn credentials_require_a_nonempty_token_string() {
        for input in [
            Value::Null,
            json!({}),
            json!({"token": ""}),
            json!({"token": 42}),
        ] {
            assert_eq!(
                token(&input).expect_err("invalid credential").code,
                "UNAUTHENTICATED"
            );
        }
        assert_eq!(
            token(&json!({"token": "credential"})).unwrap(),
            "credential"
        );
    }
}
