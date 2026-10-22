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

use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use brz_http_server::{Bytes, HttpResponse, StatusCode};
use futures_util::Stream;
use serde_json::Value;

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::state::AppState;

pub(crate) mod model_config;

use model_config::{resolve_llm_proxy_protocol, resolve_upstream_target, validate_model_access};

/// `MODEL_TYPE_HEADER`.
const MODEL_TYPE_HEADER: &str = "x-wegent-model-type";
/// `MODEL_NAMESPACE_HEADER`.
const MODEL_NAMESPACE_HEADER: &str = "x-wegent-model-namespace";
/// `MODEL_USER_ID_HEADER`.
const MODEL_USER_ID_HEADER: &str = "x-wegent-model-user-id";
/// `UPSTREAM_HEADER_PREFIX`.
const UPSTREAM_HEADER_PREFIX: &str = "x-wegent-upstream-header-";
/// `SUPPORTED_MODEL_TYPES`.
const SUPPORTED_MODEL_TYPES: [&str; 3] = ["public", "user", "group"];
/// `PROTECTED_UPSTREAM_HEADERS` (normalized) plus the source's marker list.
const PROTECTED_UPSTREAM_HEADERS: [&str; 14] = [
    "accept",
    "authorization",
    "connection",
    "content-length",
    "content-type",
    "cookie",
    "host",
    "proxy-authorization",
    "set-cookie",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    MODEL_TYPE_HEADER,
];
/// `PROTECTED_UPSTREAM_HEADER_MARKERS`.
const PROTECTED_UPSTREAM_HEADER_MARKERS: [&str; 4] = ["api-key", "apikey", "credential", "token"];

/// `httpx.AsyncClient(timeout=600.0)`.
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(600);

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
/// Mirrors `app.services.llm_proxy_service.resolve_llm_proxy_provider_api_key`.
/// The open-source default returns the processed Model CRD value unchanged; an
/// internal deployment whose Model CRDs carry user-scoped placeholders
/// registers its own resolver before route construction.
#[async_trait]
pub trait LlmProxyCredentials: Send + Sync {
    /// Resolve the credential for `request`.
    ///
    /// # Errors
    /// Returns the source's `HTTPException` mapping when a deployment cannot
    /// resolve the credential it promised.
    async fn provider_api_key(
        &self,
        request: CredentialRequest<'_>,
    ) -> Result<String, FastApiError>;
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

/// The open-source credential resolver: the processed Model CRD value.
pub struct StoredLlmProxyCredentials;

#[async_trait]
impl LlmProxyCredentials for StoredLlmProxyCredentials {
    async fn provider_api_key(
        &self,
        request: CredentialRequest<'_>,
    ) -> Result<String, FastApiError> {
        Ok(request.api_key.to_string())
    }
}

/// The inbound request headers the proxy consumes.
struct InboundHeaders<'a> {
    model_type: Option<&'a str>,
    namespace: Option<&'a str>,
    model_user_id: Option<&'a str>,
    content_type: Option<&'a str>,
    accept: Option<&'a str>,
    wecode_action: Option<&'a str>,
    wecode_executor: Option<&'a str>,
    wecode_source: Option<&'a str>,
}

