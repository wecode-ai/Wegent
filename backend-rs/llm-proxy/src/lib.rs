// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/runtime-work/llm-responses-proxy/{responses,messages}` — the
//! authenticated LLM proxy gateway for Wework cloud models.
//!
//! Mirrors `app/api/endpoints/runtime_work.llm_responses_proxy_endpoint` and
//! `app/services/llm_proxy_service.proxy_llm_responses`: the Wework local
//! executor authenticates with the user's backend token, names a Model CRD
//! through the `x-wegent-model-*` headers, and the backend resolves the same
//! wire protocol, attaches the provider credentials, and streams the native
//! upstream request and response without further conversion.
//!
//! Provider credential resolution is delegated to the registered
//! [`LlmProxyCredentials`]: the open-source default returns the processed Model
//! CRD value unchanged, while the internal deployment registers a resolver that
//! expands user-scoped placeholders through its API-key service. This keeps the
//! internal domain and credential out of the open-source crate.
//!
//! The source registers three physical siblings (`/responses`,
//! `/chat/completions`, `/messages`) on one handler. Both `/responses` and
//! `/messages` have recorded contract cases; the Chat Completions sibling stays
//! on the Python fallback until it is recorded.
//!
//! Unlike every other migrated API, this route is a hand-written `Handler`
//! rather than a `#[brz_http_server::post]` function: the source forwards every
//! inbound `x-wegent-upstream-header-*` header with its prefix stripped, and the
//! function API can only bind named header parameters. The handler therefore
//! reads the complete request header list, matching
//! `_extract_custom_upstream_headers` and `_extract_runtime_metadata_headers`.

use std::pin::Pin;
use std::sync::LazyLock;
use std::time::Duration;

use async_trait::async_trait;
use brz_http_server::{Bytes, HttpResponse, StatusCode};
use futures_util::Stream;
use regex::Regex;
use serde_json::Value;
use tokio::time::{Instant, timeout_at};

use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use wegent_access::permissions;
use wegent_http_compat as http_compat;
use wegent_identity::auth;
use wegent_network_policy::http_trust;
use wegent_python_compat::json_compat;

pub mod model_config;
mod route;
mod transport;

pub use route::LlmResponsesProxyRoute;
pub use route::{MESSAGES_ROUTE_PATH, ROUTE_PATH};

use route::InboundHeaders;

use model_config::{resolve_llm_proxy_protocol, resolve_upstream_target, validate_model_access};

/// Dependencies needed to resolve a Model for the authenticated caller.
pub struct ModelLookup<'a> {
    pub mysql: &'a brz_mysql::MysqlService,
    pub redis: Option<&'a brz_redis::RedisService>,
    pub entity_resolvers: &'a permissions::EntityResolvers,
}

pub struct LlmProxyState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub entity_resolvers: permissions::EntityResolvers,
    pub llm_proxy_credentials: std::sync::Arc<dyn LlmProxyCredentials>,
}

impl LlmProxyState {
    fn model_lookup(&self) -> ModelLookup<'_> {
        ModelLookup {
            mysql: &self.mysql,
            redis: self.redis.as_ref(),
            entity_resolvers: &self.entity_resolvers,
        }
    }
}

/// `MODEL_TYPE_HEADER`.
const MODEL_TYPE_HEADER: &str = "x-wegent-model-type";
/// `MODEL_NAMESPACE_HEADER`.
const MODEL_NAMESPACE_HEADER: &str = "x-wegent-model-namespace";
/// `MODEL_USER_ID_HEADER`.
const MODEL_USER_ID_HEADER: &str = "x-wegent-model-user-id";
/// `SUPPORTED_MODEL_TYPES`.
const SUPPORTED_MODEL_TYPES: [&str; 3] = ["public", "user", "group"];
/// `LONG_CONTEXT_SUFFIXES`: client-side long-context aliases that never name a
/// Model CRD or an upstream model.
const LONG_CONTEXT_SUFFIXES: [&str; 2] = ["[1m]", "+1m"];
/// `CONTEXT_OVERFLOW_STATUSES`: provider statuses that may carry a context
/// overflow error for Anthropic clients.
const CONTEXT_OVERFLOW_STATUSES: [u16; 4] = [400, 413, 422, 460];
/// `CONTEXT_OVERFLOW_MARKERS`.
const CONTEXT_OVERFLOW_MARKERS: [&str; 6] = [
    "对话内容太长",
    "exceeds the context limit",
    "maximum context length",
    "context_length_exceeded",
    "prompt is too long",
    "input is too long",
];
/// Rough characters-per-token ratio used when a provider error carries no count.
const CONTEXT_OVERFLOW_CHARS_PER_TOKEN: usize = 4;
/// `TOKEN_COUNT_PATTERN`.
static TOKEN_COUNT_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(\d{3,})\s*tokens?\b").expect("the token-count pattern is valid")
});
/// Bound for a buffered upstream error body. The source reads the complete body
/// before deciding whether to translate a context overflow; a larger body is
/// reported as an upstream failure instead of growing without limit.
const MAX_UPSTREAM_ERROR_BODY_BYTES: usize = 4 * 1024 * 1024;

