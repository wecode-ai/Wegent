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

pub(crate) use model_key::ModelKeyExchanger;
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

/// State shared by the decision routes.
///
/// The configuration comes from Executor-controlled input, never from the
/// Smart App registration call.
#[derive(Clone)]
pub(crate) struct DecisionProxyState {
    config: Arc<DecisionProxyConfig>,
    model_key: Arc<model_key::ModelKeyExchanger>,
    timeout: Duration,
}

impl DecisionProxyState {
    /// The exchanger is passed in because the traded key must stay cached for
    /// the whole process: a state rebuilt per request would trade the login
    /// token again on every decision request.
    pub(crate) fn new(config: Arc<DecisionProxyConfig>, model_key: Arc<ModelKeyExchanger>) -> Self {
        Self {
            config,
            model_key,
            timeout: UPSTREAM_TIMEOUT,
        }
    }
}

impl<R> FromRef<AppState<R>> for DecisionProxyState {
    fn from_ref(state: &AppState<R>) -> Self {
        Self::new(
            Arc::clone(&state.decision_proxy),
            Arc::clone(&state.decision_model_key),
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
    state.model_key.invalidate().await;
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
    state.model_key.key_for(&backend_url, &login_token).await
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
    let client = match reqwest::Client::builder().timeout(state.timeout).build() {
        Ok(client) => client,
        Err(_) => {
            return (
                error_response(
                    StatusCode::BAD_GATEWAY,
                    "upstream_invalid_response",
                    "decision upstream response is unusable",
                    false,
                    request_id.to_owned(),
                ),
                false,
            )
        }
    };
    // Only Executor-chosen headers travel upstream: no cookie, origin,
    // referer, forwarded, or client-supplied authorization.
    let outcome = client
        .post(settings.upstream_url.as_str())
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
                Err(response) => response,
            },
            false,
        ),
    };
    response
}

/// `Ok(Some(body))` for a usable success, `Ok(None)` for an unusable success,
/// `Err(response)` when the upstream status alone decides the outcome.
async fn upstream_response_body(
    response: reqwest::Response,
    request_id: &str,
) -> Result<Option<Value>, Response> {
    let status = response.status();
    if status.as_u16() == 429 {
        return Err(error_response(
            StatusCode::TOO_MANY_REQUESTS,
            "upstream_rate_limited",
            "decision upstream is rate limited",
            true,
            request_id.to_owned(),
        ));
    }
    if status.is_server_error() {
        return Err(error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "decision upstream is unavailable",
            true,
            request_id.to_owned(),
        ));
    }
    if !status.is_success() {
        return Err(error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "decision upstream rejected the request",
            false,
            request_id.to_owned(),
        ));
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
mod tests {
    use std::collections::HashMap;

    use super::*;

    const VALID_UPSTREAM: &str = "https://decision-upstream.example.com/v1/decisions";

    fn config_from(
        entries: &[(&str, &str)],
    ) -> Result<DecisionProxyConfig, DecisionProxyConfigError> {
        let map: HashMap<String, String> = entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        DecisionProxyConfig::from_lookup(|name| map.get(name).cloned())
    }

    fn enabled_settings(entries: &[(&str, &str)]) -> DecisionProxySettings {
        match config_from(entries).expect("config must be valid") {
            DecisionProxyConfig::Enabled(settings) => settings,
            DecisionProxyConfig::Unconfigured => panic!("expected a configured router"),
        }
    }

    fn upstream_entries(upstream: &str) -> [(&str, &str); 2] {
        [(ENV_UPSTREAM_URL, upstream), (ENV_DEFAULT_MODEL, "model-a")]
    }

