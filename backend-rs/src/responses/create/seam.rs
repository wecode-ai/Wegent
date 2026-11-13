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

use super::dispatch::ExecutionRequest;
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
    if routing::chat_shell_mode() == "package" {
        return super::package_runtime::base_url();
    }
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
    /// `openapi_responses.py:755` / `:1122-1123`'s `created_at`, captured
    /// after the session setup and reused by every response branch.
    pub created_at: i64,
    pub user_id: i64,
    pub user_name: &'a str,
    /// The request user's `users.git_info`, classified into the Git identity
    /// and `git_auth_transport` by `build_execution_request`.
    pub user_git_info: &'a Value,
    /// The request user's `users.preferences`, read by `_build_skill_data`.
    pub user_preferences: Option<&'a str>,
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
    /// The request's normalized knowledge-base refs
    /// (`_get_current_knowledge_base_refs`).
    pub knowledge_base_refs: &'a [super::schema::KbToolRef],
    /// The legacy `knowledge_base_names` fallback parameter.
    pub knowledge_base_names: &'a [super::schema::KbToolRef],
    /// `enable_chat_bot` (`wegent_chat_bot` in the request tools).
    pub enable_chat_bot: bool,
    pub enable_web_search: bool,
    /// The API `reasoning` selection (`ReasoningConfig`).
    pub reasoning: Option<&'a super::reasoning::ReasoningConfig>,
}

/// Which response branch one routed create request takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CreateBranch {
    /// `!supports_streaming && stream && !background`
    /// (`openapi_responses.py:675` -> `_create_streaming_response_unified`'s
    /// HTTP+Callback branch, `:1323-1379`).
    CallbackStream,
    /// `!supports_streaming` without streaming: queued `ResponseObject`.
    Queued,
    /// `supports_streaming && stream && !background`: chat-shell SSE.
    ChatShellStream,
    /// `supports_streaming && background`: dispatched in the background.
    ChatShellBackground,
    /// `supports_streaming` without stream/background: consume and render.
    ChatShellSync,
}

/// `create_response`'s stream gate (`openapi_responses.py:675`) combined with
/// the routing target. `background` wins over `stream` for the non-streaming
/// response, exactly as the source's `if request_body.stream and not
/// request_body.background` does.
fn create_branch(streaming_target: bool, stream: bool, background: bool) -> CreateBranch {
    let streams = stream && !background;
    match (streaming_target, streams) {
        (true, true) => CreateBranch::ChatShellStream,
        (true, false) if background => CreateBranch::ChatShellBackground,
        (true, false) => CreateBranch::ChatShellSync,
        (false, true) => CreateBranch::CallbackStream,
        (false, false) => CreateBranch::Queued,
    }
}