/// One budget for authentication, model/credential lookup and the complete response.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// The source `Kind` filter of `resolve_llm_proxy_model_config`
/// (`db.query(Kind).filter(user_id, kind='Model', namespace, name, is_active)`).
/// The projection mirrors the source SQLAlchemy labeled rendering and the filter
/// order (`user_id`, `kind`, `namespace`, `name`, `is_active`).
const MODEL_KIND_QUERY: &str = "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
     WHERE kinds.user_id = ? AND kinds.kind = 'Model' \
     AND kinds.namespace = ? AND kinds.name = ? \
     AND kinds.is_active = true \n LIMIT 1";

/// The `kinds` row read for the resolved Model CRD.
#[derive(Debug, brz_mysql::FromMysqlRow)]
struct ModelKindRow {
    #[mysql(rename = "kinds_json")]
    json: brz_mysql::Json<brz_json::OpaqueJson>,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_id")]
    id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_user_id")]
    user_id: i64,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_kind")]
    kind: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_name")]
    name: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_namespace")]
    namespace: String,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_is_active")]
    is_active: i8,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_created_at")]
    created_at: chrono::NaiveDateTime,
    #[allow(dead_code, reason = "selected to match source column list")]
    #[mysql(rename = "kinds_updated_at")]
    updated_at: chrono::NaiveDateTime,
}

/// A boxed byte stream returned as the forwarded upstream response body.
type ProxyStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static>>;

/// Resolves the provider API key before forwarding an LLM proxy request.
///
/// Mirrors `app.services.llm_proxy_service.resolve_model_provider_api_key`.
/// The open-source default returns the processed Model CRD value unchanged; an
/// internal deployment whose Model CRDs carry user-scoped placeholders
/// registers its own resolver before route construction.
///
/// A resolver error becomes the source's `ModelCredentialError` (503
/// `Model credentials unavailable`); implementations must validate a claimed
/// key themselves before returning it.
#[async_trait]
pub trait LlmProxyCredentials: Send + Sync {
    /// Resolve the credential for `request`.
    ///
    /// # Errors
    /// Returns an error when the deployment cannot resolve a usable credential.
    async fn provider_api_key(
        &self,
        request: CredentialRequest<'_>,
    ) -> Result<String, FastApiError>;

    /// Rewrites a deployment-owned API-key placeholder in execution-request
    /// sections assembled from raw CRD values.
    ///
    /// Deployments may resolve placeholders in the Bot agent configuration
    /// after resolving the flat model configuration. The default leaves
    /// values unchanged.
    fn replace_api_key_placeholder(&self, _value: &mut Value, _resolved_api_key: &str) {}
}

/// The credential-resolution inputs shared with the registered resolver.
pub struct CredentialRequest<'a> {
    /// The processed Model CRD `api_key` (`extract_and_process_model_config`).
    pub api_key: &'a str,
    /// The raw Model CRD `api_key` when it carried a placeholder, mirroring the
    /// source's `model_config["_api_key_template"]`.
    pub api_key_template: Option<&'a str>,
    /// The authenticated user id (`current_user.id`).
    pub user_id: i64,
    /// The authenticated user name (`current_user.user_name`).
    pub user_name: &'a str,
}

/// The open-source credential resolver: the processed Model CRD value,
/// validated like the source's core path (`required=False`, so an empty key is
/// allowed and simply omits the provider authorization header).
pub struct StoredLlmProxyCredentials;

#[async_trait]
impl LlmProxyCredentials for StoredLlmProxyCredentials {
    async fn provider_api_key(
        &self,
        request: CredentialRequest<'_>,
    ) -> Result<String, FastApiError> {
        validate_model_api_key(request.api_key, false).ok_or_else(model_credentials_unavailable)
    }
}

