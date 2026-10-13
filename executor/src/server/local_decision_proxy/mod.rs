// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Executor-owned configuration for the Wework decision router.
//!
//! The decision upstream and the model catalogue are trusted Executor
//! configuration. A Smart App may read the catalogue from `GET .../status` and
//! name any model in a request, but it can never move the upstream or see a
//! credential.
//!
//! The upstream credential is not configured; it is traded at request time. The
//! Executor sends the current Wework login token to the Wegent backend and
//! receives the Wecode model API key the decision upstream accepts, and keeps
//! it in memory only.

mod model_key;
mod protocol;
mod registry;

pub(crate) use protocol::{
    DecisionModel, DecisionProxyErrorBody, DecisionProxyErrorPayload, DecisionRequest,
    DecisionStatusResponse, DECISION_PROXY_PROTOCOL_VERSION,
};
#[cfg(test)]
pub(crate) use registry::lookup as lookup_route;
pub(crate) use registry::{register, unregister};

use std::{
    env, fmt,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::{DefaultBodyLimit, FromRef, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use url::Url;

use crate::{logging::log_executor_event, server::AppState};

/// Local placeholder marker used by every Wework built-in local proxy route.
///
/// It travels as `Authorization: Bearer <value>` and is a protocol marker, not
/// a security boundary: the opaque route token in the URL is the capability.
pub(crate) const LOCAL_AUTHORIZATION_VALUE: &str = "wework-local-router";

/// Upstream path that decision requests are always forwarded to.
pub(crate) const UPSTREAM_PATH: &str = "/v1/decisions";

const ENV_UPSTREAM_URL: &str = "WEWORK_DECISION_PROXY_UPSTREAM_URL";
const ENV_DEFAULT_MODEL: &str = "WEWORK_DECISION_PROXY_DEFAULT_MODEL";

/// Parsed, validated decision proxy configuration.
///
/// The router has no on/off switch: its routes are always mounted, so the only
/// two states are "this deployment supplied a usable upstream" and "it did
/// not". Unconfigured and configured are different shapes rather than one
/// struct with an optional upstream, so handlers cannot fall back to a
/// half-configured upstream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DecisionProxyConfig {
    Unconfigured,
    Enabled(DecisionProxySettings),
}

/// Trusted settings once a deployment has supplied a usable upstream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DecisionProxySettings {
    pub upstream_url: Url,
    pub default_model: String,
    pub models: Vec<DecisionModel>,
}

/// Static, client-safe reason for a rejected configuration.
///
/// The reason never echoes an environment value, so log lines and error
/// messages cannot leak the upstream URL or a credential embedded in it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DecisionProxyConfigError {
    reason: &'static str,
}

impl DecisionProxyConfigError {
    const fn new(reason: &'static str) -> Self {
        Self { reason }
    }

    pub(crate) const fn reason(self) -> &'static str {
        self.reason
    }
}

impl fmt::Display for DecisionProxyConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid decision proxy configuration: {}",
            self.reason
        )
    }
}

impl std::error::Error for DecisionProxyConfigError {}

impl DecisionProxyConfig {
    /// Reads the configuration from the Executor process environment.
    pub(crate) fn from_env() -> Result<Self, DecisionProxyConfigError> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    /// Registered settings, or `None` while the deployment has no usable upstream.
    pub(crate) fn settings(&self) -> Option<&DecisionProxySettings> {
        match self {
            Self::Unconfigured => None,
            Self::Enabled(settings) => Some(settings),
        }
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, DecisionProxyConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let upstream = lookup(ENV_UPSTREAM_URL)
            .ok_or_else(|| DecisionProxyConfigError::new("missing_upstream_url"))?;
        let upstream_url = parse_upstream_url(&upstream)?;

        let default_model = lookup(ENV_DEFAULT_MODEL)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DecisionProxyConfigError::new("missing_default_model"))?;

