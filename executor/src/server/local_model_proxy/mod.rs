// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Local model proxy used by Codex-backed Wework tasks.
//!
//! The proxy keeps provider credentials outside the Codex process, applies
//! custom headers and outbound proxy settings, normalizes Responses streams,
//! and translates Chat Completions providers through the dedicated `chat`
//! protocol module.

mod anthropic;
mod chat;
mod fork;
mod history;
mod vision;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    pin::Pin,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
    routing::{post, MethodRouter},
};
use futures_util::{Stream, StreamExt};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::logging::log_executor_event;

use super::{codex_responses_proxy_transform, HttpError};
use fork::{codex_forked_from_thread_id, prepare_fork_request};

pub(crate) const API_KEY: &str = "wework-local-router";
pub(crate) const ROUTE: &str = "/v1/codex-router/responses";
pub(crate) const TOKEN_ROUTE: &str = "/v1/codex-router/{token}/responses";
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;
const NORMALIZED_API_ID_PREFIX_LENGTH: usize = 48;
const DEFAULT_MAX_OUTPUT_TOKENS: u64 = 96_000;
const RATE_LIMIT_RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
    Duration::from_secs(60),
];
const MAX_RATE_LIMIT_RETRIES: u32 = RATE_LIMIT_RETRY_DELAYS.len() as u32;
const MAX_RATE_LIMIT_RETRY_DELAY: Duration = Duration::from_secs(60);
const LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS: u64 = 300;

pub(crate) fn route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    post(handle_bound_thread).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

pub(crate) fn token_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    post(handle_token_route).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

#[derive(Debug, Clone)]
pub(crate) struct LocalModelProxyUpstream {
    pub base_url: String,
    pub request_url: Option<String>,
    pub api_format: String,
    pub convert_custom_tools: bool,
    pub api_key: String,
    pub default_headers: Vec<(String, String)>,
    pub proxy_url: Option<String>,
    pub model_id: Option<String>,
    pub routing_model_id: Option<String>,
    pub max_output_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct VisionSidecarUpstream {
    pub request_url: String,
    pub api_format: String,
    pub api_key: String,
    pub default_headers: Vec<(String, String)>,
    pub proxy_url: Option<String>,
    pub model_id: String,
    pub max_descriptions_per_turn: usize,
    pub timeout: Duration,
}

#[derive(Debug, Clone)]
struct RegisteredUpstream {
    upstream: LocalModelProxyUpstream,
    vision_sidecar: Option<VisionSidecarUpstream>,
    history: std::sync::Arc<history::CodexToolHistory>,
    thread_ids: HashSet<String>,
    last_routed_model: Option<String>,
    pending_model_switch_cleanup: bool,
    last_used: Instant,
    active_references: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ModelRequestRouting {
    model_switched: bool,
    model_to_commit: Option<String>,
    clear_pending_model_switch: bool,
}

#[derive(Default)]
struct LocalModelProxyRegistry {
    routes: HashMap<String, RegisteredUpstream>,
    tokens_by_scope: HashMap<String, String>,
}

const REGISTRY_IDLE_TTL: Duration = Duration::from_secs(60 * 60);

#[cfg(test)]
pub(crate) fn register(route_scope: &str, upstream: LocalModelProxyUpstream) -> String {
    register_with_vision_sidecar(route_scope, upstream, None)
}

pub(crate) fn register_with_vision_sidecar(
    route_scope: &str,
    upstream: LocalModelProxyUpstream,
    vision_sidecar: Option<VisionSidecarUpstream>,
) -> String {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    prune_registry(&mut registry);
    let token = registry
        .tokens_by_scope
        .get(route_scope)
        .cloned()
        .unwrap_or_else(|| {
            let token = generate_registration_token(&registry);
            registry
                .tokens_by_scope
                .insert(route_scope.to_owned(), token.clone());
            token
        });
    let active_references = registry
        .routes
        .get(&token)
        .map_or(1, |registered| registered.active_references + 1);
    let history = registry
        .routes
        .get(&token)
        .map(|registered| registered.history.clone())
        .unwrap_or_default();
    let thread_ids = registry
        .routes
        .get(&token)
        .map(|registered| registered.thread_ids.clone())
        .unwrap_or_default();
    let last_routed_model = registry
        .routes
        .get(&token)
        .and_then(|registered| registered.last_routed_model.clone());
    let pending_model_switch_cleanup = registry
        .routes
        .get(&token)
        .is_some_and(|registered| registered.pending_model_switch_cleanup);
    registry.routes.insert(
        token.clone(),
        RegisteredUpstream {
            upstream,
            vision_sidecar,
            history,
            thread_ids,
            last_routed_model,
            pending_model_switch_cleanup,
            last_used: Instant::now(),
            active_references,
        },
    );
    log_executor_event(
        "local model proxy registered",
        &[
            ("active_registrations", registry.routes.len().to_string()),
            ("active_references", active_references.to_string()),
            ("route_scope", route_scope.to_owned()),
        ],
    );
    token
}

pub(crate) fn mark_model_switch(token: &str) {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    if let Some(registered) = registry.routes.get_mut(token) {
        registered.pending_model_switch_cleanup = true;
        registered.last_used = Instant::now();
    }
}

pub(crate) fn bind_thread(token: &str, thread_id: &str) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let registered = registry
        .routes
        .get_mut(token)
        .ok_or_else(|| "local model proxy task route is not registered".to_owned())?;
    registered.thread_ids.insert(thread_id.to_owned());
    registered.last_used = Instant::now();
    log_executor_event(
        "local model proxy bound task thread",
        &[
            ("thread_id", thread_id.to_owned()),
            ("bound_threads", registered.thread_ids.len().to_string()),
        ],
    );
    Ok(())
}

pub(crate) fn unregister(token: &str) {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let (retained_idle, active_references) = match registry.routes.get_mut(token) {
        Some(registered) => {
            registered.active_references = registered.active_references.saturating_sub(1);
            registered.last_used = Instant::now();
            (
                registered.active_references == 0,
                registered.active_references,
            )
        }
        None => (false, 0),
    };
    log_executor_event(
        "local model proxy unregistered",
        &[
            ("retained_idle", retained_idle.to_string()),
            ("active_references", active_references.to_string()),
            ("active_registrations", registry.routes.len().to_string()),
        ],
    );
}

fn generate_registration_token(registry: &LocalModelProxyRegistry) -> String {
    loop {
        let mut bytes = [0_u8; 24];
        getrandom::fill(&mut bytes).expect("secure local model proxy token generation should work");
        let suffix = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let token = format!("task-{suffix}");
        if !registry.routes.contains_key(&token)
            && !registry
                .tokens_by_scope
                .values()
                .any(|value| value == &token)
        {
            return token;
        }
    }
}

fn prune_registry(registry: &mut LocalModelProxyRegistry) {
    let before = registry.routes.len();
    registry.routes.retain(|_, entry| {
        entry.active_references > 0 || entry.last_used.elapsed() < REGISTRY_IDLE_TTL
    });
    let removed = before.saturating_sub(registry.routes.len());
    if removed > 0 {
        log_executor_event(
            "local model proxy registrations expired",
            &[
                ("removed", removed.to_string()),
                ("active_registrations", registry.routes.len().to_string()),
            ],
        );
    }
}

fn registry() -> &'static Mutex<LocalModelProxyRegistry> {
    static REGISTRY: OnceLock<Mutex<LocalModelProxyRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(LocalModelProxyRegistry::default()))
}

#[cfg(test)]
pub(super) async fn handle(headers: HeaderMap, body: Bytes) -> Result<Response, HttpError> {
    let token = bearer_token(&headers).ok_or_else(|| HttpError {
        status: StatusCode::UNAUTHORIZED,
        detail: "missing local model proxy token".to_owned(),
    })?;
    handle_for_token(token, headers, body).await
}

pub(super) async fn handle_token_route(
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    handle_for_token(token, headers, body).await
}

async fn handle_bound_thread(headers: HeaderMap, body: Bytes) -> Result<Response, HttpError> {
    if bearer_token(&headers).as_deref() != Some(API_KEY) {
        return Err(HttpError {
            status: StatusCode::UNAUTHORIZED,
            detail: "invalid local model proxy authorization".to_owned(),
        });
    }
    let token = bound_thread_token(&body)?;
    handle_for_token(token, headers, body).await
}

fn bound_thread_token(body: &[u8]) -> Result<String, HttpError> {
    let identity = request_thread_identity(body).ok_or_else(|| HttpError {
        status: StatusCode::CONFLICT,
        detail: "Codex Responses request is missing task thread metadata".to_owned(),
    })?;
    let registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let mut tokens = registry.routes.iter().filter_map(|(token, registered)| {
        let matches_thread = registered.thread_ids.contains(&identity.thread_id);
        let matches_parent = identity
            .parent_thread_id
            .as_ref()
            .is_some_and(|parent| registered.thread_ids.contains(parent));
        (matches_thread || matches_parent).then(|| token.clone())
    });
    let token = tokens.next().ok_or_else(|| HttpError {
        status: StatusCode::NOT_FOUND,
        detail: "no local model proxy route is bound to the Codex thread".to_owned(),
    })?;
    if tokens.next().is_some() {
        return Err(HttpError {
            status: StatusCode::CONFLICT,
            detail: "multiple local model proxy routes are bound to the Codex thread".to_owned(),
        });
    }
    Ok(token)
}