/// `validate_model_api_key`: reject unresolved placeholders and header-splitting
/// characters; `required` also rejects an empty key.
pub fn validate_model_api_key(value: &str, required: bool) -> Option<String> {
    let key = value.trim();
    if key.contains("${")
        || value.contains('\r')
        || value.contains('\n')
        || (required && key.is_empty())
    {
        return None;
    }
    Some(key.to_string())
}

/// `proxy_llm_responses`.
async fn proxy_llm_responses(
    state: &LlmProxyState,
    http: &brz_http::Client,
    user: &UserRow,
    headers: &InboundHeaders<'_>,
    body: &[u8],
    path: &str,
    deadline: Instant,
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let (mut body_json, model_name) = parse_request_body(body)?;
    let model_name = strip_long_context_suffix(&model_name);
    let model_type = required_header(headers.first(MODEL_TYPE_HEADER), MODEL_TYPE_HEADER)?;
    let namespace = required_header(
        headers.first(MODEL_NAMESPACE_HEADER),
        MODEL_NAMESPACE_HEADER,
    )?;
    let resource_user_id = resource_user_id(headers.first(MODEL_USER_ID_HEADER))?;
    let model_config = timeout_at(
        deadline,
        resolve_model_config(
            &state.model_lookup(),
            user,
            &model_name,
            &model_type,
            &namespace,
            resource_user_id,
        ),
    )
    .await
    .map_err(|_| httpx_request_error("model lookup exceeded the request deadline"))??;

    let provider_base_url = model_config.base_url.trim().to_string();
    let provider_model_id = model_config.model_id.trim().to_string();
    if provider_base_url.is_empty() || provider_model_id.is_empty() {
        tracing::error!(
            user_id = user.id,
            %model_name,
            "LLM proxy model configuration incomplete"
        );
        return Err(FastApiError::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "Model configuration incomplete",
        ));
    }

    // Resolve the authorized CRD to its provider model before handing bytes to transport.
    let target_model = strip_long_context_suffix(&provider_model_id);
    let body_bytes = if headers.first("x-wegent-request-mode").as_deref() == Some("passthrough") {
        wegent_protocol::map_request_model(body, &target_model).map_err(|_| {
            FastApiError::detail(StatusCode::BAD_REQUEST, "Invalid model routing field")
        })?
    } else {
        body_json["model"] = Value::String(target_model);
        crate::json_compat::python_json_value(&body_json).into_bytes()
    };

    // The source validates the endpoint before invoking the deployment
    // credential service (`resolve_llm_proxy_protocol` precedes
    // `resolve_model_provider_api_key`).
    let protocol = resolve_llm_proxy_protocol(&model_name, &model_config)?;
    let provider_api_key = resolve_provider_api_key(state, user, &model_config, deadline).await?;
    let (upstream_path, auth_headers) = resolve_upstream_target(protocol, &provider_api_key);
    let upstream_url = model_config::join_upstream_url(&provider_base_url, &upstream_path);

    // `_extract_custom_upstream_headers` runs after credential resolution in the
    // source, so a rejected custom header never suppresses a credential error.
    let custom = headers.custom_upstream_headers()?;
    let configured = model_config.default_headers.clone();
    let runtime = headers.runtime_metadata_headers();
    let mut provider_headers = merge_headers_case_insensitive([
        configured.as_slice(),
        custom.as_slice(),
        runtime.as_slice(),
    ]);
    let mut protocol_headers = auth_headers;
    if let Some(content_type) = headers.first("content-type") {
        protocol_headers.push(("content-type".to_string(), content_type));
    }
    if let Some(accept) = headers.first("accept") {
        protocol_headers.push(("accept".to_string(), accept));
    }
    provider_headers =
        merge_headers_case_insensitive([provider_headers.as_slice(), protocol_headers.as_slice()]);

    forward_upstream(
        http,
        &upstream_url,
        &provider_headers,
        &body_bytes,
        model_config.context_window,
        is_anthropic_messages_request(path),
        deadline,
    )
    .await
}

