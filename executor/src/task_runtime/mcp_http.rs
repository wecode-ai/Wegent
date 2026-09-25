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

fn local_mcp_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| Uuid::new_v4().to_string())
}

pub(crate) async fn ensure_space_mcp_http_endpoint() -> Result<SpaceMcpEndpoint, String> {
    if let Some(endpoint) = active_endpoint() {
        if endpoint_is_reachable(&endpoint).await {
            return Ok(endpoint);
        }
        discard_endpoint(&endpoint);
    }
    let _guard = SPACE_MCP_START_LOCK.lock().await;
    if let Some(endpoint) = active_endpoint() {
        if endpoint_is_reachable(&endpoint).await {
            return Ok(endpoint);
        }
        discard_endpoint(&endpoint);
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
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/mcp", post(handle_mcp).delete(delete_mcp_session))
        .route(
            "/notifications/mcp",
            post(handle_notifications_mcp).delete(delete_mcp_session),
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

async fn endpoint_is_reachable(endpoint: &SpaceMcpEndpoint) -> bool {
    let health_url = endpoint.url.trim_end_matches("/mcp").to_owned() + "/health";
    reqwest::Client::new()
        .get(health_url)
        .bearer_auth(&endpoint.token)
        .timeout(std::time::Duration::from_secs(1))
        .send()
        .await
        .is_ok_and(|response| response.status().is_success())
}

fn discard_endpoint(endpoint: &SpaceMcpEndpoint) {
    let discarded = if let Ok(mut running) = running_endpoint().lock() {
        if running
            .as_ref()
            .is_some_and(|value| value.endpoint.url == endpoint.url)
        {
            running.take()
        } else {
            None
        }
    } else {
        None
    };
    if let Some(discarded) = discarded {
        discarded.stop();
    }
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
                endpoint: space_mcp_http_endpoint()
                    .expect("test project-space MCP endpoint should exist"),
                context_handle: "test-space-mcp-context-handle".to_owned(),
            });
        }
        #[cfg(not(test))]
        return Err("project-space MCP endpoint is not ready".to_owned());
    };
    let context_handle = Uuid::new_v4().to_string();
    let mut contexts = running
        .contexts
        .lock()
        .map_err(|_| "project-space MCP context registry is poisoned".to_owned())?;
    let now = Instant::now();
    contexts.retain(|_, registered| registered.expires_at > now);
    contexts.insert(
        context_handle.clone(),
        RegisteredContext {
            context,
            expires_at: now + CONTEXT_HANDLE_TTL,
        },
    );
    Ok(RegisteredSpaceMcpContext {
        endpoint: running.endpoint.clone(),
        context_handle,
    })
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

#[cfg(test)]
pub(crate) fn space_mcp_http_endpoint() -> Option<SpaceMcpEndpoint> {
    Some(SpaceMcpEndpoint {
        url: "http://127.0.0.1:1/mcp".to_owned(),
        token: "test-space-mcp-instance-token".to_owned(),
    })
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
    handle_mcp_for_surface(state, headers, request, false).await
}

async fn handle_notifications_mcp(
    State(state): State<SpaceMcpHttpState>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    handle_mcp_for_surface(state, headers, request, true).await
}

async fn handle_mcp_for_surface(
    state: SpaceMcpHttpState,
    headers: HeaderMap,
    request: Value,
    notifications_only: bool,
) -> Response {
    if !authorized(&headers, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }

    let method = request
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let (session_id, mut context) = if method == "initialize" {
        let expected_surface = if notifications_only {
            WeworkMcpSurface::Notifications
        } else {
            WeworkMcpSurface::ProjectSpace
        };
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
    context.set_cloud_collaboration_dispatcher(
        state
            .collaboration_dispatcher
            .lock()
            .ok()
            .and_then(|dispatcher| dispatcher.clone()),
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

    #[tokio::test]
    async fn persistent_endpoint_authenticates_and_reuses_one_mcp_session() {
        let endpoint = ensure_space_mcp_http_endpoint().await.unwrap();
        let same_endpoint = ensure_space_mcp_http_endpoint().await.unwrap();
        assert_eq!(endpoint.url, same_endpoint.url);
        assert_eq!(endpoint.token, same_endpoint.token);
        let registered =
            register_space_mcp_context(SpaceMcpRequestContext::new(None, None, None)).unwrap();

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
