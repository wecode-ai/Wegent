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
mod harness_protocol;
mod history;
mod image_budget;
mod long_context;
mod passthrough_stream;
mod progressive_tools;
mod request_body;
mod request_policy;
pub mod retry_notifications;
mod sse;
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
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::logging::log_executor_event;

use super::{codex_responses_proxy_transform, HttpError};
use fork::{codex_forked_from_thread_id, prepare_fork_request};
pub use request_policy::CodexRequestMode;

pub const API_KEY: &str = "wework-local-router";
pub const ROUTE: &str = "/v1/codex-router/responses";
pub const TOKEN_ROUTE: &str = "/v1/codex-router/{token}/responses";
pub const HARNESS_MESSAGES_ROUTE: &str = "/v1/harness-router/{token}/v1/messages";
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
const FORWARDED_CODEX_REQUEST_HEADERS: [&str; 16] = [
    "user-agent",
    "originator",
    "session-id",
    "thread-id",
    "x-client-request-id",
    "x-codex-installation-id",
    "x-codex-turn-state",
    "x-codex-turn-metadata",
    "x-codex-parent-thread-id",
    "x-codex-window-id",
    "x-codex-beta-features",
    "x-openai-subagent",
    "x-openai-memgen-request",
    "x-openai-internal-codex-responses-lite",
    "openai-beta",
    "x-responsesapi-include-timing-metrics",
];

pub fn route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    post(handle_bound_thread).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

pub fn token_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    post(handle_token_route).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

pub fn harness_messages_route<S>() -> MethodRouter<S>
where
    S: Clone + Send + Sync + 'static,
{
    post(handle_harness_messages).layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
}

#[derive(Debug, Clone, Deserialize)]
pub struct LocalModelProxyUpstream {
    pub base_url: String,
    pub request_url: Option<String>,
    pub api_format: String,
    pub convert_custom_tools: bool,
    pub native_tool_search: bool,
    pub native_namespace_tools: bool,
    #[serde(default)]
    pub codex_request_mode: CodexRequestMode,
    pub api_key: String,
    pub default_headers: Vec<(String, String)>,
    pub proxy_url: Option<String>,
    pub model_id: Option<String>,
    pub routing_model_id: Option<String>,
    pub max_output_tokens: Option<u64>,
    /// Model context window used to size the normalized prompt-too-long error
    /// reported to a harness client.
    #[serde(default)]
    pub model_context_window: Option<u64>,
}

pub fn register_harness(route_scope: &str, mut upstream: LocalModelProxyUpstream) -> String {
    upstream.api_format = canonical_upstream_api_format(&upstream.api_format);
    let upstream_endpoint = upstream
        .request_url
        .as_deref()
        .unwrap_or(upstream.base_url.as_str());
    let registration_fields = [
        ("route_scope", route_scope.to_owned()),
        ("api_format", upstream.api_format.clone()),
        ("upstream", safe_url(upstream_endpoint)),
        ("model_id", upstream.model_id.clone().unwrap_or_default()),
        ("auth_present", (!upstream.api_key.is_empty()).to_string()),
        (
            "default_headers",
            upstream.default_headers.len().to_string(),
        ),
    ];
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
    registry.routes.insert(
        token.clone(),
        RegisteredUpstream {
            upstream,
            vision_sidecar: None,
            text_only: false,
            history: Default::default(),
            thread_ids: HashSet::new(),
            last_routed_model: None,
            pending_model_switch_cleanup: false,
            last_used: Instant::now(),
            active_references: 1,
        },
    );
    log_executor_event(
        "harness model proxy registered",
        &[
            ("active_registrations", registry.routes.len().to_string()),
            registration_fields[0].clone(),
            registration_fields[1].clone(),
            registration_fields[2].clone(),
            registration_fields[3].clone(),
            registration_fields[4].clone(),
            registration_fields[5].clone(),
        ],
    );
    token
}

#[derive(Debug, Clone, Copy)]
struct ResponsesToolCapabilities {
    custom_tools: chat::CustomToolConversion,
    native_tool_search: bool,
    native_namespace_tools: bool,
    function_tools_only: bool,
}

impl LocalModelProxyUpstream {
    fn resolved_request_url(&self) -> String {
        self.request_url.clone().unwrap_or_else(|| {
            let path = match self.api_format.as_str() {
                "anthropic-messages" => "/messages",
                "openai-chat-completions" => "/chat/completions",
                _ => "/responses",
            };
            format!("{}{path}", self.base_url.trim_end_matches('/'))
        })
    }

