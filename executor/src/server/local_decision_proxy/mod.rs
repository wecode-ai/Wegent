// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Capability-scoped access to Wegent's authorized decision Model catalog.
//! Provider addresses, credentials and protocol conversion live in the backend.

mod protocol;
mod registry;

pub(crate) use protocol::{
    DecisionProxyErrorBody, DecisionProxyErrorPayload, DecisionRequest, DecisionStatusResponse,
    DECISION_PROXY_PROTOCOL_VERSION,
};
#[cfg(test)]
pub(crate) use registry::lookup as lookup_route;
pub(crate) use registry::{register, unregister};

use std::{fmt, sync::Arc, time::Duration};

use axum::{
    extract::{DefaultBodyLimit, FromRef, Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use url::Url;

use crate::{logging::log_executor_event, server::AppState};

pub(crate) const LOCAL_AUTHORIZATION_VALUE: &str = "wework-local-router";
pub(crate) const MAX_REQUEST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_QUESTIONS: usize = 20;
pub(crate) const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(35);
pub(crate) const STATUS_ROUTE: &str = "/v1/decision-router/{token}/status";
pub(crate) const DECISIONS_ROUTE: &str = "/v1/decision-router/{token}/v1/decisions";
const MAX_MODEL_LENGTH: usize = 128;
const BACKEND_PATH: &str = "/models/decisions";
const ALLOWED_RESPONSE_FIELDS: [&str; 5] =
    ["model", "request_id", "answers", "usage", "latency_ms"];

pub(crate) struct DecisionProxyRuntime {
    client: reqwest::Client,
}

impl DecisionProxyRuntime {
    pub(crate) fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("decision backend HTTP client"),
        }
    }
}

impl fmt::Debug for DecisionProxyRuntime {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DecisionProxyRuntime")
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub(crate) struct DecisionProxyState {
    runtime: Arc<DecisionProxyRuntime>,
    timeout: Duration,
}

impl DecisionProxyState {
    pub(crate) fn new(runtime: Arc<DecisionProxyRuntime>) -> Self {
        Self {
            runtime,
            timeout: UPSTREAM_TIMEOUT,
        }
    }
}

impl<R> FromRef<AppState<R>> for DecisionProxyState {
    fn from_ref(state: &AppState<R>) -> Self {
        Self::new(Arc::clone(&state.decision_runtime))
    }
}

pub(crate) fn routes<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    DecisionProxyState: FromRef<S>,
{
    Router::new().route(STATUS_ROUTE, get(handle_status)).route(
        DECISIONS_ROUTE,
        post(handle_decisions).layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES)),
    )
}

async fn handle_status(
    State(state): State<DecisionProxyState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    let request_id = new_request_id();
    let route = match authorized_route(&token, &headers, &request_id) {
        Ok(route) => route,
        Err(response) => return *response,
    };
    forward_to_backend(&state, &route, Method::GET, None, &request_id).await
}

async fn handle_decisions(
    State(state): State<DecisionProxyState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    let route = match authorized_route(&token, &headers, &request_id) {
        Ok(route) => route,
        Err(response) => return *response,
    };
    if !content_type_is_json(&headers) {
        return error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "invalid_content_type",
            "content type must be application/json",
            false,
            request_id,
        );
    }
    let request = match serde_json::from_slice::<DecisionRequest>(&body) {
        Ok(request) => request,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "request body is not a valid decision request",
                false,
                request_id,
            )
        }
    };
    if !is_valid_model(&request.model) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_model",
            "model must be a catalog model identifier",
            false,
            request_id,
        );
    }
    if !(request.state.is_string() || request.state.is_object() || request.state.is_array())
        || !request.questions.as_object().is_some_and(|questions| {
            !questions.is_empty()
                && questions.len() <= MAX_QUESTIONS
                && questions.keys().all(|key| !key.trim().is_empty())
        })
    {
        return error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "state and questions must be a valid decision request",
            false,
            request_id,
        );
    }
    let response = forward_to_backend(
        &state,
        &route,
        Method::POST,
        Some(
            json!({"model": request.model, "state": request.state, "questions": request.questions}),
        ),
        &request_id,
    )
    .await;
    log_executor_event(
        "decision_proxy.request",
        &[
            ("request_id", request_id),
            ("route_scope_hash", registry::scope_hash(&route.scope)),
            ("model", request.model),
            ("status", response.status().as_u16().to_string()),
        ],
    );
    response
}

fn authorized_route(
    token: &str,
    headers: &HeaderMap,
    request_id: &str,
) -> Result<registry::DecisionRouteHandle, Box<Response>> {
    if !has_local_marker(headers) {
        return Err(Box::new(error_response(
            StatusCode::UNAUTHORIZED,
            "invalid_local_authorization",
            "invalid local authorization",
            false,
            request_id.to_owned(),
        )));
    }
    registry::lookup(token).ok_or_else(|| {
        Box::new(error_response(
            StatusCode::NOT_FOUND,
            "route_not_found",
            "decision route is not available",
            false,
            request_id.to_owned(),
        ))
    })
}

fn backend_connection(route: &registry::DecisionRouteHandle) -> Option<(Url, String)> {
    let snapshot = route.snapshot();
    let guard = snapshot.lock().ok()?;
    let connection = guard.as_ref()?;
    let login_token = connection.auth_token.trim();
    if login_token.is_empty() {
        return None;
    }
    Some((
        backend_url(&connection.backend_url)?,
        login_token.to_owned(),
    ))
}