async fn handle_for_token(
    token: String,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let request_started_at = Instant::now();
    let forked_from_thread_id = codex_forked_from_thread_id(&headers);
    let (upstream, vision_sidecar, history, model_routing) = {
        let mut registry = registry()
            .lock()
            .expect("local model proxy registry should not be poisoned");
        prune_registry(&mut registry);
        let registered = registry.routes.get_mut(&token).ok_or_else(|| HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "unknown or expired local model proxy token".to_owned(),
        })?;
        authorize_task_thread(registered, &body)?;
        let model_routing = begin_model_request(registered, &body);
        registered.last_used = Instant::now();
        (
            registered.upstream.clone(),
            registered.vision_sidecar.clone(),
            registered.history.clone(),
            model_routing,
        )
    };
    log_stale_requested_model(&upstream, &body);
    let request_url = upstream
        .request_url
        .clone()
        .unwrap_or_else(|| format!("{}/responses", upstream.base_url.trim_end_matches('/')));
    let request_body = match upstream.model_id.as_deref() {
        Some(model_id) => rewrite_request_model(&body, model_id)?,
        None => body.to_vec(),
    };
    let request_body =
        prepare_model_switch_request(&upstream, request_body, model_routing.model_switched)?;
    let request_body =
        vision::replace_images_with_descriptions(vision_sidecar.as_ref(), &request_body).await?;
    let (request_body, conversion, expanded_browser_tools) = prepare_request_with_history(
        &upstream.api_format,
        upstream.convert_custom_tools,
        upstream.max_output_tokens,
        upstream.routing_model_id.as_deref(),
        &request_body,
        history.as_ref(),
    )
    .await?;
    let (request_body, stripped_encrypted_content) =
        prepare_fork_request(request_body, forked_from_thread_id.is_some())?;
    let mut request_log_fields = vec![
        ("api_format", upstream.api_format.clone()),
        ("upstream", safe_url(&request_url)),
        ("body_bytes", request_body.len().to_string()),
        (
            "expanded_browser_tools",
            expanded_browser_tools.len().to_string(),
        ),
    ];
    if let Some(parent_thread_id) = forked_from_thread_id {
        request_log_fields.extend([
            ("forked_from_thread_id", parent_thread_id),
            (
                "stripped_encrypted_content",
                stripped_encrypted_content.to_string(),
            ),
        ]);
    }
    log_executor_event("local model proxy request started", &request_log_fields);

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let client = proxy_client(upstream.proxy_url.as_deref())?;
    let upstream_response = send_upstream_request_with_rate_limit_retry(
        &client,
        &upstream,
        &request_url,
        &request_body,
        user_agent.as_deref(),
    )
    .await?;
    let status = upstream_response.status();
    if status.is_success() {
        commit_model_request(&token, &model_routing);
    }
    log_executor_event(
        "local model proxy upstream headers received",
        &[
            ("api_format", upstream.api_format.clone()),
            ("status", status.as_u16().to_string()),
            (
                "elapsed_ms",
                request_started_at.elapsed().as_millis().to_string(),
            ),
        ],
    );
    let content_type = upstream_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if !status.is_success() {
        let response_body = upstream_response.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to read local model error response: {error}"),
        })?;
        log_executor_event(
            "local model proxy upstream rejected request",
            &[
                ("api_format", upstream.api_format),
                ("status", status.as_u16().to_string()),
                ("body_bytes", response_body.len().to_string()),
                (
                    "upstream_error_code",
                    detect_upstream_error_code(&response_body).unwrap_or_default(),
                ),
            ],
        );
        let mut response = Response::new(Body::from(response_body));
        *response.status_mut() = status;
        if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
            response.headers_mut().insert(header::CONTENT_TYPE, value);
        }
        return Ok(response);
    }
    if !content_type
        .as_deref()
        .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
    {
        let response_body = upstream_response.bytes().await.map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to read non-streaming local model response: {error}"),
        })?;
        let value = serde_json::from_slice::<Value>(&response_body).map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Upstream returned invalid non-SSE JSON: {error}"),
        })?;
        log_executor_event(
            "local model proxy converting non-sse response",
            &[
                ("api_format", upstream.api_format),
                ("content_type", content_type.unwrap_or_default()),
                ("body_bytes", response_body.len().to_string()),
            ],
        );
        if let Some(conversion) = conversion {
            match conversion {
                Conversion::Chat(context) => {
                    let source = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                        Bytes::from(format!("data: {}\n\ndata: [DONE]\n\n", value)),
                    )]);
                    let responses_stream = chat::chat_sse_to_responses(source, context);
                    let mut response = Response::new(Body::from_stream(
                        history::record_responses_stream(responses_stream, history),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    return Ok(response);
                }
                Conversion::Anthropic(context) => {
                    let chat_value = anthropic::anthropic_response_to_chat(&value);
                    let source = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                        Bytes::from(format!("data: {}\n\ndata: [DONE]\n\n", chat_value)),
                    )]);
                    let responses_stream = chat::chat_sse_to_responses(source, context);
                    let mut response = Response::new(Body::from_stream(
                        history::record_responses_stream(responses_stream, history),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    return Ok(response);
                }
                Conversion::Responses(context) => {
                    let event = normalize_responses_event(&format!(
                        "event: response.completed\ndata: {}",
                        json!({"type": "response.completed", "response": value})
                    ));
                    let source = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
                        Bytes::from(format!("{}\n\n", event)),
                    )]);
                    let responses_stream = chat::responses_sse_to_responses(source, context);
                    let mut response = Response::new(Body::from_stream(
                        history::record_responses_stream(responses_stream, history),
                    ));
                    response.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static("text/event-stream"),
                    );
                    return Ok(response);
                }
            }
        }
        let event = normalize_responses_event(&format!(
            "event: response.completed\ndata: {}",
            json!({"type": "response.completed", "response": value})
        ));
        let mut response = Response::new(Body::from(format!("{event}\n\n")));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
        return Ok(response);
    }
    let is_converted = conversion.is_some();
    let response_stream = diagnostic_upstream_stream(
        upstream_response.bytes_stream(),
        upstream.api_format.clone(),
        request_started_at,
    );
    let mut response = match conversion {
        Some(Conversion::Chat(context)) => {
            let responses_stream = chat::chat_sse_to_responses(response_stream, context);
            Response::new(Body::from_stream(history::record_responses_stream(
                responses_stream,
                history,
            )))
        }
        Some(Conversion::Anthropic(context)) => {
            let responses_stream = anthropic::anthropic_sse_to_responses(response_stream, context);
            Response::new(Body::from_stream(history::record_responses_stream(
                responses_stream,
                history,
            )))
        }
        Some(Conversion::Responses(context)) => {
            let responses_stream = chat::responses_sse_to_responses(response_stream, context);
            Response::new(Body::from_stream(history::record_responses_stream(
                responses_stream,
                history,
            )))
        }
        None => Response::new(Body::from_stream(normalize_responses_stream(
            response_stream,
            expanded_browser_tools,
        ))),
    };
    *response.status_mut() = status;
    if is_converted {
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
    } else if let Some(value) = content_type.and_then(|value| HeaderValue::from_str(&value).ok()) {
        response.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    Ok(response)
}

fn requested_model(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()?
        .get("model")?
        .as_str()
        .map(str::to_owned)
}

fn authorize_task_thread(
    registered: &mut RegisteredUpstream,
    body: &[u8],
) -> Result<(), HttpError> {
    if registered.thread_ids.is_empty() {
        return Ok(());
    }
    let identity = request_thread_identity(body).ok_or_else(|| HttpError {
        status: StatusCode::CONFLICT,
        detail: "Codex Responses request is missing task thread metadata".to_owned(),
    })?;
    if registered.thread_ids.contains(&identity.thread_id) {
        return Ok(());
    }
    if identity
        .parent_thread_id
        .as_ref()
        .is_some_and(|parent| registered.thread_ids.contains(parent))
    {
        registered.thread_ids.insert(identity.thread_id);
        return Ok(());
    }
    Err(HttpError {
        status: StatusCode::CONFLICT,
        detail: "Codex Responses request thread does not belong to the task route".to_owned(),
    })
}

struct RequestThreadIdentity {
    thread_id: String,
    parent_thread_id: Option<String>,
}

fn request_thread_identity(body: &[u8]) -> Option<RequestThreadIdentity> {
    let request = serde_json::from_slice::<Value>(body).ok()?;
    let metadata = request.get("client_metadata")?.as_object()?;
    let thread_id = metadata.get("thread_id")?.as_str()?.to_owned();
    let parent_thread_id = metadata
        .get("parent_thread_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            metadata
                .get("x-codex-turn-metadata")
                .and_then(Value::as_str)
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .and_then(|value| {
                    value
                        .get("parent_thread_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
        });
    Some(RequestThreadIdentity {
        thread_id,
        parent_thread_id,
    })
}

fn stale_requested_model(
    upstream: &LocalModelProxyUpstream,
    body: &[u8],
) -> Option<(String, String)> {
    let expected_model = upstream.routing_model_id.as_deref()?;
    let requested_model = requested_model(body)?;
    if requested_model == expected_model {
        return None;
    }
    Some((requested_model, expected_model.to_owned()))
}

fn log_stale_requested_model(upstream: &LocalModelProxyUpstream, body: &[u8]) {
    let Some((requested_model, selected_model)) = stale_requested_model(upstream, body) else {
        return;
    };
    log_executor_event(
        "local model proxy ignored stale codex model",
        &[
            ("requested_model", requested_model),
            ("selected_model", selected_model),
        ],
    );
}

fn begin_model_request(registered: &RegisteredUpstream, body: &[u8]) -> ModelRequestRouting {
    let current_model = registered
        .upstream
        .routing_model_id
        .as_deref()
        .or(registered.upstream.model_id.as_deref())
        .map(str::to_owned);
    let Some(current_model) = current_model else {
        return ModelRequestRouting::default();
    };
    if registered.pending_model_switch_cleanup {
        return ModelRequestRouting {
            model_switched: true,
            model_to_commit: Some(current_model),
            clear_pending_model_switch: true,
        };
    }
    match registered.last_routed_model.as_deref() {
        None => ModelRequestRouting {
            model_switched: false,
            model_to_commit: Some(current_model),
            clear_pending_model_switch: false,
        },
        Some(previous_model) if previous_model == current_model => ModelRequestRouting::default(),
        Some(_) if request_contains_model_switch_marker(body) => ModelRequestRouting {
            model_switched: true,
            model_to_commit: Some(current_model),
            clear_pending_model_switch: false,
        },
        Some(_) => ModelRequestRouting::default(),
    }
}

fn commit_model_request(token: &str, routing: &ModelRequestRouting) {
    let Some(model_to_commit) = routing.model_to_commit.as_deref() else {
        return;
    };
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let Some(registered) = registry.routes.get_mut(token) else {
        return;
    };
    let current_model = registered
        .upstream
        .routing_model_id
        .as_deref()
        .or(registered.upstream.model_id.as_deref());
    if current_model == Some(model_to_commit) {
        registered.last_routed_model = Some(model_to_commit.to_owned());
        if routing.clear_pending_model_switch {
            registered.pending_model_switch_cleanup = false;
        }
    }
}

fn prepare_model_switch_request(
    upstream: &LocalModelProxyUpstream,
    body: Vec<u8>,
    model_switched: bool,
) -> Result<Vec<u8>, HttpError> {
    if !model_switched {
        return Ok(body);
    }
    let mut request = serde_json::from_slice::<Value>(&body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let Some(object) = request.as_object_mut() else {
        return Ok(body);
    };
    let removed_previous_response_id = object.remove("previous_response_id").is_some();
    let removed_items = object
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .map(|items| {
            let before = items.len();
            items.retain(|item| !has_encrypted_model_state(item));
            before.saturating_sub(items.len())
        })
        .unwrap_or_default();
    if removed_items == 0 && !removed_previous_response_id {
        return Ok(body);
    }
    log_executor_event(
        "local model proxy removed encrypted history for model switch",
        &[
            (
                "requested_model",
                requested_model(&body).unwrap_or_default(),
            ),
            (
                "upstream_model",
                upstream.model_id.clone().unwrap_or_default(),
            ),
            ("removed_items", removed_items.to_string()),
            (
                "removed_previous_response_id",
                removed_previous_response_id.to_string(),
            ),
        ],
    );
    serde_json::to_vec(&request).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode model switch request: {error}"),
    })
}

fn request_contains_model_switch_marker(body: &[u8]) -> bool {
    serde_json::from_slice::<Value>(body)
        .ok()
        .is_some_and(|request| contains_model_switch_marker(&request))
}

fn contains_model_switch_marker(request: &Value) -> bool {
    request
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter_map(|content| content.get("text").and_then(Value::as_str))
        .any(|text| text.contains("<model_switch>"))
}

fn has_encrypted_model_state(item: &Value) -> bool {
    let item_type = item.get("type").and_then(Value::as_str);
    let direct = item
        .get("encrypted_content")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let nested = item
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|part| {
            part.get("encrypted_content")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        });
    matches!(
        item_type,
        Some(
            "reasoning"
                | "compaction"
                | "compaction_summary"
                | "context_compaction"
                | "agent_message"
        )
    ) && (direct || nested)
}

fn rewrite_request_model(body: &[u8], model_id: &str) -> Result<Vec<u8>, HttpError> {
    let mut request: Value = serde_json::from_slice(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid local model proxy request: {error}"),
    })?;
    let object = request.as_object_mut().ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "Local model proxy request body must be an object".to_owned(),
    })?;
    object.insert("model".to_owned(), Value::String(model_id.to_owned()));
    serde_json::to_vec(&request).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode local model proxy request: {error}"),
    })
}

