// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Common HTTP entry routes: health, chat history, and OIDC callback.
use crate::filters::source_cors;
use crate::http_compat::FastApiError;
#[cfg(test)]
use crate::shutdown_state::ShutdownState;
use crate::state::AppState;
use brz_redis::{Redis as _, SetExpiration, SetOptions};
use serde::Serialize;
#[cfg(test)]
use std::sync::Arc;
use wegent_chat_history::{self as chat_history, chat_repository::ChatHistoryRepository};

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

/// GET /api/health. Mirrors `health_check` in source
/// app/api/endpoints/health.py: the database-aware liveness probe. A
/// successful `SELECT COUNT(*) FROM users` answers 200
/// `{"status":"healthy","shutting_down":<flag>}`; a database failure is
/// caught by the source's `except` and still answers 200 with the
/// unhealthy payload. The recorded session's trailing `ROLLBACK`s are
/// driver session cleanup that Replay classifies as optional, so no
/// rollback statements are issued here.
#[brz_http_server::get("/api/health", access = public)]
async fn health_check(#[inject(state)] state: &AppState) -> brz_http_server::Response {
    health_response(&state.mysql, state.shutdown.is_shutting_down()).await
}

/// `health_check`'s liveness statement
/// (source app/api/endpoints/health.py: `db.execute(text(...)).scalar()`).
const HEALTH_USERS_COUNT_QUERY: &str = "SELECT COUNT(*) FROM users";

/// Handler body for `GET /api/health`, generic over the MySQL boundary so
/// the statement and both response branches stay testable without a database.
async fn health_response<M: brz_mysql::Mysql>(
    mysql: &M,
    shutting_down: bool,
) -> brz_http_server::Response {
    // Source `.scalar()` reads the first column positionally and never
    // inspects the value, so only a raised error selects the unhealthy body.
    let result = mysql
        .fetch_optional::<_, _, i64>(HEALTH_USERS_COUNT_QUERY, ())
        .await;
    let body = match result {
        Ok(_) => healthy_body(shutting_down),
        Err(error) => unhealthy_body(&error.to_string()),
    };
    let bytes = serde_json::to_vec(&body).unwrap_or_default();
    brz_http_server::Response::owned_bytes(brz_http_server::StatusCode::OK, bytes)
        .content_type("application/json")
}

/// `{"status":"healthy","shutting_down":<flag>}` with the source field order.
fn healthy_body(shutting_down: bool) -> serde_json::Value {
    serde_json::json!({"status": "healthy", "shutting_down": shutting_down})
}

/// The `except` branch payload; `error` carries `str(e)` of the failure.
fn unhealthy_body(error: &str) -> serde_json::Value {
    serde_json::json!({"status": "unhealthy", "database": "error", "error": error})
}

/// POST /api/health. The source route (`health_check` in
/// app/api/endpoints/health.py:44) declares only `GET`, so Starlette answers
/// every other method with `405 {"detail":"Method Not Allowed"}` plus
/// `Allow: GET` before authentication or any database access. The recorded
/// `POST /api/health` group owns that framework response.
///
/// Starlette's `CORSMiddleware` returns before installing its response wrapper
/// when the request carries no `Origin` header, so the source 405 gains no
/// CORS permissions and no `Vary: Origin`; the gateway boundary varies by
/// origin unconditionally, so the response is rendered through the shared
/// [`crate::filters::source_cors`] helper to keep the source's headers.
#[brz_http_server::post("/api/health", access = public)]
async fn health_method_not_allowed(
    #[header("origin")] origin: Option<&str>,
) -> brz_http_server::Response {
    source_cors(health_method_not_allowed_response(), origin)
}

