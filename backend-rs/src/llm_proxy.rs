// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/runtime-work/llm-responses-proxy/responses` — the authenticated
//! LLM proxy gateway for Wework cloud models.
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
//! `/chat/completions`, `/messages`) on one handler; only `/responses` has
//! recorded contract cases, so this module registers only that route until the
//! siblings are recorded.
//!
//! Unlike every other migrated API, this route is a hand-written `Handler`
//! rather than a `#[brz_http_server::post]` function: the source forwards every
//! inbound `x-wegent-upstream-header-*` header with its prefix stripped, and the
//! function API can only bind named header parameters. The handler therefore
//! reads the complete request header list, matching
//! `_extract_custom_upstream_headers` and `_extract_runtime_metadata_headers`.

use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use brz_http_server::{Bytes, HttpResponse, StatusCode};
use futures_util::Stream;
use serde_json::Value;
use tokio::time::{Instant, timeout_at};

use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::state::AppState;

pub(crate) mod model_config;
mod route;
mod transport;

pub use route::LlmResponsesProxyRoute;
#[cfg(test)]
pub(crate) use route::ROUTE_PATH;

use route::InboundHeaders;

use model_config::{resolve_llm_proxy_protocol, resolve_upstream_target, validate_model_access};

/// `MODEL_TYPE_HEADER`.
const MODEL_TYPE_HEADER: &str = "x-wegent-model-type";
/// `MODEL_NAMESPACE_HEADER`.
const MODEL_NAMESPACE_HEADER: &str = "x-wegent-model-namespace";
/// `MODEL_USER_ID_HEADER`.
const MODEL_USER_ID_HEADER: &str = "x-wegent-model-user-id";
/// `SUPPORTED_MODEL_TYPES`.
const SUPPORTED_MODEL_TYPES: [&str; 3] = ["public", "user", "group"];

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
    state: &AppState,
    http: &brz_http::Client,
    user: &UserRow,
    headers: &InboundHeaders<'_>,
    body: &[u8],
    deadline: Instant,
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let (mut body_json, model_name) = parse_request_body(body)?;
    let model_type = required_header(headers.first(MODEL_TYPE_HEADER), MODEL_TYPE_HEADER)?;
    let namespace = required_header(
        headers.first(MODEL_NAMESPACE_HEADER),
        MODEL_NAMESPACE_HEADER,
    )?;
    let resource_user_id = resource_user_id(headers.first(MODEL_USER_ID_HEADER))?;
    let model_config = timeout_at(
        deadline,
        resolve_model_config(
            state,
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

    if let Value::Object(object) = &mut body_json {
        object.insert("model".to_string(), Value::String(provider_model_id));
    }
    // The source re-serializes through `json.dumps(body_json)`, whose default
    // separators are `", "` / `": "` and whose `ensure_ascii=True` escapes every
    // non-ASCII character as `\uXXXX`; serde_json's compact literal rendering
    // would change both the byte length and the escaped content.
    let body_bytes = crate::json_compat::python_json_value(&body_json).into_bytes();

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
        deadline,
    )
    .await
}

