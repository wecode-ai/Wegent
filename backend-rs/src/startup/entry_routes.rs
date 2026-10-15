// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Common HTTP entry routes: health, chat history, and OIDC callback.
use crate::http_compat::FastApiError;
#[cfg(test)]
use crate::shutdown_state::ShutdownState;
use crate::state::AppState;
use crate::{chat_history, oidc_callback};
use brz_redis::{Redis as _, SetExpiration, SetOptions};
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

/// `wait_for_shutdown`'s response while no stream is active (source
/// app/api/endpoints/health.py:195-201).
#[derive(Serialize)]
struct ShutdownWaitCompleted {
    status: &'static str,
    message: &'static str,
    active_streams: u32,
    waited_seconds: u32,
}

/// `SHUTDOWN_STATE_KEY` (source app/core/shutdown.py).
const SHUTDOWN_STATE_KEY: &str = "wegent:shutdown_state";
/// `SHUTDOWN_STATE_TTL` (source app/core/shutdown.py, 2 minutes).
const SHUTDOWN_STATE_TTL_SECONDS: u64 = 120;

/// The cross-worker marker `_notify_shutdown_via_redis` writes:
/// `orjson.dumps({"shutting_down": True, "timestamp": time.time()})`.
/// serde_json renders byte-identical compact output for this bool/float pair
/// (shortest round-trip float formatting, no escaping).
#[derive(Serialize)]
struct ShutdownStateNotice {
    shutting_down: bool,
    timestamp: f64,
}

/// Fixed root response matching `root` in the source app.
const ROOT_BODY: &[u8] = br#"{"name":"Task Manager Backend","version":"1.0.0","api_prefix":"/api","docs_url":"/api/docs","socketio_path":"/socket.io"}"#;

// The main-router endpoints wired inline in the source app factory rather than
// by a feature module (`root`, `startup_check`, `shutdown_status`, internal chat
// history and the OIDC callback). Each is an async free
// function in the default group, injecting the shared application state.

/// GET /. Mirrors `root` in source app/main.py: the app-information endpoint,
/// registered on the FastAPI app rather than under the API prefix.
#[brz_http_server::get("/", api_log = false, access = public)]
async fn root() -> brz_http_server::Response {
    brz_http_server::Response::static_bytes(brz_http_server::StatusCode::OK, ROOT_BODY)
        .content_type("application/json")
}

/// GET /api/startup. The readiness probe path (the migration image and the
/// traffic harness poll it every second), so its requests stay out of the
/// access log the same way `/` does.
#[brz_http_server::get("/api/startup", api_log = false, access = public)]
async fn startup() -> StartupStatus {
    StartupStatus { status: "started" }
}

/// GET /api/shutdown/status. Mirrors `shutdown_status` in source
/// app/api/endpoints/health.py: 200 with `{"is_shutting_down": false}`
/// while running; 503 with a shutdown payload once graceful shutdown has
/// been initiated.
#[brz_http_server::get("/api/shutdown/status", access = public)]
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

/// POST /api/shutdown/wait. Mirrors `wait_for_shutdown` in source
/// app/api/endpoints/health.py: the Kubernetes preStop hook that initiates
/// shutdown if needed, then waits for active streams. The migrated origin
/// tracks no active streams in this process, so the source's
/// `active_streams == 0` branch applies and the wait returns immediately.
#[brz_http_server::post("/api/shutdown/wait", access = public)]
async fn wait_for_shutdown(#[inject(state)] state: &AppState) -> ShutdownWaitCompleted {
    // `initiate_shutdown` publishes the cross-worker marker and flips the
    // process-local flag; `_notify_shutdown_via_redis` swallows every Redis
    // failure, so a missing cache never changes the response.
    if !state.shutdown.is_shutting_down()
        && state.shutdown.initiate()
        && let Some(redis) = state.redis.as_ref()
    {
        let notice = ShutdownStateNotice {
            shutting_down: true,
            timestamp: unix_now_seconds(),
        };
        // orjson's compact encoding; serde_json renders the same bytes for
        // this bool/float pair (shortest round-trip float format).
        let payload = serde_json::to_string(&notice).unwrap_or_default();
        if let Err(error) = redis
            .set_with(
                SHUTDOWN_STATE_KEY,
                payload,
                SetOptions::default()
                    .with_expiration(SetExpiration::Seconds(SHUTDOWN_STATE_TTL_SECONDS)),
            )
            .await
        {
            tracing::warn!(%error, "failed to publish shutdown state to Redis");
        }
    }
    ShutdownWaitCompleted {
        status: "completed",
        message: "No active streams, shutdown can proceed immediately",
        active_streams: 0,
        waited_seconds: 0,
    }
}

/// `time.time()`: Unix seconds with sub-second precision.
fn unix_now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64())
}

/// GET /api/internal/chat/history/{session_id}.
#[brz_http_server::get("/api/internal/chat/history/:session_id")]
async fn chat_history(
    #[inject(state)] state: &AppState,
    session_id: &str,
    #[auth] _service: crate::internal_auth::InternalService,
    query: brz_http_server::Query<chat_history::HistoryQuery>,
) -> Result<chat_history::HistoryResponse, FastApiError> {
    chat_history::get_chat_history_value(state, session_id, &query).await
}

/// GET /api/auth/oidc/callback.
#[brz_http_server::get("/api/auth/oidc/callback", access = public)]
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

// The handler body without the Redis side effect, so the response shape can
// be exercised without a live cache.
#[cfg(test)]
async fn wait_for_shutdown_value(state: &Arc<ShutdownState>) -> ShutdownWaitCompleted {
    state.initiate();
    ShutdownWaitCompleted {
        status: "completed",
        message: "No active streams, shutdown can proceed immediately",
        active_streams: 0,
        waited_seconds: 0,
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

    #[tokio::test]
    async fn shutdown_wait_body_matches_source() {
        let state = Arc::new(ShutdownState::default());
        let value = wait_for_shutdown_value(&state).await;
        let body = serde_json::to_string(&value).unwrap();
        assert_eq!(
            body,
            r#"{"status":"completed","message":"No active streams, shutdown can proceed immediately","active_streams":0,"waited_seconds":0}"#
        );
        // The second call takes the source's "already initiated" path and
        // still renders the same completed body.
        let body = serde_json::to_string(&wait_for_shutdown_value(&state).await).unwrap();
        assert_eq!(
            body,
            r#"{"status":"completed","message":"No active streams, shutdown can proceed immediately","active_streams":0,"waited_seconds":0}"#
        );
    }

    #[test]
    fn shutdown_notice_serializes_like_orjson() {
        let notice = ShutdownStateNotice {
            shutting_down: true,
            timestamp: 1791810453.1906633,
        };
        assert_eq!(
            serde_json::to_string(&notice).unwrap(),
            r#"{"shutting_down":true,"timestamp":1791810453.1906633}"#
        );
    }

    #[test]
    fn wait_for_shutdown_is_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .filter(|path| *path == "/api/shutdown/wait")
            .collect();
        assert_eq!(paths, ["/api/shutdown/wait"]);
    }
}