        // There is no model allowlist: whatever model name the deployment
        // configured is the one the router advertises and forwards verbatim.
        let models = vec![DecisionModel {
            id: default_model.clone(),
            display_name: default_model.clone(),
        }];

        Ok(Self::Enabled(DecisionProxySettings {
            upstream_url,
            default_model,
            models,
        }))
    }
}

/// Logs the startup summary. Tokens, the upstream URL, and the model catalogue
/// contents stay out of the log.
pub(crate) fn log_config_summary(config: &DecisionProxyConfig) {
    match config {
        DecisionProxyConfig::Unconfigured => log_executor_event(
            "decision_proxy.config",
            &[("configured", "false".to_owned())],
        ),
        DecisionProxyConfig::Enabled(settings) => log_executor_event(
            "decision_proxy.config",
            &[
                ("configured", "true".to_owned()),
                ("default_model", settings.default_model.clone()),
                ("upstream_host", safe_url(&settings.upstream_url)),
            ],
        ),
    }
}

/// Resolves the startup configuration.
///
/// The routes stay mounted either way. An operator mistake must not turn the
/// Executor into an open upstream proxy, but it must not make the route
/// disappear either, so an unusable configuration is reported and answered
/// with a static error by the handlers.
pub(crate) fn config_from_env_or_unconfigured() -> Arc<DecisionProxyConfig> {
    match DecisionProxyConfig::from_env() {
        Ok(config) => {
            log_config_summary(&config);
            Arc::new(config)
        }
        Err(error) => {
            log_executor_event(
                "decision_proxy.config_rejected",
                &[("reason", error.reason().to_owned())],
            );
            Arc::new(DecisionProxyConfig::Unconfigured)
        }
    }
}

/// Validates the deployment-supplied decision upstream.
///
/// The host is not pinned in code: the deployment owns the upstream address and
/// the repository must not carry an internal hostname. What is enforced here is
/// the shape a decision endpoint must have, so a mis-edited value cannot turn
/// the route into a proxy for an arbitrary path or an insecure scheme.
fn parse_upstream_url(raw: &str) -> Result<Url, DecisionProxyConfigError> {
    let invalid = || DecisionProxyConfigError::new("invalid_upstream_url");
    let url = Url::parse(raw.trim()).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != UPSTREAM_PATH
    {
        return Err(invalid());
    }
    Ok(url)
}

/// Renders `scheme://host[:port]/path` so log lines never carry credentials,
/// query parameters, or fragments.
fn safe_url(url: &Url) -> String {
    let host = url.host_str().unwrap_or("<invalid-host>");
    match url.port() {
        Some(port) => format!("{}://{}:{}{}", url.scheme(), host, port, url.path()),
        None => format!("{}://{}{}", url.scheme(), host, url.path()),
    }
}

/// Maximum accepted request body size (§12.2).
pub(crate) const MAX_REQUEST_BYTES: usize = 1024 * 1024;
/// Maximum number of questions accepted in a single request (§12.4).
pub(crate) const MAX_QUESTIONS: usize = 20;
/// Upstream timeout. The client keeps a 35s budget so it sees our 504 (§13.2).
pub(crate) const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);
/// Longest accepted `model` value (§8.4).
const MAX_MODEL_LENGTH: usize = 128;
/// Top-level response fields that may reach the Smart App (§29.2).
const ALLOWED_RESPONSE_FIELDS: [&str; 5] =
    ["model", "request_id", "answers", "usage", "latency_ms"];

/// `GET` route for the model catalogue.
pub(crate) const STATUS_ROUTE: &str = "/v1/decision-router/{token}/status";
/// `POST` route for decision requests.
pub(crate) const DECISIONS_ROUTE: &str = "/v1/decision-router/{token}/v1/decisions";

/// Process-lifetime resources shared by every decision request.
///
/// The HTTP state is rebuilt per request, so anything stateful has to live
/// here: the pooled upstream client and the exchanged-credential cache.
pub(crate) struct DecisionProxyRuntime {
    model_key: model_key::ModelKeyExchanger,
    client: reqwest::Client,
}