    fn responses_tool_capabilities(&self) -> ResponsesToolCapabilities {
        if self.codex_request_mode == CodexRequestMode::Standard {
            return ResponsesToolCapabilities {
                custom_tools: chat::CustomToolConversion::All,
                native_tool_search: false,
                native_namespace_tools: false,
                function_tools_only: true,
            };
        }
        if self.codex_request_mode == CodexRequestMode::Passthrough {
            return ResponsesToolCapabilities {
                custom_tools: chat::CustomToolConversion::None,
                native_tool_search: true,
                native_namespace_tools: true,
                function_tools_only: false,
            };
        }
        // DeepSeek documents custom apply_patch only; other custom names return HTTP 400.
        // Match the actual endpoint, never a model-name substring or a failed-request guess.
        let deepseek_responses = self.api_format == "openai-responses"
            && url::Url::parse(&self.resolved_request_url())
                .ok()
                .is_some_and(|url| url.host_str() == Some("api.deepseek.com"));
        if deepseek_responses {
            return ResponsesToolCapabilities {
                custom_tools: if self.convert_custom_tools {
                    chat::CustomToolConversion::All
                } else {
                    chat::CustomToolConversion::ExceptApplyPatch
                },
                native_tool_search: false,
                native_namespace_tools: false,
                function_tools_only: false,
            };
        }
        ResponsesToolCapabilities {
            custom_tools: self.convert_custom_tools.into(),
            native_tool_search: self.native_tool_search,
            native_namespace_tools: self.native_namespace_tools,
            function_tools_only: false,
        }
    }
}

fn canonical_upstream_api_format(api_format: &str) -> String {
    match api_format.trim().to_ascii_lowercase().as_str() {
        "responses" | "openai-responses" => "openai-responses".to_owned(),
        "chat/completions" | "openai-chat-completions" => "openai-chat-completions".to_owned(),
        "messages" | "anthropic-messages" => "anthropic-messages".to_owned(),
        _ => api_format.trim().to_owned(),
    }
}

/// Validate request policy before selecting a proxy or the direct-provider path.
pub fn upstream_from_model_config(
    model_config: &Value,
) -> Result<Option<LocalModelProxyUpstream>, String> {
    let api_format = model_upstream_api_format(model_config);
    let codex_request_mode = model_config
        .get("codex_request_mode")
        .map(|value| serde_json::from_value::<CodexRequestMode>(value.clone()))
        .transpose()
        .map_err(|_| "codex_request_mode must be auto, standard or passthrough".to_owned())?
        .unwrap_or_default();
    codex_request_mode.validate(&api_format)?;
    let Some(base_url) = non_empty_string(model_config, "base_url")
        .or_else(|| non_empty_string(model_config, "baseUrl"))
    else {
        return Ok(None);
    };
    let api_key = non_empty_string(model_config, "api_key")
        .or_else(|| non_empty_string(model_config, "apiKey"))
        .or_else(|| non_empty_string(model_config, "auth_token"))
        .unwrap_or_default();
    Ok(Some(LocalModelProxyUpstream {
        base_url: base_url.trim_end_matches('/').to_owned(),
        request_url: non_empty_string(model_config, "responses_url")
            .or_else(|| non_empty_string(model_config, "responsesUrl"))
            .or_else(|| non_empty_string(model_config, "request_url"))
            .or_else(|| non_empty_string(model_config, "requestUrl")),
        api_format,
        codex_request_mode,
        convert_custom_tools: non_empty_string(model_config, "tool_profile")
            .or_else(|| non_empty_string(model_config, "toolProfile"))
            .map_or(true, |profile| !profile.eq_ignore_ascii_case("custom")),
        native_tool_search: boolean_value(model_config, "native_tool_search")
            .or_else(|| boolean_value(model_config, "nativeToolSearch"))
            .unwrap_or(false),
        native_namespace_tools: boolean_value(model_config, "native_namespace_tools")
            .or_else(|| boolean_value(model_config, "nativeNamespaceTools"))
            .unwrap_or(false),
        api_key,
        default_headers: header_pairs(model_config.get("default_headers")),
        proxy_url: model_config
            .get("proxy")
            .and_then(|proxy| {
                non_empty_string(proxy, "url").or_else(|| non_empty_string(proxy, "proxy_url"))
            })
            .or_else(|| non_empty_string(model_config, "proxy_url")),
        model_id: non_empty_string(model_config, "model_id")
            .or_else(|| non_empty_string(model_config, "modelId")),
        routing_model_id: None,
        max_output_tokens: model_max_output_tokens(model_config),
        model_context_window: model_config
            .get("model_context_window")
            .or_else(|| model_config.get("context_window"))
            .or_else(|| model_config.get("contextWindow"))
            .and_then(Value::as_u64)
            .filter(|value| *value > 0),
    }))
}

fn model_upstream_api_format(model_config: &Value) -> String {
    canonical_upstream_api_format(
        &non_empty_string(model_config, "upstream_api_format")
            .or_else(|| non_empty_string(model_config, "upstreamApiFormat"))
            .or_else(|| non_empty_string(model_config, "api_format"))
            .unwrap_or_else(|| "openai-responses".to_owned()),
    )
}

