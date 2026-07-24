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
mod history;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    hash::{DefaultHasher, Hash, Hasher},
    pin::Pin,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
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

use crate::logging::log_executor_event;

use super::{codex_responses_proxy_transform, HttpError};

pub(crate) const ROUTE: &str = "/v1/codex-router/{token}/responses";
const MAX_REQUEST_BODY_BYTES: usize = 64 * 1024 * 1024;

pub(crate) fn route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    post(handle_routed).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

#[derive(Debug, Clone)]
pub(crate) struct LocalModelProxyUpstream {
    pub registration_id: String,
    pub base_url: String,
    pub request_url: Option<String>,
    pub api_format: String,
    pub api_key: String,
    pub default_headers: Vec<(String, String)>,
    pub proxy_url: Option<String>,
    pub model_id: Option<String>,
    pub routing_model_id: Option<String>,
}

#[derive(Debug, Clone)]
struct RegisteredUpstream {
    upstream: LocalModelProxyUpstream,
    history: std::sync::Arc<history::CodexToolHistory>,
    last_used: Instant,
    active_references: usize,
}

const REGISTRY_IDLE_TTL: Duration = Duration::from_secs(60 * 60);

pub(crate) fn register(upstream: LocalModelProxyUpstream) -> String {
    let token = registration_token(&upstream);
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    prune_registry(&mut registry);
    let active_references = registry
        .get(&token)
        .map_or(1, |registered| registered.active_references + 1);
    let history = registry
        .get(&token)
        .map(|registered| registered.history.clone())
        .unwrap_or_default();
    registry.insert(
        token.clone(),
        RegisteredUpstream {
            upstream,
            history,
            last_used: Instant::now(),
            active_references,
        },
    );
    log_executor_event(
        "local model proxy registered",
        &[
            ("active_registrations", registry.len().to_string()),
            ("active_references", active_references.to_string()),
        ],
    );
    token
}

pub(crate) fn unregister(token: &str) {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let (retained_idle, active_references) = match registry.get_mut(token) {
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
            ("active_registrations", registry.len().to_string()),
        ],
    );
}

fn registration_token(upstream: &LocalModelProxyUpstream) -> String {
    let mut hasher = DefaultHasher::new();
    std::process::id().hash(&mut hasher);
    upstream.registration_id.hash(&mut hasher);
    upstream.base_url.hash(&mut hasher);
    upstream.request_url.hash(&mut hasher);
    upstream.api_format.hash(&mut hasher);
    upstream.api_key.hash(&mut hasher);
    upstream.default_headers.hash(&mut hasher);
    upstream.proxy_url.hash(&mut hasher);
    upstream.model_id.hash(&mut hasher);
    upstream.routing_model_id.hash(&mut hasher);
    format!("model-{}-{:016x}", std::process::id(), hasher.finish())
}

fn prune_registry(registry: &mut HashMap<String, RegisteredUpstream>) {
    let before = registry.len();
    registry.retain(|_, entry| {
        entry.active_references > 0 || entry.last_used.elapsed() < REGISTRY_IDLE_TTL
    });
    let removed = before.saturating_sub(registry.len());
    if removed > 0 {
        log_executor_event(
            "local model proxy registrations expired",
            &[
                ("removed", removed.to_string()),
                ("active_registrations", registry.len().to_string()),
            ],
        );
    }
}

fn registry() -> &'static Mutex<HashMap<String, RegisteredUpstream>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, RegisteredUpstream>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
pub(super) async fn handle(headers: HeaderMap, body: Bytes) -> Result<Response, HttpError> {
    let token = local_token(&headers).ok_or_else(|| HttpError {
        status: StatusCode::UNAUTHORIZED,
        detail: "missing local model proxy token".to_owned(),
    })?;
    handle_for_token(token, headers, body).await
}

pub(super) async fn handle_routed(
    Path(token): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    handle_for_token(token, headers, body).await
}

