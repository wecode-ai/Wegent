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

use std::{
    collections::{HashMap, HashSet, VecDeque},
    pin::Pin,
    sync::{Mutex, OnceLock},
};

use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Response,
};
use futures_util::{Stream, StreamExt};
use serde_json::{Map, Value};

use crate::logging::log_executor_event;

use super::{codex_responses_proxy_transform, HttpError};

pub(crate) const ROUTE: &str = "/v1/codex-responses-proxy/responses";

#[derive(Debug, Clone)]
pub(crate) struct LocalModelProxyUpstream {
    pub base_url: String,
    pub request_url: Option<String>,
    pub api_format: String,
    pub api_key: String,
    pub default_headers: Vec<(String, String)>,
    pub proxy_url: Option<String>,
}

pub(crate) fn register(upstream: LocalModelProxyUpstream) -> String {
    static NEXT_ID: OnceLock<Mutex<u64>> = OnceLock::new();
    let token = {
        let next_id = NEXT_ID.get_or_init(|| Mutex::new(0));
        let mut guard = next_id
            .lock()
            .expect("local model proxy token counter should not be poisoned");
        *guard += 1;
        format!("model-{}-{}", std::process::id(), *guard)
    };
    registry()
        .lock()
        .expect("local model proxy registry should not be poisoned")
        .insert(token.clone(), upstream);
    token
}

fn registry() -> &'static Mutex<HashMap<String, LocalModelProxyUpstream>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, LocalModelProxyUpstream>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) async fn handle(headers: HeaderMap, body: Bytes) -> Result<Response, HttpError> {
    let token = local_token(&headers).ok_or_else(|| HttpError {
        status: StatusCode::UNAUTHORIZED,
        detail: "missing local model proxy token".to_owned(),
    })?;
    let upstream = registry()
        .lock()
        .expect("local model proxy registry should not be poisoned")
        .get(&token)
        .cloned()
        .ok_or_else(|| HttpError {
            status: StatusCode::NOT_FOUND,
            detail: "unknown local model proxy token".to_owned(),
        })?;
    let request_url = upstream
        .request_url
        .clone()
        .unwrap_or_else(|| format!("{}/responses", upstream.base_url.trim_end_matches('/')));
    let (request_body, conversion, expanded_browser_tools) =
        prepare_request(&upstream.api_format, &body)?;
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
    let content_type = upstream_response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let is_converted = conversion.is_some();
    let mut response = match conversion {
        Some(Conversion::Chat(context)) => Response::new(Body::from_stream(
            chat::chat_sse_to_responses(upstream_response.bytes_stream(), context),
        )),
        Some(Conversion::Anthropic(context)) => Response::new(Body::from_stream(
            anthropic::anthropic_sse_to_responses(upstream_response.bytes_stream(), context),
        )),
        None => Response::new(Body::from_stream(normalize_responses_stream(
            upstream_response.bytes_stream(),
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

#[allow(clippy::type_complexity)]
fn prepare_request(
    api_format: &str,
    body: &[u8],
) -> Result<(Vec<u8>, Option<Conversion>, HashSet<String>), HttpError> {
    if api_format == "openai-responses" {
        let mut request_value =
            serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
                status: StatusCode::BAD_REQUEST,
                detail: format!("Invalid Codex Responses request: {error}"),
            })?;
        let expanded_browser_tools =
            codex_responses_proxy_transform::expand_wework_browser_namespace_tools(
                &mut request_value,
            );
        let body = serde_json::to_vec(&request_value).map_err(|error| HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("Failed to serialize local model request: {error}"),
        })?;
        return Ok((body, None, expanded_browser_tools));
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
}

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
    expanded_browser_tools: HashSet<String>,
}

fn normalize_responses_stream<S>(
    stream: S,
    expanded_browser_tools: HashSet<String>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, reqwest::Error>> + Send + 'static,
{
    let state = ResponsesStreamState {
        stream: Box::pin(stream),
        pending: String::new(),
        output: VecDeque::new(),
        expanded_browser_tools,
    };
    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(output) = state.output.pop_front() {
                return Some((output, state));
            }
            match state.stream.next().await {
                Some(Ok(bytes)) => {
                    state.pending.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(index) = state.pending.find("\n\n") {
                        let event = state.pending[..index].to_owned();
                        state.pending.drain(..index + 2);
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
                    return Some((Err(std::io::Error::other(error.to_string())), state));
                }
                None => return None,
            }
        }
    })
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

    use axum::{routing::post, Router};
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
            base_url,
            request_url: Some(request_url),
            api_format,
            api_key,
            default_headers: Vec::new(),
            proxy_url: None,
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