impl DecisionProxyRuntime {
    pub(crate) fn new() -> Self {
        Self {
            model_key: model_key::ModelKeyExchanger::new(),
            // One pooled client for the whole process, so decision requests and
            // 401 retries reuse the upstream connection instead of opening a new
            // TCP and TLS session each time.
            client: reqwest::Client::new(),
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

/// State shared by the decision routes.
///
/// The configuration comes from Executor-controlled input, never from the
/// Smart App registration call.
#[derive(Clone)]
pub(crate) struct DecisionProxyState {
    config: Arc<DecisionProxyConfig>,
    runtime: Arc<DecisionProxyRuntime>,
    timeout: Duration,
}

impl DecisionProxyState {
    /// The runtime is passed in because the traded key must stay cached, and the
    /// client must stay pooled, for the whole process: a state rebuilt per
    /// request would drop both.
    pub(crate) fn new(
        config: Arc<DecisionProxyConfig>,
        runtime: Arc<DecisionProxyRuntime>,
    ) -> Self {
        Self {
            config,
            runtime,
            timeout: UPSTREAM_TIMEOUT,
        }
    }
}

impl<R> FromRef<AppState<R>> for DecisionProxyState {
    fn from_ref(state: &AppState<R>) -> Self {
        Self::new(
            Arc::clone(&state.decision_proxy),
            Arc::clone(&state.decision_runtime),
        )
    }
}

/// Decision routes, merged into the main Executor router.
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
    if !has_local_marker(&headers) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "invalid_local_authorization",
            "invalid local authorization",
            false,
            new_request_id(),
        );
    }
    let Some(settings) = state.config.settings() else {
        return router_unconfigured();
    };
    if registry::lookup(&token).is_none() {
        return route_not_found();
    }
    (
        StatusCode::OK,
        [(header::CACHE_CONTROL, "no-store")],
        Json(DecisionStatusResponse {
            protocol_version: DECISION_PROXY_PROTOCOL_VERSION,
            default_model: settings.default_model.clone(),
            models: settings.models.clone(),
        }),
    )
        .into_response()
}

async fn handle_decisions(
    State(state): State<DecisionProxyState>,
    Path(token): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    let request_id = new_request_id();
    if !has_local_marker(&headers) {
        return error_response(
            StatusCode::UNAUTHORIZED,
            "invalid_local_authorization",
            "invalid local authorization",
            false,
            request_id,
        );
    }
    let Some(settings) = state.config.settings() else {
        return router_unconfigured();
    };
    let Some(route) = registry::lookup(&token) else {
        return route_not_found();
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
        Err(error) => {
            return if error.to_string().contains("unknown field") {
                error_response(
                    StatusCode::BAD_REQUEST,
                    "unsupported_field",
                    "request contains unsupported fields",
                    false,
                    request_id,
                )
            } else {
                error_response(
                    StatusCode::BAD_REQUEST,
                    "invalid_request",
                    "request body is not a valid decision request",
                    false,
                    request_id,
                )
            };
        }
    };
    if let Some(response) = validate_request(&request, &request_id) {
        return response;
    }
    let started = Instant::now();
    let response = forward_with_credential(&state, settings, &request, &request_id, &route).await;
    log_request(&request_id, &route, &request, response.status(), started);
    response
}

/// Forwards one request, trading the login token for the upstream credential
/// first.
///
/// A key the upstream rejects is dropped and traded once more: a key can be
/// revoked or rotated server-side while it is still cached locally.
async fn forward_with_credential(
    state: &DecisionProxyState,
    settings: &DecisionProxySettings,
    request: &DecisionRequest,
    request_id: &str,
    route: &registry::DecisionRouteHandle,
) -> Response {
    let Some(credential) = resolve_credential(state, route).await else {
        return credential_unavailable(request_id);
    };
    let (response, rejected) =
        forward_to_upstream(state, settings, request, credential, request_id).await;
    if !rejected {
        return response;
    }
    state.runtime.model_key.invalidate().await;
    let Some(credential) = resolve_credential(state, route).await else {
        return response;
    };
    let (retried, _) = forward_to_upstream(state, settings, request, credential, request_id).await;
    retried
}

