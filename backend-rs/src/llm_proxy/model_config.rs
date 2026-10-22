// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Model CRD configuration extraction for the LLM proxy gateway.
//!
//! Mirrors `app/services/chat/config/model_resolver._extract_model_config`,
//! `_process_model_config_placeholders`, `resolve_llm_proxy_protocol`,
//! `_resolve_upstream_target`, `_join_upstream_url`, and
//! `llm_proxy_service._validate_model_access`. Only the fields the proxy
//! consumes are projected; the optional capability/codex-catalog fields the
//! source logs are not read on this path.

use brz_http_server::StatusCode;
use serde_json::Value;

use crate::auth::UserRow;
use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `WEGENT_IDENTITY_HEADER_MARKER`.
const WEGENT_IDENTITY_HEADER_MARKER: &str = "wegent-agent-";
/// `_extract_model_config`'s `base_url` default.
const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
/// `_extract_model_config`'s `model_id` default.
const DEFAULT_MODEL_ID: &str = "gpt-4";

/// The resolved Model CRD configuration consumed by the proxy.
#[derive(Debug, Default)]
pub(crate) struct ModelConfig {
    /// The processed `api_key`.
    pub api_key: String,
    /// The raw Model CRD `api_key` when it carried a placeholder, mirroring the
    /// source's `_api_key_template`.
    pub api_key_template: Option<String>,
    pub base_url: String,
    pub model_id: String,
    /// `default_headers` after placeholder processing, in declaration order.
    pub default_headers: Vec<(String, String)>,
    pub api_format: Option<String>,
    pub protocol: Option<String>,
}

/// The shared wire protocol a Model CRD maps to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Protocol {
    OpenAiResponses,
    OpenAiChatCompletions,
    AnthropicMessages,
}

/// `extract_and_process_model_config`.
pub(crate) fn extract_and_process_model_config(
    spec: &Value,
    user_id: i64,
    user_name: &str,
) -> Result<ModelConfig, FastApiError> {
    let mut config = extract_model_config(spec)?;
    process_placeholders(&mut config, user_id, user_name);
    Ok(config)
}

