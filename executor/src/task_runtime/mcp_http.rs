// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    net::TcpListener as StdTcpListener,
    sync::mpsc,
    sync::{Mutex as StdMutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use axum::{
    extract::State,
    http::{
        header::{AUTHORIZATION, CONTENT_TYPE},
        HeaderMap, HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Mutex},
};
use uuid::Uuid;

use crate::logging::log_executor_event;

use super::{
    mcp::{
        handle_request_with_context, CloudCollaborationRoundDispatcher, SpaceMcpRequestContext,
        WeworkMcpSurface, SPACE_MCP_SERVER_NAME,
    },
    TaskRuntime,
};

const CONTEXT_HANDLE_HEADER: &str = "x-wework-mcp-context";
const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";
const CONTEXT_HANDLE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone)]
pub(crate) struct SpaceMcpEndpoint {
    pub(crate) url: String,
    pub(crate) token: String,
}

pub(crate) struct RegisteredSpaceMcpContext {
    pub(crate) endpoint: SpaceMcpEndpoint,
    pub(crate) context_handle: String,
}

#[derive(Clone)]
struct RegisteredContext {
    context: SpaceMcpRequestContext,
    expires_at: Instant,
}

#[derive(Clone)]
struct SpaceMcpHttpState {
    runtime: TaskRuntime,
    token: String,
    sessions: std::sync::Arc<Mutex<HashMap<String, SpaceMcpRequestContext>>>,
    contexts: std::sync::Arc<StdMutex<HashMap<String, RegisteredContext>>>,
    collaboration_dispatcher: std::sync::Arc<StdMutex<Option<CloudCollaborationRoundDispatcher>>>,
    event_sender: std::sync::Arc<StdMutex<Option<tokio::sync::broadcast::Sender<Value>>>>,
}

static SPACE_MCP_START_LOCK: Mutex<()> = Mutex::const_new(());

struct RunningSpaceMcpEndpoint {
    endpoint: SpaceMcpEndpoint,
    contexts: std::sync::Arc<StdMutex<HashMap<String, RegisteredContext>>>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_task: Option<thread::JoinHandle<()>>,
}

impl RunningSpaceMcpEndpoint {
    fn stop(mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(());
        }
        if let Some(server_task) = self.server_task.take() {
            if server_task.join().is_err() {
                log_executor_event(
                    "project-space MCP endpoint thread panicked",
                    &[("url", self.endpoint.url)],
                );
            }
        }
    }
}

fn running_endpoint() -> &'static StdMutex<Option<RunningSpaceMcpEndpoint>> {
    static RUNNING: OnceLock<StdMutex<Option<RunningSpaceMcpEndpoint>>> = OnceLock::new();
    RUNNING.get_or_init(|| StdMutex::new(None))
}

fn collaboration_dispatcher_registry(
) -> &'static std::sync::Arc<StdMutex<Option<CloudCollaborationRoundDispatcher>>> {
    static DISPATCHER: OnceLock<
        std::sync::Arc<StdMutex<Option<CloudCollaborationRoundDispatcher>>>,
    > = OnceLock::new();
    DISPATCHER.get_or_init(|| std::sync::Arc::new(StdMutex::new(None)))
}

fn event_sender_registry(
) -> &'static std::sync::Arc<StdMutex<Option<tokio::sync::broadcast::Sender<Value>>>> {
    static SENDER: OnceLock<
        std::sync::Arc<StdMutex<Option<tokio::sync::broadcast::Sender<Value>>>>,
    > = OnceLock::new();
    SENDER.get_or_init(|| std::sync::Arc::new(StdMutex::new(None)))
}

fn local_mcp_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| Uuid::new_v4().to_string())
}

