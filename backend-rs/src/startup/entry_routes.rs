// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Common HTTP entry routes: health, chat history, and OIDC callback.
use crate::http_compat::FastApiError;
#[cfg(test)]
use crate::shutdown_state::ShutdownState;
use crate::state::AppState;
use crate::{chat_history, oidc_callback};
use serde::Serialize;
#[cfg(test)]
use std::sync::Arc;

/// Mirrors source `startup_check` in
/// Wegent/backend/app/api/endpoints/health.py (registered under /api with no
/// extra prefix): always 200 with {"status":"started"} once the server is up.
#[derive(Serialize)]
struct StartupStatus {
    status: &'static str,
}

#[derive(Serialize)]
struct ShutdownRunning {
    is_shutting_down: bool,
}

/// Fixed root response matching `root` in the source app.
const ROOT_BODY: &[u8] = br#"{"name":"Task Manager Backend","version":"1.0.0","api_prefix":"/api","docs_url":"/api/docs","socketio_path":"/socket.io"}"#;

// The main-router endpoints wired inline in the source app factory rather than
// by a feature module (`root`, `startup_check`, `shutdown_status`, internal chat
// history and the OIDC callback). Each is an async free
// function in the default group, injecting the shared application state.

/// GET /. Mirrors `root` in source app/main.py: the app-information endpoint,
/// registered on the FastAPI app rather than under the API prefix.
#[brz_http_server::get("/", api_log = false)]
async fn root() -> brz_http_server::Response {
    brz_http_server::Response::static_bytes(brz_http_server::StatusCode::OK, ROOT_BODY)
        .content_type("application/json")
}

/// GET /api/startup.
#[brz_http_server::get("/api/startup")]
async fn startup() -> StartupStatus {
    StartupStatus { status: "started" }
}

/// GET /api/shutdown/status. Mirrors `shutdown_status` in source
/// app/api/endpoints/health.py: 200 with `{"is_shutting_down": false}`
/// while running; 503 with a shutdown payload once graceful shutdown has
/// been initiated.
#[brz_http_server::get("/api/shutdown/status")]
async fn shutdown_status(
    #[inject(state)] state: &AppState,
) -> Result<ShutdownRunning, FastApiError> {
    if state.shutdown.is_shutting_down() {
        Err(shutdown_stopping_error())
    } else {
        Ok(ShutdownRunning {
            is_shutting_down: false,
        })
    }
}

/// GET /api/internal/chat/history/{session_id}.
#[brz_http_server::get("/api/internal/chat/history/:session_id")]
async fn chat_history(
    #[inject(state)] state: &AppState,
    session_id: &str,
    #[header] authorization: Option<&str>,
    query: brz_http_server::Query<chat_history::HistoryQuery>,
) -> Result<chat_history::HistoryResponse, FastApiError> {
    chat_history::get_chat_history_value(state, session_id, authorization, &query).await
}

/// GET /api/auth/oidc/callback.
#[brz_http_server::get("/api/auth/oidc/callback")]
async fn oidc_callback(
    #[inject(state)] state: &AppState,
    code: Option<String>,
    oidc_state: Option<String>,
    error: Option<String>,
) -> Result<brz_http_server::Redirect, FastApiError> {
    state
        .oidc_callback
        .handle(
            state,
            oidc_callback::CallbackQuery {
                code,
                state: oidc_state,
                error,
            },
        )
        .await
}

/// The source's 503 shutdown payload rendered with its field order.
fn shutdown_stopping_error() -> FastApiError {
    FastApiError::json_body(
        brz_http_server::StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({
            "status": "shutting_down",
            "message": "Service is shutting down, not accepting new traffic",
        }),
    )
}

// Mirrors `shutdown_status` in source app/api/endpoints/health.py: 200 with
// `{"is_shutting_down": false}` while running; 503 with a shutdown payload
// once graceful shutdown has been initiated.
#[cfg(test)]
async fn shutdown_status_value(
    state: &Arc<ShutdownState>,
) -> Result<ShutdownRunning, FastApiError> {
    if state.is_shutting_down() {
        Err(shutdown_stopping_error())
    } else {
        Ok(ShutdownRunning {
            is_shutting_down: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_check_body_matches_source() {
        let body = serde_json::to_string(&StartupStatus { status: "started" }).unwrap();
        assert_eq!(body, r#"{"status":"started"}"#);
    }

    #[test]
    fn root_body_matches_source() {
        assert_eq!(
            ROOT_BODY,
            r#"{"name":"Task Manager Backend","version":"1.0.0","api_prefix":"/api","docs_url":"/api/docs","socketio_path":"/socket.io"}"#
                .as_bytes()
        );
    }

    #[tokio::test]
    async fn shutdown_status_returns_false_while_running() {
        let state = Arc::new(ShutdownState::default());
        let Ok(value) = shutdown_status_value(&state).await else {
            panic!("shutdown status must be Ok while running");
        };
        let body = serde_json::to_string(&value).unwrap();
        assert_eq!(body, r#"{"is_shutting_down":false}"#);
    }
}