/// `_extract_model_config`.
fn extract_model_config(spec: &Value) -> Result<ModelConfig, FastApiError> {
    let model_config = spec.get("modelConfig").and_then(Value::as_object);
    let env = model_config
        .and_then(|config| config.get("env"))
        .and_then(Value::as_object)
        // The source raises `ValueError("Model config has no env configuration")`
        // which reaches the application's unhandled-exception handler.
        .ok_or_else(FastApiError::unhandled)?;

    let raw_api_key = string_field(env.get("api_key"));
    let api_key =
        crate::git_repositories::crypto::decrypt_git_token(&resolve_env_placeholder(&raw_api_key))
            .map_err(|_| FastApiError::unhandled())?;
    let base_url = string_or(env.get("base_url"), DEFAULT_BASE_URL);
    let model_id = string_or(env.get("model_id"), DEFAULT_MODEL_ID);
    let env_model = string_field(env.get("model")).trim().to_lowercase();

    let mut default_headers = default_headers(model_config, env);
    if let Some(custom) = env.get("custom_headers").and_then(Value::as_object) {
        for (name, value) in custom {
            let Some(value) = value.as_str() else {
                continue;
            };
            if let Some((_, previous)) = default_headers.iter_mut().find(|(key, _)| key == name) {
                *previous = value.to_owned();
            } else {
                default_headers.push((name.clone(), value.to_owned()));
            }
        }
    }

    let api_format = spec
        .get("apiFormat")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            model_config
                .and_then(|config| config.get("apiFormat"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty());
    let mut protocol = spec
        .get("protocol")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            model_config
                .and_then(|config| config.get("protocol"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|value| !value.is_empty());
    if protocol.is_none() {
        protocol = match env_model.as_str() {
            "openai" => Some("openai".to_string()),
            "claude" => Some("claude".to_string()),
            _ => None,
        };
    }
    let api_format = api_format.or_else(|| match protocol.as_deref() {
        Some("openai-responses") => Some("responses".to_string()),
        Some("openai") => Some("chat/completions".to_string()),
        _ => None,
    });

    let api_key_template = raw_api_key.contains("${").then(|| raw_api_key.clone());
    Ok(ModelConfig {
        api_key,
        api_key_template,
        base_url,
        model_id,
        default_headers,
        api_format,
        protocol,
    })
}

/// `_process_model_config_placeholders` for `api_key` and `default_headers`.
fn process_placeholders(config: &mut ModelConfig, user_id: i64, user_name: &str) {
    if config.api_key.contains("${") {
        let sources = PlaceholderSources {
            user_id,
            user_name,
            config,
        };
        let processed = sources.replace(&config.api_key.clone());
        // The source only assigns a truthy replacement.
        if !processed.is_empty() {
            config.api_key = processed;
        }
    }
    if config.default_headers.is_empty() {
        return;
    }
    let processed: Vec<(String, String)> = {
        let sources = PlaceholderSources {
            user_id,
            user_name,
            config,
        };
        config
            .default_headers
            .iter()
            .map(|(name, value)| (name.clone(), sources.replace(value)))
            .collect()
    };
    // `strip_empty_wegent_headers` then `encode_wegent_header_values`.
    config.default_headers = processed
        .into_iter()
        .filter(|(name, value)| {
            !(name.to_lowercase().contains(WEGENT_IDENTITY_HEADER_MARKER)
                && value.trim().is_empty())
        })
        .map(|(name, value)| {
            if name.to_lowercase().contains(WEGENT_IDENTITY_HEADER_MARKER) {
                (name, encode_wegent_header_value(&value))
            } else {
                (name, value)
            }
        })
        .collect();
}

/// The `data_sources` map used by `replace_placeholders_with_sources`.
struct PlaceholderSources<'a> {
    user_id: i64,
    user_name: &'a str,
    config: &'a ModelConfig,
}

impl PlaceholderSources<'_> {
    /// `replace_placeholders_with_sources`.
    fn replace(&self, template: &str) -> String {
        let mut result = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(start) = rest.find("${") {
            result.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else {
                result.push_str(&rest[start..]);
                return result;
            };
            result.push_str(&self.resolve(&after[..end]));
            rest = &after[end + 1..];
        }
        result.push_str(rest);
        result
    }

    /// `resolve_value_from_source` over the fixed source set.
    fn resolve(&self, spec: &str) -> String {
        let (source, path) = spec.split_once('.').unwrap_or(("agent_config", spec));
        let user_name = self.user_name;
        match source {
            "user" => match path {
                "id" => self.user_id.to_string(),
                "name" | "user_name" => user_name.to_string(),
                _ => String::new(),
            },
            "model_config" => match path {
                "api_key" => self.config.api_key.clone(),
                "base_url" => self.config.base_url.clone(),
                "model_id" => self.config.model_id.clone(),
                _ => String::new(),
            },
            // `task_data.user.*` is populated from the caller context; the proxy
            // path has no Team context, so nested Team fields resolve empty.
            "task_data" => match path {
                "user.id" => self.user_id.to_string(),
                "user.name" | "user.user_name" => user_name.to_string(),
                _ => String::new(),
            },
            "env" => self
                .config
                .default_headers
                .iter()
                .find(|(name, _)| name == path)
                .map(|(_, value)| value.clone())
                .unwrap_or_default(),
            // `agent_config` is empty on the proxy path.
            _ => String::new(),
        }
    }
}