impl<'a> InboundHeaders<'a> {
    /// `_extract_custom_upstream_headers`: the Wework Runtime's forwarded
    /// identity headers with the `x-wegent-upstream-header-` prefix stripped,
    /// rejecting protected names.
    ///
    /// The source iterates every header carrying the prefix. The platform
    /// handler binds headers by name, so this forwards the prefix's declared
    /// members: `wecode-action` (set by the Wework Runtime) and
    /// `wecode-executor` / `wecode-source`
    /// (`app/services/chat/trigger/request_preparation.py`). The protected-name
    /// rejection and empty-name validation are preserved.
    fn custom_upstream_headers(&self) -> Result<Vec<(String, String)>, FastApiError> {
        let mut custom = Vec::new();
        for (name, value) in [
            ("x-wegent-upstream-header-wecode-action", self.wecode_action),
            (
                "x-wegent-upstream-header-wecode-executor",
                self.wecode_executor,
            ),
            ("x-wegent-upstream-header-wecode-source", self.wecode_source),
        ] {
            let Some(value) = value else { continue };
            let target_name = name[UPSTREAM_HEADER_PREFIX.len()..].trim();
            if target_name.is_empty() || target_name.starts_with('-') {
                return Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "Invalid custom upstream header name",
                ));
            }
            if is_protected_upstream_header(target_name) {
                return Err(FastApiError::detail(
                    StatusCode::BAD_REQUEST,
                    format!("Custom upstream header is protected: {target_name}"),
                ));
            }
            custom.push((target_name.to_string(), value.to_string()));
        }
        Ok(custom)
    }
}

/// `_is_protected_upstream_header`.
fn is_protected_upstream_header(name: &str) -> bool {
    let normalized = name.trim().to_lowercase().replace('_', "-");
    let parts: Vec<&str> = normalized.split('-').collect();
    PROTECTED_UPSTREAM_HEADERS.contains(&normalized.as_str())
        || parts.contains(&"auth")
        || parts.contains(&"authentication")
        || PROTECTED_UPSTREAM_HEADER_MARKERS
            .iter()
            .any(|marker| normalized.contains(marker))
}

/// `POST /api/runtime-work/llm-responses-proxy/responses`.
#[brz_http_server::post("/api/runtime-work/llm-responses-proxy/responses")]
#[allow(clippy::too_many_arguments)]
async fn llm_responses_proxy(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    #[header("x-wegent-model-type")] model_type: Option<&str>,
    #[header("x-wegent-model-namespace")] namespace: Option<&str>,
    #[header("x-wegent-model-user-id")] model_user_id: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("accept")] accept: Option<&str>,
    #[header("x-wegent-upstream-header-wecode-action")] wecode_action: Option<&str>,
    #[header("x-wegent-upstream-header-wecode-executor")] wecode_executor: Option<&str>,
    #[header("x-wegent-upstream-header-wecode-source")] wecode_source: Option<&str>,
    body: &[u8],
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let headers = InboundHeaders {
        model_type,
        namespace,
        model_user_id,
        content_type,
        accept,
        wecode_action,
        wecode_executor,
        wecode_source,
    };
    proxy_llm_responses(state, &user.0, &headers, body).await
}

/// `proxy_llm_responses`.
async fn proxy_llm_responses(
    state: &AppState,
    user: &UserRow,
    headers: &InboundHeaders<'_>,
    body: &[u8],
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let (mut body_json, model_name) = parse_request_body(body)?;
    let model_type = required_header(headers.model_type, MODEL_TYPE_HEADER)?;
    let namespace = required_header(headers.namespace, MODEL_NAMESPACE_HEADER)?;
    let resource_user_id = resource_user_id(headers.model_user_id)?;
    let model_config = resolve_model_config(
        state,
        user,
        &model_name,
        &model_type,
        &namespace,
        resource_user_id,
    )
    .await?;

    let provider_base_url = model_config.base_url.trim().to_string();
    let provider_api_key = state
        .llm_proxy_credentials
        .provider_api_key(CredentialRequest {
            api_key: &model_config.api_key,
            api_key_template: model_config.api_key_template.as_deref(),
            user_id: i64::from(user.id),
            user_name: &user.user_name,
        })
        .await?;
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

    let protocol = resolve_llm_proxy_protocol(&model_name, &model_config)?;
    let (upstream_path, auth_headers) = resolve_upstream_target(protocol, &provider_api_key);
    let upstream_url = model_config::join_upstream_url(&provider_base_url, &upstream_path);

    let custom = headers.custom_upstream_headers()?;
    let configured = model_config.default_headers.clone();
    // The deployed source builds the provider headers from the configured Model
    // CRD headers, the `x-wegent-upstream-header-` custom headers and the
    // protocol headers only. `RUNTIME_METADATA_HEADERS` forwarding landed in
    // Wegent-intra f577f2377 (2026-09-27), after the source revision pinned by
    // `.traffic-e2e/source-traffic-policy.yaml` (image build 1.0.538,
    // 2026-09-24), so it is not part of the recorded contract: forwarding those
    // headers adds five request headers the source never sent.
    let mut provider_headers =
        merge_headers_case_insensitive([configured.as_slice(), custom.as_slice()]);
    let mut protocol_headers = auth_headers;
    if let Some(content_type) = headers.content_type {
        protocol_headers.push(("content-type".to_string(), content_type.to_string()));
    }
    if let Some(accept) = headers.accept {
        protocol_headers.push(("accept".to_string(), accept.to_string()));
    }
    provider_headers =
        merge_headers_case_insensitive([provider_headers.as_slice(), protocol_headers.as_slice()]);

    forward_upstream(state, &upstream_url, &provider_headers, &body_bytes).await
}