fn credential_unavailable(request_id: &str) -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "credential_unavailable",
        "decision credential is currently unavailable",
        true,
        request_id.to_owned(),
    )
}

/// Shape checks the proxy owns: model identifier shape, `state` presence, and
/// `questions`. The model name itself is forwarded verbatim; the router keeps
/// no allowlist. `Some` carries the response to send when the request must be
/// rejected.
fn validate_request(request: &DecisionRequest, request_id: &str) -> Option<Response> {
    let model = request.model.trim();
    if !is_valid_model(model) {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "invalid_model",
            "model must be a non-empty model identifier",
            false,
            request_id.to_owned(),
        ));
    }
    if request.state.is_null() {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "state must be present and must not be null",
            false,
            request_id.to_owned(),
        ));
    }
    let valid_questions = request.questions.as_object().is_some_and(|questions| {
        !questions.is_empty()
            && questions.len() <= MAX_QUESTIONS
            && questions.keys().all(|key| !key.trim().is_empty())
    });
    if !valid_questions {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "questions must be a non-empty object within the limit",
            false,
            request_id.to_owned(),
        ));
    }
    None
}

/// Reads the login state for this request without holding the registry lock.
///
/// The snapshot guard is dropped before the exchange awaits, because holding a
/// `std` mutex guard across an await point would make the handler future
/// non-`Send`.
async fn resolve_credential(
    state: &DecisionProxyState,
    route: &registry::DecisionRouteHandle,
) -> Option<String> {
    let (backend_url, login_token) = {
        let snapshot = route.snapshot();
        let guard = snapshot.lock().ok()?;
        let connection = guard.as_ref()?;
        (
            connection.backend_url.trim().to_owned(),
            connection.auth_token.trim().to_owned(),
        )
    };
    state
        .runtime
        .model_key
        .key_for(&backend_url, &login_token)
        .await
}

/// Sends one request upstream.
///
/// The second element of the tuple is `true` only when the upstream answered
/// `401`: the credential was rejected, so the caller may trade a fresh key and
/// retry once. Everything else is final.
async fn forward_to_upstream(
    state: &DecisionProxyState,
    settings: &DecisionProxySettings,
    request: &DecisionRequest,
    credential: String,
    request_id: &str,
) -> (Response, bool) {
    let payload = json!({
        "model": request.model.trim(),
        "state": request.state,
        "questions": request.questions,
    });
    // Only Executor-chosen headers travel upstream: no cookie, origin,
    // referer, forwarded, or client-supplied authorization.
    let outcome = state
        .runtime
        .client
        .post(settings.upstream_url.as_str())
        .timeout(state.timeout)
        .header(header::AUTHORIZATION, format!("Bearer {credential}"))
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCEPT, "application/json")
        .header("x-request-id", request_id)
        .json(&payload)
        .send()
        .await;

    let response = match outcome {
        Err(error) if error.is_timeout() => (
            error_response(
                StatusCode::GATEWAY_TIMEOUT,
                "upstream_timeout",
                "decision upstream timed out",
                true,
                request_id.to_owned(),
            ),
            false,
        ),
        Err(_) => (
            error_response(
                StatusCode::BAD_GATEWAY,
                "upstream_rejected",
                "decision upstream is unavailable",
                true,
                request_id.to_owned(),
            ),
            false,
        ),
        Ok(response) if response.status() == StatusCode::UNAUTHORIZED => (
            error_response(
                StatusCode::BAD_GATEWAY,
                "upstream_rejected",
                "decision upstream rejected the credential",
                false,
                request_id.to_owned(),
            ),
            true,
        ),
        Ok(response) => (
            match upstream_response_body(response, request_id).await {
                Ok(Some(body)) => (StatusCode::OK, Json(body)).into_response(),
                Ok(None) => error_response(
                    StatusCode::BAD_GATEWAY,
                    "upstream_invalid_response",
                    "decision upstream response is unusable",
                    false,
                    request_id.to_owned(),
                ),
                Err(response) => *response,
            },
            false,
        ),
    };
    response
}

