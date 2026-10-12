// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Executor-owned configuration for the Wework decision router.
//!
//! The decision upstream, the model catalogue, and the upstream credential are
//! trusted Executor configuration. A Smart App may read the catalogue from
//! `GET .../status` and name one of the allowlisted models in a request, but it
//! can never move the upstream, widen the allowlist, or see the credential.

// The routing work that consumes these types lands in follow-up changes; until
// then the module is intentionally unreferenced.
#![allow(dead_code, unused_imports)]

mod protocol;
mod registry;

pub(crate) use protocol::{
    DecisionModel, DecisionProxyErrorBody, DecisionProxyErrorPayload, DecisionRequest,
    DecisionStatusResponse, DECISION_PROXY_PROTOCOL_VERSION,
};
pub(crate) use registry::{lookup as lookup_route, register, unregister, DecisionCredentialSource};

use std::{
    collections::HashSet,
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

/// Hosts allowed for the decision upstream.
///
/// The upstream is fixed by trusted configuration; this list is defense in
/// depth against a mis-edited deployment value.
const ALLOWED_UPSTREAM_HOSTS: &[&str] = &["copilot.weibo.com"];

const ENV_ENABLED: &str = "WEWORK_DECISION_PROXY_ENABLED";
const ENV_UPSTREAM_URL: &str = "WEWORK_DECISION_PROXY_UPSTREAM_URL";
const ENV_DEFAULT_MODEL: &str = "WEWORK_DECISION_PROXY_DEFAULT_MODEL";
const ENV_ALLOWED_MODELS_JSON: &str = "WEWORK_DECISION_PROXY_ALLOWED_MODELS_JSON";
const ENV_CREDENTIAL: &str = "WEWORK_DECISION_PROXY_CREDENTIAL";
const ENV_STATIC_CREDENTIAL: &str = "WEWORK_DECISION_PROXY_API_KEY";

/// Where the upstream credential comes from.
///
/// [REV-D3] The first version defaults to [`Self::Static`]: the platform
/// decision credential belongs to `copilot.weibo.com` and is unrelated to the
/// Wework user session token used for the Wegent backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DecisionCredentialMode {
    /// Executor-controlled platform credential, read per request.
    Static,
    /// Current Wework login snapshot (`ConnectionConfig.auth_token`).
    Login,
}

/// Parsed, validated decision proxy configuration.
///
/// Disabled and enabled configurations are different shapes rather than one
/// struct with an optional upstream, so handlers cannot fall back to a
/// half-configured upstream.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum DecisionProxyConfig {
    Disabled,
    Enabled(DecisionProxySettings),
}

/// Trusted settings used once the decision proxy is enabled.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DecisionProxySettings {
    pub upstream_url: Url,
    pub default_model: String,
    pub models: Vec<DecisionModel>,
    pub credential: DecisionCredentialMode,
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

    /// Whether route registration and HTTP handling are open.
    pub(crate) const fn enabled(&self) -> bool {
        matches!(self, Self::Enabled(_))
    }

    /// Registered settings, or `None` while the proxy is disabled.
    pub(crate) fn settings(&self) -> Option<&DecisionProxySettings> {
        match self {
            Self::Disabled => None,
            Self::Enabled(settings) => Some(settings),
        }
    }

    fn from_lookup<F>(lookup: F) -> Result<Self, DecisionProxyConfigError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let enabled = lookup(ENV_ENABLED).is_some_and(|value| is_truthy_flag(&value));
        if !enabled {
            return Ok(Self::Disabled);
        }

        let upstream = lookup(ENV_UPSTREAM_URL)
            .ok_or_else(|| DecisionProxyConfigError::new("missing_upstream_url"))?;
        let upstream_url = parse_upstream_url(&upstream)?;

        let default_model = lookup(ENV_DEFAULT_MODEL)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DecisionProxyConfigError::new("missing_default_model"))?;

        let models = parse_allowed_models(lookup(ENV_ALLOWED_MODELS_JSON).as_deref())?;
        if !models.iter().any(|model| model.id == default_model) {
            return Err(DecisionProxyConfigError::new("default_model_not_allowed"));
        }

        let credential = parse_credential_mode(lookup(ENV_CREDENTIAL).as_deref())?;

        Ok(Self::Enabled(DecisionProxySettings {
            upstream_url,
            default_model,
            models,
            credential,
        }))
    }
}