/// `resolve_env_placeholder`: `${ENV_VAR}` substitution from `os.environ`.
fn resolve_env_placeholder(value: &str) -> String {
    if !value.contains("${") {
        return value.to_string();
    }
    let mut result = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        result.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            result.push_str(&rest[start..]);
            return result;
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(resolved) => result.push_str(&resolved),
            // An unknown variable keeps the placeholder verbatim.
            Err(_) => result.push_str(&rest[start..start + 2 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    result.push_str(rest);
    result
}

/// `_extract_model_config`'s `default_headers` resolution chain.
fn default_headers(
    model_config: Option<&serde_json::Map<String, Value>>,
    env: &serde_json::Map<String, Value>,
) -> Vec<(String, String)> {
    if let Some(headers) = model_config
        .and_then(|config| config.get("DEFAULT_HEADERS"))
        .and_then(headers_from_value)
    {
        return headers;
    }
    if let Some(headers) = env.get("DEFAULT_HEADERS").and_then(headers_from_value) {
        return headers;
    }
    if let Some(headers) = executor_env_default_headers() {
        return headers;
    }
    std::env::var("DEFAULT_HEADERS")
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| headers_from_value(&value))
        .unwrap_or_default()
}

/// `settings.EXECUTOR_ENV`'s `DEFAULT_HEADERS`.
fn executor_env_default_headers() -> Option<Vec<(String, String)>> {
    let raw = std::env::var("EXECUTOR_ENV").ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.get("DEFAULT_HEADERS").and_then(headers_from_value)
}

/// Decode a `DEFAULT_HEADERS` value (object, or a JSON string of an object).
fn headers_from_value(value: &Value) -> Option<Vec<(String, String)>> {
    let object = match value {
        Value::Object(object) => object.clone(),
        Value::String(text) => match serde_json::from_str::<Value>(text).ok()? {
            Value::Object(object) => object,
            _ => return None,
        },
        _ => return None,
    };
    if object.is_empty() {
        return None;
    }
    Some(
        object
            .into_iter()
            .map(|(name, value)| {
                let value = match value {
                    Value::String(value) => value,
                    other => other.to_string(),
                };
                (name, value)
            })
            .collect(),
    )
}

/// `_encode_wegent_header_value`.
fn encode_wegent_header_value(value: &str) -> String {
    use base64::Engine as _;
    if value.is_ascii() {
        return value.to_string();
    }
    format!(
        "b64:{}",
        base64::engine::general_purpose::STANDARD.encode(value.as_bytes())
    )
}

/// `resolve_llm_proxy_protocol`.
pub(super) fn resolve_llm_proxy_protocol(
    model_name: &str,
    config: &ModelConfig,
) -> Result<Protocol, FastApiError> {
    let api_format = config
        .api_format
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let protocol = config
        .protocol
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_lowercase();

    let is_anthropic = matches!(protocol.as_str(), "claude" | "anthropic-messages");
    let is_chat_completions = api_format == "chat/completions"
        || matches!(protocol.as_str(), "openai" | "openai-chat-completions");
    let is_responses = api_format == "responses" || protocol == "openai-responses";

    if protocol == "openai-responses" && api_format == "chat/completions" {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!(
                "Model '{model_name}' has conflicting protocol/apiFormat: \
                 protocol={protocol:?}, api_format={api_format:?}. \
                 Use protocol 'openai-responses' with apiFormat 'responses'."
            ),
        ));
    }
    if is_anthropic && api_format == "responses" {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!(
                "Model '{model_name}' has conflicting protocol/apiFormat: \
                 protocol={protocol:?}, api_format={api_format:?}. \
                 Anthropic Messages does not support apiFormat 'responses'."
            ),
        ));
    }
    if is_anthropic {
        return Ok(Protocol::AnthropicMessages);
    }
    if is_responses {
        return Ok(Protocol::OpenAiResponses);
    }
    if is_chat_completions {
        return Ok(Protocol::OpenAiChatCompletions);
    }
    Err(FastApiError::detail(
        StatusCode::BAD_REQUEST,
        format!(
            "Model '{model_name}' has an unsupported or ambiguous protocol/apiFormat \
             configuration: protocol={protocol:?}, api_format={api_format:?}. \
             Please update the Model CRD: use protocol 'openai-responses' with \
             apiFormat 'responses' for OpenAI Responses, protocol 'openai' with \
             apiFormat 'chat/completions' for OpenAI Chat Completions, or protocol \
             'claude'/'anthropic-messages' for Anthropic Messages."
        ),
    ))
}