/// `Ok(Some(body))` for a usable success, `Ok(None)` for an unusable success,
/// `Err(response)` when the upstream status alone decides the outcome.
///
/// The error is boxed because `Response` is large and this `Result` is not on a
/// hot path: clippy rejects an unboxed `Err` variant of that size.
async fn upstream_response_body(
    response: reqwest::Response,
    request_id: &str,
) -> Result<Option<Value>, Box<Response>> {
    let status = response.status();
    if status.as_u16() == 429 {
        return Err(Box::new(error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "upstream_rate_limited",
            "decision upstream is rate limited",
            true,
            request_id.to_owned(),
        )));
    }
    if status.is_server_error() {
        return Err(Box::new(error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "decision upstream is unavailable",
            true,
            request_id.to_owned(),
        )));
    }
    if !status.is_success() {
        return Err(Box::new(error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "decision upstream rejected the request",
            false,
            request_id.to_owned(),
        )));
    }
    let Ok(value) = response.json::<Value>().await else {
        return Ok(None);
    };
    let Some(object) = value.as_object() else {
        return Ok(None);
    };
    if object.get("model").is_some_and(|model| !model.is_string()) {
        return Ok(None);
    }
    let filtered = ALLOWED_RESPONSE_FIELDS
        .iter()
        .filter_map(|field| {
            object
                .get(*field)
                .map(|value| ((*field).to_owned(), value.clone()))
        })
        .collect::<Map<String, Value>>();
    Ok(Some(Value::Object(filtered)))
}

fn log_request(
    request_id: &str,
    route: &registry::DecisionRouteHandle,
    request: &DecisionRequest,
    status: StatusCode,
    started: Instant,
) {
    let question_count = request
        .questions
        .as_object()
        .map_or(0, serde_json::Map::len);
    log_executor_event(
        "local decision proxy request",
        &[
            ("request_id", request_id.to_owned()),
            ("route_scope_hash", registry::scope_hash(&route.scope)),
            ("model", request.model.trim().to_owned()),
            ("question_count", question_count.to_string()),
            ("status", status.as_u16().to_string()),
            ("latency_ms", started.elapsed().as_millis().to_string()),
        ],
    );
}

fn has_local_marker(headers: &HeaderMap) -> bool {
    bearer_token(headers).as_deref() == Some(LOCAL_AUTHORIZATION_VALUE)
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())?
        .trim();
    let mut parts = value.split_whitespace();
    if parts.next()?.eq_ignore_ascii_case("Bearer") {
        parts.next().map(str::to_owned)
    } else {
        None
    }
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
    let mut bytes = [0_u8; 8];
    let _ = getrandom::fill(&mut bytes);
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("local_req_{suffix}")
}

/// Answers when the deployment has no usable upstream configuration.
///
/// The wire code stays `decision_router_disabled` for the Smart App client
/// contract; the router itself no longer has an on/off switch.
fn router_unconfigured() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "decision_router_disabled",
        "decision router is not configured",
        false,
        new_request_id(),
    )
}

fn route_not_found() -> Response {
    error_response(
        StatusCode::NOT_FOUND,
        "route_not_found",
        "decision route is not available",
        false,
        new_request_id(),
    )
}

fn error_response(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    retryable: bool,
    request_id: String,
) -> Response {
    let body = DecisionProxyErrorBody {
        error: DecisionProxyErrorPayload {
            code,
            message,
            retryable,
            request_id,
        },
    };
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod http_tests;