/// `_create_non_streaming_response_unified` / `_create_streaming_response_
/// unified`: build, route, dispatch, and render the create response.
pub async fn dispatch_create(
    state: &AppState,
    input: &DispatchInput<'_>,
) -> Result<HttpResponse<BodyStream>, FastApiError> {
    // The caller captured `created_at` at the source's point (after setup,
    // before the user/team reloads and this builder), so the response
    // timestamp never includes their work.
    let created_at = input.created_at;
    let mut request = match build_execution_request(
        state,
        &BuildExecutionRequestInput {
            user_id: input.user_id,
            user_name: input.user_name,
            user_git_info: input.user_git_info,
            user_preferences: input.user_preferences,
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
            knowledge_base_refs: input.knowledge_base_refs,
            knowledge_base_names: input.knowledge_base_names,
            web_runtime_guidance: false,
            subtask_bot_resolved: false,
            enable_web_search: input.enable_web_search,
            enable_deep_thinking: input.enable_chat_bot,
            reasoning: input.reasoning,
            task_json: input.task_json,
            request_id: input.request_id,
            message_id: input.message_id,
            is_group_chat: input.is_group_chat,
            task_project_id: input.task_project_id,
            executor_name: input.executor_name,
            executor_namespace: input.executor_namespace,
            executor_deleted: input.setup.assistant_executor_deleted,
            new_session: false,
        },
    )
    .await
    {
        Ok(request) => request,
        Err(error) => {
            // The source's `try` around `build_execution_request` persists a
            // terminal FAILED result before every raise
            // (`openapi_responses.py:788-853`, `:1085-1219`).
            persist_build_failure(
                state,
                input.setup.task_id,
                input.setup.assistant_subtask_id,
                build_failure_message(&error),
            )
            .await;
            return Err(error);
        }
    };

    let shell_type = request_shell_type(&request);
    let chat_shell_mode = routing::chat_shell_mode();
    let chat_shell = chat_shell_url();
    let executor_manager = executor_manager_url();
    let model_protocol = request.model_config.get("protocol").and_then(Value::as_str);
    let target = routing::route(&RouteInputs {
        shell_type: &shell_type,
        chat_shell_mode: &chat_shell_mode,
        chat_shell_url: &chat_shell,
        executor_manager_url: &executor_manager,
        device_id: None,
        model_is_video: false,
        model_protocol,
    });

    let branch = create_branch(
        routing::supports_streaming(&target),
        input.stream,
        input.background,
    );
    // Executor recovery runs inside the dispatch job. A callback stream
    // subscribes before submitting it, and a queued create can return promptly.
    if branch != CreateBranch::CallbackStream
        && target.mode != routing::CommunicationMode::HttpCallback
    {
        recover_before_dispatch(state, &mut request, None).await?;
        mark_subtask_running(state, request.subtask_id).await;
    }
    if matches!(branch, CreateBranch::CallbackStream | CreateBranch::Queued) {
        // `openapi_responses.py:1323-1379`: an executor target still streams
        // when the caller asked for it — subscribe to the callback channel,
        // dispatch fire-and-forget, and forward the pushed events as SSE. Only
        // the non-streaming request renders the queued response.
        if branch == CreateBranch::CallbackStream {
            let events = super::streaming_bridge::stream_callback(
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
        // Non-streaming: fire-and-forget the executor dispatch and return
        // `queued`.
        if let Some(url) = target.url.as_deref() {
            if target.mode == routing::CommunicationMode::Inprocess {
                enqueue_chat_shell_dispatch(state, Some(url), request.clone(), input.request_id);
            } else {
                // The non-streaming OpenAPI path creates no Task of its own,
                // so its START carries no `task:created` frame.
                enqueue_executor_dispatch(state, url, &request, None);
            }
        }
        // `openapi_responses.py:936-942`: the source also queries the task's
        // subtasks here and renders the output from the current assistant turn.
        // A just-created subtask carries `result = null`, so the `queued`
        // output stays empty, but the read is request behavior.
        let output = current_assistant_output(
            state,
            input.setup.task_id,
            input.user_id,
            input.setup.assistant_subtask_id,
            "in_progress",
            "",
        )
        .await?;
        let object = ResponseObject::queued(
            input.setup.task_id,
            created_at,
            input.model_string,
            output,
            input.previous_response_id.clone(),
        );
        return json_response(&object);
    }

    // SSE target (chat-shell): stream the transformed upstream events to the
    // caller (`raw_chat_stream` + `create_streaming_response`).
    if branch == CreateBranch::ChatShellStream {
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

    if branch == CreateBranch::ChatShellBackground {
        enqueue_chat_shell_dispatch(state, target.url.as_deref(), request, input.request_id);
        // `openapi_responses.py:985-1006`: after starting the background work
        // the source queries the task's subtasks (`_query_subtasks`) and renders
        // the in-progress response from the current assistant turn. The
        // just-created subtask carries `result = null`, so the output is empty,
        // but the read and its filtered turn are still request behavior.
        let output = current_assistant_output(
            state,
            input.setup.task_id,
            input.user_id,
            input.setup.assistant_subtask_id,
            "in_progress",
            "",
        )
        .await?;
        let (pending_user_input, pending_user_input_payload) =
            super::response_object::extract_pending_user_input_state();
        let object = ResponseObject {
            id: format!("resp_{}", input.setup.task_id),
            object: "response",
            created_at,
            status: "in_progress",
            error: None,
            model: input.model_string.to_string(),
            output,
            pending_user_input: pending_user_input.then_some(true),
            pending_user_input_payload,
            previous_response_id: input.previous_response_id.clone(),
        };
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
    let consumer = super::sse_sync::ConsumerContext::from_app(state);
    let collected = super::sse_sync::collect(
        &consumer,
        url,
        &request,
        input.request_id,
        request.message_id,
    )
    .await
    .map_err(|message| {
        FastApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("LLM request failed: {message}"),
        )
    })?;

    // `_query_subtasks` + `_filter_current_assistant_turn`: only the assistant
    // subtask this request created contributes output items.
    let output = current_assistant_output(
        state,
        input.setup.task_id,
        input.user_id,
        input.setup.assistant_subtask_id,
        "completed",
        &collected.content,
    )
    .await?;

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

/// `_query_subtasks` (`openapi_responses.py:900-909`) plus
/// `_filter_current_assistant_turn` (`openapi_responses.py:223-227`): list the
/// task's subtasks on a fresh session and keep only the assistant turn this
/// request created. Only that subtask contributes output items
/// (`build_response_output`).
async fn current_assistant_output(
    state: &AppState,
    task_id: i64,
    user_id: i64,
    assistant_subtask_id: i64,
    status: &'static str,
    content: &str,
) -> Result<Vec<Value>, FastApiError> {
    let subtasks = super::super::responses_repository::list_subtasks_for_user_ordered_labeled(
        state.task_store.as_ref(),
        task_id,
        i32::try_from(user_id).unwrap_or(i32::MAX),
    )
    .await
    .map_err(|error| {
        tracing::error!(%error, "responses subtask read failed");
        FastApiError::internal()
    })?;
    let active: Vec<_> = subtasks
        .into_iter()
        .filter(|subtask| subtask.id == assistant_subtask_id)
        .collect();
    let output = super::super::output_builder::build_response_output(
        &active,
        &state.auth,
        Some(super::super::output_builder::ActiveAssistant {
            subtask_id: assistant_subtask_id,
            status,
            content,
        }),
    )
    .map_err(|error| {
        tracing::error!(?error, "responses output build failed");
        FastApiError::internal()
    })?;
    Ok(output
        .iter()
        .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
        .collect())
}

/// The `error_message` the source persists before it raises
/// (`openapi_responses.py:788-853`): `str(e)` for its `ValueError` and generic
/// branches, and `_exception_message(e)` for `HTTPException`, which is the
/// error's `detail` (`:257-261`). The same value is what the client receives.
fn build_failure_message(error: &FastApiError) -> &str {
    error.detail_message().unwrap_or("Internal Server Error")
}

/// `_persist_terminal_failure` (`openapi_responses.py:367-388`): collect the
/// terminal result, then persist the FAILED subtask/task state and clean the
/// streaming state up. The callback pipeline runs the same collect + persist
/// work (`internal_callback/pipeline.rs`), so reuse those helpers.
async fn persist_build_failure(state: &AppState, task_id: i64, subtask_id: i64, message: &str) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let ctx = completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    let result =
        completion::collect_completed_result(&ctx, subtask_id, "FAILED", None, Some(message), None)
            .await;
    completion::persist_completed_result(
        &ctx,
        task_id,
        subtask_id,
        "FAILED",
        result.as_ref(),
        Some(message),
        None,
        None,
    )
    .await;
}

/// `ExecutionDispatcher._update_subtask_to_running`
/// (`app/services/execution/dispatcher.py:335-355`): mark the dispatched
/// assistant subtask RUNNING and re-derive the Task CRD. The source's
/// `update_subtask_status` commits before the task status update, and its
/// after-commit hook publishes the run metrics; a store failure only logs.
pub(crate) async fn mark_subtask_running(state: &AppState, subtask_id: i64) {
    let Some(redis) = state.redis.as_ref() else {
        return;
    };
    let ctx = completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables: crate::internal_callback::tables(state),
        executor_manager: &state.executor_manager,
    };
    completion::mark_subtask_running(&ctx, subtask_id, false).await;
}

pub(crate) async fn claim_executor_dispatch(state: &AppState, subtask_id: i64) -> bool {
    let tables = crate::internal_callback::tables(state);
    let Some(redis) = state.redis.as_ref() else {
        return completion::claim_running_subtask(&state.mysql, tables, subtask_id)
            .await
            .inspect_err(
                |error| tracing::warn!(subtask_id, %error, "executor dispatch claim failed"),
            )
            .unwrap_or(false);
    };
    let ctx = completion::Completion {
        app: Some(state),
        mysql: &state.mysql,
        redis,
        tables,
        executor_manager: &state.executor_manager,
    };
    completion::mark_subtask_running(&ctx, subtask_id, true).await
}

/// `ExecutionDispatcher._resolve_device_route_id` (`dispatcher.py:391-415`):
/// map a submitted device identity to its heartbeat connection route. A missing
/// owned row falls back to the submitted route; it never errors or drops the
/// device routing.
async fn resolve_device_route_id(
    state: &AppState,
    request: &ExecutionRequest,
    device_id: Option<&str>,
) -> Result<Option<String>, FastApiError> {
    let Some(device_id) = device_id else {
        return Ok(None);
    };
    if request.user.get("id").and_then(Value::as_i64).is_none()
        || has_fork_workspace_archive(request)
    {
        return Ok(Some(device_id.to_string()));
    }
    match crate::device_identity::resolve_owned_device_alias(
        &state.mysql,
        request.user_id,
        device_id,
    )
    .await
    {
        Ok(Some(device)) => Ok(Some(crate::device_identity::device_connection_route_id(
            &device,
        ))),
        Ok(None) => Ok(Some(device_id.to_string())),
        Err(error) => {
            tracing::error!(%error, task_id = request.task_id, "device route resolution failed");
            Err(FastApiError::internal())
        }
    }
}

/// `_has_fork_workspace_archive`: a fork runtime with a stored archive keeps
/// its submitted route.
fn has_fork_workspace_archive(request: &ExecutionRequest) -> bool {
    request
        .fork_runtime
        .as_ref()
        .and_then(|runtime| runtime.get("workspaceArchive"))
        .and_then(|archive| archive.get("storageKey"))
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
}

/// `ExecutionDispatcher._dispatch_websocket` (`dispatcher.py:571-620`): set
/// the device executor on the subtask, emit the START pair on `/chat`, then
/// publish `task:execute` to the device room.
async fn dispatch_device_turn(
    state: &AppState,
    request: &ExecutionRequest,
    created_task: Option<crate::internal_callback::emitter::CreatedTask>,
    device_route: &str,
) -> Result<(), FastApiError> {
    set_subtask_executor(state, request, device_route).await?;
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(task_id = request.task_id, "device dispatch has no Redis");
        return Err(FastApiError::internal());
    };
    let shell = routing::shell_type(request);
    if let Err(error) = crate::internal_callback::publish_chat_start(
        redis,
        request.task_id,
        request.subtask_id,
        Value::String(request.bot_name.clone()),
        &shell,
        request.message_id,
    )
    .await
    {
        tracing::error!(%error, task_id = request.task_id, "chat:start emit failed");
        return Err(FastApiError::internal());
    }
    if let Some(created) = created_task.as_ref()
        && let Err(error) =
            crate::internal_callback::publish_task_created(redis, request.task_id, created).await
    {
        tracing::error!(%error, task_id = request.task_id, "task:created emit failed");
        return Err(FastApiError::internal());
    }
    let mut payload = super::dispatch::device_execution_payload(request, device_route);
    if let Some(user) = payload.get_mut("user").and_then(Value::as_object_mut) {
        user.remove("git_token");
        user.remove("gitToken");
    }
    payload["git_auth_transport"] = serde_json::json!("device_local");
    let message = crate::socketio_emit::device_execution_message(
        "task:execute",
        &payload,
        "/local-executor",
        &format!("device:{}:{device_route}", request.user_id),
    );
    use brz_redis::Redis as _;
    if let Err(error) = redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        tracing::error!(%error, task_id = request.task_id, "task:execute publish failed");
        return Err(FastApiError::internal());
    }
    Ok(())
}

