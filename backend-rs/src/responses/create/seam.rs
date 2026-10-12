// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The create flow's dispatch seam
//! (`openapi_responses.py:_create_non_streaming_response_unified` /
//! `_create_streaming_response_unified` + `execution/dispatcher.py`).
//!
//! After `setup_chat_session` and `build_execution_request`, the create flow
//! routes the request (`ExecutionRouter.route`) and branches on whether the
//! target streams:
//!
//! * a non-SSE (executor) target is dispatched fire-and-forget and the caller
//!   receives the `queued` `ResponseObject` immediately;
//! * an SSE (chat-shell) target blocks: with `stream=True` it returns the SSE
//!   framing (`text/event-stream`), otherwise it waits for the chat-shell
//!   stream and, on a transport failure, renders the source's
//!   `500 {"detail": "LLM request failed: Connection error."}`.
//!
//! The chat-shell upstream is the deployment's `CHAT_SHELL_URL`; the recorded
//! create cases reach it with no server listening, so the dispatch fails with
//! the openai client's `Connection error.` message.
use std::io;
use std::pin::Pin;
use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_http_server::{Bytes, HttpResponse, StatusCode};
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::state::AppState;

use super::dispatch::{self, ExecutionRequest};
use super::executor_client::{DEFAULT_EXECUTOR_MANAGER_URL, EXECUTOR_MANAGER_URL_ENV};
use super::request::{BuildExecutionRequestInput, build_execution_request};
use super::response_object::ResponseObject;
use super::routing::{self, RouteInputs};
use super::session::ChatSessionSetup;
use super::streaming::{SSE_CONTENT_TYPE, framing_events, request_shell_type};

/// The boxed byte stream the create handler returns.
pub type BodyStream = Pin<Box<dyn futures_util::Stream<Item = Result<Bytes, io::Error>> + Send>>;

/// `settings.CHAT_SHELL_URL`.
pub fn chat_shell_url() -> String {
    std::env::var(routing::CHAT_SHELL_URL_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| routing::DEFAULT_CHAT_SHELL_URL.to_string())
}

/// `settings.EXECUTOR_MANAGER_URL`.
pub fn executor_manager_url() -> String {
    std::env::var(EXECUTOR_MANAGER_URL_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_EXECUTOR_MANAGER_URL.to_string())
}

/// `settings.WEB_SEARCH_ENABLED` (source default `False`).
pub fn web_search_enabled() -> bool {
    std::env::var("WEB_SEARCH_ENABLED")
        .ok()
        .is_some_and(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
}

/// The create flow's post-resolution dispatch inputs.
pub struct DispatchInput<'a> {
    pub user_id: i64,
    pub user_name: &'a str,
    pub request_id: &'a str,
    pub team: &'a super::resolution::KindRow,
    pub bot: &'a super::resolution::KindRow,
    pub bot_role: &'a str,
    pub team_member_prompt: Option<&'a str>,
    pub input_text: &'a str,
    pub task_json: &'a Value,
    pub setup: &'a ChatSessionSetup,
    pub message_id: i64,
    pub is_group_chat: bool,
    pub stream: bool,
    pub background: bool,
    pub previous_response_id: Option<String>,
    /// The caller's model string (echoed in the response).
    pub model_string: &'a str,
    /// `enable_tools`: `enable_chat_bot or current/inherited KB refs`.
    pub enable_tools: bool,
    /// `enable_chat_bot` (`wegent_chat_bot` in the request tools).
    pub enable_chat_bot: bool,
    pub enable_web_search: bool,
}

/// `_create_non_streaming_response_unified` / `_create_streaming_response_
/// unified`: build, route, dispatch, and render the create response.
pub async fn dispatch_create(
    state: &AppState,
    input: &DispatchInput<'_>,
) -> Result<HttpResponse<BodyStream>, FastApiError> {
    let request = build_execution_request(
        state,
        &BuildExecutionRequestInput {
            user_id: input.user_id,
            user_name: input.user_name,
            task_id: input.setup.task_id,
            assistant_subtask_id: input.setup.assistant_subtask_id,
            user_subtask_id: input.setup.user_subtask_id,
            team: input.team,
            bot: input.bot,
            bot_role: input.bot_role,
            team_member_prompt: input.team_member_prompt,
            message: input.input_text,
            enable_tools: input.enable_tools,
            enable_web_search: input.enable_web_search,
            enable_deep_thinking: input.enable_chat_bot,
            task_json: input.task_json,
            request_id: input.request_id,
            message_id: input.message_id,
            is_group_chat: input.is_group_chat,
        },
    )
    .await?;

    let shell_type = request_shell_type(&request);
    let chat_shell = chat_shell_url();
    let executor_manager = executor_manager_url();
    let model_protocol = request.model_config.get("protocol").and_then(Value::as_str);
    let target = routing::route(&RouteInputs {
        shell_type: &shell_type,
        chat_shell_url: &chat_shell,
        executor_manager_url: &executor_manager,
        device_id: None,
        model_is_video: false,
        model_protocol,
    });

    let created_at = chrono::Utc::now().timestamp();
    if !routing::supports_streaming(&target) {
        // Non-SSE: fire-and-forget the executor dispatch and return `queued`.
        if let Some(url) = target.url.as_deref() {
            enqueue_executor_dispatch(state, url, &request).await;
        }
        // A just-created assistant subtask carries `result = null`, so
        // `build_response_output` yields no items.
        let object = ResponseObject::queued(
            input.setup.task_id,
            created_at,
            input.model_string,
            Vec::new(),
            input.previous_response_id.clone(),
        );
        return json_response(&object);
    }

    // SSE target (chat-shell).
    if input.stream && !input.background {
        // The stream opens with the two framing events; the chat-shell dispatch
        // (enqueued on the startup-owned worker) feeds the events a reachable
        // upstream appends.
        enqueue_chat_shell_dispatch(state, &target.url, &request, input.request_id).await;
        let events = framing_events(
            input.setup.task_id,
            created_at,
            input.model_string,
            input.previous_response_id.clone(),
        );
        return Ok(sse_response(events));
    }

    if input.background {
        enqueue_chat_shell_dispatch(state, &target.url, &request, input.request_id).await;
        let object = ResponseObject::in_progress(
            input.setup.task_id,
            created_at,
            input.model_string,
            input.previous_response_id.clone(),
        );
        return json_response(&object);
    }

    // SSE sync: wait for the chat-shell stream. A transport failure renders the
    // source's `500 {"detail": "LLM request failed: Connection error."}`.
    if let Some(url) = target.url.as_deref()
        && let Err(message) = dispatch_chat_shell_sync(url, &request, input.request_id).await
    {
        return Err(FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("LLM request failed: {message}"),
        ));
    }
    let object = ResponseObject {
        id: format!("resp_{}", input.setup.task_id),
        object: "response",
        created_at,
        status: "completed",
        error: None,
        model: input.model_string.to_string(),
        output: Vec::new(),
        pending_user_input: None,
        pending_user_input_payload: None,
        previous_response_id: input.previous_response_id.clone(),
    };
    json_response(&object)
}