fn backend_url(base: &str) -> Option<Url> {
    let mut url = Url::parse(base.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    let api_path = if path.ends_with("/api") {
        path.to_owned()
    } else {
        format!("{path}/api")
    };
    url.set_path(&format!("{api_path}{BACKEND_PATH}"));
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

async fn forward_to_backend(
    state: &DecisionProxyState,
    route: &registry::DecisionRouteHandle,
    method: Method,
    payload: Option<Value>,
    request_id: &str,
) -> Response {
    let Some((url, token)) = backend_connection(route) else {
        return credential_unavailable(request_id);
    };
    let mut request = state
        .runtime
        .client
        .request(method, url)
        .bearer_auth(token)
        .timeout(state.timeout)
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", request_id);
    let is_status = payload.is_none();
    if let Some(payload) = payload {
        request = request.json(&payload);
    }
    match request.send().await {
        Ok(response) => backend_response(response, is_status, request_id).await,
        Err(error) if error.is_timeout() => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "upstream_timeout",
            "decision backend timed out",
            true,
            request_id.to_owned(),
        ),
        Err(_) => error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "decision backend is unavailable",
            true,
            request_id.to_owned(),
        ),
    }
}

async fn backend_response(
    mut response: reqwest::Response,
    is_status: bool,
    request_id: &str,
) -> Response {
    let status = response.status();
    if matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN) {
        return credential_unavailable(request_id);
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_REQUEST_BYTES => {
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            _ => return invalid_response(request_id),
        }
    }
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return invalid_response(request_id);
    };
    if !status.is_success() {
        return backend_error(status, &value, request_id);
    }
    if is_status {
        let Ok(catalog) = serde_json::from_value::<DecisionStatusResponse>(value) else {
            return invalid_response(request_id);
        };
        if catalog.protocol_version != DECISION_PROXY_PROTOCOL_VERSION
            || catalog.models.iter().any(|model| {
                !is_valid_model(&model.id)
                    || !matches!(model.protocol.as_str(), "systemone" | "openai")
                    || !matches!(model.model_type.as_str(), "public" | "user" | "group")
            })
            || catalog
                .models
                .iter()
                .map(|model| &model.id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                != catalog.models.len()
            || (!catalog.default_model.is_empty()
                && !catalog
                    .models
                    .iter()
                    .any(|model| model.id == catalog.default_model))
            || (catalog.default_model.is_empty() && !catalog.models.is_empty())
        {
            return invalid_response(request_id);
        }
        return ([(header::CACHE_CONTROL, "no-store")], Json(catalog)).into_response();
    }
    let Some(object) = value.as_object() else {
        return invalid_response(request_id);
    };
    if !object.get("answers").is_some_and(Value::is_object) {
        return invalid_response(request_id);
    }
    let filtered = ALLOWED_RESPONSE_FIELDS
        .iter()
        .filter_map(|field| {
            object
                .get(*field)
                .map(|value| ((*field).to_owned(), value.clone()))
        })
        .collect::<serde_json::Map<String, Value>>();
    ([(header::CACHE_CONTROL, "no-store")], Json(filtered)).into_response()
}

fn backend_error(status: StatusCode, value: &Value, request_id: &str) -> Response {
    let (code, message, retryable) = match value["error"]["code"].as_str() {
        Some("model_not_found") => ("model_not_found", "decision model is not available", false),
        Some("invalid_model_config") => (
            "invalid_model_config",
            "decision model configuration is unusable",
            false,
        ),
        Some("invalid_request") => ("invalid_request", "invalid decision request", false),
        Some("upstream_rate_limited") => (
            "upstream_rate_limited",
            "decision upstream is rate limited",
            true,
        ),
        Some("upstream_timeout") => ("upstream_timeout", "decision upstream timed out", true),
        Some("upstream_invalid_response") => (
            "upstream_invalid_response",
            "decision upstream response is unusable",
            false,
        ),
        _ => (
            "upstream_rejected",
            "decision backend rejected the request",
            status.is_server_error(),
        ),
    };
    error_response(status, code, message, retryable, request_id.to_owned())
}

fn credential_unavailable(request_id: &str) -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "credential_unavailable",
        "decision login is currently unavailable",
        true,
        request_id.to_owned(),
    )
}

fn invalid_response(request_id: &str) -> Response {
    error_response(
        StatusCode::BAD_GATEWAY,
        "upstream_invalid_response",
        "decision backend response is unusable",
        false,
        request_id.to_owned(),
    )
}

fn has_local_marker(headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let mut parts = value.split_whitespace();
    parts
        .next()
        .is_some_and(|part| part.eq_ignore_ascii_case("Bearer"))
        && parts.next() == Some(LOCAL_AUTHORIZATION_VALUE)
        && parts.next().is_none()
}

fn content_type_is_json(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
}

fn is_valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= MAX_MODEL_LENGTH
        && model.chars().all(|value| {
            value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-' | '/' | ':')
        })
}

fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn error_response(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    retryable: bool,
    request_id: String,
) -> Response {
    (
        status,
        Json(DecisionProxyErrorBody {
            error: DecisionProxyErrorPayload {
                code,
                message,
                retryable,
                request_id,
            },
        }),
    )
        .into_response()
}

#[cfg(test)]
mod http_tests;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
