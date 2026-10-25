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
//!   framing (`text/event-stream`), otherwise it consumes the chat-shell
//!   stream ([`super::sse_sync`]) and renders the completed response from the
//!   persisted assistant turn. A transport or terminal failure renders the
//!   source's `500 {"detail": "LLM request failed: <message>"}`.
//!
//! The chat-shell upstream is the deployment's `CHAT_SHELL_URL`.
use std::io;
use std::pin::Pin;

use brz_http_server::{Bytes, HttpResponse, StatusCode};
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::internal_callback::completion;
use crate::state::AppState;

use super::dispatch::{self, ExecutionRequest};
use super::executor_client::{DEFAULT_EXECUTOR_MANAGER_URL, EXECUTOR_MANAGER_URL_ENV};
use super::request::{BuildExecutionRequestInput, build_execution_request};
use super::response_object::ResponseObject;
use super::routing::{self, RouteInputs};
use super::session::ChatSessionSetup;
use super::streaming::{SSE_CONTENT_TYPE, request_shell_type};

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
    /// The assistant subtask's `bot_ids` (`_get_bot_for_subtask`'s input).
    pub bot_ids: &'a [i64],
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
    /// The Task row's `project_id` (`_merge_project_workspace`).
    pub task_project_id: i64,
    /// The assistant subtask row's executor identity.
    pub executor_name: &'a str,
    pub executor_namespace: &'a str,
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
            bot_ids: input.bot_ids,
            message: input.input_text,
            enable_tools: input.enable_tools,
            enable_web_search: input.enable_web_search,
            enable_deep_thinking: input.enable_chat_bot,
            task_json: input.task_json,
            request_id: input.request_id,
            message_id: input.message_id,
            is_group_chat: input.is_group_chat,
            task_project_id: input.task_project_id,
            executor_name: input.executor_name,
            executor_namespace: input.executor_namespace,
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
    // `_update_subtask_to_running` (`dispatcher.py:166`): every dispatch mode
    // flips the assistant subtask to RUNNING before it is dispatched, and the
    // committed change re-derives the Task CRD's status.
    mark_subtask_running(state, request.subtask_id).await;
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

    // SSE target (chat-shell): stream the transformed upstream events to the
    // caller (`raw_chat_stream` + `create_streaming_response`).
    if input.stream && !input.background {
        let events = super::streaming_bridge::stream(
            state,
            &request,
            &super::streaming_bridge::BridgeInput {
                model_string: input.model_string,
                previous_response_id: input.previous_response_id.clone(),
                request_id: input.request_id,
                created_at,
                target_url: target.url.as_deref(),
            },
        )?;
        return Ok(sse_stream_response(events));
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

    // SSE sync: consume the chat-shell stream, persist its terminal state, and
    // render the completed response from the stored assistant turn. A transport
    // or terminal failure renders the source's
    // `500 {"detail": "LLM request failed: <message>"}`.
    let Some(url) = target.url.as_deref() else {
        return Err(FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "LLM request failed: Chat Shell SSE dispatch requires a target URL",
        ));
    };
    let collected =
        super::sse_sync::collect(state, url, &request, input.request_id, request.message_id)
            .await
            .map_err(|message| {
                FastApiError::detail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("LLM request failed: {message}"),
                )
            })?;

    // `_query_subtasks` + `_filter_current_assistant_turn`: only the assistant
    // subtask this request created contributes output items.
    let subtasks = super::super::responses_repository::list_subtasks_for_user_ordered(
        state.task_store.as_ref(),
        input.setup.task_id,
        i32::try_from(input.user_id).unwrap_or(i32::MAX),
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "responses sync subtask read failed");
        FastApiError::internal()
    })?;
    let active: Vec<_> = subtasks
        .into_iter()
        .filter(|subtask| subtask.id == input.setup.assistant_subtask_id)
        .collect();
    let output = super::super::output_builder::build_response_output(
        &active,
        &state.auth,
        Some(super::super::output_builder::ActiveAssistant {
            subtask_id: input.setup.assistant_subtask_id,
            status: "completed",
            content: &collected.content,
        }),
    )
    .map_err(|error| {
        tracing::error!(?error, "responses sync output build failed");
        FastApiError::internal()
    })?;
    let output: Vec<Value> = output
        .iter()
        .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
        .collect();

    let object = ResponseObject {
        id: format!("resp_{}", input.setup.task_id),
        object: "response",
        created_at,
        status: "completed",
        error: None,
        model: input.model_string.to_string(),
        output,
        pending_user_input: None,
        pending_user_input_payload: None,
        previous_response_id: input.previous_response_id.clone(),
    };
    json_response(&object)
}

/// `ExecutionDispatcher._update_subtask_to_running`
/// (`app/services/execution/dispatcher.py:335-355`): mark the dispatched
/// assistant subtask RUNNING and re-derive the Task CRD. The source's
/// `update_subtask_status` commits before the task status update, and its
/// after-commit hook publishes the run metrics; a store failure only logs.
async fn mark_subtask_running(state: &AppState, subtask_id: i64) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let ctx = completion::Completion {
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    completion::mark_subtask_running(&ctx, subtask_id).await;
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
    sse_stream_response(stream)
}

/// The `text/event-stream` response over a lazy body stream.
fn sse_stream_response(stream: BodyStream) -> HttpResponse<BodyStream> {
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