/// `_resolve_upstream_target`: `(endpoint path, authentication headers)`.
pub(super) fn resolve_upstream_target(
    protocol: Protocol,
    provider_api_key: &str,
) -> (String, Vec<(String, String)>) {
    if protocol == Protocol::AnthropicMessages {
        let mut headers = vec![("anthropic-version".to_string(), "2023-06-01".to_string())];
        if !provider_api_key.is_empty() {
            headers.push(("x-api-key".to_string(), provider_api_key.to_string()));
        }
        return ("/v1/messages".to_string(), headers);
    }
    let mut headers = Vec::new();
    if !provider_api_key.is_empty() {
        headers.push((
            "Authorization".to_string(),
            format!("Bearer {provider_api_key}"),
        ));
    }
    let endpoint = if protocol == Protocol::OpenAiResponses {
        "/responses"
    } else {
        "/chat/completions"
    };
    (endpoint.to_string(), headers)
}

/// `_join_upstream_url`: append an endpoint path without duplicating an
/// existing trailing path segment.
pub(super) fn join_upstream_url(base_url: &str, endpoint_path: &str) -> String {
    let trimmed = base_url.trim();
    let (scheme, remainder) = trimmed
        .split_once("://")
        .map_or(("", trimmed), |(scheme, rest)| (scheme, rest));
    let (authority, path) = remainder.find('/').map_or((remainder, ""), |index| {
        (&remainder[..index], &remainder[index..])
    });
    let base_segments: Vec<&str> = path.split('/').filter(|seg| !seg.is_empty()).collect();
    let endpoint_segments: Vec<&str> = endpoint_path
        .trim()
        .split('/')
        .filter(|seg| !seg.is_empty())
        .collect();
    let max_overlap = base_segments.len().min(endpoint_segments.len());
    let overlap = (1..=max_overlap)
        .rev()
        .find(|&size| base_segments[base_segments.len() - size..] == endpoint_segments[..size])
        .unwrap_or(0);
    let mut segments = base_segments;
    segments.extend_from_slice(&endpoint_segments[overlap..]);
    let joined = segments.join("/");
    if joined.is_empty() {
        format!("{scheme}://{authority}")
    } else {
        format!("{scheme}://{authority}/{joined}")
    }
}

/// `_validate_model_access`.
pub(super) async fn validate_model_access(
    state: &AppState,
    user: &UserRow,
    model_type: &str,
    namespace: &str,
    resource_user_id: i64,
) -> Result<(), FastApiError> {
    if !super::SUPPORTED_MODEL_TYPES.contains(&model_type) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Unsupported cloud model type: {model_type}"),
        ));
    }
    let current_user_id = i64::from(user.id);
    let allowed = match model_type {
        "user" => namespace == "default" && resource_user_id == current_user_id,
        "public" => namespace == "default" && resource_user_id == 0,
        _ => {
            namespace != "default"
                && user_groups(state, user)
                    .await?
                    .iter()
                    .any(|group| group == namespace)
        }
    };
    if !allowed {
        return Err(FastApiError::detail(
            StatusCode::FORBIDDEN,
            "Cloud model access denied",
        ));
    }
    Ok(())
}

/// `get_user_groups` for the group-model access check.
async fn user_groups(state: &AppState, user: &UserRow) -> Result<Vec<String>, FastApiError> {
    let erp = crate::teams::group_membership::ErpContext {
        erp: state.erp.as_ref(),
        redis: state.redis.as_ref(),
    };
    crate::skills::skills_unified::get_user_groups(&state.mysql, &erp, user.id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "LLM proxy group membership resolution failed");
            FastApiError::unhandled()
        })
}

/// `str(env.get("api_key") or "")`.
fn string_field(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

/// `env.get(key, default)` for a string field.
fn string_or(value: Option<&Value>, default: &str) -> String {
    match value {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => default.to_string(),
    }
}