/// `SubtaskStore.update_executor_info` (`dispatcher.py:417-454`): the subtask's
/// executor identity must name the device before its progress/result events
/// pass the device namespace's ownership check.
async fn set_subtask_executor(
    state: &AppState,
    request: &ExecutionRequest,
    runtime_device_id: &str,
) -> Result<(), FastApiError> {
    let tables = state.task_store.table_templates();
    let mysql = state
        .mysql
        .route(crate::task_routing::ByTaskId(request.task_id as u64));
    // `update_executor_info`'s `db.query(...).first()` is a different shape
    // from the shared no-limit `db.refresh` helper, so this call site adds the
    // Source's `LIMIT 1`.
    let read = format!(
        "{} \n LIMIT 1",
        crate::task_store_statements::subtask_by_id_labeled_refresh_statement(tables.subtasks)
    );
    let row: Option<brz_mysql::MysqlRow> = mysql
        .fetch_optional(read, (request.subtask_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, subtask_id = request.subtask_id, "executor subtask read failed");
            FastApiError::internal()
        })?;
    if row.is_none() {
        return Ok(());
    }
    // `_set_subtask_executor`'s subtask session also loads the subtask's
    // contexts (`WHERE subtask_id IN (?) ORDER BY id ASC`) before the update.
    let contexts = format!(
        "SELECT {} \nFROM subtask_contexts \n\
         WHERE subtask_contexts.subtask_id IN (?) \
         ORDER BY subtask_contexts.id ASC",
        crate::task_store_listing::subtask_context_columns()
    );
    let _rows: Vec<brz_mysql::MysqlRow> = mysql
        .fetch_all(contexts, (request.subtask_id,))
        .await
        .map_err(|error| {
            tracing::error!(%error, subtask_id = request.subtask_id, "subtask contexts read failed");
            FastApiError::internal()
        })?;
    use brz_mysql::MysqlTransaction as _;
    let now = chrono::Local::now().naive_local();
    mysql
        .with_transaction(async |transaction| {
            transaction
                .execute(
                    format!(
                        "UPDATE {table} SET executor_namespace=?, executor_name=?, updated_at=? \
                         WHERE {table}.id=?",
                        table = tables.subtasks
                    ),
                    (
                        format!("user-{}", request.user_id),
                        format!("device-{runtime_device_id}"),
                        now,
                        request.subtask_id,
                    ),
                )
                .await?;
            Ok(())
        })
        .await
        .map_err(|error| {
            tracing::error!(%error, subtask_id = request.subtask_id, "executor update failed");
            FastApiError::internal()
        })?;
    Ok(())
}