/// Use the same output reservation for proxy requests and Codex compaction.
pub fn model_max_output_tokens(model_config: &Value) -> Option<u64> {
    ["max_output_tokens", "maxOutputTokens"]
        .iter()
        .filter_map(|key| model_config.get(key))
        .find_map(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str()?.trim().parse().ok())
                .filter(|value| *value > 0)
        })
        .or_else(|| {
            matches!(
                model_upstream_api_format(model_config).as_str(),
                "openai-chat-completions" | "anthropic-messages"
            )
            .then_some(DEFAULT_MAX_OUTPUT_TOKENS)
        })
}

fn non_empty_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn boolean_value(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

fn header_pairs(value: Option<&Value>) -> Vec<(String, String)> {
    match value {
        Some(Value::Object(headers)) => headers
            .iter()
            .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_owned())))
            .collect(),
        _ => Vec::new(),
    }
}

#[derive(Debug, Clone)]
pub struct VisionSidecarUpstream {
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
    text_only: bool,
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
pub fn register(route_scope: &str, upstream: LocalModelProxyUpstream) -> String {
    register_with_vision_sidecar(route_scope, upstream, None)
}

pub fn register_with_vision_sidecar(
    route_scope: &str,
    mut upstream: LocalModelProxyUpstream,
    vision_sidecar: Option<VisionSidecarUpstream>,
) -> String {
    upstream.api_format = canonical_upstream_api_format(&upstream.api_format);
    let upstream_endpoint = upstream
        .request_url
        .as_deref()
        .unwrap_or(upstream.base_url.as_str());
    let registration_fields = [
        ("route_scope", route_scope.to_owned()),
        ("api_format", upstream.api_format.clone()),
        ("upstream", safe_url(upstream_endpoint)),
        ("model_id", upstream.model_id.clone().unwrap_or_default()),
        (
            "routing_model_id",
            upstream.routing_model_id.clone().unwrap_or_default(),
        ),
        ("auth_present", (!upstream.api_key.is_empty()).to_string()),
        (
            "default_headers",
            upstream.default_headers.len().to_string(),
        ),
    ];
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
            text_only: false,
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
            registration_fields[0].clone(),
            registration_fields[1].clone(),
            registration_fields[2].clone(),
            registration_fields[3].clone(),
            registration_fields[4].clone(),
            registration_fields[5].clone(),
            registration_fields[6].clone(),
        ],
    );
    token
}

pub fn mark_model_switch(token: &str) {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    if let Some(registered) = registry.routes.get_mut(token) {
        registered.pending_model_switch_cleanup = true;
        registered.last_used = Instant::now();
    }
}

pub fn set_text_only(token: &str) {
    if let Some(route) = registry()
        .lock()
        .expect("model registry lock")
        .routes
        .get_mut(token)
    {
        route.text_only = true;
    }
}

fn text_only_request(body: &[u8]) -> Result<Vec<u8>, HttpError> {
    let mut value: Value = serde_json::from_slice(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("invalid text generation request: {error}"),
    })?;
    if let Some(object) = value.as_object_mut() {
        object.insert("tools".to_owned(), json!([]));
        object.insert("tool_choice".to_owned(), json!("none"));
        object.remove("parallel_tool_calls");
        if let Some(input) = object.get_mut("input").and_then(Value::as_array_mut) {
            input.retain(|item| item["type"] != "additional_tools");
            for item in input {
                if item["type"] == "tool_search_output" {
                    item["tools"] = json!([]);
                }
            }
        }
    }
    Ok(serde_json::to_vec(&value).expect("JSON request serializes"))
}

#[cfg(test)]
mod text_only_tests {
    use super::*;