pub(crate) async fn ensure_space_mcp_http_endpoint() -> Result<SpaceMcpEndpoint, String> {
    // A delayed HTTP response must not revoke a live server's sessions and contexts.
    // The owning thread exits whenever axum::serve exits, so its handle owns liveness.
    if let Some(endpoint) = active_endpoint() {
        return Ok(endpoint);
    }
    let _guard = SPACE_MCP_START_LOCK.lock().await;
    if let Some(endpoint) = active_endpoint() {
        return Ok(endpoint);
    }

    let runtime = TaskRuntime::from_env().map_err(|error| error.to_string())?;
    let listener = StdTcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("failed to bind project-space MCP endpoint: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("failed to configure project-space MCP endpoint: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("failed to read project-space MCP endpoint address: {error}"))?;
    let endpoint = SpaceMcpEndpoint {
        url: format!("http://{address}/mcp"),
        token: local_mcp_token().to_owned(),
    };
    let contexts = std::sync::Arc::new(StdMutex::new(HashMap::new()));
    let state = SpaceMcpHttpState {
        runtime,
        token: endpoint.token.clone(),
        sessions: std::sync::Arc::new(Mutex::new(HashMap::new())),
        contexts: contexts.clone(),
        collaboration_dispatcher: collaboration_dispatcher_registry().clone(),
        event_sender: event_sender_registry().clone(),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(handle_mcp).delete(delete_mcp_session))
        .route(
            "/notifications/mcp",
            post(handle_notifications_mcp).delete(delete_mcp_session),
        )
        .route(
            "/stand-in/mcp",
            post(handle_stand_in_mcp).delete(delete_mcp_session),
        )
        .with_state(state);
    let server_endpoint = endpoint.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let server_task = thread::Builder::new()
        .name("wework-space-mcp-http".to_owned())
        .spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            runtime.block_on(async move {
                let listener = match TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error.to_string()));
                        return;
                    }
                };
                let _ = ready_tx.send(Ok(()));
                if let Err(error) = axum::serve(listener, app)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_rx.await;
                    })
                    .await
                {
                    log_executor_event(
                        "project-space MCP endpoint stopped",
                        &[("url", server_endpoint.url), ("error", error.to_string())],
                    );
                }
            });
        })
        .map_err(|error| format!("failed to start project-space MCP endpoint: {error}"))?;
    let running = RunningSpaceMcpEndpoint {
        endpoint: endpoint.clone(),
        contexts,
        shutdown_tx: Some(shutdown_tx),
        server_task: Some(server_task),
    };
    let readiness = match ready_rx.recv_timeout(Duration::from_secs(2)) {
        Ok(result) => {
            result.map_err(|error| format!("failed to start project-space MCP endpoint: {error}"))
        }
        Err(error) => Err(format!("project-space MCP endpoint did not start: {error}")),
    };
    if let Err(error) = readiness {
        running.stop();
        return Err(error);
    }
    *running_endpoint()
        .lock()
        .map_err(|_| "project-space MCP endpoint state is poisoned".to_owned())? = Some(running);
    log_executor_event(
        "project-space MCP endpoint ready",
        &[("url", endpoint.url.clone())],
    );
    Ok(endpoint)
}

fn active_endpoint() -> Option<SpaceMcpEndpoint> {
    let mut running = running_endpoint().lock().ok()?;
    if running.as_ref().is_some_and(|running| {
        running
            .server_task
            .as_ref()
            .is_some_and(thread::JoinHandle::is_finished)
    }) {
        let finished = running.take();
        drop(running);
        if let Some(finished) = finished {
            finished.stop();
        }
        return None;
    }
    running.as_ref().map(|running| running.endpoint.clone())
}

pub(crate) fn register_space_mcp_context(
    context: SpaceMcpRequestContext,
) -> Result<RegisteredSpaceMcpContext, String> {
    let running = running_endpoint()
        .lock()
        .map_err(|_| "project-space MCP endpoint state is poisoned".to_owned())?;
    let Some(running) = running.as_ref() else {
        #[cfg(test)]
        {
            return Ok(RegisteredSpaceMcpContext {
                endpoint: unstarted_test_endpoint(),
                context_handle: "test-space-mcp-context-handle".to_owned(),
            });
        }
        #[cfg(not(test))]
        return Err("project-space MCP endpoint is not ready".to_owned());
    };
    let mut contexts = running
        .contexts
        .lock()
        .map_err(|_| "project-space MCP context registry is poisoned".to_owned())?;
    let context_handle = register_context(&mut contexts, context, Instant::now());
    Ok(RegisteredSpaceMcpContext {
        endpoint: running.endpoint.clone(),
        context_handle,
    })
}

fn register_context(
    contexts: &mut HashMap<String, RegisteredContext>,
    context: SpaceMcpRequestContext,
    now: Instant,
) -> String {
    // Unbound authority is immutable: share its transport without sharing grants.
    let reused = contexts
        .iter_mut()
        .find(|(_, registered)| registered.context.shares_unbound_authority(&context))
        .map(|(handle, registered)| {
            registered.expires_at = now + CONTEXT_HANDLE_TTL;
            handle.clone()
        });
    contexts.retain(|_, registered| registered.expires_at > now);
    if let Some(handle) = reused {
        return handle;
    }
    let context_handle = Uuid::new_v4().to_string();
    contexts.insert(
        context_handle.clone(),
        RegisteredContext {
            context,
            expires_at: now + CONTEXT_HANDLE_TTL,
        },
    );
    context_handle
}