/// Reads the platform decision credential used by [`DecisionCredentialMode::Static`].
///
/// Returns `None` when the deployment has not provided one, so callers answer
/// `credential_unavailable` instead of calling the upstream unauthenticated.
pub(crate) fn static_credential_from_env() -> Option<String> {
    env::var(ENV_STATIC_CREDENTIAL)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Logs the startup summary. Tokens, the upstream URL, and the model catalogue
/// contents stay out of the log.
pub(crate) fn log_config_summary(config: &DecisionProxyConfig) {
    match config {
        DecisionProxyConfig::Disabled => {
            log_executor_event("decision_proxy.config", &[("enabled", "false".to_owned())])
        }
        DecisionProxyConfig::Enabled(settings) => log_executor_event(
            "decision_proxy.config",
            &[
                ("enabled", "true".to_owned()),
                ("model_count", settings.models.len().to_string()),
                ("upstream_host", safe_url(&settings.upstream_url)),
            ],
        ),
    }
}

/// Resolves the startup configuration, failing closed when it is invalid.
///
/// An operator mistake must not turn the Executor into an open upstream proxy,
/// so an unusable configuration is reported and treated as "disabled".
pub(crate) fn config_from_env_or_disabled() -> Arc<DecisionProxyConfig> {
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
            Arc::new(DecisionProxyConfig::Disabled)
        }
    }
}

fn is_truthy_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn parse_credential_mode(
    raw: Option<&str>,
) -> Result<DecisionCredentialMode, DecisionProxyConfigError> {
    match raw.map(str::trim) {
        None | Some("") => Ok(DecisionCredentialMode::Static),
        Some(value) => match value.to_ascii_lowercase().as_str() {
            "static" => Ok(DecisionCredentialMode::Static),
            "login" => Ok(DecisionCredentialMode::Login),
            _ => Err(DecisionProxyConfigError::new("invalid_credential_mode")),
        },
    }
}

fn parse_upstream_url(raw: &str) -> Result<Url, DecisionProxyConfigError> {
    let invalid = || DecisionProxyConfigError::new("invalid_upstream_url");
    let url = Url::parse(raw.trim()).map_err(|_| invalid())?;
    let host_allowed = url
        .host_str()
        .is_some_and(|host| ALLOWED_UPSTREAM_HOSTS.contains(&host));
    if url.scheme() != "https"
        || !host_allowed
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

fn parse_allowed_models(raw: Option<&str>) -> Result<Vec<DecisionModel>, DecisionProxyConfigError> {
    let invalid = || DecisionProxyConfigError::new("invalid_allowed_models");
    let ids: Vec<String> = serde_json::from_str(raw.ok_or_else(invalid)?).map_err(|_| invalid())?;
    if ids.is_empty() {
        return Err(invalid());
    }

    let mut seen = HashSet::with_capacity(ids.len());
    let mut models = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.trim().to_owned();
        if id.is_empty() || !seen.insert(id.clone()) {
            return Err(invalid());
        }
        models.push(DecisionModel {
            display_name: id.clone(),
            id,
        });
    }
    Ok(models)
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

type StaticCredentialFn = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// State shared by the decision routes.
///
/// The configuration comes from Executor-controlled input, never from the
/// Smart App registration call.
#[derive(Clone)]
pub(crate) struct DecisionProxyState {
    config: Arc<DecisionProxyConfig>,
    static_credential: StaticCredentialFn,
    timeout: Duration,
}

impl DecisionProxyState {
    pub(crate) fn new(config: Arc<DecisionProxyConfig>) -> Self {
        Self {
            config,
            static_credential: Arc::new(static_credential_from_env),
            timeout: UPSTREAM_TIMEOUT,
        }
    }
}

impl<R> FromRef<AppState<R>> for DecisionProxyState {
    fn from_ref(state: &AppState<R>) -> Self {
        Self::new(Arc::clone(&state.decision_proxy))
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
        return router_disabled();
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
        return router_disabled();
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
    if let Some(response) = validate_request(settings, &request, &request_id) {
        return response;
    }
    let credential = match resolve_credential(&state, &route) {
        Some(credential) => credential,
        None => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "credential_unavailable",
                "decision credential is currently unavailable",
                true,
                request_id,
            )
        }
    };
    forward_to_upstream(&state, settings, &request, credential, &request_id, &route).await
}