/// The source framework's method-mismatch response for `/api/health`.
/// `Allow` advertises the source route's only method, not the target
/// router's registered method set.
fn health_method_not_allowed_response() -> brz_http_server::Response {
    brz_http_server::Response::static_bytes(
        brz_http_server::StatusCode::METHOD_NOT_ALLOWED,
        br#"{"detail":"Method Not Allowed"}"#,
    )
    .content_type("application/json")
    .allow("GET")
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
#[brz_http_server::post("/api/shutdown/wait")]
async fn wait_for_shutdown(
    #[inject(state)] state: &AppState,
    #[auth] _service: crate::internal_auth::InternalService,
) -> ShutdownWaitCompleted {
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
    let repository = ChatHistoryRepository::new(&state.mysql, state.task_store.as_ref());
    chat_history::get_chat_history_value(
        &repository,
        state.external_playback.as_ref(),
        &state.internal_chat,
        session_id,
        &query,
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
    fn wait_for_shutdown_is_registered_in_the_authenticated_group() {
        use brz_http_server::__private::inventory;
        let paths: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)().iter().map(|route| route.path))
            .filter(|path| *path == "/api/shutdown/wait")
            .collect();
        assert_eq!(paths, ["/api/shutdown/wait"]);
    }

    #[test]
    fn health_routes_are_registered_in_the_public_group() {
        use brz_http_server::__private::inventory;
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        const POST: u16 = 1 << 5;
        let methods: Vec<_> = inventory::iter::<crate::__http_registry_http_apis::Entry>()
            .flat_map(|entry| (entry.0.routes)())
            .filter(|route| route.path == "/api/health")
            .map(|route| route.methods)
            .collect();
        assert_eq!(methods.len(), 2, "GET and POST /api/health are registered");
        assert!(methods.iter().any(|bits| bits & GET != 0), "GET missing");
        assert!(methods.iter().any(|bits| bits & POST != 0), "POST missing");
    }

    #[test]
    fn health_post_response_is_the_source_method_not_allowed_body() {
        let response = health_method_not_allowed_response();
        assert_eq!(
            response.status(),
            brz_http_server::StatusCode::METHOD_NOT_ALLOWED
        );
        match response.body() {
            brz_http_server::ResponseBody::Static(bytes) => {
                assert_eq!(*bytes, br#"{"detail":"Method Not Allowed"}"#);
            }
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    /// Starlette's `CORSMiddleware` bypasses a request without an `Origin`
    /// header, so the recorded 405 gains no `Vary: Origin`; a cross-origin
    /// request keeps the configured gateway policy.
    #[test]
    fn health_post_cors_follows_the_source_origin_bypass() {
        let headerless = source_cors(health_method_not_allowed_response(), None);
        assert_eq!(
            headerless.cors_policy(),
            brz_http_server::ResponseCors::Skip
        );
        let cross_origin = source_cors(
            health_method_not_allowed_response(),
            Some("https://app.example"),
        );
        assert_eq!(
            cross_origin.cors_policy(),
            brz_http_server::ResponseCors::Apply
        );
    }

    // A dedicated test group (separate from the crate's real `http_apis`
    // group) so the probe's route does not collide with the real handler.
    mod health_probe {
        brz_http_server::registry!(group = health_probe, dependencies());
    }

    #[brz_http_server::post(
        "/api/health",
        group = health_probe::health_probe,
        access = public
    )]
    async fn probe_health_post(
        #[header("origin")] origin: Option<&str>,
    ) -> brz_http_server::Response {
        source_cors(health_method_not_allowed_response(), origin)
    }

    /// Drives the registered route over a real socket so the status, `Allow`
    /// header, body, and the absence of gateway CORS variance are asserted
    /// exactly as the runtime renders them. The recorded source request
    /// (`recording 20261111045050`, all three `/api/health` POST cases) carries
    /// no `Origin` header and the recorded 405 carries no `Vary`.
    #[tokio::test]
    async fn health_post_renders_405_with_allow_get_over_http() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let handler =
            brz_http_server::handlers!(; group = health_probe::health_probe).expect("probe router");
        let server = brz_http_server::Server::bind("127.0.0.1:0".parse().unwrap(), handler)
            .await
            .expect("bind test server");
        let address = server.local_addr().expect("local address");
        let serve = tokio::spawn(async move {
            let _ = server.serve_until(std::future::pending::<()>()).await;
        });
        let mut client = tokio::net::TcpStream::connect(address)
            .await
            .expect("connect");
        client
            .write_all(
                b"POST /api/health HTTP/1.1\r\n\
                  Host: localhost\r\nConnection: close\r\n\r\n",
            )
            .await
            .expect("send");
        let mut raw = Vec::new();
        client.read_to_end(&mut raw).await.expect("read");
        serve.abort();
        let raw = String::from_utf8_lossy(&raw);
        assert!(raw.starts_with("HTTP/1.1 405"), "{raw}");
        assert!(raw.to_ascii_lowercase().contains("allow: get"), "{raw}");
        assert!(raw.contains(r#"{"detail":"Method Not Allowed"}"#), "{raw}");
        assert!(
            !raw.to_ascii_lowercase().contains("vary:"),
            "a headerless request keeps the source's missing Vary: Origin: {raw}"
        );
        assert!(
            !raw.to_ascii_lowercase().contains("access-control-"),
            "a headerless request grants no CORS permissions: {raw}"
        );
    }

    /// The recorded response body of `api-health/5f47f84b` (recording
    /// 20261016030056): 200 with the healthy payload while running.
    #[test]
    fn health_bodies_match_source() {
        assert_eq!(
            healthy_body(false).to_string(),
            r#"{"status":"healthy","shutting_down":false}"#
        );
        assert_eq!(
            unhealthy_body("MySQL connection acquisition timed out").to_string(),
            r#"{"status":"unhealthy","database":"error","error":"MySQL connection acquisition timed out"}"#
        );
    }

    /// `KindQueryCapture` answers an empty row set. Source `.scalar()` treats
    /// an executed statement without rows as healthy, so the probe pins both
    /// the issued statement and the still-200 healthy render.
    #[tokio::test]
    async fn health_check_issues_the_source_liveness_statement() {
        let capture = crate::sql_test_support::KindQueryCapture::default();
        let response = health_response(&capture, false).await;
        let queries = capture.queries();
        assert_eq!(queries.len(), 1);
        assert_eq!(queries[0].sql, "SELECT COUNT(*) FROM users");
        assert_eq!(queries[0].args, 0);
        assert_eq!(response.status(), brz_http_server::StatusCode::OK);
        let brz_http_server::ResponseBody::Owned(body) = response.body() else {
            panic!("health renders an owned JSON body");
        };
        assert_eq!(
            body.as_ref(),
            br#"{"status":"healthy","shutting_down":false}"#.as_slice()
        );
    }
}