pub(crate) fn register_cloud_collaboration_dispatcher(
    dispatcher: CloudCollaborationRoundDispatcher,
) -> Result<(), String> {
    *collaboration_dispatcher_registry()
        .lock()
        .map_err(|_| "Executor collaboration coordinator is unavailable".to_owned())? =
        Some(dispatcher);
    Ok(())
}

pub(crate) fn register_runtime_event_sender(sender: tokio::sync::broadcast::Sender<Value>) {
    *event_sender_registry()
        .lock()
        .expect("Executor event sender registry should not be poisoned") = Some(sender);
}

#[cfg(test)]
fn unstarted_test_endpoint() -> SpaceMcpEndpoint {
    SpaceMcpEndpoint {
        url: "http://127.0.0.1:1/mcp".to_owned(),
        token: local_mcp_token().to_owned(),
    }
}

#[cfg(test)]
pub(crate) fn space_mcp_http_endpoint() -> Option<SpaceMcpEndpoint> {
    Some(active_endpoint().unwrap_or_else(unstarted_test_endpoint))
}

#[cfg(not(test))]
pub(crate) fn space_mcp_http_endpoint() -> Option<SpaceMcpEndpoint> {
    active_endpoint()
}

async fn health(State(state): State<SpaceMcpHttpState>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({
        "status": "ready",
        "server": SPACE_MCP_SERVER_NAME,
    }))
    .into_response()
}

async fn handle_mcp(
    State(state): State<SpaceMcpHttpState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    handle_mcp_for_surface(state, headers, request, WeworkMcpSurface::ProjectSpace).await
}

async fn handle_notifications_mcp(
    State(state): State<SpaceMcpHttpState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    handle_mcp_for_surface(state, headers, request, WeworkMcpSurface::Notifications).await
}

async fn handle_stand_in_mcp(
    State(state): State<SpaceMcpHttpState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    handle_mcp_for_surface(state, headers, request, WeworkMcpSurface::StandIn).await
}