/// `resolve_model_provider_api_key`: resolve for the caller, never the owner of
/// a shared Model, and map every resolver failure to the source's
/// `ModelCredentialError` response.
async fn resolve_provider_api_key(
    state: &AppState,
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
pub(crate) async fn resolve_model_config(
    state: &AppState,
    user: &UserRow,
    model_name: &str,
    model_type: &str,
    namespace: &str,
    resource_user_id: i64,
) -> Result<model_config::ModelConfig, FastApiError> {
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
    Ok(config)
}

/// `forward_upstream`: send the native request and stream the upstream response.
///
/// The source builds a fresh `httpx.AsyncClient(timeout=600.0)` per call. The
/// request carries no connection-local state, so the target reuses the retained
/// pooled transport, spending only the request budget remaining after credentials.
async fn forward_upstream(
    http: &brz_http::Client,
    upstream_url: &str,
    provider_headers: &[(String, String)],
    body: &[u8],
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
    let response = match timeout_at(deadline, request.timeout(remaining).send()).await {
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
    let stream = upstream_stream(response, deadline);

    // `text/event-stream` default and Starlette's `text/*` charset rendering.
    let media_type = upstream_content_type.unwrap_or_else(|| "text/event-stream".to_string());
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
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_body_requires_object_and_model() {
        let (_, model) = parse_request_body(br#"{"model":"m"}"#).unwrap();
        assert_eq!(model, "m");
        assert_eq!(
            parse_request_body(b"not json").unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
        assert!(parse_request_body(b"[]").is_err());
        assert!(parse_request_body(br#"{"model":"  "}"#).is_err());
        assert!(parse_request_body(br#"{}"#).is_err());
    }

    #[test]
    fn forwarded_body_renders_like_python_json_dumps() {
        // The recorded upstream request body is `json.dumps(body_json)`: the
        // `", "` / `": "` separators and `\uXXXX` non-ASCII escapes differ from
        // serde_json's compact rendering.
        let value: Value = serde_json::from_str(
            "{\"model\":\"旧\",\"messages\":[{\"content\":\"你好\",\"role\":\"user\"}]}",
        )
        .unwrap();
        let mut forwarded = value;
        if let Value::Object(object) = &mut forwarded {
            object.insert("model".to_string(), Value::String("m".to_string()));
        }
        let rendered = crate::json_compat::python_json_value(&forwarded);
        assert_eq!(
            rendered,
            "{\"model\": \"m\", \"messages\": [{\"content\": \"\\u4f60\\u597d\", \
             \"role\": \"user\"}]}"
        );
    }

    #[test]
    fn merge_headers_overrides_case_insensitively() {
        let a = vec![("X-A".to_string(), "1".to_string())];
        let b = vec![("x-a".to_string(), "2".to_string())];
        let merged = merge_headers_case_insensitive([a.as_slice(), b.as_slice()]);
        assert_eq!(merged, vec![("x-a".to_string(), "2".to_string())]);
    }

    #[test]
    fn starlette_media_type_appends_charset_only_for_text() {
        assert_eq!(
            starlette_media_type("text/event-stream"),
            "text/event-stream; charset=utf-8"
        );
        assert_eq!(
            starlette_media_type("text/event-stream; charset=utf-8"),
            "text/event-stream; charset=utf-8"
        );
        assert_eq!(starlette_media_type("application/json"), "application/json");
    }

    #[test]
    fn required_header_and_resource_user_id_validate() {
        assert_eq!(required_header(Some(" x ".to_string()), "h").unwrap(), "x");
        assert_eq!(
            required_header(Some("  ".to_string()), "h")
                .unwrap_err()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(resource_user_id(Some("0".to_string())).unwrap(), 0);
        assert!(resource_user_id(Some("-1".to_string())).is_err());
        assert!(resource_user_id(Some("abc".to_string())).is_err());
    }

    #[test]
    fn model_api_key_validation_matches_source() {
        assert_eq!(
            validate_model_api_key(" sk-1 ", false).as_deref(),
            Some("sk-1")
        );
        assert_eq!(validate_model_api_key("", false).as_deref(), Some(""));
        assert!(validate_model_api_key("", true).is_none());
        assert!(validate_model_api_key("${DEPLOYMENT_USER_API_KEY}", true).is_none());
        assert!(validate_model_api_key("a\nb", false).is_none());
        assert!(validate_model_api_key("a\rb", false).is_none());
    }

    #[test]
    fn protocol_selection_and_targets_match_source() {
        use model_config::ModelConfig;
        use model_config::Protocol;
        let responses = ModelConfig {
            protocol: Some("openai-responses".to_string()),
            ..ModelConfig::default()
        };
        assert_eq!(
            resolve_llm_proxy_protocol("m", &responses).unwrap(),
            Protocol::OpenAiResponses
        );
        let chat = ModelConfig {
            protocol: Some("openai".to_string()),
            api_format: Some("chat/completions".to_string()),
            ..ModelConfig::default()
        };
        assert_eq!(
            resolve_llm_proxy_protocol("m", &chat).unwrap(),
            Protocol::OpenAiChatCompletions
        );
        let anthropic = ModelConfig {
            protocol: Some("claude".to_string()),
            ..ModelConfig::default()
        };
        assert_eq!(
            resolve_llm_proxy_protocol("m", &anthropic).unwrap(),
            Protocol::AnthropicMessages
        );
        assert!(resolve_llm_proxy_protocol("m", &ModelConfig::default()).is_err());

        let (path, headers) = resolve_upstream_target(Protocol::OpenAiResponses, "sk-1");
        assert_eq!(path, "/responses");
        assert_eq!(
            headers,
            vec![("Authorization".into(), "Bearer sk-1".into())]
        );
        let (path, headers) = resolve_upstream_target(Protocol::OpenAiResponses, "");
        assert_eq!(path, "/responses");
        assert!(headers.is_empty());
    }

    #[test]
    fn join_and_defaults_match_source() {
        assert_eq!(
            model_config::join_upstream_url("https://llm.example.invalid/v1", "/responses"),
            "https://llm.example.invalid/v1/responses"
        );
        assert_eq!(
            model_config::join_upstream_url("https://api.openai.com/v1/responses", "/responses"),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            model_config::join_upstream_url("https://api.openai.com", "/responses"),
            "https://api.openai.com/responses"
        );
        let _ = json!({});
        assert_eq!(SUPPORTED_MODEL_TYPES.len(), 3);
    }
}