fn diagnostic_upstream_stream<S, E>(
    stream: S,
    api_format: String,
    started_at: Instant,
) -> impl Stream<Item = Result<Bytes, E>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
{
    futures_util::stream::unfold(
        (Box::pin(stream), api_format, started_at, false, 0_u64),
        |(mut stream, api_format, started_at, first_seen, total_bytes)| async move {
            match stream.next().await {
                Some(item) => {
                    let chunk_bytes = item.as_ref().map_or(0, Bytes::len) as u64;
                    let next_total = total_bytes.saturating_add(chunk_bytes);
                    if !first_seen {
                        log_executor_event(
                            "local model proxy upstream first chunk received",
                            &[
                                ("api_format", api_format.clone()),
                                ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                                ("chunk_bytes", chunk_bytes.to_string()),
                            ],
                        );
                    }
                    Some((item, (stream, api_format, started_at, true, next_total)))
                }
                None => {
                    log_executor_event(
                        "local model proxy upstream stream completed",
                        &[
                            ("api_format", api_format),
                            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                            ("body_bytes", total_bytes.to_string()),
                        ],
                    );
                    None
                }
            }
        },
    )
}

async fn prepare_request_with_history(
    api_format: &str,
    convert_custom_tools: bool,
    max_output_tokens: Option<u64>,
    model_hint: Option<&str>,
    body: &[u8],
    history: &history::CodexToolHistory,
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    if api_format == "openai-responses" {
        let mut responses_body =
            serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: format!("Invalid Codex Responses request: {error}"),
            })?;
        let enhanced = history
            .enhance_native_apply_patch_errors(&mut responses_body)
            .await;
        if enhanced > 0 {
            log_executor_event(
                "local model proxy enhanced apply_patch error",
                &[
                    ("api_format", api_format.to_owned()),
                    ("outputs", enhanced.to_string()),
                ],
            );
        }
        let body = serde_json::to_vec(&responses_body).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to serialize enriched Codex request: {error}"),
        })?;
        return prepare_request_with_model_hint(
            api_format,
            convert_custom_tools,
            max_output_tokens,
            model_hint,
            &body,
        );
    }
    let mut responses_body = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let restored = history.enrich_request(&mut responses_body).await;
    if restored > 0 {
        log_executor_event(
            "local model proxy restored tool history",
            &[
                ("api_format", api_format.to_owned()),
                ("restored_items", restored.to_string()),
            ],
        );
    }
    let enriched = serde_json::to_vec(&responses_body).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to serialize enriched Codex request: {error}"),
    })?;
    prepare_request_with_model_hint(
        api_format,
        convert_custom_tools,
        max_output_tokens,
        model_hint,
        &enriched,
    )
}

#[allow(clippy::type_complexity)]
#[cfg(test)]
fn prepare_request(
    api_format: &str,
    convert_custom_tools: bool,
    max_output_tokens: Option<u64>,
    body: &[u8],
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    prepare_request_with_model_hint(
        api_format,
        convert_custom_tools,
        max_output_tokens,
        None,
        body,
    )
}

#[allow(clippy::type_complexity)]
fn prepare_request_with_model_hint(
    api_format: &str,
    convert_custom_tools: bool,
    max_output_tokens: Option<u64>,
    model_hint: Option<&str>,
    body: &[u8],
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    let mut responses_body = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    normalize_responses_request_ids(&mut responses_body);
    apply_default_max_output_tokens(&mut responses_body, max_output_tokens);

    if api_format == "openai-responses" {
        let conversion = if convert_custom_tools {
            let (converted, context) =
                chat::responses_to_responses(&responses_body).map_err(|error| HttpError {
                    status: StatusCode::BAD_REQUEST,
                    detail: format!("Failed to convert local model request: {error}"),
                })?;
            responses_body = converted;
            Some(Conversion::Responses(context))
        } else {
            None
        };
        let expanded_browser_tools =
            codex_responses_proxy_transform::expand_wework_browser_namespace_tools(
                &mut responses_body,
            );
        let body = serde_json::to_vec(&responses_body).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to serialize local model request: {error}"),
        })?;
        return Ok((body, conversion, expanded_browser_tools));
    }
    let (converted, context) = match api_format {
        "openai-chat-completions" => {
            chat::responses_to_chat_with_model_hint(&responses_body, model_hint)
                .map(|(body, context)| (body, Conversion::Chat(context)))
        }
        "anthropic-messages" => anthropic::responses_to_anthropic(&responses_body)
            .map(|(body, context)| (body, Conversion::Anthropic(context))),
        _ => return Ok((body.to_vec(), None, HashSet::new())),
    }
    .map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Failed to convert local model request: {error}"),
    })?;
    let body = serde_json::to_vec(&converted).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to serialize local model request: {error}"),
    })?;
    Ok((body, Some(context), HashSet::new()))
}

fn apply_default_max_output_tokens(body: &mut Value, max_output_tokens: Option<u64>) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    if ["max_output_tokens", "max_completion_tokens", "max_tokens"]
        .iter()
        .any(|field| object.contains_key(*field))
    {
        return;
    }
    object.insert(
        "max_output_tokens".to_owned(),
        Value::Number(
            max_output_tokens
                .unwrap_or(DEFAULT_MAX_OUTPUT_TOKENS)
                .into(),
        ),
    );
}

fn normalize_responses_request_ids(body: &mut Value) -> usize {
    let Some(input) = body.get_mut("input") else {
        return 0;
    };
    let items = match input {
        Value::Array(items) => items.as_mut_slice(),
        Value::Object(_) => std::slice::from_mut(input),
        _ => return 0,
    };
    let mut changed = 0;

    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        for field in ["id", "call_id"] {
            let Some(value) = object.get_mut(field) else {
                continue;
            };
            let Some(raw) = value.as_str() else {
                continue;
            };
            let normalized = normalized_responses_api_id(raw);
            if normalized != raw {
                *value = Value::String(normalized);
                changed += 1;
            }
        }
    }

    changed
}

fn normalized_responses_api_id(value: &str) -> String {
    if !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return value.to_owned();
    }

    let mut prefix = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .take(NORMALIZED_API_ID_PREFIX_LENGTH)
        .collect::<String>();
    if prefix.is_empty() {
        prefix.push_str("id");
    }
    let digest = Sha256::digest(value.as_bytes());
    let suffix = digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{prefix}_{suffix}")
}

#[derive(Debug)]
enum Conversion {
    Chat(chat::ToolContext),
    Anthropic(chat::ToolContext),
    Responses(chat::ToolContext),
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?
        .trim();
    let mut parts = auth.split_whitespace();
    if parts.next()?.eq_ignore_ascii_case("Bearer") {
        parts.next().map(str::to_owned)
    } else {
        None
    }
}

fn proxy_client(proxy_url: Option<&str>) -> Result<reqwest::Client, HttpError> {
    let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return reqwest::Client::builder()
            .timeout(Duration::from_secs(
                LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS,
            ))
            .build()
            .map_err(|error| HttpError {
                status: StatusCode::BAD_GATEWAY,
                detail: format!("Failed to configure local model proxy client: {error}"),
            });
    };
    reqwest::Client::builder()
        .timeout(Duration::from_secs(
            LOCAL_MODEL_PROXY_REQUEST_TIMEOUT_SECONDS,
        ))
        .proxy(reqwest::Proxy::all(proxy_url).map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Invalid local model proxy URL: {error}"),
        })?)
        .build()
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to configure local model proxy client: {error}"),
        })
}

fn proxy_client_without_redirects(proxy_url: Option<&str>) -> Result<reqwest::Client, HttpError> {
    proxy_client_builder(proxy_url)?
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| HttpError {
            status: StatusCode::BAD_GATEWAY,
            detail: format!("Failed to configure local model proxy client: {error}"),
        })
}

fn proxy_client_builder(proxy_url: Option<&str>) -> Result<reqwest::ClientBuilder, HttpError> {
    let Some(proxy_url) = proxy_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(reqwest::Client::builder());
    };
    Ok(
        reqwest::Client::builder().proxy(reqwest::Proxy::all(proxy_url).map_err(|error| {
            HttpError {
                status: StatusCode::BAD_GATEWAY,
                detail: format!("Invalid local model proxy URL: {error}"),
            }
        })?),
    )
}

async fn send_upstream_request_with_rate_limit_retry(
    client: &reqwest::Client,
    upstream: &LocalModelProxyUpstream,
    request_url: &str,
    request_body: &[u8],
    user_agent: Option<&str>,
) -> Result<reqwest::Response, HttpError> {
    for retry_count in 0..=MAX_RATE_LIMIT_RETRIES {
        let response =
            build_upstream_request(client, upstream, request_url, request_body, user_agent)
                .send()
                .await
                .map_err(|error| HttpError {
                    status: StatusCode::BAD_GATEWAY,
                    detail: format!("Local model proxy request failed: {error}"),
                })?;
        if response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS
            || retry_count == MAX_RATE_LIMIT_RETRIES
        {
            return Ok(response);
        }

        let delay = rate_limit_retry_delay(response.headers(), retry_count);
        log_executor_event(
            "local model proxy rate limited; retrying",
            &[
                ("api_format", upstream.api_format.clone()),
                ("retry", (retry_count + 1).to_string()),
                ("max_retries", MAX_RATE_LIMIT_RETRIES.to_string()),
                ("delay_ms", delay.as_millis().to_string()),
            ],
        );
        tokio::time::sleep(delay).await;
    }

    unreachable!("rate limit retry loop always returns a response")
}

fn build_upstream_request(
    client: &reqwest::Client,
    upstream: &LocalModelProxyUpstream,
    request_url: &str,
    request_body: &[u8],
    user_agent: Option<&str>,
) -> reqwest::RequestBuilder {
    let mut request = client
        .post(request_url)
        .bearer_auth(&upstream.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .body(request_body.to_vec());
    if upstream.api_format == "anthropic-messages" {
        request = request
            .header("x-api-key", &upstream.api_key)
            .header("anthropic-version", "2023-06-01");
    }
    if let Some(user_agent) = user_agent {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    for (key, value) in &upstream.default_headers {
        request = request.header(key, value);
    }
    request
}

fn detect_upstream_error_code(response_body: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(response_body);
    [
        "invalid_encrypted_content",
        "context_length_exceeded",
        "rate_limit_exceeded",
    ]
    .into_iter()
    .find(|code| text.contains(code))
    .map(str::to_owned)
}

fn rate_limit_retry_delay(headers: &reqwest::header::HeaderMap, retry_count: u32) -> Duration {
    let retry_after = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    retry_after
        .unwrap_or_else(|| configured_rate_limit_delay(retry_count))
        .min(MAX_RATE_LIMIT_RETRY_DELAY)
}

fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let retry_at = httpdate::parse_http_date(value).ok()?;
    Some(
        retry_at
            .duration_since(SystemTime::now())
            .unwrap_or(Duration::ZERO),
    )
}

fn configured_rate_limit_delay(retry_count: u32) -> Duration {
    RATE_LIMIT_RETRY_DELAYS
        .get(retry_count as usize)
        .copied()
        .unwrap_or(MAX_RATE_LIMIT_RETRY_DELAY)
}

fn safe_url(value: &str) -> String {
    reqwest::Url::parse(value)
        .ok()
        .and_then(|url| {
            let host = url.host_str()?;
            let port = url
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            Some(format!("{}://{}{}{}", url.scheme(), host, port, url.path()))
        })
        .unwrap_or_else(|| "<invalid-url>".to_owned())
}

struct ResponsesStreamState<S> {
    stream: Pin<Box<S>>,
    pending: String,
    pending_utf8: Vec<u8>,
    output: VecDeque<Result<Bytes, std::io::Error>>,
    source_done: bool,
    terminal_seen: bool,
    expanded_browser_tools: HashSet<String>,
}

fn normalize_responses_stream<S, E>(
    stream: S,
    expanded_browser_tools: HashSet<String>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: ToString,
{
    let state = ResponsesStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        pending_utf8: Vec::new(),
        output: VecDeque::new(),
        source_done: false,
        terminal_seen: false,
        expanded_browser_tools,
    };
    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            if state.terminal_seen {
                return None;
            }
            if state.source_done {
                state.terminal_seen = true;
                return Some((
                    Ok(responses_failed_event(
                        "Upstream Responses stream ended before a terminal event",
                    )),
                    state,
                ));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    if let Err(error) =
                        append_stream_utf8(&mut state.pending, &mut state.pending_utf8, &bytes)
                    {
                        state.source_done = true;
                        state.terminal_seen = true;
                        return Some((Ok(responses_failed_event(&error.to_string())), state));
                    }
                    while let Some(event) = take_sse_block(&mut state.pending) {
                        state.terminal_seen |= is_responses_terminal_event(&event);
                        let normalized = if state.expanded_browser_tools.is_empty() {
                            normalize_responses_event(&event)
                        } else {
                            let rewritten =
                                rewrite_responses_event(&event, &state.expanded_browser_tools);
                            normalize_responses_event(&rewritten)
                        };
                        log_responses_event_diagnostics(&normalized);
                        state
                            .output
                            .push_back(Ok(Bytes::from(format!("{}\n\n", normalized))));
                    }
                }
                Some(Err(error)) => {
                    state.source_done = true;
                    state.terminal_seen = true;
                    return Some((Ok(responses_failed_event(&error.to_string())), state));
                }
                None => {
                    state.source_done = true;
                    if let Err(error) = finish_stream_utf8(&state.pending_utf8) {
                        state.terminal_seen = true;
                        return Some((Ok(responses_failed_event(&error.to_string())), state));
                    }
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        let trailing = trailing.trim_end();
                        state.terminal_seen |= is_responses_terminal_event(trailing);
                        let normalized = normalize_responses_event(trailing);
                        log_responses_event_diagnostics(&normalized);
                        state
                            .output
                            .push_back(Ok(Bytes::from(format!("{}\n\n", normalized))));
                    }
                }
            }
        }
    })
}