async fn handle_mcp_for_surface(
    state: SpaceMcpHttpState,
    headers: HeaderMap,
    request: Value,
    expected_surface: WeworkMcpSurface,
) -> Response {
    if !authorized(&headers, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (session_id, mut context) = if method == "initialize" {
        let Some(context) = registered_context(&state, &headers, expected_surface) else {
            return json_rpc_http_error(
                request.get("id").cloned().unwrap_or(Value::Null),
                -32001,
                "Invalid or expired Wework MCP context",
                StatusCode::UNAUTHORIZED,
            );
        };
        let session_id = Uuid::new_v4().to_string();
        state
            .sessions
            .lock()
            .await
            .insert(session_id.clone(), context.clone());
        (session_id, context)
    } else {
        let Some(session_id) = header_text(&headers, MCP_SESSION_ID_HEADER) else {
            return json_rpc_http_error(
                request.get("id").cloned().unwrap_or(Value::Null),
                -32002,
                "Missing MCP session ID",
                StatusCode::BAD_REQUEST,
            );
        };
        let Some(context) = state.sessions.lock().await.get(&session_id).cloned() else {
            return json_rpc_http_error(
                request.get("id").cloned().unwrap_or(Value::Null),
                -32003,
                "Unknown or closed MCP session",
                StatusCode::NOT_FOUND,
            );
        };
        (session_id, context)
    };
    if context.surface() != expected_surface {
        return StatusCode::FORBIDDEN.into_response();
    }
    context.set_cloud_collaboration_dispatcher(
        state
            .collaboration_dispatcher
            .lock()
            .ok()
            .and_then(|dispatcher| dispatcher.clone()),
    );
    context.set_event_sender(
        state
            .event_sender
            .lock()
            .ok()
            .and_then(|sender| sender.clone()),
    );
    match handle_request_with_context(&state.runtime, &request, &context).await {
        Some(response) => json_rpc_response(response, &session_id),
        None => StatusCode::ACCEPTED.into_response(),
    }
}

async fn delete_mcp_session(
    State(state): State<SpaceMcpHttpState>,
    headers: HeaderMap,
) -> Response {
    if !authorized(&headers, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Some(session_id) = header_text(&headers, MCP_SESSION_ID_HEADER) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    state.sessions.lock().await.remove(&session_id);
    StatusCode::NO_CONTENT.into_response()
}

fn registered_context(
    state: &SpaceMcpHttpState,
    headers: &HeaderMap,
    expected_surface: WeworkMcpSurface,
) -> Option<SpaceMcpRequestContext> {
    let handle = header_text(headers, CONTEXT_HANDLE_HEADER)?;
    let now = Instant::now();
    let mut contexts = state.contexts.lock().ok()?;
    contexts.retain(|_, registered| registered.expires_at > now);
    contexts
        .get(&handle)
        .filter(|registered| registered.context.surface() == expected_surface)
        .map(|registered| registered.context.clone())
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    header_text(headers, AUTHORIZATION.as_str()).as_deref() == Some(&format!("Bearer {token}"))
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn json_rpc_response(value: Value, session_id: &str) -> Response {
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(value) = HeaderValue::from_str(session_id) {
        response.headers_mut().insert(MCP_SESSION_ID_HEADER, value);
    }
    response
}

fn json_rpc_http_error(id: Value, code: i64, message: &str, status: StatusCode) -> Response {
    let mut response = Json(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        }
    }))
    .into_response();
    *response.status_mut() = status;
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header::AUTHORIZATION;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    #[test]
    fn identical_unbound_authority_reuses_and_renews_its_handle() {
        let mut contexts = HashMap::new();
        let now = Instant::now();
        let context = SpaceMcpRequestContext::new(
            None,
            Some("https://backend.example".into()),
            Some("user-a".into()),
        );
        let handle = register_context(&mut contexts, context.clone(), now);
        register_context(
            &mut contexts,
            SpaceMcpRequestContext::new(None, None, None),
            now,
        );
        let later = now + CONTEXT_HANDLE_TTL + Duration::from_secs(1);
        assert_eq!(register_context(&mut contexts, context, later), handle);
        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[&handle].expires_at, later + CONTEXT_HANDLE_TTL);
    }

    #[test]
    fn unbound_handles_do_not_share_credentials_backends_or_surfaces() {
        let mut contexts = HashMap::new();
        let now = Instant::now();
        let backend = Some("https://backend.example".to_owned());
        let token = Some("user-a".to_owned());
        let personal = register_context(
            &mut contexts,
            SpaceMcpRequestContext::new(None, backend.clone(), token.clone()),
            now,
        );
        for context in [
            SpaceMcpRequestContext::new(None, backend.clone(), Some("user-b".into())),
            SpaceMcpRequestContext::new(None, Some("https://other.example".into()), token.clone()),
            SpaceMcpRequestContext::notifications(backend.clone(), token.clone()),
        ] {
            assert_ne!(register_context(&mut contexts, context, now), personal);
        }
        let notifications = SpaceMcpRequestContext::notifications(backend, token);
        assert_eq!(
            register_context(&mut contexts, notifications.clone(), now),
            register_context(&mut contexts, notifications, now),
        );
        assert_eq!(contexts.len(), 4);
    }

    #[test]
    fn bound_grants_never_reuse_a_previous_execution_handle() {
        let grant = serde_json::from_value(json!({
            "version":1, "task_id":"task-1", "space_id":"space-1", "item_id":"issue-1",
            "expires_at_unix":chrono::Local::now().timestamp() + 3600
        }))
        .unwrap();
        let context = SpaceMcpRequestContext::new(Some(grant), None, None);
        let mut contexts = HashMap::new();
        let now = Instant::now();
        assert_ne!(
            register_context(&mut contexts, context.clone(), now),
            register_context(&mut contexts, context, now),
        );
        assert_eq!(contexts.len(), 2);
    }

    #[test]
    fn authorization_requires_the_exact_instance_token() {
        let mut headers = HeaderMap::new();
        headers.insert(AUTHORIZATION, HeaderValue::from_static("Bearer expected"));

        assert!(authorized(&headers, "expected"));
        assert!(!authorized(&headers, "other"));
    }

    #[test]
    fn context_registry_expires_handles_and_preserves_surface_isolation() {
        let now = Instant::now();
        let mut contexts = HashMap::from([
            (
                "expired".to_owned(),
                RegisteredContext {
                    context: SpaceMcpRequestContext::new(None, None, None),
                    expires_at: now,
                },
            ),
            (
                "notifications".to_owned(),
                RegisteredContext {
                    context: SpaceMcpRequestContext::notifications(None, None),
                    expires_at: now + Duration::from_secs(1),
                },
            ),
        ]);
        contexts.retain(|_, registered| registered.expires_at > now);

        assert!(!contexts.contains_key("expired"));
        assert_eq!(
            contexts
                .get("notifications")
                .map(|registered| registered.context.surface()),
            Some(WeworkMcpSurface::Notifications)
        );
        assert_ne!(
            contexts
                .get("notifications")
                .map(|registered| registered.context.surface()),
            Some(WeworkMcpSurface::ProjectSpace)
        );
    }

    #[test]
    fn local_mcp_authentication_is_stable_for_the_executor_process() {
        assert_eq!(local_mcp_token(), local_mcp_token());
        assert!(!local_mcp_token().is_empty());
    }

    #[test]
    fn endpoint_stop_signals_shutdown_and_joins_the_server_thread() {
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let (stopped_tx, stopped_rx) = mpsc::sync_channel(1);
        let server_task = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let _ = shutdown_rx.await;
                stopped_tx.send(()).unwrap();
            });
        });
        RunningSpaceMcpEndpoint {
            endpoint: SpaceMcpEndpoint {
                url: "http://127.0.0.1:1/mcp".to_owned(),
                token: "test".to_owned(),
            },
            contexts: std::sync::Arc::new(StdMutex::new(HashMap::new())),
            shutdown_tx: Some(shutdown_tx),
            server_task: Some(server_task),
        }
        .stop();

        stopped_rx.recv_timeout(Duration::from_secs(1)).unwrap();
    }

    #[test]
    fn busy_endpoint_is_preserved_until_its_server_thread_exits() {
        const CHILD: &str = "WEGENT_TEST_SPACE_MCP_LIFECYCLE_CHILD";
        if std::env::var(CHILD).as_deref() != Ok("1") {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "task_runtime::mcp_http::tests::busy_endpoint_is_preserved_until_its_server_thread_exits",
                    "--nocapture",
                ])
                .env(CHILD, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("WEGENT_EXECUTOR_HOME", home.path());
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(verify_busy_endpoint_lifecycle());
    }

    async fn verify_busy_endpoint_lifecycle() {
        // Keep the listener alive without processing HTTP, as when the owner thread is busy.
        let listener = StdTcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = SpaceMcpEndpoint {
            url: format!("http://{}/mcp", listener.local_addr().unwrap()),
            token: local_mcp_token().to_owned(),
        };
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let server_task = thread::spawn(move || {
            let _listener = listener;
            shutdown_rx.blocking_recv().unwrap();
        });
        *running_endpoint().lock().unwrap() = Some(RunningSpaceMcpEndpoint {
            endpoint: endpoint.clone(),
            contexts: std::sync::Arc::new(StdMutex::new(HashMap::new())),
            shutdown_tx: Some(shutdown_tx),
            server_task: Some(server_task),
        });
        let registered =
            register_space_mcp_context(SpaceMcpRequestContext::new(None, None, None)).unwrap();
        let (first, second) = tokio::join!(
            ensure_space_mcp_http_endpoint(),
            ensure_space_mcp_http_endpoint()
        );
        assert_eq!(first.unwrap().url, endpoint.url);
        assert_eq!(second.unwrap().url, endpoint.url);
        {
            let mut running = running_endpoint().lock().unwrap();
            let running = running.as_mut().unwrap();
            assert!(running
                .contexts
                .lock()
                .unwrap()
                .contains_key(&registered.context_handle));
            running.shutdown_tx.take().unwrap().send(()).unwrap();
        }
        let started = Instant::now();
        while !running_endpoint()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .server_task
            .as_ref()
            .unwrap()
            .is_finished()
        {
            assert!(started.elapsed() < Duration::from_secs(2));
            tokio::task::yield_now().await;
        }
        let (first, second) = tokio::join!(
            ensure_space_mcp_http_endpoint(),
            ensure_space_mcp_http_endpoint()
        );
        let restarted = first.unwrap();
        assert_eq!(second.unwrap().url, restarted.url);
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(restarted.url.replace("/mcp", "/health"))
            .bearer_auth(&restarted.token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        running_endpoint().lock().unwrap().take().unwrap().stop();
    }

    #[tokio::test]
    async fn persistent_endpoint_authenticates_and_reuses_one_mcp_session() {
        use futures_util::FutureExt;

        let endpoint = ensure_space_mcp_http_endpoint().await.unwrap();
        // Reusing an owned live server must not depend on a timed HTTP probe:
        // discarding it on timeout invalidates concurrent turns and MCP contexts.
        let same_endpoint = ensure_space_mcp_http_endpoint()
            .now_or_never()
            .expect("Reusing a live MCP endpoint must not wait for network scheduling")
            .unwrap();
        assert_eq!(endpoint.url, same_endpoint.url);
        assert_eq!(endpoint.token, same_endpoint.token);
        let active = space_mcp_http_endpoint().unwrap();
        assert_eq!(active.url, endpoint.url);
        assert_eq!(active.token, endpoint.token);
        let registered =
            register_space_mcp_context(SpaceMcpRequestContext::new(None, None, None)).unwrap();
        assert_eq!(registered.endpoint.url, active.url);
        assert_eq!(registered.endpoint.token, active.token);

        let client = reqwest::Client::new();
        let unauthorized = client
            .post(&endpoint.url)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let initialized = client
            .post(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .header(CONTEXT_HANDLE_HEADER, registered.context_handle)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(initialized.status(), StatusCode::OK);
        let session_id = initialized
            .headers()
            .get(MCP_SESSION_ID_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();

        let tools = client
            .post(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, session_id)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/list",
                "params": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(tools.status(), StatusCode::OK);
        let tools = tools.json::<Value>().await.unwrap();
        assert!(tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "read_item_attachment"));
    }

    #[tokio::test]
    async fn accepted_context_grant_remains_valid_for_the_mcp_session() {
        let endpoint = ensure_space_mcp_http_endpoint().await.unwrap();
        let expires_at_unix = chrono::Local::now().timestamp() + 1;
        let grant = STANDARD.encode(
            serde_json::to_vec(&json!({
                "version": 1,
                "task_id": "http-session-test",
                "space_id": "space-1",
                "item_id": "ISSUE-1",
                "device_id": null,
                "automation_run_id": null,
                "expires_at_unix": expires_at_unix
            }))
            .unwrap(),
        );
        let context = SpaceMcpRequestContext::new(
            super::super::mcp::decode_space_context_grant(&grant),
            None,
            None,
        );
        let registered = register_space_mcp_context(context).unwrap();
        let client = reqwest::Client::new();
        let initialized = client
            .post(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .header(CONTEXT_HANDLE_HEADER, registered.context_handle)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(initialized.status(), StatusCode::OK);
        let session_id = initialized
            .headers()
            .get(MCP_SESSION_ID_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();

        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let tools = client
            .post(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, session_id)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }))
            .send()
            .await
            .unwrap();
        let tools = tools.json::<Value>().await.unwrap();
        assert!(tools["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "get_current_context"));
    }

    #[tokio::test]
    async fn notifications_endpoint_exposes_only_send_notification() {
        let endpoint = ensure_space_mcp_http_endpoint().await.unwrap();
        let notifications_url = format!(
            "{}/notifications/mcp",
            endpoint.url.trim_end_matches("/mcp")
        );
        let registered = register_space_mcp_context(SpaceMcpRequestContext::notifications(
            Some("https://wework.example.com".to_owned()),
            Some("runtime-token".to_owned()),
        ))
        .unwrap();
        let client = reqwest::Client::new();
        let wrong_surface = client
            .post(&endpoint.url)
            .bearer_auth(&endpoint.token)
            .header(CONTEXT_HANDLE_HEADER, registered.context_handle.as_str())
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 0,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_surface.status(), StatusCode::UNAUTHORIZED);

        let initialized = client
            .post(&notifications_url)
            .bearer_auth(&endpoint.token)
            .header(CONTEXT_HANDLE_HEADER, registered.context_handle)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(initialized.status(), StatusCode::OK);
        let session_id = initialized
            .headers()
            .get(MCP_SESSION_ID_HEADER)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let initialized_body = initialized.json::<Value>().await.unwrap();
        assert_eq!(
            initialized_body["result"]["serverInfo"]["name"],
            "wework_notifications"
        );

        let tools = client
            .post(&notifications_url)
            .bearer_auth(&endpoint.token)
            .header(MCP_SESSION_ID_HEADER, session_id)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(tools.status(), StatusCode::OK);
        let tools = tools.json::<Value>().await.unwrap();
        assert_eq!(
            tools["result"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tool| tool["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["send_notification"]
        );
    }
}