/// Submit the dispatch after the response stream subscribes to its callbacks.
pub(super) async fn dispatch_executor_after_subscribe(
    state: &AppState,
    request: &mut ExecutionRequest,
    target_url: Option<&str>,
    request_id: &str,
) -> Result<(), FastApiError> {
    if let Some(url) = target_url {
        if super::package_runtime::is_target(url) {
            recover_before_dispatch(state, request, None).await?;
            mark_subtask_running(state, request.subtask_id).await;
            enqueue_chat_shell_dispatch(state, Some(url), request.clone(), request_id);
        } else {
            // The OpenAPI streaming path creates no Task of its own, so its
            // START carries no `task:created` frame.
            enqueue_executor_dispatch(state, url, request, None);
        }
    }
    Ok(())
}

pub(crate) async fn recover_before_dispatch(
    state: &AppState,
    request: &mut ExecutionRequest,
    device_id: Option<&str>,
) -> Result<bool, FastApiError> {
    let error = match super::recover_executor::recover_executor_if_needed(state, request, device_id)
        .await
    {
        Ok(recovered) => return Ok(recovered),
        Err(error) => error,
    };
    let message = error.to_string();
    tracing::warn!(
        task_id = request.task_id,
        subtask_id = request.subtask_id,
        %error,
        "executor recovery failed"
    );
    crate::responses::dispatch::finalize_executor_failure(
        &crate::responses::dispatch::ConsumerState::from_app(state),
        request.task_id,
        request.subtask_id,
        request.user_id,
        request.message_id,
        (&message, "container_error"),
    )
    .await;
    tracing::info!(
        task_id = request.task_id,
        subtask_id = request.subtask_id,
        "executor recovery failure handled"
    );
    Err(FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        message,
    ))
}