    #[test]
    fn text_only_request_does_not_expose_lite_or_discovered_definitions() {
        let body = json!({"input":[{"type":"additional_tools","tools":[{"type":"custom","name":"exec"}]},{"type":"tool_search_output","call_id":"search","tools":[{"type":"function","name":"private_tool"}]},{"type":"message","role":"user","content":"Predict text only"}]});
        let sanitized: Value = serde_json::from_slice(
            &text_only_request(&serde_json::to_vec(&body).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(sanitized["tools"], json!([]));
        assert_eq!(sanitized["tool_choice"], "none");
        assert_eq!(sanitized["input"][0]["tools"], json!([]));
        assert_eq!(sanitized["input"][1]["content"], "Predict text only");
        assert!(!sanitized.to_string().contains("private_tool"));
        assert!(!sanitized.to_string().contains("additional_tools"));
    }

    #[test]
    fn text_only_request_preserves_prompt_schema_and_model_without_tools() {
        let body = json!({
            "model": "independent-predictor", "input": "Predict next reply",
            "tools": [{"type": "function", "name": "exec_command"}],
            "tool_choice": "required", "parallel_tool_calls": true,
            "text": {"format": {"type": "json_schema"}}
        });
        let sanitized: Value = serde_json::from_slice(
            &text_only_request(&serde_json::to_vec(&body).unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(sanitized["tools"], json!([]));
        assert_eq!(sanitized["tool_choice"], "none");
        assert!(sanitized.get("parallel_tool_calls").is_none());
        assert_eq!(sanitized["input"], body["input"]);
        assert_eq!(sanitized["model"], body["model"]);
        assert_eq!(sanitized["text"], body["text"]);
    }
}

pub fn bind_thread(token: &str, thread_id: &str) -> Result<(), String> {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    if !registry.routes.contains_key(token) {
        return Err("local model proxy task route is not registered".to_owned());
    }
    let mut reassigned_routes = 0;
    for (registered_token, registered) in &mut registry.routes {
        if registered_token != token && registered.thread_ids.remove(thread_id) {
            reassigned_routes += 1;
        }
    }
    let registered = registry
        .routes
        .get_mut(token)
        .expect("validated local model proxy task route should exist");
    registered.thread_ids.insert(thread_id.to_owned());
    registered.last_used = Instant::now();
    log_executor_event(
        "local model proxy bound task thread",
        &[
            ("thread_id", thread_id.to_owned()),
            ("bound_threads", registered.thread_ids.len().to_string()),
            ("reassigned_routes", reassigned_routes.to_string()),
        ],
    );
    Ok(())
}

pub fn bind_fork_thread(token: &str, thread_id: &str) -> Result<(), String> {
    bind_thread(token, thread_id)?;
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    // Subsequent sends use the new thread ID as task ID and must reuse this route.
    registry.tokens_by_scope.retain(|_, value| value != token);
    registry
        .tokens_by_scope
        .insert(thread_id.to_owned(), token.to_owned());
    Ok(())
}

pub fn unregister(token: &str) {
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

pub fn unregister_harness(token: &str) {
    let mut registry = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned");
    let removed = registry.routes.remove(token).is_some();
    registry.tokens_by_scope.retain(|_, value| value != token);
    log_executor_event(
        "harness model proxy unregistered",
        &[
            ("removed", removed.to_string()),
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

struct RequestThreadIdentity {
    thread_id: String,
    parent_thread_id: Option<String>,
}

#[derive(Debug)]
enum Conversion {
    Chat(chat::ToolContext),
    Anthropic(chat::ToolContext),
    Responses(chat::ToolContext),
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

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;

mod handlers;

mod request_identity;

mod request_preparation;

mod upstream_transport;

mod responses_stream;
#[cfg(test)]
use handlers::bound_thread_token;
use handlers::handle_bound_thread;
#[cfg(test)]
use handlers::handle_for_token;
use handlers::handle_harness_messages;
pub(super) use handlers::handle_token_route;
#[cfg(any(test, feature = "test-support"))]
pub use handlers::thread_has_bound_route;
#[cfg(test)]
use handlers::token_route_token;
use request_identity::authorize_task_thread;
use request_identity::begin_model_request;
use request_identity::commit_model_request;
use request_identity::log_stale_requested_model;
use request_identity::prepare_model_switch_request;
use request_identity::request_thread_identity;
use request_identity::request_tool_diagnostic_fields;
use request_identity::rewrite_request_model;
#[cfg(test)]
use request_identity::stale_requested_model;
use request_preparation::diagnostic_upstream_stream;
use request_preparation::normalized_responses_api_id;
#[cfg(test)]
use request_preparation::prepare_request;
use request_preparation::prepare_request_with_history;
#[cfg(test)]
use request_preparation::prepare_request_with_model_hint;
pub(super) use responses_stream::is_responses_terminal_event;
use responses_stream::normalize_responses_event;
use responses_stream::normalize_responses_stream;
#[cfg(test)]
use responses_stream::responses_event_diagnostics;
#[cfg(test)]
use responses_stream::responses_event_values;
pub(super) use responses_stream::responses_failed_event;
#[cfg(test)]
use responses_stream::rewrite_responses_event;
pub(super) use sse::{append_stream_utf8, finish_stream_utf8, take_sse_block};
use upstream_transport::bearer_token;
#[cfg(test)]
use upstream_transport::build_upstream_request;
use upstream_transport::detect_upstream_error_code;
use upstream_transport::is_event_stream_content_type;
use upstream_transport::proxy_client;
use upstream_transport::proxy_client_without_redirects;
#[cfg(test)]
use upstream_transport::rate_limit_retry_delay;
use upstream_transport::safe_url;
use upstream_transport::send_upstream_request_with_rate_limit_retry;