    fn model_entries(default: &str) -> [(&str, &str); 2] {
        [
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, default),
        ]
    }

    #[test]
    fn empty_environment_is_unconfigured_rather_than_disabled() {
        let error = config_from(&[]).expect_err("upstream is required");
        assert_eq!(error.reason(), "missing_upstream_url");
    }

    #[test]
    fn enabled_without_upstream_is_invalid() {
        let error = config_from(&[(ENV_DEFAULT_MODEL, "model-a")])
            .expect_err("upstream is required when enabled");
        assert_eq!(error.reason(), "missing_upstream_url");
    }

    #[test]
    fn upstream_must_be_a_plain_https_decisions_url() {
        for upstream in [
            "http://decision-upstream.example.com/v1/decisions",
            "ftp://decision-upstream.example.com/v1/decisions",
            "https://user:secret@decision-upstream.example.com/v1/decisions",
            "https://decision-upstream.example.com/v1/decisions?x=1",
            "https://decision-upstream.example.com/v1/decisions#fragment",
            "https://decision-upstream.example.com/v1/decisions/",
            "https://decision-upstream.example.com/v1/other",
            "https://decision-upstream.example.com/",
            "not-a-url",
        ] {
            let error = config_from(&upstream_entries(upstream)).expect_err(upstream);
            assert_eq!(
                error.reason(),
                "invalid_upstream_url",
                "upstream={upstream}"
            );
        }
    }

    #[test]
    fn any_https_host_is_accepted_because_the_deployment_owns_the_upstream() {
        for upstream in [
            "https://decision-upstream.example.com/v1/decisions",
            "https://decisions-eu.example.net:8443/v1/decisions",
        ] {
            let settings = enabled_settings(&upstream_entries(upstream));
            assert_eq!(settings.upstream_url.as_str(), upstream);
        }
    }

    #[test]
    fn default_model_must_be_present_and_non_blank() {
        for default in ["", "   "] {
            let error = config_from(&model_entries(default)).expect_err("blank default model");
            assert_eq!(
                error.reason(),
                "missing_default_model",
                "default={default:?}"
            );
        }
        let error =
            config_from(&[(ENV_UPSTREAM_URL, VALID_UPSTREAM)]).expect_err("missing default model");
        assert_eq!(error.reason(), "missing_default_model");
    }

    #[test]
    fn valid_config_parses_into_stable_settings() {
        let entries = model_entries("model-a");
        let first = enabled_settings(&entries);
        let second = enabled_settings(&entries);
        assert_eq!(first, second);
        assert_eq!(first.upstream_url.as_str(), VALID_UPSTREAM);
        assert_eq!(first.default_model, "model-a");
        assert_eq!(
            first.models,
            vec![DecisionModel {
                id: "model-a".to_owned(),
                display_name: "model-a".to_owned(),
            }]
        );
    }

    #[test]
    fn config_error_display_never_leaks_the_upstream_value() {
        let error = config_from(&upstream_entries(
            "https://user:secret@decision-upstream.example.com/v1/decisions",
        ))
        .expect_err("invalid upstream");
        let text = error.to_string();
        assert!(!text.contains("secret"), "error leaked a value: {text}");
        assert!(
            !text.contains("decision-upstream.example.com"),
            "error leaked a value: {text}"
        );
    }

    #[test]
    fn safe_url_strips_credentials_query_and_fragment() {
        let url = url::Url::parse("https://user:secret@example.com:8443/v1/decisions?x=1#frag")
            .expect("parse url");
        let safe = safe_url(&url);
        assert_eq!(safe, "https://example.com:8443/v1/decisions");
        assert!(!safe.contains("secret"));
        assert!(!safe.contains("x=1"));
    }

    #[derive(Clone)]
    struct NoopRunner;

    impl crate::server::TaskRunner for NoopRunner {
        type SubmitFuture = std::future::Ready<crate::server::RunnerResult>;

        fn submit(&self, _request: crate::protocol::ExecutionRequest) -> Self::SubmitFuture {
            std::future::ready(crate::server::RunnerResult {
                status: crate::protocol::TaskStatus::Failed,
                message: Some("noop runner".to_owned()),
            })
        }
    }

    /// The served router extracts `DecisionProxyState` from `AppState` for every
    /// request. Building a fresh exchanger there would trade the login token on
    /// every decision request instead of reusing the cached credential.
    #[tokio::test]
    async fn every_request_shares_one_model_key_cache() {
        let state = crate::server::AppState::new(NoopRunner);
        let first: DecisionProxyState = FromRef::from_ref(&state);
        let second: DecisionProxyState = FromRef::from_ref(&state);
        assert!(
            Arc::ptr_eq(&first.model_key, &second.model_key),
            "each request must reuse the process-wide model key cache"
        );
    }
}