/// `_dispatch_http_callback`: admit the fire-and-forget executor-manager
/// dispatch on the startup-owned supervisor. The callback streaming branch
/// issues it only after its channel subscription exists.
pub(super) fn enqueue_executor_dispatch(
    state: &AppState,
    target_url: &str,
    request: &ExecutionRequest,
    created_task: Option<crate::internal_callback::emitter::CreatedTask>,
) {
    let url = super::executor_client::executor_responses_url(target_url);
    state
        .responses_dispatch
        .submit(crate::responses::dispatch::DefaultDispatchJob::Executor {
            consumer: Box::new(crate::responses::dispatch::ConsumerState::from_app(state)),
            task_id: request.task_id,
            subtask_id: request.subtask_id,
            user_id: request.user_id,
            message_id: request.message_id,
            url,
            body: crate::responses::dispatch::ExecutorDispatchBody::Recover(Box::new(
                request.clone(),
            )),
            start: state
                .redis
                .clone()
                .map(|redis| crate::responses::dispatch::start_event(redis, request, created_task)),
        });
}

/// Admit the fire-and-forget chat-shell consumer for the background response.
///
/// The job carries the resolved request and the consumer handles; the
/// supervisor runs `sse_sync::collect` after the response is returned.
fn enqueue_chat_shell_dispatch(
    state: &AppState,
    target_url: Option<&str>,
    request: ExecutionRequest,
    request_id: &str,
) {
    let Some(url) = target_url else {
        return;
    };
    let job = crate::responses::dispatch::ChatShellJob {
        task_id: request.task_id,
        subtask_id: request.subtask_id,
        consumer: crate::responses::dispatch::ConsumerState::from_app(state),
        target_url: url.to_string(),
        request,
        request_id: request_id.to_string(),
        forward: false,
        start_data: serde_json::Value::Null,
        created_task: None,
    };
    state
        .responses_dispatch
        .submit(crate::responses::dispatch::DefaultDispatchJob::ChatShell(
            Box::new(job),
        ));
}