/// `resolve_model_provider_api_key`: resolve for the caller, never the owner of
/// a shared Model, and map every resolver failure to the source's
/// `ModelCredentialError` response.
async fn resolve_provider_api_key(
    state: &LlmProxyState,
    user: &UserRow,
    model_config: &model_config::ModelConfig,
    deadline: Instant,
) -> Result<String, FastApiError> {
    let resolution = timeout_at(
        deadline,
        state
            .llm_proxy_credentials
            .provider_api_key(CredentialRequest {
                api_key: &model_config.api_key,
                api_key_template: model_config.api_key_template.as_deref(),
                user_id: i64::from(user.id),
                user_name: &user.user_name,
            }),
    )
    .await;
    match resolution {
        Ok(Ok(api_key)) if Instant::now() < deadline => Ok(api_key),
        Ok(Err(error)) => {
            tracing::error!(status = %error.status(), "LLM proxy credential resolution failed");
            Err(model_credentials_unavailable())
        }
        _ => {
            tracing::error!("LLM proxy credential resolution timed out");
            Err(model_credentials_unavailable())
        }
    }
}

/// `HTTPException(503, "Model credentials unavailable")`.
fn model_credentials_unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Model credentials unavailable",
    )
}

/// `resolve_llm_proxy_model_config`.
pub async fn resolve_model_config(
    state: &ModelLookup<'_>,
    user: &UserRow,
    model_name: &str,
    model_type: &str,
    namespace: &str,
    resource_user_id: i64,
) -> Result<model_config::ModelConfig, FastApiError> {
    Ok(resolve_model_config_with_spec(
        state,
        user,
        model_name,
        model_type,
        namespace,
        resource_user_id,
    )
    .await?
    .0)
}

/// [`resolve_model_config`] plus the raw Model CRD spec. The Wework cloud
/// gateway config reads `modelConfig` token limits and native-tool flags from
/// the same row instead of issuing a second Model read.
pub async fn resolve_model_config_with_spec(
    state: &ModelLookup<'_>,
    user: &UserRow,
    model_name: &str,
    model_type: &str,
    namespace: &str,
    resource_user_id: i64,
) -> Result<(model_config::ModelConfig, Value), FastApiError> {
    validate_model_access(state, user, model_type, namespace, resource_user_id).await?;
    let row: Option<ModelKindRow> = state
        .mysql
        .fetch_optional(MODEL_KIND_QUERY, (resource_user_id, namespace, model_name))
        .await
        .unwrap_or_else(|error| {
            tracing::error!(%error, "LLM proxy model kinds dependency failure");
            None
        });
    let Some(row) = row else {
        return Err(FastApiError::detail(
            StatusCode::NOT_FOUND,
            "Cloud model not found",
        ));
    };
    if !model_config::model_row_access_allowed(model_type, &row.json.0, &user.user_name) {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Cloud model access denied",
        ));
    }
    let spec = row
        .json
        .0
        .to_value()
        .get("spec")
        .cloned()
        .unwrap_or(Value::Null);
    let config =
        model_config::extract_and_process_model_config(&spec, i64::from(user.id), &user.user_name)?;
    model_config::validate_wework_model_config_options(&spec, model_name, &config)?;
    Ok((config, spec))
}

/// `forward_upstream`: send the native request and stream the upstream response.
///
/// The source builds a fresh `httpx.AsyncClient(timeout=600.0)` per call. The
/// request carries no connection-local state, so the target reuses the retained
/// pooled transport, spending only the request budget remaining after credentials.
///
/// A `>= 400` upstream response is buffered instead of streamed so an Anthropic
/// Messages client can receive the source's translated context-overflow error.
async fn forward_upstream(
    http: &brz_http::Client,
    upstream_url: &str,
    provider_headers: &[(String, String)],
    body: &[u8],
    context_window: Option<i64>,
    is_messages: bool,
    deadline: Instant,
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(httpx_request_error(
            "request deadline exceeded before upstream dispatch",
        ));
    }
    let mut request = http
        .post(upstream_url)
        .map_err(|error| httpx_request_error(&error.to_string()))?;
    for (name, value) in provider_headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let request = request.body(body.to_vec());
    let mut response = match timeout_at(deadline, request.timeout(remaining).send()).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            tracing::error!(%error, "LLM proxy upstream request failed");
            return Err(httpx_request_error(&error.to_string()));
        }
        Err(_) => {
            return Err(httpx_request_error(
                "upstream response exceeded the request deadline",
            ));
        }
    };
    let status = response.status();
    let upstream_content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    // `text/event-stream` default and Starlette's `text/*` charset rendering.
    let media_type = upstream_content_type.unwrap_or_else(|| "text/event-stream".to_string());
    if status.as_u16() >= 400 {
        let error_body = read_upstream_error_body(&mut response, deadline).await?;
        if is_messages
            && let Some(normalized) =
                normalize_context_overflow(status, &error_body, body.len(), context_window)
        {
            tracing::warn!(
                upstream_status = status.as_u16(),
                "LLM proxy normalized an Anthropic context overflow"
            );
            let rendered =
                serde_json::to_vec(&normalized).map_err(|_| FastApiError::unhandled())?;
            return byte_reply(StatusCode::BAD_REQUEST, "application/json", rendered);
        }
        return byte_reply(status, &media_type, error_body);
    }

    let stream = upstream_stream(response, deadline);
    let reply = HttpResponse::new(stream).status(status);
    let reply = reply
        .header("content-type", &starlette_media_type(&media_type))
        .map_err(|_| FastApiError::unhandled())?;
    let reply = reply
        .header("cache-control", "no-cache")
        .map_err(|_| FastApiError::unhandled())?;
    // `Connection` is runtime-owned by the server, so the source's
    // `keep-alive` nomination is not re-emitted; the server keeps the
    // connection alive by default.
    let reply = reply
        .header("x-accel-buffering", "no")
        .map_err(|_| FastApiError::unhandled())?;
    Ok(reply)
}