async fn handle_for_token(
    token: String,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, HttpError> {
    let request_started_at = Instant::now();
    let (upstream, history) = {
        let mut registry = registry()
            .lock()
            .expect("local model proxy registry should not be poisoned");
        prune_registry(&mut registry);
        let original = registry.get(&token).ok_or_else(|| HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "unknown or expired local model proxy token".to_owned(),
        })?;
        let selected_token = requested_model(&body)
            .as_deref()
            .and_then(|model| matching_route_token(&registry, original, model))
            .unwrap_or(&token)
            .clone();
        let registered = registry
            .get_mut(&selected_token)
            .expect("selected local model proxy route should remain registered");
        registered.last_used = Instant::now();
        (registered.upstream.clone(), registered.history.clone())
    };
    let request_url = upstream
        .request_url
        .clone()
        .unwrap_or_else(|| format!("{}/responses", upstream.base_url.trim_end_matches('/')));
    let request_body = match upstream.model_id.as_deref() {
        Some(model_id) => rewrite_request_model(&body, model_id)?,
        None => body.to_vec(),
    };
    let (request_body, conversion, expanded_browser_tools) =
        prepare_request_with_history(&upstream.api_format, &request_body, history.as_ref()).await?;
    log_executor_event(
        "local model proxy request started",
        &[
            ("api_format", upstream.api_format.clone()),
            ("upstream", safe_url(&request_url)),
            ("body_bytes", request_body.len().to_string()),
            (
                "expanded_browser_tools",
                expanded_browser_tools.len().to_string(),
            ),
        ],
    );

    let client = proxy_client(upstream.proxy_url.as_deref())?;
    let mut request = client
        .post(request_url)
        .bearer_auth(&upstream.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .body(request_body);
    if upstream.api_format == "anthropic-messages" {
        request = request
            .header("x-api-key", upstream.api_key)
            .header("anthropic-version", "2023-06-01");
    }
    if let Some(user_agent) = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
    {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
    for (key, value) in upstream.default_headers {
        request = request.header(key, value);
    }

    let upstream_response = request.send().await.map_err(|error| HttpError {
        status: StatusCode::BAD_GATEWAY,
        detail: format!("Local model proxy request failed: {error}"),
    })?;
    let status = upstream_response.status();
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

fn matching_route_token<'a>(
    registry: &'a HashMap<String, RegisteredUpstream>,
    original: &RegisteredUpstream,
    requested_model: &str,
) -> Option<&'a String> {
    registry
        .iter()
        .filter(|(_, candidate)| {
            candidate.upstream.base_url == original.upstream.base_url
                && candidate.upstream.api_key == original.upstream.api_key
                && candidate.upstream.routing_model_id.as_deref() == Some(requested_model)
        })
        .max_by_key(|(_, candidate)| (candidate.active_references > 0, candidate.last_used))
        .map(|(token, _)| token)
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
        return prepare_request(api_format, &body);
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
    prepare_request(api_format, &enriched)
}

#[allow(clippy::type_complexity)]
fn prepare_request(
    api_format: &str,
    body: &[u8],
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    if api_format == "openai-responses" {
        let request_value = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: format!("Invalid Codex Responses request: {error}"),
        })?;
        let (mut request_value, context) =
            chat::responses_to_responses(&request_value).map_err(|error| HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: format!("Failed to convert local model request: {error}"),
            })?;
        let expanded_browser_tools =
            codex_responses_proxy_transform::expand_wework_browser_namespace_tools(
                &mut request_value,
            );
        let body = serde_json::to_vec(&request_value).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to serialize local model request: {error}"),
        })?;
        return Ok((
            body,
            Some(Conversion::Responses(context)),
            expanded_browser_tools,
        ));
    }
    let responses_body = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let (converted, context) = match api_format {
        "openai-chat-completions" => chat::responses_to_chat(&responses_body)
            .map(|(body, context)| (body, Conversion::Chat(context))),
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

#[derive(Debug)]
enum Conversion {
    Chat(chat::ToolContext),
    Anthropic(chat::ToolContext),
    Responses(chat::ToolContext),
}

#[cfg(test)]
fn local_token(headers: &HeaderMap) -> Option<String> {
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
        return Ok(reqwest::Client::new());
    };
    reqwest::Client::builder()
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
                    state.pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(event) = take_sse_block(&mut state.pending) {
                        state.terminal_seen |= is_responses_terminal_event(&event);
                        let normalized = if state.expanded_browser_tools.is_empty() {
                            normalize_responses_event(&event)
                        } else {
                            let rewritten =
                                rewrite_responses_event(&event, &state.expanded_browser_tools);
                            normalize_responses_event(&rewritten)
                        };
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
                    if !state.pending.trim().is_empty() {
                        let trailing = std::mem::take(&mut state.pending);
                        let trailing = trailing.trim_end();
                        state.terminal_seen |= is_responses_terminal_event(trailing);
                        state.output.push_back(Ok(Bytes::from(format!(
                            "{}\n\n",
                            normalize_responses_event(trailing)
                        ))));
                    }
                }
            }
        }
    })
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
    use std::{env, fs};

    use axum::{body::to_bytes, routing::post, Json, Router};
    use serde_json::json;

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
    fn rejects_invalid_chat_request() {
        let error = prepare_request("openai-chat-completions", b"not-json")
            .expect_err("invalid JSON should fail");
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn proxy_client_rejects_invalid_url() {
        assert!(proxy_client(Some("not a proxy url")).is_err());
    }

    #[test]
    fn leaves_non_completed_events_unchanged() {
        let event = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}";
        assert_eq!(normalize_responses_event(event), event);
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
    fn registration_is_stable_and_reference_counted_for_persistent_threads() {
        let upstream = LocalModelProxyUpstream {
            registration_id: "unregister-test".to_owned(),
            base_url: "https://example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
        };
        let token = register(upstream.clone());
        let repeated_token = register(upstream.clone());
        assert_eq!(repeated_token, token);
        assert!(registry()
            .lock()
            .expect("registry lock")
            .contains_key(&token));

        unregister(&token);
        assert!(registry()
            .lock()
            .expect("registry lock")
            .contains_key(&token));

        unregister(&token);

        {
            let mut entries = registry().lock().expect("registry lock");
            let entry = entries.get_mut(&token).expect("idle registration retained");
            assert_eq!(entry.active_references, 0);
            entry.last_used = Instant::now() - REGISTRY_IDLE_TTL - Duration::from_secs(1);
            prune_registry(&mut entries);
            assert!(!entries.contains_key(&token));
        }

        let resumed_token = register(upstream);
        assert_eq!(resumed_token, token);
        unregister(&resumed_token);
    }

    #[test]
    fn registration_token_changes_when_the_upstream_changes() {
        let upstream = LocalModelProxyUpstream {
            registration_id: "upstream-change-test".to_owned(),
            base_url: "https://one.example.com".to_owned(),
            request_url: None,
            api_format: "openai-responses".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
        };
        let first = registration_token(&upstream);
        let mut changed = upstream;
        changed.base_url = "https://two.example.com".to_owned();

        assert_ne!(registration_token(&changed), first);
    }

    #[test]
    fn selects_the_requested_model_route_within_the_same_credential_scope() {
        let original = registered_upstream("source", "shared-secret");
        let mut target = registered_upstream("target", "shared-secret");
        target.upstream.routing_model_id = Some("target-model".to_owned());
        let registry = HashMap::from([
            ("source-token".to_owned(), original),
            ("target-token".to_owned(), target),
        ]);

        let selected = matching_route_token(
            &registry,
            registry.get("source-token").expect("source route"),
            "target-model",
        );

        assert_eq!(selected.map(String::as_str), Some("target-token"));
    }

    #[test]
    fn does_not_route_a_model_request_across_credentials() {
        let original = registered_upstream("source", "source-secret");
        let mut target = registered_upstream("target", "other-user-secret");
        target.upstream.routing_model_id = Some("target-model".to_owned());
        let registry = HashMap::from([
            ("source-token".to_owned(), original),
            ("target-token".to_owned(), target),
        ]);

        let selected = matching_route_token(
            &registry,
            registry.get("source-token").expect("source route"),
            "target-model",
        );

        assert!(selected.is_none());
    }

    fn registered_upstream(registration_id: &str, api_key: &str) -> RegisteredUpstream {
        RegisteredUpstream {
            upstream: LocalModelProxyUpstream {
                registration_id: registration_id.to_owned(),
                base_url: "https://shared.example.com".to_owned(),
                request_url: None,
                api_format: "openai-responses".to_owned(),
                api_key: api_key.to_owned(),
                default_headers: Vec::new(),
                proxy_url: None,
                model_id: None,
                routing_model_id: None,
            },
            history: Default::default(),
            last_used: Instant::now(),
            active_references: 1,
        }
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
        let token = register(LocalModelProxyUpstream {
            registration_id: "non-success-test".to_owned(),
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
        });
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
        let token = register(LocalModelProxyUpstream {
            registration_id: "non-sse-test".to_owned(),
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/chat/completions")),
            api_format: "openai-chat-completions".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
        });
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
        let token = register(LocalModelProxyUpstream {
            registration_id: "native-non-sse-test".to_owned(),
            base_url: format!("http://{address}"),
            request_url: Some(format!("http://{address}/responses")),
            api_format: "openai-responses".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: None,
            routing_model_id: None,
        });
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
        let token = register(LocalModelProxyUpstream {
            registration_id: "external-model-test".to_owned(),
            base_url,
            request_url: Some(request_url),
            api_format,
            api_key,
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: Some(model_id.clone()),
            routing_model_id: None,
        });
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