/// `_dispatch_http_callback`: enqueue the fire-and-forget executor-manager
/// dispatch on the startup-owned worker.
async fn enqueue_executor_dispatch(state: &AppState, target_url: &str, request: &ExecutionRequest) {
    let payload = dispatch::assemble(request, false, true);
    let body = serde_json::to_value(&payload).unwrap_or(Value::Null);
    let url = super::executor_client::executor_responses_url(target_url);
    state
        .responses_dispatch
        .submit(crate::responses::dispatch::DispatchJob::Executor { url, body })
        .await;
}

/// `_dispatch_sse`: open the chat-shell stream. The recorded cases only reach
/// the transport-failure branch, so this returns `Err("Connection error.")` for
/// a connect failure and `Ok(())` once the upstream accepts the request.
async fn dispatch_chat_shell_sync(
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
) -> Result<(), String> {
    let payload = dispatch::assemble(request, true, false);
    let url = format!("{}/v1/responses", target_url.trim_end_matches('/'));
    let client = HttpClient::builder()
        .build()
        .map_err(|_| "Connection error.".to_string())?;
    let body = serde_json::to_value(&payload).unwrap_or(Value::Null);
    // `AsyncOpenAI(base_url=f"{target.url}/v1")` with `stream=True` and the
    // `X-Request-ID` propagation header.
    let result = client
        .post(&url)
        .map_err(|_| "Connection error.".to_string())?
        .header("content-type", "application/json")
        .header("X-Request-ID", request_id)
        .json(&body)
        .timeout(Duration::from_secs(300))
        .send()
        .await;
    match result {
        // A reachable chat-shell streams the OpenAI responses events; the sync
        // path only needs to know the connection opened.
        Ok(_) => Ok(()),
        Err(_) => Err("Connection error.".to_string()),
    }
}

/// Enqueue the fire-and-forget chat-shell dispatch for the streaming response.
async fn enqueue_chat_shell_dispatch(
    state: &AppState,
    target: &Option<String>,
    request: &ExecutionRequest,
    request_id: &str,
) {
    let Some(url) = target.clone() else {
        return;
    };
    let payload = dispatch::assemble(request, true, false);
    let body = serde_json::to_value(&payload).unwrap_or(Value::Null);
    state
        .responses_dispatch
        .submit(crate::responses::dispatch::DispatchJob::ChatShell {
            url: format!("{}/v1/responses", url.trim_end_matches('/')),
            request_id: request_id.to_string(),
            body,
        })
        .await;
}

/// A JSON response whose media type matches the source's `JSONResponse`.
fn json_response(object: &ResponseObject) -> Result<HttpResponse<BodyStream>, FastApiError> {
    let bytes = serde_json::to_vec(object).map_err(|error| {
        tracing::error!(%error, "failed to serialize the create response");
        FastApiError::internal()
    })?;
    let length = bytes.len() as u64;
    let stream: BodyStream = Box::pin(futures_util::stream::once(async move {
        Ok::<Bytes, io::Error>(Bytes::from(bytes))
    }));
    HttpResponse::new(stream)
        .content_length(length)
        .header("content-type", "application/json")
        .map_err(|_| FastApiError::internal())
}

/// The `text/event-stream` response with the source's streaming headers.
fn sse_response(events: Vec<Bytes>) -> HttpResponse<BodyStream> {
    let stream: BodyStream = Box::pin(futures_util::stream::iter(
        events.into_iter().map(Ok::<Bytes, io::Error>),
    ));
    let response = HttpResponse::new(stream)
        .header("content-type", SSE_CONTENT_TYPE)
        .expect("a literal content type");
    let response = response
        .header("cache-control", "no-cache")
        .expect("a literal cache-control");
    response
        .header("x-accel-buffering", "no")
        .expect("a literal x-accel-buffering")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_shell_and_executor_defaults_match_the_source() {
        // The source defaults, used when the deployment sets neither URL.
        assert_eq!(routing::DEFAULT_CHAT_SHELL_URL, "http://127.0.0.1:8100");
        assert_eq!(DEFAULT_EXECUTOR_MANAGER_URL, "http://localhost:8001");
    }
}