/// Buffers a complete upstream error body under the request deadline.
///
/// The source reads the whole body with `httpx.Response.aread()`; a read error
/// becomes the same `HTTPException(502, "Upstream request failed: ...")` the
/// target already maps from request failures.
async fn read_upstream_error_body(
    response: &mut brz_http::Response,
    deadline: Instant,
) -> Result<Vec<u8>, FastApiError> {
    let mut body = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err(httpx_request_error(
                "upstream error body exceeded the request deadline",
            ));
        }
        match timeout_at(deadline, response.chunk()).await {
            Ok(Ok(Some(chunk))) => {
                if body.len().saturating_add(chunk.len()) > MAX_UPSTREAM_ERROR_BODY_BYTES {
                    return Err(httpx_request_error(
                        "upstream error body exceeded the read limit",
                    ));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(Ok(None)) => return Ok(body),
            Ok(Err(error)) => {
                tracing::error!(%error, "LLM proxy upstream error body failed");
                return Err(httpx_request_error(&error.to_string()));
            }
            Err(_) => {
                return Err(httpx_request_error(
                    "upstream error body exceeded the request deadline",
                ));
            }
        }
    }
}

/// A closed, single-chunk body with the source's `Response` headers.
fn byte_reply(
    status: StatusCode,
    media_type: &str,
    body: Vec<u8>,
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let length = body.len() as u64;
    let stream: ProxyStream = Box::pin(futures_util::stream::once(
        async move { Ok(Bytes::from(body)) },
    ));
    HttpResponse::new(stream)
        .status(status)
        .content_length(length)
        .header("content-type", &starlette_media_type(media_type))
        .map_err(|_| FastApiError::unhandled())
}

/// Keeps the original absolute deadline while consuming every upstream body chunk.
/// Errors are emitted once, then the response is dropped to cancel the upstream.
fn upstream_stream(response: brz_http::Response, deadline: Instant) -> ProxyStream {
    Box::pin(futures_util::stream::unfold(
        Some(response),
        move |response| async move {
            let mut response = response?;
            loop {
                if Instant::now() >= deadline {
                    return Some((Err(stream_deadline_error()), None));
                }
                match timeout_at(deadline, response.chunk()).await {
                    Ok(Ok(Some(chunk))) if chunk.is_empty() => continue,
                    Ok(Ok(Some(chunk))) => return Some((Ok(chunk), Some(response))),
                    Ok(Ok(None)) => return None,
                    Ok(Err(error)) => {
                        tracing::error!(%error, "LLM proxy upstream response body failed");
                        return Some((Err(std::io::Error::other(error.to_string())), None));
                    }
                    Err(_) => return Some((Err(stream_deadline_error()), None)),
                }
            }
        },
    ))
}

/// Distinguishes a response deadline from a clean upstream EOF.
fn stream_deadline_error() -> std::io::Error {
    tracing::error!("LLM proxy response body exceeded the request deadline");
    std::io::Error::new(
        std::io::ErrorKind::TimedOut,
        "LLM proxy request deadline exceeded",
    )
}

/// `LLM_PROXY_STREAM_HEADERS`' media type: Starlette appends `; charset=utf-8`
/// to a `text/*` media type that does not already declare a charset, so the
/// recorded `text/event-stream; charset=utf-8` is reproduced.
fn starlette_media_type(media_type: &str) -> String {
    if media_type.starts_with("text/") && !media_type.to_lowercase().contains("charset=") {
        format!("{media_type}; charset=utf-8")
    } else {
        media_type.to_string()
    }
}