#[cfg(test)]
mod http_tests {
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use serde_json::{json, Value};
    use tower::ServiceExt;

    use super::*;
    use crate::config::device::ConnectionConfig;

    /// Credential the fake backend hands out, and what the fake upstream must see.
    const EXCHANGED_KEY: &str = "sk-wecode-test-key";
    /// Login token the routes carry in their connection snapshot.
    const LOGIN_TOKEN: &str = "weework-login-token";
    const EXCHANGE_PATH: &str = "/api/internal/apikey/wegent-model-key";
    const MAX_TEST_BODY_BYTES: usize = 4 * 1024 * 1024;

    #[derive(Clone, Default)]
    struct RecordedRequest {
        headers: Vec<(String, String)>,
        body: Value,
    }

    #[derive(Clone)]
    struct ScriptedResponse {
        status: u16,
        body: String,
        delay: Duration,
    }

    impl ScriptedResponse {
        fn json(status: u16, body: Value) -> Self {
            Self {
                status,
                body: body.to_string(),
                delay: Duration::ZERO,
            }
        }

        fn raw(status: u16, body: &str) -> Self {
            Self {
                status,
                body: body.to_owned(),
                delay: Duration::ZERO,
            }
        }
    }

    /// Response script: the last entry repeats, so one entry means "always".
    #[derive(Clone)]
    struct Script {
        responses: Vec<ScriptedResponse>,
    }

    impl From<ScriptedResponse> for Script {
        fn from(response: ScriptedResponse) -> Self {
            Self {
                responses: vec![response],
            }
        }
    }

    impl Script {
        fn sequence(responses: Vec<ScriptedResponse>) -> Self {
            assert!(
                !responses.is_empty(),
                "a script needs at least one response"
            );
            Self { responses }
        }

        fn at(&self, served: usize) -> ScriptedResponse {
            self.responses[served.min(self.responses.len() - 1)].clone()
        }
    }

    fn exchange_response(api_key: &str) -> ScriptedResponse {
        ScriptedResponse::json(200, json!({"api_key": api_key}))
    }

    struct UpstreamShared {
        requests: Mutex<Vec<RecordedRequest>>,
        script: Mutex<Script>,
        key_requests: Mutex<Vec<RecordedRequest>>,
        key_script: Mutex<Script>,
    }

    struct FakeUpstream {
        url: Url,
        /// Backend origin the route snapshot points at.
        backend_url: String,
        shared: Arc<UpstreamShared>,
    }

    impl FakeUpstream {
        fn requests(&self) -> Vec<RecordedRequest> {
            self.shared.requests.lock().expect("requests lock").clone()
        }

        fn only_request(&self) -> RecordedRequest {
            let requests = self.requests();
            assert_eq!(requests.len(), 1, "expected exactly one upstream call");
            requests.into_iter().next().expect("recorded request")
        }

        fn last_request(&self) -> RecordedRequest {
            self.requests()
                .into_iter()
                .next_back()
                .expect("recorded request")
        }

        fn header(&self, name: &str) -> Option<String> {
            self.last_request()
                .headers
                .into_iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value)
        }

        fn key_requests(&self) -> Vec<RecordedRequest> {
            self.shared
                .key_requests
                .lock()
                .expect("key requests lock")
                .clone()
        }