#[derive(Debug, PartialEq, Eq)]
enum ResponsesEventDiagnostic {
    ToolCall {
        phase: &'static str,
        tool_name: String,
        namespace: String,
        custom_tool: bool,
        arguments_bytes: usize,
    },
    Terminal {
        status: String,
        output_items: usize,
        tool_calls: usize,
        empty_output: bool,
    },
}

fn log_responses_event_diagnostics(event: &str) {
    for diagnostic in responses_event_diagnostics(event) {
        match diagnostic {
            ResponsesEventDiagnostic::ToolCall {
                phase,
                tool_name,
                namespace,
                custom_tool,
                arguments_bytes,
            } => {
                log_executor_event(
                    &format!("local model proxy responses tool call {phase}"),
                    &[
                        ("tool_name", tool_name),
                        ("namespace", namespace),
                        ("custom_tool", custom_tool.to_string()),
                        ("arguments_bytes", arguments_bytes.to_string()),
                    ],
                );
            }
            ResponsesEventDiagnostic::Terminal {
                status,
                output_items,
                tool_calls,
                empty_output,
            } => {
                log_executor_event(
                    "local model proxy responses completion summary",
                    &[
                        ("status", status),
                        ("output_items", output_items.to_string()),
                        ("tool_calls", tool_calls.to_string()),
                        ("empty_output", empty_output.to_string()),
                    ],
                );
            }
        }
    }
}

fn responses_event_diagnostics(event: &str) -> Vec<ResponsesEventDiagnostic> {
    let mut diagnostics = Vec::new();
    for value in responses_event_values(event) {
        let event_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let phase = match event_type {
            "response.output_item.added" => Some("started"),
            "response.output_item.done" => Some("completed"),
            _ => None,
        };
        if let Some(phase) = phase {
            if let Some(item) = value.get("item") {
                let item_type = item.get("type").and_then(Value::as_str);
                if matches!(
                    item_type,
                    Some("function_call" | "custom_tool_call" | "tool_search_call")
                ) {
                    diagnostics.push(ResponsesEventDiagnostic::ToolCall {
                        phase,
                        tool_name: item
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        namespace: item
                            .get("namespace")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        custom_tool: item_type == Some("custom_tool_call"),
                        arguments_bytes: item
                            .get("arguments")
                            .or_else(|| item.get("input"))
                            .and_then(Value::as_str)
                            .map_or(0, str::len),
                    });
                }
            }
        }
        if matches!(
            event_type,
            "response.completed" | "response.failed" | "response.incomplete"
        ) {
            let output = value
                .pointer("/response/output")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default();
            diagnostics.push(ResponsesEventDiagnostic::Terminal {
                status: value
                    .pointer("/response/status")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| event_type.trim_start_matches("response."))
                    .to_owned(),
                output_items: output.len(),
                tool_calls: output
                    .iter()
                    .filter(|item| {
                        matches!(
                            item.get("type").and_then(Value::as_str),
                            Some("function_call" | "custom_tool_call" | "tool_search_call")
                        )
                    })
                    .count(),
                empty_output: output.is_empty(),
            });
        }
    }
    diagnostics
}

fn responses_event_values(event: &str) -> Vec<Value> {
    event
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("data:"))
        .map(str::trim_start)
        .filter(|data| *data != "[DONE]")
        .filter_map(|data| serde_json::from_str::<Value>(data).ok())
        .collect()
}

pub(super) fn is_responses_terminal_event(event: &str) -> bool {
    let mut event_name = None;
    let mut data_lines = Vec::new();
    for line in event.lines() {
        let line = line.trim_start_matches('\u{feff}').trim_start();
        if let Some(value) = line.strip_prefix("event:") {
            event_name = Some(value.trim());
        } else if let Some(value) = line.strip_prefix("data:") {
            data_lines.push(value.trim_start());
        }
    }
    if event_name.is_some_and(|value| {
        matches!(
            value,
            "response.completed" | "response.failed" | "response.incomplete"
        )
    }) {
        return true;
    }
    serde_json::from_str::<Value>(&data_lines.join("\n"))
        .ok()
        .and_then(|value| value.get("type").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|event_type| {
            matches!(
                event_type.as_str(),
                "response.completed" | "response.failed" | "response.incomplete"
            )
        })
}

pub(super) fn responses_failed_event(message: &str) -> Bytes {
    Bytes::from(format!(
        "event: response.failed\ndata: {}\n\n",
        json!({
            "type": "response.failed",
            "response": {
                "id": "resp_wework_proxy_failed",
                "object": "response",
                "status": "failed",
                "output": [],
                "error": {"type": "upstream_error", "message": message}
            }
        })
    ))
}

pub(super) fn take_sse_block(buffer: &mut String) -> Option<String> {
    let (index, delimiter_len) = buffer
        .find("\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| buffer.find("\n\n").map(|index| (index, 2)))?;
    let block = buffer[..index].to_owned();
    buffer.drain(..index + delimiter_len);
    Some(block)
}

pub(super) fn append_stream_utf8(
    buffer: &mut String,
    pending_utf8: &mut Vec<u8>,
    chunk: &[u8],
) -> Result<(), std::io::Error> {
    pending_utf8.extend_from_slice(chunk);
    match std::str::from_utf8(pending_utf8) {
        Ok(text) => {
            buffer.push_str(text);
            pending_utf8.clear();
            Ok(())
        }
        Err(error) => {
            let valid_up_to = error.valid_up_to();
            let error_len = error.error_len();
            if valid_up_to > 0 {
                let valid = std::str::from_utf8(&pending_utf8[..valid_up_to])
                    .expect("UTF-8 validator should identify a valid prefix");
                buffer.push_str(valid);
                pending_utf8.drain(..valid_up_to);
            }
            if error_len.is_some() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Upstream stream contains invalid UTF-8",
                ));
            }
            Ok(())
        }
    }
}

pub(super) fn finish_stream_utf8(pending_utf8: &[u8]) -> Result<(), std::io::Error> {
    if pending_utf8.is_empty() {
        return Ok(());
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "Upstream stream ended with an incomplete UTF-8 sequence",
    ))
}