/// `strip_long_context_suffix`: Claude Code addresses long-context models
/// through a `[1m]` alias that never names a Model CRD or upstream model.
fn strip_long_context_suffix(model_name: &str) -> String {
    let normalized = model_name.trim();
    let lowercase = normalized.to_lowercase();
    for suffix in LONG_CONTEXT_SUFFIXES {
        if normalized.len() > suffix.len() && lowercase.ends_with(suffix) {
            return normalized[..normalized.len() - suffix.len()]
                .trim_end()
                .to_string();
        }
    }
    normalized.to_string()
}

/// `_is_anthropic_messages_request`.
fn is_anthropic_messages_request(path: &str) -> bool {
    path.trim_end_matches('/').ends_with("/messages")
}

/// `_normalize_context_overflow`: translate a provider context-overflow error
/// for Anthropic clients, which need positive counts with `actual > limit` to
/// size their compaction.
fn normalize_context_overflow(
    status: StatusCode,
    body: &[u8],
    request_body_length: usize,
    context_window: Option<i64>,
) -> Option<Value> {
    if !CONTEXT_OVERFLOW_STATUSES.contains(&status.as_u16()) {
        return None;
    }
    let text = String::from_utf8_lossy(body);
    let lowered = text.to_lowercase();
    if !CONTEXT_OVERFLOW_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return None;
    }
    let mut actual_tokens = TOKEN_COUNT_PATTERN
        .captures_iter(&text)
        .filter_map(|captures| captures.get(1)?.as_str().parse::<i64>().ok())
        .max()
        .unwrap_or_else(|| {
            (i64::try_from(request_body_length / CONTEXT_OVERFLOW_CHARS_PER_TOKEN)
                .unwrap_or(i64::MAX))
            .max(1)
        });
    actual_tokens = actual_tokens.max(2);
    let limit_tokens = match context_window {
        Some(window) if window > 0 && window < actual_tokens => window,
        _ => (actual_tokens - 1).max(1),
    };
    Some(serde_json::json!({
        "type": "error",
        "error": {
            "type": "invalid_request_error",
            "message": format!(
                "prompt is too long: {actual_tokens} tokens > {limit_tokens} maximum"
            ),
        },
    }))
}

/// `_parse_request_body`.
fn parse_request_body(body: &[u8]) -> Result<(Value, String), FastApiError> {
    let value: Value = serde_json::from_slice(body).map_err(|_| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "LLM proxy request body must be valid JSON",
        )
    })?;
    let model_name = match &value {
        Value::Object(object) => object
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) | Value::Array(_) => {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                "LLM proxy request body must be an object",
            ));
        }
    };
    let model_name = model_name.ok_or_else(|| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "LLM proxy request body model is required",
        )
    })?;
    Ok((value, model_name))
}

/// `_required_header`.
fn required_header(value: Option<String>, name: &str) -> Result<String, FastApiError> {
    let value = value.unwrap_or_default();
    let value = value.trim();
    if value.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Missing {name} header"),
        ));
    }
    Ok(value.to_string())
}

/// `_resource_user_id`.
fn resource_user_id(value: Option<String>) -> Result<i64, FastApiError> {
    let raw = required_header(value, MODEL_USER_ID_HEADER)?;
    let parsed: i64 = raw.parse().map_err(|_| {
        FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Invalid {MODEL_USER_ID_HEADER} header"),
        )
    })?;
    if parsed < 0 {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Invalid {MODEL_USER_ID_HEADER} header"),
        ));
    }
    Ok(parsed)
}

/// `_merge_headers_case_insensitive`: later sources override earlier ones.
fn merge_headers_case_insensitive<const N: usize>(
    sources: [&[(String, String)]; N],
) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = Vec::new();
    for source in sources {
        for (name, value) in source {
            let normalized = name.to_lowercase();
            merged.retain(|(existing, _)| existing.to_lowercase() != normalized);
            merged.push((name.clone(), value.clone()));
        }
    }
    merged
}

/// `httpx.RequestError` mapping of the source's 502
/// (`HTTPException(502, f"Upstream request failed: {exc}")`).
fn httpx_request_error(message: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::BAD_GATEWAY,
        format!("Upstream request failed: {message}"),
    )
}

#[cfg(test)]
#[path = "llm_proxy_tests.rs"]
mod tests;