/// Shape checks the proxy owns: allowlist, `state` presence, `questions`.
/// `Some` carries the response to send when the request must be rejected.
fn validate_request(
    settings: &DecisionProxySettings,
    request: &DecisionRequest,
    request_id: &str,
) -> Option<Response> {
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
    if !settings.models.iter().any(|entry| entry.id == model) {
        return Some(error_response(
            StatusCode::BAD_REQUEST,
            "unsupported_model",
            "model is not available on this route",
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

/// Reads the credential for this request without holding the registry lock.
fn resolve_credential(
    state: &DecisionProxyState,
    route: &registry::DecisionRouteHandle,
) -> Option<String> {
    match &route.credential {
        DecisionCredentialSource::Static => (state.static_credential)(),
        DecisionCredentialSource::Login(snapshot) => {
            let current = {
                let guard = snapshot.lock().ok()?;
                guard
                    .as_ref()
                    .map(|connection| connection.auth_token.trim().to_owned())
            };
            current.filter(|value| !value.is_empty())
        }
    }
}

async fn forward_to_upstream(
    state: &DecisionProxyState,
    settings: &DecisionProxySettings,
    request: &DecisionRequest,
    credential: String,
    request_id: &str,
    route: &registry::DecisionRouteHandle,
) -> Response {
    let payload = json!({
        "model": request.model.trim(),
        "state": request.state,
        "questions": request.questions,
    });
    let client = match reqwest::Client::builder().timeout(state.timeout).build() {
        Ok(client) => client,
        Err(_) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "upstream_invalid_response",
                "decision upstream response is unusable",
                false,
                request_id.to_owned(),
            )
        }
    };
    let started = Instant::now();
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
        Err(error) if error.is_timeout() => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "upstream_timeout",
            "decision upstream timed out",
            true,
            request_id.to_owned(),
        ),
        Err(_) => error_response(
            StatusCode::BAD_GATEWAY,
            "upstream_rejected",
            "decision upstream is unavailable",
            true,
            request_id.to_owned(),
        ),
        Ok(response) => match upstream_response_body(response, request_id).await {
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
    };
    log_request(request_id, route, request, response.status(), started);
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

fn router_disabled() -> Response {
    error_response(
        StatusCode::SERVICE_UNAVAILABLE,
        "decision_router_disabled",
        "decision router is disabled",
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

    const VALID_UPSTREAM: &str = "https://copilot.weibo.com/v1/decisions";

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
            DecisionProxyConfig::Disabled => panic!("expected an enabled config"),
        }
    }

    fn upstream_entries(upstream: &str) -> [(&str, &str); 4] {
        [
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, upstream),
            (ENV_DEFAULT_MODEL, "model-a"),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
        ]
    }

    fn model_entries<'a>(allowed: &'a str, default: &'a str) -> [(&'a str, &'a str); 4] {
        [
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, default),
            (ENV_ALLOWED_MODELS_JSON, allowed),
        ]
    }

    #[test]
    fn flag_absent_or_false_disables_the_proxy() {
        assert_eq!(
            config_from(&[]).expect("empty environment is valid"),
            DecisionProxyConfig::Disabled
        );
        for value in ["false", "0", "no", "off", "  FALSE "] {
            assert_eq!(
                config_from(&[(ENV_ENABLED, value)]).expect("false flag is valid"),
                DecisionProxyConfig::Disabled,
                "value={value}"
            );
        }
    }

    #[test]
    fn enabled_without_upstream_is_invalid() {
        let error = config_from(&[
            (ENV_ENABLED, "true"),
            (ENV_DEFAULT_MODEL, "model-a"),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
        ])
        .expect_err("upstream is required when enabled");
        assert_eq!(error.reason(), "missing_upstream_url");
    }

    #[test]
    fn upstream_must_be_a_plain_https_decisions_url() {
        for upstream in [
            "http://copilot.weibo.com/v1/decisions",
            "ftp://copilot.weibo.com/v1/decisions",
            "https://user:secret@copilot.weibo.com/v1/decisions",
            "https://copilot.weibo.com/v1/decisions?x=1",
            "https://copilot.weibo.com/v1/decisions#fragment",
            "https://copilot.weibo.com/v1/decisions/",
            "https://copilot.weibo.com/v1/other",
            "https://copilot.weibo.com/",
            "https://evil.example.com/v1/decisions",
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
    fn default_model_must_be_present_and_non_blank() {
        for default in ["", "   "] {
            let error = config_from(&model_entries(r#"["model-a"]"#, default))
                .expect_err("blank default model");
            assert_eq!(
                error.reason(),
                "missing_default_model",
                "default={default:?}"
            );
        }
        let error = config_from(&[
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
        ])
        .expect_err("missing default model");
        assert_eq!(error.reason(), "missing_default_model");
    }

    #[test]
    fn allowed_models_must_be_a_json_string_array() {
        for allowed in [
            r#""model-a""#,
            r#"{"model-a": true}"#,
            r#"["model-a", 1]"#,
            r#"[["model-a"]]"#,
            "not json",
        ] {
            let error = config_from(&model_entries(allowed, "model-a")).expect_err(allowed);
            assert_eq!(
                error.reason(),
                "invalid_allowed_models",
                "allowed={allowed}"
            );
        }
        let error = config_from(&[
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, "model-a"),
        ])
        .expect_err("missing allowed models");
        assert_eq!(error.reason(), "invalid_allowed_models");
    }

    #[test]
    fn allowed_models_must_be_non_empty_unique_and_non_blank() {
        for allowed in [
            r#"[]"#,
            r#"[""]"#,
            r#"["   "]"#,
            r#"["model-a", "model-a"]"#,
            r#"["model-a", " model-a "]"#,
        ] {
            let error = config_from(&model_entries(allowed, "model-a")).expect_err(allowed);
            assert_eq!(
                error.reason(),
                "invalid_allowed_models",
                "allowed={allowed}"
            );
        }
    }

    #[test]
    fn default_model_must_be_allowed() {
        let error = config_from(&model_entries(r#"["model-a", "model-b"]"#, "model-z"))
            .expect_err("default model must be allowlisted");
        assert_eq!(error.reason(), "default_model_not_allowed");
    }

    #[test]
    fn valid_config_parses_into_stable_settings() {
        let entries = model_entries(r#"["model-a", "model-b"]"#, "model-a");
        let first = enabled_settings(&entries);
        let second = enabled_settings(&entries);
        assert_eq!(first, second);
        assert_eq!(first.upstream_url.as_str(), VALID_UPSTREAM);
        assert_eq!(first.default_model, "model-a");
        assert_eq!(first.credential, DecisionCredentialMode::Static);
        assert_eq!(
            first.models,
            vec![
                DecisionModel {
                    id: "model-a".to_owned(),
                    display_name: "model-a".to_owned(),
                },
                DecisionModel {
                    id: "model-b".to_owned(),
                    display_name: "model-b".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn credential_mode_defaults_to_static_and_accepts_login() {
        let default = enabled_settings(&model_entries(r#"["model-a"]"#, "model-a"));
        assert_eq!(default.credential, DecisionCredentialMode::Static);

        for (value, expected) in [
            ("static", DecisionCredentialMode::Static),
            ("STATIC", DecisionCredentialMode::Static),
            ("login", DecisionCredentialMode::Login),
            (" Login ", DecisionCredentialMode::Login),
        ] {
            let entries = [
                (ENV_ENABLED, "true"),
                (ENV_UPSTREAM_URL, VALID_UPSTREAM),
                (ENV_DEFAULT_MODEL, "model-a"),
                (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
                (ENV_CREDENTIAL, value),
            ];
            assert_eq!(
                enabled_settings(&entries).credential,
                expected,
                "value={value}"
            );
        }
    }

    #[test]
    fn unknown_credential_mode_is_invalid() {
        let entries = [
            (ENV_ENABLED, "true"),
            (ENV_UPSTREAM_URL, VALID_UPSTREAM),
            (ENV_DEFAULT_MODEL, "model-a"),
            (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
            (ENV_CREDENTIAL, "keychain"),
        ];
        assert_eq!(
            config_from(&entries)
                .expect_err("unknown credential mode")
                .reason(),
            "invalid_credential_mode"
        );
    }

    #[test]
    fn enabled_flag_accepts_documented_truthy_values() {
        for value in ["true", "TRUE", "1", "yes", "on", "  On  "] {
            let entries = [
                (ENV_ENABLED, value),
                (ENV_UPSTREAM_URL, VALID_UPSTREAM),
                (ENV_DEFAULT_MODEL, "model-a"),
                (ENV_ALLOWED_MODELS_JSON, r#"["model-a"]"#),
            ];
            let settings = enabled_settings(&entries);
            assert_eq!(settings.default_model, "model-a", "value={value}");
        }
    }

    #[test]
    fn config_error_display_never_leaks_the_upstream_value() {
        let error = config_from(&upstream_entries(
            "https://user:secret@copilot.weibo.com/v1/decisions",
        ))
        .expect_err("invalid upstream");
        let text = error.to_string();
        assert!(!text.contains("secret"), "error leaked a value: {text}");
        assert!(
            !text.contains("copilot.weibo.com"),
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

    const STATIC_CREDENTIAL: &str = "test-upstream-credential";
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

    struct UpstreamShared {
        requests: Mutex<Vec<RecordedRequest>>,
        script: Mutex<ScriptedResponse>,
    }

    struct FakeUpstream {
        url: Url,
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
    }

    async fn start_upstream(script: ScriptedResponse) -> FakeUpstream {
        let shared = Arc::new(UpstreamShared {
            requests: Mutex::new(Vec::new()),
            script: Mutex::new(script),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("upstream listener");
        let address = listener.local_addr().expect("upstream address");
        let router = Router::new()
            .route("/v1/decisions", post(fake_upstream))
            .with_state(Arc::clone(&shared));
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        FakeUpstream {
            url: Url::parse(&format!("http://{address}/v1/decisions")).expect("upstream url"),
            shared,
        }
    }

    async fn fake_upstream(
        State(shared): State<Arc<UpstreamShared>>,
        headers: HeaderMap,
        body: axum::body::Bytes,
    ) -> Response {
        let scripted = shared.script.lock().expect("script lock").clone();
        if !scripted.delay.is_zero() {
            tokio::time::sleep(scripted.delay).await;
        }
        shared
            .requests
            .lock()
            .expect("requests lock")
            .push(RecordedRequest {
                headers: headers
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.as_str().to_owned(),
                            value.to_str().unwrap_or_default().to_owned(),
                        )
                    })
                    .collect(),
                body: serde_json::from_slice(&body).unwrap_or(Value::Null),
            });
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
            credential: DecisionCredentialMode::Static,
        }
    }

    fn app(config: DecisionProxyConfig, timeout: Duration) -> Router {
        let mut state = DecisionProxyState::new(Arc::new(config));
        state.static_credential = Arc::new(|| Some(STATIC_CREDENTIAL.to_owned()));
        state.timeout = timeout;
        routes::<DecisionProxyState>().with_state(state)
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
    async fn disabled_router_answers_503_on_both_routes() {
        let app = app(DecisionProxyConfig::Disabled, UPSTREAM_TIMEOUT);
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
        let token = register("http-tests-marker", DecisionCredentialSource::Static);
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
        let token = register("http-tests-status", DecisionCredentialSource::Static);
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
        assert!(!serialized.contains(STATIC_CREDENTIAL));
        assert_eq!(
            upstream.requests().len(),
            0,
            "status must not call upstream"
        );
    }

    #[tokio::test]
    async fn request_validation_rejects_bad_shapes() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({}))).await;
        let token = register("http-tests-validation", DecisionCredentialSource::Static);

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
                "unknown model",
                Some("application/json"),
                json_body(json!({
                    "model": "model-z",
                    "state": {},
                    "questions": {"q": {}},
                })),
                StatusCode::BAD_REQUEST,
                "unsupported_model",
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
        let token = register("http-tests-oversized", DecisionCredentialSource::Static);
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
            let token = register("http-tests-content-type", DecisionCredentialSource::Static);
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
        let token = register("http-tests-forward", DecisionCredentialSource::Static);
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
            Some(format!("Bearer {STATIC_CREDENTIAL}").as_str())
        );
        let forwarded_request_id = upstream.header("x-request-id").unwrap_or_default();
        assert!(
            forwarded_request_id.starts_with("local_req_"),
            "the Executor must mint its own request id, got {forwarded_request_id}"
        );
        assert_ne!(forwarded_request_id, "client-supplied");
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
                "upstream_request": {"url": "https://copilot.weibo.com"},
            }),
        ))
        .await;
        let token = register("http-tests-whitelist", DecisionCredentialSource::Static);
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
            let token = register("http-tests-status-map", DecisionCredentialSource::Static);
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
        let token = register("http-tests-bad-json", DecisionCredentialSource::Static);
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
        let token = register("http-tests-timeout", DecisionCredentialSource::Static);
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
        let token = register("http-tests-leak", DecisionCredentialSource::Static);
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
            STATIC_CREDENTIAL,
            "upstream body",
            upstream.url.as_str(),
            "127.0.0.1",
            "panicked",
        ] {
            assert!(!serialized.contains(needle), "leaked {needle}");
        }
    }

    #[tokio::test]
    async fn missing_static_credential_answers_503() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let token = register("http-tests-credential", DecisionCredentialSource::Static);
        let mut state = DecisionProxyState::new(Arc::new(DecisionProxyConfig::Enabled(settings(
            &upstream.url,
        ))));
        state.static_credential = Arc::new(|| None);
        let app = routes::<DecisionProxyState>().with_state(state);
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
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(error_code(&payload), "credential_unavailable");
        assert_eq!(upstream.requests().len(), 0);
    }

    #[tokio::test]
    async fn login_routes_follow_the_live_snapshot() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let snapshot = Arc::new(Mutex::new(None::<ConnectionConfig>));
        let token = register(
            "http-tests-login",
            DecisionCredentialSource::Login(Arc::clone(&snapshot)),
        );
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

        *snapshot.lock().expect("snapshot lock") = Some(ConnectionConfig {
            backend_url: String::new(),
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
            Some("Bearer first-token")
        );

        *snapshot.lock().expect("snapshot lock") = Some(ConnectionConfig {
            backend_url: String::new(),
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
            upstream.header("authorization").as_deref(),
            Some("Bearer rotated-token"),
            "each request must read the current snapshot"
        );
    }

    #[tokio::test]
    async fn released_route_stops_authenticating() {
        let upstream = start_upstream(ScriptedResponse::json(200, json!({"answers": {}}))).await;
        let token = register("http-tests-release", DecisionCredentialSource::Static);
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