/// A JSON response whose media type matches the source's `JSONResponse`.
pub(super) fn json_response<T: serde::Serialize>(
    object: &T,
) -> Result<HttpResponse<BodyStream>, FastApiError> {
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
pub(super) fn sse_stream_response(stream: BodyStream) -> HttpResponse<BodyStream> {
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

/// `/chat` `chat:send`'s `ExecutionDispatcher.dispatch` half: recover the
/// executor, mark the assistant subtask RUNNING and admit the turn's dispatch.
///
/// The chat path always streams its events to the Socket.IO emitter, so a
/// chat-shell target runs in forwarding mode and an executor target keeps the
/// fire-and-forget POST plus its `chat:start` acknowledgement.
pub(crate) async fn dispatch_chat_turn(
    state: &AppState,
    request: &mut ExecutionRequest,
    request_id: &str,
    created_task: Option<crate::internal_callback::emitter::CreatedTask>,
    device_id: Option<&str>,
) -> Result<(), FastApiError> {
    // `dispatcher.py:121-127`: resolve the device route before routing and
    // before the subtask turns RUNNING.
    let resolved_device = resolve_device_route_id(state, request, device_id).await?;
    let shell = routing::shell_type(request);
    let chat_shell_mode = routing::chat_shell_mode();
    let chat_shell = chat_shell_url();
    let executor_manager = executor_manager_url();
    let target = routing::route(&RouteInputs {
        shell_type: &shell,
        chat_shell_mode: &chat_shell_mode,
        chat_shell_url: &chat_shell,
        executor_manager_url: &executor_manager,
        device_id: resolved_device.as_deref(),
        model_is_video: request
            .model_config
            .get("modelType")
            .and_then(Value::as_str)
            == Some("video"),
        model_protocol: request.model_config.get("protocol").and_then(Value::as_str),
    });
    if target.mode == routing::CommunicationMode::HttpCallback {
        let Some(url) = target.url.as_deref() else {
            return Err(FastApiError::internal());
        };
        enqueue_executor_dispatch(state, url, request, created_task);
        return Ok(());
    }
    recover_before_dispatch(state, request, device_id).await?;
    mark_subtask_running(state, request.subtask_id).await;
    if target.mode == routing::CommunicationMode::Websocket {
        let Some(route) = resolved_device.as_deref() else {
            tracing::error!(task_id = request.task_id, "device dispatch has no route");
            return Err(FastApiError::internal());
        };
        return dispatch_device_turn(state, request, created_task, route).await;
    }
    if target.mode == routing::CommunicationMode::Polling {
        return crate::background_jobs::video::create::dispatch(state, request)
            .await
            .map_err(|error| {
                tracing::error!(%error, task_id = request.task_id, "chat:send polling dispatch failed");
                FastApiError::internal()
            });
    }
    let Some(url) = target.url.as_deref() else {
        tracing::warn!(
            task_id = request.task_id,
            subtask_id = request.subtask_id,
            mode = ?target.mode,
            "chat:send dispatch has no execution target URL"
        );
        return Err(FastApiError::internal());
    };
    if routing::supports_streaming(&target) || target.mode == routing::CommunicationMode::Inprocess
    {
        let mut start_data = serde_json::Map::new();
        start_data.insert("shell_type".into(), Value::String(shell.clone()));
        if !request.bot_name.trim().is_empty() {
            start_data.insert("bot_name".into(), Value::String(request.bot_name.clone()));
        }
        let job = crate::responses::dispatch::ChatShellJob {
            task_id: request.task_id,
            subtask_id: request.subtask_id,
            consumer: crate::responses::dispatch::ConsumerState::from_app(state),
            target_url: chat_turn_stream_url(request, url),
            request: request.clone(),
            request_id: request_id.to_string(),
            forward: true,
            start_data: Value::Object(start_data),
            created_task,
        };
        state
            .responses_dispatch
            .submit(crate::responses::dispatch::DefaultDispatchJob::ChatShell(
                Box::new(job),
            ));
    }
    Ok(())
}

fn chat_turn_stream_url(request: &ExecutionRequest, chat_shell_url: &str) -> String {
    if request.model_config["modelType"] == "image" {
        super::package_runtime::image_url()
    } else {
        chat_shell_url.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_turn_routes_images_to_python_and_chat_to_the_configured_shell() {
        let chat_shell = "http://chat-shell:8100";
        let mut request = ExecutionRequest::default();
        assert_eq!(chat_turn_stream_url(&request, chat_shell), chat_shell);

        request.model_config = serde_json::json!({
            "modelType": "image",
            "protocol": "gpt-image",
            "model_id": "image-model"
        });
        assert_eq!(
            chat_turn_stream_url(&request, chat_shell),
            super::super::package_runtime::image_url()
        );
    }

    #[test]
    fn chat_shell_and_executor_defaults_match_the_source() {
        // The source defaults, used when the deployment sets neither URL.
        assert_eq!(routing::DEFAULT_CHAT_SHELL_URL, "http://127.0.0.1:8100");
        assert_eq!(DEFAULT_EXECUTOR_MANAGER_URL, "http://localhost:8001");
    }

    /// The recorded case's shape: an executor shell (`ClaudeCode` ->
    /// `HTTP_CALLBACK`) with `stream=true` and no `background`. The source
    /// streams the callback channel; the queued branch belongs only to
    /// `!stream || background`.
    #[test]
    fn an_executor_streaming_request_takes_the_callback_stream_branch() {
        assert_eq!(
            create_branch(false, true, false),
            CreateBranch::CallbackStream
        );
        assert_eq!(create_branch(false, false, false), CreateBranch::Queued);
        assert_eq!(create_branch(false, false, true), CreateBranch::Queued);
        assert_eq!(
            create_branch(false, true, true),
            CreateBranch::Queued,
            "background wins over stream, as in the source gate"
        );
    }

    #[test]
    fn an_sse_target_keeps_its_chat_shell_branches() {
        assert_eq!(
            create_branch(true, true, false),
            CreateBranch::ChatShellStream
        );
        assert_eq!(
            create_branch(true, false, true),
            CreateBranch::ChatShellBackground
        );
        assert_eq!(
            create_branch(true, false, false),
            CreateBranch::ChatShellSync
        );
    }

    #[test]
    fn the_persisted_message_is_the_raised_detail() {
        // `_persist_terminal_failure` writes `str(e)` / the HTTPException
        // detail, which is the same message the client receives.
        let error = FastApiError::detail(
            brz_http_server::StatusCode::BAD_REQUEST,
            "Model sample-model not found",
        );
        assert_eq!(
            build_failure_message(&error),
            "Model sample-model not found"
        );
        assert_eq!(
            error.detail_message(),
            Some("Model sample-model not found"),
            "the persisted error_message and the response detail are the same value"
        );
        assert_eq!(
            build_failure_message(&FastApiError::internal()),
            "Internal Server Error"
        );
    }

    #[test]
    fn the_build_failure_persists_before_the_create_dispatch() {
        // A build failure must run the terminal-failure chain and re-raise
        // before routing or dispatch starts.
        let source = include_str!("seam.rs");
        let persist = source
            .find("            persist_build_failure(\n                state,")
            .expect("build-failure persistence");
        let raise = source
            .find("            return Err(error);")
            .expect("build-failure re-raise");
        let route = source
            .find("routing::route(&RouteInputs")
            .expect("create dispatch routing");
        assert!(
            persist < raise && raise < route,
            "a build failure must persist and re-raise before the create dispatch"
        );
    }

    #[test]
    fn the_build_failure_reuses_the_callback_completion_chain() {
        let source = include_str!("seam.rs");
        let collect = source
            .find("completion::collect_completed_result(")
            .expect("collect step");
        let persist = source
            .find("completion::persist_completed_result(")
            .expect("persist step");
        assert!(collect < persist, "collect must precede persist");
        assert!(
            source[collect..persist].contains("Some(message)"),
            "the collect step must receive the raised message"
        );
        let tail = &source[persist..];
        let end = tail.find(".await;").expect("persist call end");
        assert!(
            tail[..end].contains("Some(message)"),
            "the persist step must receive the raised message"
        );
        assert!(
            tail[..end].contains("result.as_ref()"),
            "the persist step must forward the collected result option, not a fabricated object"
        );
    }
}