/// `resolve_llm_proxy_model_config`.
async fn resolve_model_config(
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
    model_config::extract_and_process_model_config(&spec, i64::from(user.id), &user.user_name)
}

/// `forward_upstream`: send the native request and stream the upstream response.
///
/// The source builds a fresh `httpx.AsyncClient(timeout=600.0)` per call. The
/// request carries no connection-local state, so the target reuses the retained
/// pooled transport with the same 600-second budget instead of constructing a
/// client per request.
async fn forward_upstream(
    state: &AppState,
    upstream_url: &str,
    provider_headers: &[(String, String)],
    body: &[u8],
) -> Result<HttpResponse<ProxyStream>, FastApiError> {
    let mut request = state
        .attachment_http
        .post(upstream_url)
        .map_err(|error| httpx_request_error(&error.to_string()))?;
    for (name, value) in provider_headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let request = request.body(body.to_vec());
    let response = match request.timeout(UPSTREAM_TIMEOUT).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::error!(%error, "LLM proxy upstream request failed");
            return Err(httpx_request_error(&error.to_string()));
        }
    };
    let status = response.status();
    let upstream_content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let stream: ProxyStream = Box::pin(futures_util::stream::unfold(
        response,
        |mut response| async move {
            match response.chunk().await {
                Ok(Some(chunk)) if !chunk.is_empty() => {
                    Some((Ok::<Bytes, std::io::Error>(chunk), response))
                }
                Ok(_) => None,
                Err(error) => Some((Err(std::io::Error::other(error.to_string())), response)),
            }
        },
    ));

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
fn required_header(value: Option<&str>, name: &str) -> Result<String, FastApiError> {
    let value = value.unwrap_or("").trim();
    if value.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Missing {name} header"),
        ));
    }
    Ok(value.to_string())
}

/// `_resource_user_id`.
fn resource_user_id(value: Option<&str>) -> Result<i64, FastApiError> {
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
    fn protected_upstream_headers_match_source_rules() {
        assert!(is_protected_upstream_header("Authorization"));
        assert!(is_protected_upstream_header("x_api_key"));
        assert!(is_protected_upstream_header(MODEL_TYPE_HEADER));
        assert!(is_protected_upstream_header("x-my-auth-header"));
        assert!(!is_protected_upstream_header("wecode-action"));
    }

    #[test]
    fn required_header_and_resource_user_id_validate() {
        assert_eq!(required_header(Some(" x "), "h").unwrap(), "x");
        assert_eq!(
            required_header(Some("  "), "h").unwrap_err().status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(resource_user_id(Some("0")).unwrap(), 0);
        assert!(resource_user_id(Some("-1")).is_err());
        assert!(resource_user_id(Some("abc")).is_err());
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