fn normalize_responses_event(event: &str) -> String {
    if !event.contains("response.completed") {
        return event.to_owned();
    }
    event
        .lines()
        .map(|line| {
            let Some(data) = line.strip_prefix("data:") else {
                return line.to_owned();
            };
            let data = data.trim_start();
            let Ok(mut value) = serde_json::from_str::<Value>(data) else {
                return line.to_owned();
            };
            normalize_completed_usage(&mut value);
            format!(
                "data: {}",
                serde_json::to_string(&value).unwrap_or_else(|_| data.to_owned())
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn rewrite_responses_event(event: &str, expanded: &HashSet<String>) -> String {
    if expanded.is_empty() {
        return event.to_owned();
    }
    let mut changed = false;
    let lines = event
        .lines()
        .map(|line| {
            let Some(data) = line.strip_prefix("data:") else {
                return line.to_owned();
            };
            let data = data.trim_start();
            if data == "[DONE]" {
                return line.to_owned();
            }
            let Ok(mut value) = serde_json::from_str::<Value>(data) else {
                return line.to_owned();
            };
            let original = value.clone();
            codex_responses_proxy_transform::rewrite_wework_browser_function_calls(
                &mut value, expanded,
            );
            if value == original {
                return line.to_owned();
            }
            changed = true;
            format!(
                "data: {}",
                serde_json::to_string(&value).unwrap_or_else(|_| data.to_owned())
            )
        })
        .collect::<Vec<_>>();
    if changed {
        lines.join("\n")
    } else {
        event.to_owned()
    }
}

fn normalize_completed_usage(value: &mut Value) {
    if value.get("type").and_then(Value::as_str) != Some("response.completed") {
        return;
    }
    let Some(usage) = value
        .pointer_mut("/response/usage")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    ensure_usage_detail(usage, "input_tokens_details", "cached_tokens");
    ensure_usage_detail(usage, "output_tokens_details", "reasoning_tokens");
}

fn ensure_usage_detail(usage: &mut Map<String, Value>, details_key: &str, field: &str) {
    match usage.get_mut(details_key) {
        Some(Value::Object(details)) => {
            details.entry(field.to_owned()).or_insert(Value::from(0));
        }
        Some(Value::Null) | None => {}
        Some(_) => {
            usage.insert(details_key.to_owned(), Value::Null);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env, fs,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
    };

    use axum::{body::to_bytes, routing::post, Json, Router};
    use serde_json::json;
    use tokio::sync::oneshot;

    #[test]
    fn detects_known_upstream_error_codes_in_priority_order() {
        assert_eq!(
            detect_upstream_error_code(
                br#"{"error":{"code":"invalid_encrypted_content","message":"invalid"}}"#
            )
            .as_deref(),
            Some("invalid_encrypted_content")
        );
        assert_eq!(
            detect_upstream_error_code(br#"{"error":{"code":"upstream_unavailable"}}"#),
            None
        );
        assert_eq!(
            detect_upstream_error_code(
                b"rate_limit_exceeded appeared first, then invalid_encrypted_content"
            )
            .as_deref(),
            Some("invalid_encrypted_content")
        );
    }

    #[test]
    fn normalizes_completed_usage_details() {
        let event = format!(
            "data: {}",
            json!({
                "type": "response.completed",
                "response": {"usage": {
                    "input_tokens_details": {},
                    "output_tokens_details": {}
                }}
            })
        );
        let normalized = normalize_responses_event(&event);
        assert!(normalized.contains("cached_tokens"));
        assert!(normalized.contains("reasoning_tokens"));
    }

    #[test]
    fn extracts_native_responses_tool_diagnostics_without_arguments() {
        let started = concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"item\":{",
            "\"type\":\"function_call\",\"name\":\"exec_command\",",
            "\"namespace\":\"functions\",\"arguments\":\"\"}}"
        );
        let completed = concat!(
            "event: response.output_item.done\n",
            "data: {\"type\":\"response.output_item.done\",\"item\":{",
            "\"type\":\"function_call\",\"name\":\"exec_command\",",
            "\"namespace\":\"functions\",\"arguments\":\"{\\\"cmd\\\":\\\"secret\\\"}\"}}"
        );
        let terminal = concat!(
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{",
            "\"status\":\"completed\",\"output\":[",
            "{\"type\":\"function_call\"},{\"type\":\"message\"}]}}"
        );

        assert_eq!(
            responses_event_diagnostics(started),
            vec![ResponsesEventDiagnostic::ToolCall {
                phase: "started",
                tool_name: "exec_command".to_owned(),
                namespace: "functions".to_owned(),
                custom_tool: false,
                arguments_bytes: 0,
            }]
        );
        assert_eq!(
            responses_event_diagnostics(completed),
            vec![ResponsesEventDiagnostic::ToolCall {
                phase: "completed",
                tool_name: "exec_command".to_owned(),
                namespace: "functions".to_owned(),
                custom_tool: false,
                arguments_bytes: 16,
            }]
        );
        assert_eq!(
            responses_event_diagnostics(terminal),
            vec![ResponsesEventDiagnostic::Terminal {
                status: "completed".to_owned(),
                output_items: 2,
                tool_calls: 1,
                empty_output: false,
            }]
        );
        assert!(!format!("{:?}", responses_event_diagnostics(completed)).contains("secret"));
    }

    #[test]
    fn removes_encrypted_history_before_an_explicit_model_switch() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-luna".to_owned()),
            routing_model_id: Some("wework-gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };
        let body = serde_json::to_vec(&json!({
            "model": "wework-gpt-5.6-sol",
            "previous_response_id": "resp_previous",
            "input": [
                {
                    "type": "reasoning",
                    "summary": [],
                    "encrypted_content": "encrypted-old-model-state"
                },
                {
                    "type": "context_compaction",
                    "encrypted_content": "encrypted-old-compaction"
                },
                {
                    "type": "message",
                    "role": "developer",
                    "content": [{
                        "type": "input_text",
                        "text": "<model_switch>Use the new model instructions.</model_switch>"
                    }]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "continue"}]
                }
            ]
        }))
        .expect("request body");

        let prepared = prepare_model_switch_request(&upstream, body, true)
            .expect("model switch should prepare");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared request");

        assert_eq!(prepared["input"].as_array().unwrap().len(), 2);
        assert!(prepared.get("previous_response_id").is_none());
        assert_eq!(prepared["input"][0]["role"], "developer");
        assert_eq!(prepared["input"][1]["role"], "user");
    }

    #[test]
    fn removes_encrypted_compaction_on_the_first_proxied_request_after_a_model_switch() {
        let token = register(
            "first-proxied-request-after-switch",
            LocalModelProxyUpstream {
                base_url: "https://example.com".to_owned(),
                request_url: None,
                api_format: "openai-chat-completions".to_owned(),
                convert_custom_tools: true,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("kimi-k3".to_owned()),
                routing_model_id: Some("wework-kimi-k3".to_owned()),
                max_output_tokens: None,
            },
        );
        mark_model_switch(&token);
        let body = serde_json::to_vec(&json!({
            "model": "gpt-5.6-sol",
            "previous_response_id": "resp_compacted",
            "input": [
                {
                    "type": "context_compaction",
                    "encrypted_content": "provider-bound-summary"
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "continue"}]
                }
            ]
        }))
        .expect("request body");

        let routing = {
            let entries = registry().lock().expect("registry lock");
            begin_model_request(entries.routes.get(&token).expect("registered route"), &body)
        };
        assert!(routing.model_switched);
        assert!(routing.clear_pending_model_switch);

        let prepared = prepare_model_switch_request(
            &LocalModelProxyUpstream {
                base_url: "https://example.com".to_owned(),
                request_url: None,
                api_format: "openai-chat-completions".to_owned(),
                convert_custom_tools: true,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("kimi-k3".to_owned()),
                routing_model_id: Some("wework-kimi-k3".to_owned()),
                max_output_tokens: None,
            },
            body,
            routing.model_switched,
        )
        .expect("model switch should prepare");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared request");

        assert!(prepared.get("previous_response_id").is_none());
        assert_eq!(prepared["input"].as_array().unwrap().len(), 1);
        assert_eq!(prepared["input"][0]["role"], "user");

        let (converted, conversion, _) = prepare_request(
            "openai-chat-completions",
            true,
            None,
            &prepared.to_string().into_bytes(),
        )
        .expect("cleaned request should convert to chat completions");
        assert!(matches!(conversion, Some(Conversion::Chat(_))));
        let converted: Value = serde_json::from_slice(&converted).expect("converted chat request");
        assert!(converted
            .get("messages")
            .and_then(Value::as_array)
            .is_some_and(|messages| messages.iter().all(|message| {
                !message.to_string().contains("provider-bound-summary")
                    && !message.to_string().contains("encrypted_content")
            })));

        commit_model_request(&token, &routing);
        {
            let entries = registry().lock().expect("registry lock");
            assert!(
                !entries
                    .routes
                    .get(&token)
                    .expect("registered route")
                    .pending_model_switch_cleanup
            );
        }
        unregister(&token);
    }

    #[test]
    fn consumes_pending_model_switch_cleanup_on_the_first_plain_request() {
        let token = register(
            "first-plain-request-after-switch",
            LocalModelProxyUpstream {
                base_url: "https://example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("kimi-k3".to_owned()),
                routing_model_id: Some("wework-kimi-k3".to_owned()),
                max_output_tokens: None,
            },
        );
        mark_model_switch(&token);
        let body = br#"{
            "model":"stale-codex-model",
            "input":[{
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"continue"}]
            }]
        }"#;

        let routing = {
            let entries = registry().lock().expect("registry lock");
            begin_model_request(entries.routes.get(&token).expect("registered route"), body)
        };
        assert!(routing.model_switched);
        assert!(routing.clear_pending_model_switch);

        commit_model_request(&token, &routing);
        {
            let entries = registry().lock().expect("registry lock");
            let route = entries.routes.get(&token).expect("registered route");
            assert!(!route.pending_model_switch_cleanup);
            assert!(!begin_model_request(route, body).model_switched);
        }
        unregister(&token);
    }

    #[test]
    fn removes_previous_response_id_from_a_switched_request_without_encrypted_items() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("kimi-k3".to_owned()),
            routing_model_id: Some("wework-kimi-k3".to_owned()),
            max_output_tokens: None,
        };
        let body = serde_json::to_vec(&json!({
            "model": "stale-codex-model",
            "previous_response_id": "resp_old_provider",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "continue"}]
            }]
        }))
        .expect("request body");

        let prepared =
            prepare_model_switch_request(&upstream, body, true).expect("request preparation");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared request");

        assert!(prepared.get("previous_response_id").is_none());
        assert_eq!(prepared["input"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn preserves_encrypted_history_without_a_model_switch_marker() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-sol".to_owned()),
            routing_model_id: Some("wework-gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };
        let body = serde_json::to_vec(&json!({
            "model": "wework-gpt-5.6-sol",
            "previous_response_id": "resp_previous",
            "input": [{
                "type": "reasoning",
                "summary": [],
                "encrypted_content": "encrypted-same-model-state"
            }]
        }))
        .expect("request body");

        let prepared = prepare_model_switch_request(&upstream, body.clone(), false)
            .expect("request should prepare");

        assert_eq!(prepared, body);
    }

    #[test]
    fn preserves_new_encrypted_history_after_the_model_switch_is_recorded() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-sol".to_owned()),
            routing_model_id: Some("wework-gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };
        let body = serde_json::to_vec(&json!({
            "model": "wework-gpt-5.6-sol",
            "previous_response_id": "resp_after_switch",
            "input": [
                {
                    "type": "reasoning",
                    "summary": [],
                    "encrypted_content": "encrypted-new-model-state"
                },
                {
                    "type": "message",
                    "role": "developer",
                    "content": [{
                        "type": "input_text",
                        "text": "<model_switch>Persistent historical marker.</model_switch>"
                    }]
                }
            ]
        }))
        .expect("request body");

        let prepared = prepare_model_switch_request(&upstream, body.clone(), false)
            .expect("later request should preserve new model state");

        assert_eq!(prepared, body);
    }

    #[test]
    fn rejects_invalid_chat_request() {
        let error = prepare_request("openai-chat-completions", false, None, b"not-json")
            .expect_err("invalid JSON should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn preserves_custom_tools_for_native_responses_models() {
        let body = serde_json::to_vec(&json!({
            "model": "gpt-5.6-sol",
            "input": "edit it",
            "tools": [{
                "type": "custom",
                "name": "apply_patch",
                "description": "Patch files"
            }]
        }))
        .expect("request body");

        let (prepared, conversion, _) =
            prepare_request("openai-responses", false, None, &body).expect("native request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(prepared["tools"][0]["type"], "custom");
        assert!(conversion.is_none());
    }

    #[test]
    fn normalizes_cross_protocol_history_ids_for_native_responses_models() {
        let body = cross_protocol_history_with_invalid_ids();

        let (prepared, conversion, _) =
            prepare_request("openai-responses", false, None, &body).expect("native request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");
        let call = &prepared["input"][0];
        let output = &prepared["input"][1];
        let item_id = call["id"].as_str().expect("function call item id");
        let call_id = call["call_id"].as_str().expect("function call id");

        assert_valid_api_id(item_id);
        assert_valid_api_id(call_id);
        assert_ne!(item_id, "fc_functions.exec_command:0");
        assert_ne!(call_id, "functions.exec_command:0");
        assert_eq!(output["call_id"], call["call_id"]);
        assert!(conversion.is_none());
    }

    #[test]
    fn normalizes_cross_protocol_history_ids_before_chat_conversion() {
        let body = cross_protocol_history_with_invalid_ids();

        let (prepared, conversion, _) =
            prepare_request("openai-chat-completions", false, None, &body).expect("chat request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");
        let call = &prepared["messages"][0]["tool_calls"][0];
        let output = &prepared["messages"][1];
        let call_id = call["id"].as_str().expect("chat tool call id");

        assert_valid_api_id(call_id);
        assert_ne!(call_id, "functions.exec_command:0");
        assert_eq!(output["tool_call_id"], call["id"]);
        assert!(matches!(conversion, Some(Conversion::Chat(_))));
    }

    #[test]
    fn chat_conversion_uses_the_routing_model_for_kimi_compatibility() {
        let body = serde_json::to_vec(&json!({
            "model": "cloud-model-resource-name",
            "reasoning": {"effort": "low"},
            "input": "hello",
            "tools": [{
                "type": "function",
                "name": "update_site_metadata",
                "parameters": {
                    "type": "object",
                    "properties": {"title": {"type": "string"}},
                    "anyOf": [{"type": "object", "required": ["title"]}]
                }
            }]
        }))
        .expect("request body");

        let (prepared, conversion, _) = prepare_request_with_model_hint(
            "openai-chat-completions",
            false,
            None,
            Some("wework-kimi-k3"),
            &body,
        )
        .expect("chat request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(prepared["model"], "cloud-model-resource-name");
        assert_eq!(prepared["thinking"], json!({"type": "enabled"}));
        assert!(prepared.get("reasoning_effort").is_none());
        assert!(prepared["tools"][0]["function"]["parameters"]
            .get("type")
            .is_none());
        assert_eq!(
            prepared["tools"][0]["function"]["parameters"]["anyOf"][0]["type"],
            "object"
        );
        assert!(matches!(conversion, Some(Conversion::Chat(_))));
    }

    #[test]
    fn normalizes_cross_protocol_history_ids_before_anthropic_conversion() {
        let body = cross_protocol_history_with_invalid_ids();

        let (prepared, conversion, _) =
            prepare_request("anthropic-messages", false, None, &body).expect("Anthropic request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");
        let call = &prepared["messages"][0]["content"][0];
        let output = &prepared["messages"][1]["content"][0];
        let call_id = call["id"].as_str().expect("Anthropic tool use id");

        assert_valid_api_id(call_id);
        assert_ne!(call_id, "functions.exec_command:0");
        assert_eq!(output["tool_use_id"], call["id"]);
        assert!(matches!(conversion, Some(Conversion::Anthropic(_))));
    }

    #[test]
    fn defaults_anthropic_max_output_tokens_to_96000() {
        let body = serde_json::to_vec(&json!({
            "model": "kimi-k3",
            "input": "finish the task"
        }))
        .expect("request body");

        let (prepared, _, _) =
            prepare_request("anthropic-messages", false, None, &body).expect("Anthropic request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(prepared["max_tokens"], 96_000);
    }

    #[test]
    fn configured_max_output_tokens_override_the_default() {
        let body = serde_json::to_vec(&json!({
            "model": "kimi-k3",
            "input": "finish the task"
        }))
        .expect("request body");

        let (prepared, _, _) = prepare_request("anthropic-messages", false, Some(12_345), &body)
            .expect("Anthropic request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(prepared["max_tokens"], 12_345);
    }

    #[test]
    fn explicit_request_max_output_tokens_override_model_configuration() {
        let body = serde_json::to_vec(&json!({
            "model": "kimi-k3",
            "input": "finish the task",
            "max_output_tokens": 2_048
        }))
        .expect("request body");

        let (prepared, _, _) = prepare_request("anthropic-messages", false, Some(96_000), &body)
            .expect("Anthropic request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(prepared["max_tokens"], 2_048);
    }

    fn cross_protocol_history_with_invalid_ids() -> Vec<u8> {
        serde_json::to_vec(&json!({
            "model": "gpt-5.6-sol",
            "input": [
                {
                    "type": "function_call",
                    "id": "fc_functions.exec_command:0",
                    "call_id": "functions.exec_command:0",
                    "name": "exec_command",
                    "arguments": "{}"
                },
                {
                    "type": "function_call_output",
                    "call_id": "functions.exec_command:0",
                    "output": "done"
                }
            ]
        }))
        .expect("request body")
    }

    fn assert_valid_api_id(value: &str) {
        assert!(value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')));
    }

    #[test]
    fn converts_custom_tools_only_for_function_profile_responses_models() {
        let body = serde_json::to_vec(&json!({
            "model": "gateway-model",
            "input": "edit it",
            "tools": [{
                "type": "custom",
                "name": "apply_patch",
                "description": "Patch files"
            }]
        }))
        .expect("request body");

        let (prepared, conversion, _) =
            prepare_request("openai-responses", true, None, &body).expect("converted request");
        let prepared: Value = serde_json::from_slice(&prepared).expect("prepared JSON");

        assert_eq!(prepared["tools"][0]["type"], "function");
        assert!(matches!(conversion, Some(Conversion::Responses(_))));
    }

    #[test]
    fn proxy_client_rejects_invalid_url() {
        assert!(proxy_client(Some("not a proxy url")).is_err());
    }

    #[test]
    fn rate_limit_retry_delay_uses_retry_after_and_caps_large_values() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("2"),
        );
        assert_eq!(rate_limit_retry_delay(&headers, 0), Duration::from_secs(2));

        headers.insert(
            reqwest::header::RETRY_AFTER,
            reqwest::header::HeaderValue::from_static("120"),
        );
        assert_eq!(
            rate_limit_retry_delay(&headers, 0),
            MAX_RATE_LIMIT_RETRY_DELAY
        );
    }

    #[test]
    fn rate_limit_retry_delay_falls_back_to_configured_backoff_sequence() {
        let headers = reqwest::header::HeaderMap::new();

        let delays = (0..MAX_RATE_LIMIT_RETRIES)
            .map(|retry_count| rate_limit_retry_delay(&headers, retry_count))
            .collect::<Vec<_>>();

        assert_eq!(delays, RATE_LIMIT_RETRY_DELAYS);
        assert_eq!(
            rate_limit_retry_delay(&headers, 20),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn leaves_non_completed_events_unchanged() {
        let event = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}";
        assert_eq!(normalize_responses_event(event), event);
    }

    #[test]
    fn buffers_incomplete_utf8_until_the_next_stream_chunk() {
        let mut buffer = String::new();
        let mut pending_utf8 = Vec::new();

        for byte in "在".as_bytes() {
            append_stream_utf8(&mut buffer, &mut pending_utf8, &[*byte])
                .expect("split UTF-8 should remain valid");
        }

        finish_stream_utf8(&pending_utf8).expect("all UTF-8 bytes should be consumed");
        assert_eq!(buffer, "在");
    }

    #[test]
    fn rejects_an_incomplete_utf8_sequence_at_stream_end() {
        let mut buffer = String::new();
        let mut pending_utf8 = Vec::new();
        append_stream_utf8(&mut buffer, &mut pending_utf8, &["在".as_bytes()[0]])
            .expect("an incomplete trailing sequence should be buffered");

        let error = finish_stream_utf8(&pending_utf8).expect_err("stream should be incomplete");

        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        assert!(buffer.is_empty());
    }

    async fn collect_responses_stream<S, E>(stream: S) -> String
    where
        S: Stream<Item = Result<Bytes, E>> + Send + 'static,
        E: ToString,
    {
        normalize_responses_stream(stream, HashSet::new())
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .map(|chunk| String::from_utf8_lossy(&chunk.expect("normalized chunk")).into_owned())
            .collect()
    }

    #[tokio::test]
    async fn reports_truncated_native_responses_stream_as_failed() {
        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from_static(
            b"event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
        ))]);
        let output = collect_responses_stream(stream).await;

        assert!(output.contains("response.created"));
        assert!(output.contains("response.failed"));
        assert!(output.contains("ended before a terminal event"));
    }

    #[tokio::test]
    async fn accepts_native_responses_terminal_event_without_blank_tail() {
        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(Bytes::from_static(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}",
        ))]);
        let output = collect_responses_stream(stream).await;

        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
    }

    #[tokio::test]
    async fn converts_native_responses_read_error_to_failed_event() {
        let stream = futures_util::stream::iter(vec![Err::<Bytes, _>(std::io::Error::other(
            "connection reset",
        ))]);
        let output = collect_responses_stream(stream).await;

        assert!(output.contains("response.failed"));
        assert!(output.contains("connection reset"));
    }

    #[tokio::test]
    async fn ignores_transport_error_after_native_terminal_event() {
        let stream = futures_util::stream::iter(vec![
            Ok(Bytes::from_static(
                b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{}}\n\n",
            )),
            Err(std::io::Error::other("late connection reset")),
        ]);
        let output = collect_responses_stream(stream).await;

        assert!(output.contains("response.completed"));
        assert!(!output.contains("response.failed"));
        assert!(!output.contains("late connection reset"));
    }

    #[test]
    fn registration_is_stable_and_updates_upstream_for_a_task() {
        let initial = LocalModelProxyUpstream {
            base_url: "https://luna.example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "luna-secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-luna".to_owned()),
            routing_model_id: Some("wework-gpt-5.6-luna".to_owned()),
            max_output_tokens: None,
        };
        let token = register("stable-task-route", initial);
        let original_history = registry()
            .lock()
            .expect("registry lock")
            .routes
            .get(&token)
            .expect("task route")
            .history
            .clone();
        let updated = LocalModelProxyUpstream {
            base_url: "https://sol.example.com".to_owned(),
            request_url: Some("https://sol.example.com/v1/responses".to_owned()),
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "sol-secret".to_owned(),
            default_headers: vec![("x-route".to_owned(), "sol".to_owned())],
            proxy_url: None,
            model_id: Some("gpt-5.6-sol".to_owned()),
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };
        let repeated_token = register("stable-task-route", updated.clone());

        assert_eq!(repeated_token, token);
        {
            let entries = registry().lock().expect("registry lock");
            let route = entries.routes.get(&token).expect("updated task route");
            assert_eq!(route.upstream.base_url, updated.base_url);
            assert_eq!(route.upstream.api_key, updated.api_key);
            assert_eq!(route.upstream.model_id, updated.model_id);
            assert!(std::sync::Arc::ptr_eq(&route.history, &original_history));
        }

        unregister(&token);
        assert!(registry()
            .lock()
            .expect("registry lock")
            .routes
            .contains_key(&token));

        unregister(&token);

        {
            let mut entries = registry().lock().expect("registry lock");
            let entry = entries
                .routes
                .get_mut(&token)
                .expect("idle registration retained");
            assert_eq!(entry.active_references, 0);
            entry.last_used = Instant::now() - REGISTRY_IDLE_TTL - Duration::from_secs(1);
            prune_registry(&mut entries);
            assert!(!entries.routes.contains_key(&token));
        }

        let resumed_token = register("stable-task-route", updated);
        assert_eq!(resumed_token, token);
        unregister(&resumed_token);
    }

    #[test]
    fn task_routes_use_distinct_stable_tokens() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("gpt-5.6-sol".to_owned()),
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };
        let task_a = register("stable-random-token-task-a", upstream.clone());
        let repeated_task_a = register("stable-random-token-task-a", upstream.clone());
        let task_b = register("stable-random-token-task-b", upstream);

        assert_eq!(repeated_task_a, task_a);
        assert_ne!(task_a, task_b);
        assert!(!task_a.contains("stable-random-token-task-a"));

        unregister(&task_a);
        unregister(&repeated_task_a);
        unregister(&task_b);
    }

    #[test]
    fn model_switch_cleanup_is_consumed_once_per_routed_model_change() {
        let marker_body = br#"{
            "model":"stale-codex-model",
            "input":[{
                "type":"message",
                "role":"developer",
                "content":[{
                    "type":"input_text",
                    "text":"<model_switch>Use the selected model.</model_switch>"
                }]
            }]
        }"#;
        let token = register(
            "model-switch-consumed-once",
            LocalModelProxyUpstream {
                base_url: "https://luna.example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "luna-secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("gpt-5.6-luna".to_owned()),
                routing_model_id: Some("wework-gpt-5.6-luna".to_owned()),
                max_output_tokens: None,
            },
        );
        {
            let entries = registry().lock().expect("registry lock");
            let route = entries.routes.get(&token).expect("task route");
            let routing = begin_model_request(route, marker_body);
            assert!(!routing.model_switched);
            assert_eq!(
                routing.model_to_commit.as_deref(),
                Some("wework-gpt-5.6-luna")
            );
        }
        commit_model_request(
            &token,
            &ModelRequestRouting {
                model_switched: false,
                model_to_commit: Some("wework-gpt-5.6-luna".to_owned()),
                clear_pending_model_switch: false,
            },
        );
        let repeated_token = register(
            "model-switch-consumed-once",
            LocalModelProxyUpstream {
                base_url: "https://sol.example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "sol-secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("gpt-5.6-sol".to_owned()),
                routing_model_id: Some("gpt-5.6-sol".to_owned()),
                max_output_tokens: None,
            },
        );
        assert_eq!(repeated_token, token);
        {
            let entries = registry().lock().expect("registry lock");
            let route = entries.routes.get(&token).expect("updated task route");
            let routing = begin_model_request(route, marker_body);
            assert!(routing.model_switched);
            assert_eq!(routing.model_to_commit.as_deref(), Some("gpt-5.6-sol"));
            assert!(begin_model_request(route, marker_body).model_switched);
        }
        commit_model_request(
            &token,
            &ModelRequestRouting {
                model_switched: true,
                model_to_commit: Some("gpt-5.6-sol".to_owned()),
                clear_pending_model_switch: false,
            },
        );
        {
            let entries = registry().lock().expect("registry lock");
            let route = entries.routes.get(&token).expect("updated task route");
            assert!(!begin_model_request(route, marker_body).model_switched);
        }

        unregister(&token);
        unregister(&repeated_token);
    }

    #[test]
    fn task_route_recognizes_the_model_selected_for_that_task() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("upstream-sol".to_owned()),
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };

        assert_eq!(
            stale_requested_model(&upstream, br#"{"model":"gpt-5.6-sol"}"#),
            None
        );
    }

    #[test]
    fn task_route_detects_but_does_not_select_by_a_stale_requested_model() {
        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some("upstream-sol".to_owned()),
            routing_model_id: Some("gpt-5.6-sol".to_owned()),
            max_output_tokens: None,
        };

        assert_eq!(
            stale_requested_model(&upstream, br#"{"model":"gpt-5.6-luna"}"#),
            Some(("gpt-5.6-luna".to_owned(), "gpt-5.6-sol".to_owned()))
        );
    }

    #[test]
    fn task_route_only_accepts_bound_threads_and_their_children() {
        let token = register(
            "thread-bound-task-route",
            LocalModelProxyUpstream {
                base_url: "https://example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: Some("gpt-5.6-sol".to_owned()),
                max_output_tokens: None,
            },
        );
        bind_thread(&token, "thread-root").expect("root thread should bind");
        let mut entries = registry().lock().expect("registry lock");
        let route = entries.routes.get_mut(&token).expect("task route");

        authorize_task_thread(route, br#"{"client_metadata":{"thread_id":"thread-root"}}"#)
            .expect("bound root should be accepted");
        authorize_task_thread(
            route,
            br#"{"client_metadata":{"thread_id":"thread-child","x-codex-turn-metadata":"{\"parent_thread_id\":\"thread-root\"}"}}"#,
        )
        .expect("child of a bound root should be accepted");
        assert!(route.thread_ids.contains("thread-child"));

        let error = authorize_task_thread(
            route,
            br#"{"client_metadata":{"thread_id":"thread-unrelated"}}"#,
        )
        .expect_err("unrelated thread must not use the task route");
        assert_eq!(error.status, StatusCode::CONFLICT);

        drop(entries);
        unregister(&token);
    }

    #[test]
    fn generic_route_resolves_the_task_from_the_bound_codex_thread() {
        let token = register(
            "generic-bound-thread-task-route",
            LocalModelProxyUpstream {
                base_url: "https://example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: Some("gpt-5.6-luna".to_owned()),
                max_output_tokens: None,
            },
        );
        bind_thread(&token, "generic-bound-thread-root").expect("root thread should bind");

        assert_eq!(
            bound_thread_token(br#"{"client_metadata":{"thread_id":"generic-bound-thread-root"}}"#)
                .expect("bound root should resolve"),
            token
        );
        assert_eq!(
            bound_thread_token(
                br#"{"client_metadata":{"thread_id":"generic-bound-thread-child","parent_thread_id":"generic-bound-thread-root"}}"#
            )
            .expect("child of bound root should resolve"),
            token
        );

        unregister(&token);
    }

    #[test]
    fn generic_route_rejects_unbound_and_ambiguous_codex_threads() {
        let unbound_error =
            bound_thread_token(br#"{"client_metadata":{"thread_id":"generic-unbound-thread"}}"#)
                .expect_err("unbound thread must not resolve");
        assert_eq!(unbound_error.status, StatusCode::NOT_FOUND);

        let upstream = LocalModelProxyUpstream {
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            convert_custom_tools: false,
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: Some("gpt-5.6-luna".to_owned()),
            max_output_tokens: None,
        };
        let first = register("generic-ambiguous-thread-task-a", upstream.clone());
        let second = register("generic-ambiguous-thread-task-b", upstream);
        bind_thread(&first, "generic-ambiguous-thread").expect("first route should bind");
        bind_thread(&second, "generic-ambiguous-thread").expect("second route should bind");

        let ambiguous_error =
            bound_thread_token(br#"{"client_metadata":{"thread_id":"generic-ambiguous-thread"}}"#)
                .expect_err("ambiguous thread must not resolve");
        assert_eq!(ambiguous_error.status, StatusCode::CONFLICT);

        unregister(&first);
        unregister(&second);
    }

    #[test]
    fn task_route_rejects_missing_thread_metadata_after_binding() {
        let token = register(
            "missing-thread-metadata-task-route",
            LocalModelProxyUpstream {
                base_url: "https://example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: Some("gpt-5.6-sol".to_owned()),
                max_output_tokens: None,
            },
        );
        bind_thread(&token, "thread-root").expect("root thread should bind");
        let mut entries = registry().lock().expect("registry lock");
        let route = entries.routes.get_mut(&token).expect("task route");

        let error = authorize_task_thread(route, br#"{"model":"gpt-5.6-sol"}"#)
            .expect_err("bound task route requires thread metadata");
        assert_eq!(error.status, StatusCode::CONFLICT);

        drop(entries);
        unregister(&token);
    }

    #[test]
    fn rewrites_internal_catalog_model_to_real_upstream_model() {
        let body = serde_json::to_vec(&json!({
            "model": "wework-custom-user-model",
            "input": "hello"
        }))
        .expect("request body");

        let rewritten = rewrite_request_model(&body, "k3").expect("rewritten request");
        let request: Value = serde_json::from_slice(&rewritten).expect("request JSON");

        assert_eq!(request["model"], "k3");
        assert_eq!(request["input"], "hello");
    }

    #[tokio::test]
    async fn preserves_non_success_status_and_body() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/chat/completions",
                    post(|| async {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error": {"message": "tools are unsupported"}})),
                        )
                    }),
                ),
            )
            .await
            .expect("upstream server");
        });
        let token = register(
            "non-success-test",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/chat/completions")),
                api_format: "openai-chat-completions".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
        );

        let response = handle(
            headers,
            Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
        )
        .await
        .expect("proxy response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        assert!(String::from_utf8_lossy(&body).contains("tools are unsupported"));

        unregister(&token);
        server.abort();
    }

    #[tokio::test]
    async fn retries_rate_limited_model_requests_until_success() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn({
            let request_count = request_count.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/chat/completions",
                        post(move || {
                            let request_count = request_count.clone();
                            async move {
                                if request_count.fetch_add(1, Ordering::SeqCst) < 2 {
                                    return (
                                        StatusCode::TOO_MANY_REQUESTS,
                                        [(header::RETRY_AFTER, "0")],
                                        Json(json!({"error": {"message": "rate limited"}})),
                                    );
                                }
                                (
                                    StatusCode::OK,
                                    [(header::RETRY_AFTER, "0")],
                                    Json(json!({"choices": [{"message": {"content": "hi"}}]})),
                                )
                            }
                        }),
                    ),
                )
                .await
                .expect("upstream server");
            }
        });
        let token = register(
            "rate-limit-retry-success",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/chat/completions")),
                api_format: "openai-chat-completions".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );

        let response = handle(
            proxy_headers(&token),
            Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
        )
        .await
        .expect("proxy response");

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(request_count.load(Ordering::SeqCst), 3);

        unregister(&token);
        server.abort();
    }

    #[tokio::test]
    async fn returns_last_rate_limit_response_after_retry_budget_is_exhausted() {
        let request_count = Arc::new(AtomicUsize::new(0));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn({
            let request_count = request_count.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/responses",
                        post(move || {
                            request_count.fetch_add(1, Ordering::SeqCst);
                            async {
                                (
                                    StatusCode::TOO_MANY_REQUESTS,
                                    [(header::RETRY_AFTER, "0")],
                                    Json(json!({"error": {"message": "still rate limited"}})),
                                )
                            }
                        }),
                    ),
                )
                .await
                .expect("upstream server");
            }
        });
        let token = register(
            "rate-limit-retry-exhausted",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/responses")),
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );

        let response = handle(
            proxy_headers(&token),
            Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
        )
        .await
        .expect("proxy response");

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            request_count.load(Ordering::SeqCst),
            (MAX_RATE_LIMIT_RETRIES + 1) as usize
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        assert!(String::from_utf8_lossy(&body).contains("still rate limited"));

        unregister(&token);
        server.abort();
    }

    #[tokio::test]
    async fn failed_model_switch_remains_pending_for_retry() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/responses",
                    post(|| async {
                        (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error": {"message": "request rejected"}})),
                        )
                    }),
                ),
            )
            .await
            .expect("upstream server");
        });
        let token = register(
            "failed-model-switch",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/responses")),
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("gpt-5.6-luna".to_owned()),
                routing_model_id: Some("gpt-5.6-luna".to_owned()),
                max_output_tokens: None,
            },
        );
        {
            let mut entries = registry().lock().expect("registry lock");
            entries
                .routes
                .get_mut(&token)
                .expect("task route")
                .last_routed_model = Some("gpt-5.6-luna".to_owned());
        }
        let repeated_token = register(
            "failed-model-switch",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/responses")),
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some("gpt-5.6-sol".to_owned()),
                routing_model_id: Some("gpt-5.6-sol".to_owned()),
                max_output_tokens: None,
            },
        );
        assert_eq!(repeated_token, token);
        let body = serde_json::to_vec(&json!({
            "model": "stale-codex-model",
            "previous_response_id": "resp_luna",
            "input": [
                {
                    "type": "reasoning",
                    "summary": [],
                    "encrypted_content": "encrypted-luna-state"
                },
                {
                    "type": "message",
                    "role": "developer",
                    "content": [{
                        "type": "input_text",
                        "text": "<model_switch>Use the selected model.</model_switch>"
                    }]
                }
            ]
        }))
        .expect("request body");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
        );

        let response = handle(headers, Bytes::from(body.clone()))
            .await
            .expect("upstream rejection should be preserved");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        {
            let entries = registry().lock().expect("registry lock");
            let route = entries.routes.get(&token).expect("task route");
            assert_eq!(route.last_routed_model.as_deref(), Some("gpt-5.6-luna"));
            assert!(begin_model_request(route, &body).model_switched);
        }

        unregister(&token);
        unregister(&repeated_token);
        server.abort();
    }

    #[tokio::test]
    async fn converts_successful_non_sse_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/chat/completions",
                    post(|| async { Json(json!({"choices": [{"message": {"content": "hi"}}]})) }),
                ),
            )
            .await
            .expect("upstream server");
        });
        let token = register(
            "non-sse-test",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/chat/completions")),
                api_format: "openai-chat-completions".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
        );

        let response = handle(
            headers,
            Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
        )
        .await
        .expect("non-SSE JSON should be converted");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/event-stream"))
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("converted response body");
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("response.output_text.delta"));
        assert!(body.contains("response.completed"));

        unregister(&token);
        server.abort();
    }

    #[tokio::test]
    async fn chat_completion_bridge_preserves_mixed_assistant_tool_turns_end_to_end() {
        let (request_tx, request_rx) = oneshot::channel();
        let request_tx = Arc::new(Mutex::new(Some(request_tx)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn({
            let request_tx = request_tx.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/chat/completions",
                        post(move |Json(body): Json<Value>| {
                            let request_tx = request_tx.clone();
                            async move {
                                request_tx
                                    .lock()
                                    .expect("request sender")
                                    .take()
                                    .expect("single request")
                                    .send(body)
                                    .expect("request receiver");
                                (
                                    [(
                                        header::CONTENT_TYPE,
                                        HeaderValue::from_static("text/event-stream"),
                                    )],
                                    concat!(
                                        "data: {\"id\":\"chatcmpl-e2e\",\"model\":\"kimi-k3\",\"choices\":[{\"delta\":{\"content\":\"I will inspect it.\"},\"finish_reason\":null}]}\n\n",
                                        "data: {\"id\":\"chatcmpl-e2e\",\"model\":\"kimi-k3\",\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_next\",\"type\":\"function\",\"function\":{\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
                                        "data: [DONE]\n\n"
                                    ),
                                )
                            }
                        }),
                    ),
                )
                .await
                .expect("upstream server");
            }
        });
        let token = register(
            "chat-mixed-turn-e2e",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/chat/completions")),
                api_format: "openai-chat-completions".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );
        let response = handle(
            proxy_headers(&token),
            Bytes::from(serde_json::to_vec(&mixed_tool_turn_request()).expect("request body")),
        )
        .await
        .expect("proxy response");
        let response_body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let upstream_request = request_rx.await.expect("captured upstream request");
        let messages = upstream_request["messages"].as_array().expect("messages");
        let assistant = messages
            .iter()
            .find(|message| {
                message.get("role").and_then(Value::as_str) == Some("assistant")
                    && message.get("content").and_then(Value::as_str) == Some("I will inspect it.")
            })
            .expect("assistant tool turn");

        assert_eq!(
            assistant["tool_calls"][0]["function"]["name"],
            "exec_command"
        );
        assert!(!messages
            .windows(2)
            .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
        let response_body = String::from_utf8_lossy(&response_body);
        assert!(response_body.contains("response.output_text.delta"));
        assert!(response_body.contains("\"type\":\"function_call\""));
        assert!(response_body.contains("\"name\":\"exec_command\""));

        unregister(&token);
        server.abort();
    }

    #[tokio::test]
    async fn anthropic_messages_bridge_preserves_mixed_assistant_tool_turns_end_to_end() {
        let (request_tx, request_rx) = oneshot::channel();
        let request_tx = Arc::new(Mutex::new(Some(request_tx)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn({
            let request_tx = request_tx.clone();
            async move {
                axum::serve(
                    listener,
                    Router::new().route(
                        "/messages",
                        post(move |Json(body): Json<Value>| {
                            let request_tx = request_tx.clone();
                            async move {
                                request_tx
                                    .lock()
                                    .expect("request sender")
                                    .take()
                                    .expect("single request")
                                    .send(body)
                                    .expect("request receiver");
                                (
                                    [(
                                        header::CONTENT_TYPE,
                                        HeaderValue::from_static("text/event-stream"),
                                    )],
                                    concat!(
                                        "event: message_start\n",
                                        "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_e2e\",\"model\":\"kimi-k3\",\"usage\":{\"input_tokens\":10}}}\n\n",
                                        "event: content_block_start\n",
                                        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                                        "event: content_block_delta\n",
                                        "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"I will inspect it.\"}}\n\n",
                                        "event: content_block_stop\n",
                                        "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                                        "event: content_block_start\n",
                                        "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_next\",\"name\":\"exec_command\",\"input\":{}}}\n\n",
                                        "event: content_block_delta\n",
                                        "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}}\n\n",
                                        "event: content_block_stop\n",
                                        "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                                        "event: message_delta\n",
                                        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":8}}\n\n",
                                        "event: message_stop\n",
                                        "data: {\"type\":\"message_stop\"}\n\n"
                                    ),
                                )
                            }
                        }),
                    ),
                )
                .await
                .expect("upstream server");
            }
        });
        let token = register(
            "anthropic-mixed-turn-e2e",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/messages")),
                api_format: "anthropic-messages".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );
        let response = handle(
            proxy_headers(&token),
            Bytes::from(serde_json::to_vec(&mixed_tool_turn_request()).expect("request body")),
        )
        .await
        .expect("proxy response");
        let response_body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        let upstream_request = request_rx.await.expect("captured upstream request");
        let messages = upstream_request["messages"].as_array().expect("messages");
        let assistant = messages
            .iter()
            .find(|message| {
                message.get("role").and_then(Value::as_str) == Some("assistant")
                    && message
                        .get("content")
                        .and_then(Value::as_array)
                        .is_some_and(|content| {
                            content.iter().any(|block| {
                                block.get("type").and_then(Value::as_str) == Some("text")
                                    && block.get("text").and_then(Value::as_str)
                                        == Some("I will inspect it.")
                            })
                        })
            })
            .expect("assistant tool turn");
        let content = assistant["content"].as_array().expect("assistant content");

        assert!(content
            .iter()
            .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use")));
        assert!(!messages
            .windows(2)
            .any(|pair| pair[0]["role"] == "assistant" && pair[1]["role"] == "assistant"));
        let response_body = String::from_utf8_lossy(&response_body);
        assert!(response_body.contains("response.output_text.delta"));
        assert!(response_body.contains("\"type\":\"function_call\""));
        assert!(response_body.contains("\"name\":\"exec_command\""));

        unregister(&token);
        server.abort();
    }

    fn proxy_headers(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
        );
        headers
    }

    fn mixed_tool_turn_request() -> Value {
        json!({
            "model": "kimi-k3",
            "stream": true,
            "input": [
                {"role": "user", "content": [{"type": "input_text", "text": "Inspect it"}]},
                {"role": "assistant", "content": [{"type": "output_text", "text": "I will inspect it."}]},
                {"type": "function_call", "call_id": "call_previous", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
                {"type": "function_call_output", "call_id": "call_previous", "output": "/workspace"},
                {"role": "user", "content": [{"type": "input_text", "text": "Continue"}]}
            ],
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {
                    "type": "object",
                    "properties": {"cmd": {"type": "string"}},
                    "required": ["cmd"]
                }
            }]
        })
    }

    #[tokio::test]
    async fn wraps_native_responses_non_sse_response() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().route(
                    "/responses",
                    post(|| async {
                        Json(json!({
                            "id": "resp_non_sse",
                            "object": "response",
                            "status": "completed",
                            "output": [{
                                "type": "message",
                                "role": "assistant",
                                "content": [{"type": "output_text", "text": "hi"}]
                            }],
                            "usage": {
                                "input_tokens": 1,
                                "output_tokens": 1,
                                "input_tokens_details": {},
                                "output_tokens_details": {}
                            }
                        }))
                    }),
                ),
            )
            .await
            .expect("upstream server");
        });
        let token = register(
            "native-non-sse-test",
            LocalModelProxyUpstream {
                base_url: format!("http://{address}"),
                request_url: Some(format!("http://{address}/responses")),
                api_format: "openai-responses".to_owned(),
                convert_custom_tools: false,
                api_key: "secret".to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
                max_output_tokens: None,
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}")).expect("authorization"),
        );

        let response = handle(
            headers,
            Bytes::from_static(br#"{"model":"m","input":"hi","stream":true}"#),
        )
        .await
        .expect("native non-SSE JSON should be wrapped");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static("text/event-stream"))
        );
        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("wrapped response body");
        let body = String::from_utf8_lossy(&body);
        assert!(body.contains("event: response.completed"));
        assert!(body.contains("resp_non_sse"));
        assert!(body.contains("input_tokens_details"), "{body}");

        unregister(&token);
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires an external model and Codex binary"]
    async fn external_model_completes_a_codex_tool_loop() {
        let base_url =
            env::var("WEWORK_TEST_MODEL_BASE_URL").expect("WEWORK_TEST_MODEL_BASE_URL is required");
        let api_key =
            env::var("WEWORK_TEST_MODEL_API_KEY").expect("WEWORK_TEST_MODEL_API_KEY is required");
        let model_id = env::var("WEWORK_TEST_MODEL_ID").expect("WEWORK_TEST_MODEL_ID is required");
        let api_format = env::var("WEWORK_TEST_MODEL_API_FORMAT")
            .unwrap_or_else(|_| "openai-chat-completions".to_owned());
        let default_path = if api_format == "anthropic-messages" {
            "/v1/messages"
        } else {
            "/chat/completions"
        };
        let request_url = format!("{}{default_path}", base_url.trim_end_matches('/'));
        let token = register(
            "external-model-test",
            LocalModelProxyUpstream {
                base_url,
                request_url: Some(request_url),
                api_format,
                convert_custom_tools: false,
                api_key,
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: Some(model_id.clone()),
                routing_model_id: None,
                max_output_tokens: None,
            },
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("test proxy should bind");
        let address = listener
            .local_addr()
            .expect("test proxy address should exist");
        let server = tokio::spawn(async move {
            axum::serve(listener, Router::new().route(ROUTE, post(handle)))
                .await
                .expect("test proxy should serve");
        });
        let workspace = tempfile::tempdir().expect("temporary workspace should exist");
        let codex_home = workspace.path().join("codex-home");
        fs::create_dir_all(&codex_home).expect("Codex home should be created");
        fs::write(workspace.path().join("README.md"), "# Verification\n")
            .expect("seed file should be written");

        let output = tokio::process::Command::new("codex")
            .current_dir(workspace.path())
            .env("CODEX_HOME", &codex_home)
            .args([
                "exec",
                "--skip-git-repo-check",
                "--dangerously-bypass-approvals-and-sandbox",
                "-m",
                &model_id,
                "-c",
                "model_provider=\"verification\"",
                "-c",
                "model_providers.verification.name=\"Wework verification\"",
                "-c",
                &format!(
                    "model_providers.verification.base_url=\"http://{address}/v1/codex-responses-proxy\""
                ),
                "-c",
                "model_providers.verification.wire_api=\"responses\"",
                "-c",
                &format!(
                    "model_providers.verification.experimental_bearer_token=\"{token}\""
                ),
                "Use apply_patch to create verification.txt containing exactly WEWORK_MODEL_TOOL_OK, then read the file and reply with exactly complete.",
            ])
            .output()
            .await
            .expect("Codex should run");
        server.abort();

        assert!(
            output.status.success(),
            "Codex failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("verification.txt"))
                .expect("verification file should exist")
                .trim(),
            "WEWORK_MODEL_TOOL_OK"
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("complete"));
    }

    #[test]
    fn rewrite_responses_event_adds_namespace_to_browser_calls() {
        let event = concat!(
            "event: response.output_item.added\n",
            "data: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"browser_navigate\",\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}"
        );
        let expanded = HashSet::from(["browser_navigate".to_owned()]);

        let rewritten = rewrite_responses_event(event, &expanded);
        let data = rewritten
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .expect("rewritten event should contain data");
        let value = serde_json::from_str::<Value>(data).unwrap();

        assert_eq!(value["item"]["namespace"], "wework_browser");
        assert_eq!(value["item"]["name"], "browser_navigate");
    }

    #[test]
    fn rewrite_responses_event_leaves_non_browser_calls_unchanged() {
        let event =
            "data: {\"type\":\"function_call\",\"name\":\"exec_command\",\"arguments\":\"{}\"}";
        let expanded = HashSet::from(["browser_navigate".to_owned()]);

        assert_eq!(rewrite_responses_event(event, &expanded), event);
    }

    #[test]
    fn rewrite_responses_event_combines_with_completed_usage_normalization() {
        let event = concat!(
            "event: response.completed\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\",\"output\":[{\"type\":\"function_call\",\"name\":\"browser_snapshot\",\"arguments\":\"{}\"}],\"usage\":{\"input_tokens\":1,\"input_tokens_details\":{},\"output_tokens\":2,\"output_tokens_details\":{},\"total_tokens\":3}}}"
        );
        let expanded = HashSet::from(["browser_snapshot".to_owned()]);

        let normalized = if expanded.is_empty() {
            normalize_responses_event(event)
        } else {
            let rewritten = rewrite_responses_event(event, &expanded);
            normalize_responses_event(&rewritten)
        };
        let data = normalized
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .expect("normalized event should contain data");
        let value = serde_json::from_str::<Value>(data).unwrap();

        assert_eq!(
            value["response"]["output"][0]["namespace"],
            "wework_browser"
        );
        assert_eq!(
            value["response"]["usage"]["input_tokens_details"]["cached_tokens"],
            json!(0)
        );
        assert_eq!(
            value["response"]["usage"]["output_tokens_details"]["reasoning_tokens"],
            json!(0)
        );
    }
}