        fn last_key_authorization(&self) -> Option<String> {
            self.key_requests()
                .into_iter()
                .next_back()
                .and_then(|request| {
                    request
                        .headers
                        .into_iter()
                        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                        .map(|(_, value)| value)
                })
        }
    }

    async fn start_upstream(script: impl Into<Script>) -> FakeUpstream {
        start_backend(
            script.into(),
            Script::from(exchange_response(EXCHANGED_KEY)),
        )
        .await
    }

    async fn start_backend(script: Script, key_script: Script) -> FakeUpstream {
        let shared = Arc::new(UpstreamShared {
            requests: Mutex::new(Vec::new()),
            script: Mutex::new(script),
            key_requests: Mutex::new(Vec::new()),
            key_script: Mutex::new(key_script),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let router = Router::new()
            .route("/v1/decisions", post(fake_upstream))
            .route(EXCHANGE_PATH, post(fake_model_key))
            .with_state(Arc::clone(&shared));
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        FakeUpstream {
            url: Url::parse(&format!("http://{address}/v1/decisions")).expect("upstream url"),
            backend_url: format!("http://{address}"),
            shared,
        }
    }

    async fn fake_upstream(
        State(shared): State<Arc<UpstreamShared>>,
        headers: HeaderMap,
        body: axum::body::Bytes,
    ) -> Response {
        let served = record(&shared.requests, headers, || {
            serde_json::from_slice(&body).unwrap_or(Value::Null)
        });
        scripted_response(&shared.script, served).await
    }

    async fn fake_model_key(
        State(shared): State<Arc<UpstreamShared>>,
        headers: HeaderMap,
    ) -> Response {
        let served = record(&shared.key_requests, headers, Value::default);
        scripted_response(&shared.key_script, served).await
    }

    fn record(
        log: &Mutex<Vec<RecordedRequest>>,
        headers: HeaderMap,
        body: impl FnOnce() -> Value,
    ) -> usize {
        let mut entries = log.lock().expect("requests lock");
        entries.push(RecordedRequest {
            headers: headers
                .iter()
                .map(|(name, value)| {
                    (
                        name.as_str().to_owned(),
                        value.to_str().unwrap_or_default().to_owned(),
                    )
                })
                .collect(),
            body: body(),
        });
        entries.len() - 1
    }

    async fn scripted_response(script: &Mutex<Script>, served: usize) -> Response {
        let scripted = script.lock().expect("script lock").at(served);
        if !scripted.delay.is_zero() {
            tokio::time::sleep(scripted.delay).await;
        }
        (
            StatusCode::from_u16(scripted.status).expect("status"),
            [(header::CONTENT_TYPE, "application/json")],
            scripted.body,
        )
            .into_response()
    }

    fn settings(upstream: &Url) -> DecisionProxySettings {
        DecisionProxySettings {
            upstream_url: upstream.clone(),
            default_model: "model-a".to_owned(),
            models: vec![
                DecisionModel {
                    id: "model-a".to_owned(),
                    display_name: "Model A".to_owned(),
                },
                DecisionModel {
                    id: "model-b".to_owned(),
                    display_name: "model-b".to_owned(),
                },
            ],
        }
    }

    fn app(config: DecisionProxyConfig, timeout: Duration) -> Router {
        let mut state = DecisionProxyState::new(
            Arc::new(config),
            Arc::new(model_key::ModelKeyExchanger::new()),
        );
        state.timeout = timeout;
        routes::<DecisionProxyState>().with_state(state)
    }

    fn connection_snapshot(
        backend_url: &str,
        login_token: &str,
    ) -> Arc<Mutex<Option<ConnectionConfig>>> {
        Arc::new(Mutex::new(Some(ConnectionConfig {
            backend_url: backend_url.to_owned(),
            socket_url: String::new(),
            auth_token: login_token.to_owned(),
            runtime_auth_token: String::new(),
        })))
    }

    /// Registers a route bound to `upstream`'s fake backend and login token.
    fn register_route(upstream: &FakeUpstream, scope: &str) -> String {
        register(
            scope,
            connection_snapshot(&upstream.backend_url, LOGIN_TOKEN),
        )
    }

    fn enabled_app(upstream: &FakeUpstream) -> Router {
        app(
            DecisionProxyConfig::Enabled(settings(&upstream.url)),
            UPSTREAM_TIMEOUT,
        )
    }

    async fn send(app: Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = app.oneshot(request).await.expect("router response");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), MAX_TEST_BODY_BYTES)
            .await
            .expect("response body");
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    fn status_request(token: &str, authorization: Option<&str>) -> Request<Body> {
        let mut builder = Request::builder()
            .method("GET")
            .uri(format!("/v1/decision-router/{token}/status"));
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        builder.body(Body::empty()).expect("status request")
    }

    fn decision_request(
        token: &str,
        authorization: Option<&str>,
        content_type: Option<&str>,
        body: Body,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method("POST")
            .uri(format!("/v1/decision-router/{token}/v1/decisions"))
            .header("x-request-id", "client-supplied");
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        if let Some(value) = content_type {
            builder = builder.header(header::CONTENT_TYPE, value);
        }
        builder.body(body).expect("decision request")
    }

    fn json_body(value: Value) -> Body {
        Body::from(value.to_string())
    }

    fn valid_body() -> Value {
        json!({
            "model": "model-a",
            "state": {"field": "comment", "value": "great"},
            "questions": {"sentiment": {"type": "choice"}},
        })
    }

    fn local_marker() -> String {
        format!("Bearer {LOCAL_AUTHORIZATION_VALUE}")
    }

    fn error_code(value: &Value) -> String {
        value["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    #[tokio::test]
    async fn unconfigured_router_answers_503_on_both_routes() {
        let app = app(DecisionProxyConfig::Unconfigured, UPSTREAM_TIMEOUT);
        let (status, body) = send(
            app.clone(),
            status_request("decision-unknown", Some(&local_marker())),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&body), "decision_router_disabled");

        let (status, body) = send(
            app,
            decision_request(
                "decision-unknown",
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&body), "decision_router_disabled");
    }

    #[tokio::test]
    async fn local_marker_is_required() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
        let token = register_route(&upstream, "http-tests-marker");
        let app = enabled_app(&upstream);

        for authorization in [None, Some("Bearer wrong"), Some("Basic abc")] {
            let (status, body) = send(app.clone(), status_request(&token, authorization)).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "auth={authorization:?}");
            assert_eq!(error_code(&body), "invalid_local_authorization");
        }
    }

    #[tokio::test]
    async fn unknown_token_is_not_found() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
        let app = enabled_app(&upstream);
        let (status, body) = send(
            app,
            status_request("decision-unknown", Some(&local_marker())),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_code(&body), "route_not_found");
    }

    #[tokio::test]
    async fn status_lists_only_the_configured_catalogue() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
        let token = register_route(&upstream, "http-tests-status");
        let (status, body) = send(
            enabled_app(&upstream),
            status_request(&token, Some(&local_marker())),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "protocolVersion": 1,
                "defaultModel": "model-a",
                "models": [
                    {"id": "model-a", "displayName": "Model A"},
                    {"id": "model-b", "displayName": "model-b"},
                ],
            })
        );
        let serialized = body.to_string();
        assert!(!serialized.contains(&upstream.url.to_string()));
        assert!(!serialized.contains(EXCHANGED_KEY));
        assert!(!serialized.contains(LOGIN_TOKEN));
        assert_eq!(
            upstream.requests().len(),
            0,
            "status must not call upstream"
        );
        assert_eq!(
            upstream.key_requests().len(),
            0,
            "status must not trade the login token"
        );
    }

    #[tokio::test]
    async fn request_validation_rejects_bad_shapes() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
        let token = register_route(&upstream, "http-tests-validation");

        let cases = [
            (
                "not json",
                Some("application/json"),
                Body::from("not json"),
                StatusCode::BAD_REQUEST,
                "invalid_request",
            ),
            (
                "unknown field",
                Some("application/json"),
                json_body(json!({
                    "model": "model-a",
                    "state": {},
                    "questions": {"q": {}},
                    "baseUrl": "https://evil.example.com",
                })),
                StatusCode::BAD_REQUEST,
                "unsupported_field",
            ),
            (
                "blank model",
                Some("application/json"),
                json_body(json!({
                    "model": "   ",
                    "state": {},
                    "questions": {"q": {}},
                })),
                StatusCode::BAD_REQUEST,
                "invalid_model",
            ),
            (
                "null state",
                Some("application/json"),
                json_body(json!({
                    "model": "model-a",
                    "state": null,
                    "questions": {"q": {}},
                })),
                StatusCode::BAD_REQUEST,
                "invalid_request",
            ),
            (
                "empty questions",
                Some("application/json"),
                json_body(json!({
                    "model": "model-a",
                    "state": {},
                    "questions": {},
                })),
                StatusCode::BAD_REQUEST,
                "invalid_request",
            ),
            (
                "questions not an object",
                Some("application/json"),
                json_body(json!({
                    "model": "model-a",
                    "state": {},
                    "questions": ["q"],
                })),
                StatusCode::BAD_REQUEST,
                "invalid_request",
            ),
            (
                "wrong content type",
                Some("text/plain"),
                json_body(valid_body()),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_content_type",
            ),
            (
                "missing content type",
                None,
                json_body(valid_body()),
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_content_type",
            ),
        ];

        for (name, content_type, body, expected_status, expected_code) in cases {
            let (status, payload) = send(
                enabled_app(&upstream),
                decision_request(&token, Some(&local_marker()), content_type, body),
            )
            .await;
            assert_eq!(status, expected_status, "case={name}");
            assert_eq!(error_code(&payload), expected_code, "case={name}");
        }
        assert_eq!(
            upstream.requests().len(),
            0,
            "rejected requests must never reach the upstream"
        );
    }

    #[tokio::test]
    async fn oversized_body_is_rejected_locally() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
        let token = register_route(&upstream, "http-tests-oversized");
        let oversized = "x".repeat(MAX_REQUEST_BYTES + 1);
        let (status, _) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                Body::from(oversized),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(upstream.requests().len(), 0);
    }

    #[tokio::test]
    async fn accepted_content_type_variants_are_allowed() {
        for content_type in ["application/json", "application/json; charset=utf-8"] {
            let upstream =
                start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
            let token = register_route(&upstream, "http-tests-content-type");
            let (status, _) = send(
                enabled_app(&upstream),
                decision_request(
                    &token,
                    Some(&local_marker()),
                    Some(content_type),
                    json_body(valid_body()),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK, "content-type={content_type}");
        }
    }

    #[tokio::test]
    async fn upstream_receives_the_request_verbatim_and_no_client_headers() {
        let upstream =
            start_upstream(ScriptedResponse::json(200, json!({"answers": {"q": {}}}))).await;
        let token = register_route(&upstream, "http-tests-forward");
        let body = json!({
            "model": "model-a",
            "state": "plain string state",
            "questions": {"sentiment": {"type": "choice", "criteria": {"positive": "正面"}}},
        });
        let request = Request::builder()
            .method("POST")
            .uri(format!("/v1/decision-router/{token}/v1/decisions"))
            .header(header::AUTHORIZATION, local_marker())
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, "session=client-cookie")
            .header(header::ORIGIN, "https://evil.example.com")
            .header(header::REFERER, "https://evil.example.com")
            .header("x-api-key", "client-key")
            .header("x-forwarded-for", "10.1.2.3")
            .body(json_body(body.clone()))
            .expect("request");

        let (status, payload) = send(enabled_app(&upstream), request).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(payload, json!({"answers": {"q": {}}}));

        let recorded = upstream.only_request();
        assert_eq!(recorded.body, body);
        let names = recorded
            .headers
            .iter()
            .map(|(name, _)| name.to_ascii_lowercase())
            .collect::<Vec<_>>();
        for forbidden in [
            "cookie",
            "origin",
            "referer",
            "x-api-key",
            "x-forwarded-for",
        ] {
            assert!(
                !names.contains(&forbidden.to_owned()),
                "leaked header {forbidden}"
            );
        }
        assert_eq!(
            upstream.header("authorization").as_deref(),
            Some(format!("Bearer {EXCHANGED_KEY}").as_str())
        );
        let forwarded_request_id = upstream.header("x-request-id").unwrap_or_default();
        assert!(
            forwarded_request_id.starts_with("local_req_"),
            "the Executor must mint its own request id, got {forwarded_request_id}"
        );
        assert_ne!(forwarded_request_id, "client-supplied");
    }

    #[tokio::test]
    async fn the_router_forwards_any_model_name_verbatim() {
        let upstream =
            start_upstream(ScriptedResponse::json(200, json!({"answers": {"q": {}}}))).await;
        let token = register_route(&upstream, "http-tests-any-model");
        let body = json!({
            "model": "team-owned-model-2026",
            "state": "plain string state",
            "questions": {"q": {}},
        });

        let (status, _) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(body.clone()),
            ),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(upstream.only_request().body, body);
    }

    #[tokio::test]
    async fn response_is_whitelisted_before_reaching_the_client() {
        let upstream = start_upstream(ScriptedResponse::json(
            200,
            json!({
                "model": "model-a",
                "request_id": "req_1",
                "answers": {"q": {"choice": "yes"}},
                "usage": {"total_tokens": 3},
                "latency_ms": 12,
                "debug": {"secret": true},
                "trace": "internal",
                "authorization": "Bearer leaked",
                "upstream_request": {"url": "https://decision-upstream.example.com"},
            }),
        ))
        .await;
        let token = register_route(&upstream, "http-tests-whitelist");
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload,
            json!({
                "model": "model-a",
                "request_id": "req_1",
                "answers": {"q": {"choice": "yes"}},
                "usage": {"total_tokens": 3},
                "latency_ms": 12,
            })
        );
    }

    #[tokio::test]
    async fn upstream_statuses_map_to_the_fixed_table() {
        let cases = [
            (429, 429, "upstream_rate_limited", true),
            (400, 502, "upstream_rejected", false),
            (422, 502, "upstream_rejected", false),
            (500, 502, "upstream_rejected", true),
            (503, 502, "upstream_rejected", true),
        ];
        for (upstream_status, expected_status, expected_code, retryable) in cases {
            let upstream =
                start_upstream(ScriptedResponse::raw(upstream_status, "upstream failure")).await;
            let token = register_route(&upstream, "http-tests-status-map");
            let (status, payload) = send(
                enabled_app(&upstream),
                decision_request(
                    &token,
                    Some(&local_marker()),
                    Some("application/json"),
                    json_body(valid_body()),
                ),
            )
            .await;
            assert_eq!(
                status.as_u16(),
                expected_status,
                "upstream={upstream_status}"
            );
            assert_eq!(
                error_code(&payload),
                expected_code,
                "upstream={upstream_status}"
            );
            assert_eq!(
                payload["error"]["retryable"], retryable,
                "upstream={upstream_status}"
            );
            assert_eq!(upstream.requests().len(), 1, "no upstream retry");
        }
    }

    #[tokio::test]
    async fn success_without_json_maps_to_502() {
        let upstream = start_upstream(ScriptedResponse::raw(200, "<html>not json</html>")).await;
        let token = register_route(&upstream, "http-tests-bad-json");
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(error_code(&payload), "upstream_invalid_response");
    }

    #[tokio::test]
    async fn timeout_maps_to_504() {
        let mut scripted = ScriptedResponse::json(200, json!({"answers": {}}));
        scripted.delay = Duration::from_millis(400);
        let upstream = start_upstream(scripted).await;
        let token = register_route(&upstream, "http-tests-timeout");
        let app = app(
            DecisionProxyConfig::Enabled(settings(&upstream.url)),
            Duration::from_millis(20),
        );
        let (status, payload) = send(
            app,
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(error_code(&payload), "upstream_timeout");
        assert_eq!(payload["error"]["retryable"], true);
    }

    #[tokio::test]
    async fn upstream_failures_never_leak_internals() {
        let upstream = start_upstream(ScriptedResponse::raw(
            500,
            "upstream body with credential test-upstream-credential",
        ))
        .await;
        let token = register_route(&upstream, "http-tests-leak");
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        let serialized = payload.to_string();
        for needle in [
            EXCHANGED_KEY,
            LOGIN_TOKEN,
            "upstream body",
            upstream.url.as_str(),
            "127.0.0.1",
            "panicked",
        ] {
            assert!(!serialized.contains(needle), "leaked {needle}");
        }
    }

    #[tokio::test]
    async fn login_token_is_traded_for_the_upstream_credential() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let token = register_route(&upstream, "http-tests-trade");
        let (status, _) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            upstream.last_key_authorization().as_deref(),
            Some(format!("Bearer {LOGIN_TOKEN}").as_str()),
            "the exchange must present the current login token"
        );
        assert_eq!(upstream.key_requests().len(), 1);
    }

    #[tokio::test]
    async fn the_exchanged_key_is_cached_between_requests() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let token = register_route(&upstream, "http-tests-key-cache");
        let app = enabled_app(&upstream);
        for _ in 0..3 {
            let (status, _) = send(
                app.clone(),
                decision_request(
                    &token,
                    Some(&local_marker()),
                    Some("application/json"),
                    json_body(valid_body()),
                ),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
        }
        assert_eq!(
            upstream.key_requests().len(),
            1,
            "the traded key must be reused instead of traded again per request"
        );
        assert_eq!(
            upstream.header("authorization").as_deref(),
            Some(format!("Bearer {EXCHANGED_KEY}").as_str())
        );
    }

    #[tokio::test]
    async fn upstream_401_drops_the_key_and_retries_once() {
        let upstream = start_backend(
            Script::sequence(vec![
                ScriptedResponse::raw(401, "unauthorized"),
                ScriptedResponse::json(200, json!({"answers": {}})),
            ]),
            Script::sequence(vec![
                exchange_response("sk-wecode-stale"),
                exchange_response("sk-wecode-fresh"),
            ]),
        )
        .await;
        let token = register_route(&upstream, "http-tests-rekey");
        let (status, _) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let authorizations = upstream
            .requests()
            .into_iter()
            .filter_map(|request| {
                request
                    .headers
                    .into_iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
                    .map(|(_, value)| value)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            authorizations,
            vec![
                "Bearer sk-wecode-stale".to_owned(),
                "Bearer sk-wecode-fresh".to_owned(),
            ],
            "the retry must carry a freshly traded key"
        );
        assert_eq!(upstream.key_requests().len(), 2);
    }

    #[tokio::test]
    async fn persistent_upstream_401_is_reported_after_one_retry() {
        let upstream = start_upstream(ScriptedResponse::raw(401, "unauthorized")).await;
        let token = register_route(&upstream, "http-tests-rekey-failed");
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        assert_eq!(error_code(&payload), "upstream_rejected");
        assert_eq!(
            (upstream.requests().len(), upstream.key_requests().len()),
            (2, 2)
        );
    }

    #[tokio::test]
    async fn failed_exchange_answers_503_without_calling_upstream() {
        let upstream = start_backend(
            Script::from(ScriptedResponse::json(200, json!({"answers": {}}))),
            Script::from(ScriptedResponse::json(500, json!({"detail": "boom"}))),
        )
        .await;
        let token = register_route(&upstream, "http-tests-credential");
        let (status, payload) = send(
            enabled_app(&upstream),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&payload), "credential_unavailable");
        assert_eq!(upstream.requests().len(), 0);
    }

    #[tokio::test]
    async fn login_routes_follow_the_live_snapshot() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let snapshot = Arc::new(Mutex::new(None::<ConnectionConfig>));
        let token = register("http-tests-login", Arc::clone(&snapshot));
        let app = app(
            DecisionProxyConfig::Enabled(settings(&upstream.url)),
            UPSTREAM_TIMEOUT,
        );

        let (status, payload) = send(
            app.clone(),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&payload), "credential_unavailable");
        assert_eq!(
            upstream.key_requests().len(),
            0,
            "no login token means no exchange"
        );

        *snapshot.lock().expect("snapshot lock") = Some(ConnectionConfig {
            backend_url: upstream.backend_url.clone(),
            socket_url: String::new(),
            auth_token: "first-token".to_owned(),
            runtime_auth_token: String::new(),
        });
        let (status, _) = send(
            app.clone(),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            upstream.header("authorization").as_deref(),
            Some(format!("Bearer {EXCHANGED_KEY}").as_str())
        );
        assert_eq!(
            upstream.last_key_authorization().as_deref(),
            Some("Bearer first-token")
        );

        *snapshot.lock().expect("snapshot lock") = Some(ConnectionConfig {
            backend_url: upstream.backend_url.clone(),
            socket_url: String::new(),
            auth_token: "rotated-token".to_owned(),
            runtime_auth_token: String::new(),
        });
        let (status, _) = send(
            app,
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            upstream.last_key_authorization().as_deref(),
            Some("Bearer rotated-token"),
            "a new login token must be traded again instead of reusing the cache"
        );
        assert_eq!(
            upstream.header("authorization").as_deref(),
            Some(format!("Bearer {EXCHANGED_KEY}").as_str())
        );
    }

    #[tokio::test]
    async fn released_route_stops_authenticating() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let token = register_route(&upstream, "http-tests-release");
        let app = enabled_app(&upstream);
        let (status, _) = send(
            app.clone(),
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK);

        unregister(&token);
        let (status, payload) = send(
            app,
            decision_request(
                &token,
                Some(&local_marker()),
                Some("application/json"),
                json_body(valid_body()),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(error_code(&payload), "route_not_found");
    }
}
