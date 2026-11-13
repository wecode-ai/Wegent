// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-owned background dispatch for the responses create flow
//! (`openapi_responses.py:_create_non_streaming_response_unified` /
//! `_create_streaming_response_unified` + `execution/dispatcher.py`).
//!
//! The source fires the executor-manager and chat-shell dispatches with
//! `asyncio.create_task(...)`, returning the create response immediately. That
//! background work is process-owned, so it runs on one startup-owned
//! supervisor: the create handler only admits a job into a bounded queue, and
//! the supervisor spawns one observed task per admitted job.
//!
//! * a chat-shell job runs the real SSE consumer
//!   ([`super::create::sse_sync::collect`]), reproducing
//!   `dispatch_sse`'s register/poll/consume/persist/unregister lifecycle;
//! * an executor job keeps the fire-and-forget acknowledgement.
//!
//! The supervisor keeps every task handle, reaps completed tasks, and logs a
//! panicking or early-exiting task with its task/subtask/request identity, so
//! a background failure is never invisible.
use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_mysql::{Mysql, MysqlService};
use brz_redis::{Redis, RedisService};
use serde_json::Value;
use tokio::sync::{Semaphore, mpsc};
use tokio::task::{Id, JoinSet};

use crate::executor_manager::ExecutorManager;
use crate::internal_callback::completion::Tables;
use crate::state::AppState;

use super::create::dispatch::ExecutionRequest;
use super::create::sse_sync::{self, Collected};

/// `httpx`'s 300-second executor/chat-shell timeout.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(300);
/// The bounded admission queue depth.
const QUEUE_DEPTH: usize = 256;
/// The background consumer concurrency bound.
///
/// The source runs one `asyncio.create_task` per accepted background request
/// (`openapi_responses.py:960-980`), so its concurrency is request-driven and
/// unbounded. This supervisor is the bounded target equivalent: each chat-shell
/// consumer holds one upstream SSE connection for up to [`DISPATCH_TIMEOUT`]
/// (300 s), so eight permits bound sockets and memory while removing the
/// serial head-of-line block. Saturation is observable through the admission
/// queue: a full queue rejects the job and logs it instead of blocking the
/// request path.
const MAX_CONSUMER_JOBS: usize = 8;

/// The service handles one background chat-shell consumer owns.
///
/// The supervisor is created inside `AppState` assembly, so it cannot hold a
/// borrow of the state. The job instead carries the service handles plus the
/// request-time `Weak<AppState>`; the worker upgrades the weak for the
/// completion notification path (the same weak the streaming bridge keeps).
pub(crate) struct ConsumerState<M: Mysql, R: Redis> {
    pub(crate) mysql: M,
    pub(crate) redis: Option<R>,
    pub(crate) tables: Tables,
    pub(crate) executor_manager: ExecutorManager,
    pub(crate) app: Weak<AppState>,
}

impl ConsumerState<MysqlService, RedisService> {
    /// The production handles for one create request.
    #[must_use]
    pub(crate) fn from_app(state: &AppState) -> Self {
        Self {
            mysql: state.mysql.clone(),
            redis: state.redis.clone(),
            tables: crate::internal_callback::tables(state),
            executor_manager: state.executor_manager.clone(),
            app: state.completion_app.get().cloned().unwrap_or_default(),
        }
    }
}

/// One background chat-shell turn: the identity, the resolved request, and the
/// consumer handles.
pub(crate) struct ChatShellJob<M: Mysql, R: Redis> {
    pub(crate) task_id: i64,
    pub(crate) subtask_id: i64,
    pub(crate) consumer: ConsumerState<M, R>,
    pub(crate) target_url: String,
    pub(crate) request: ExecutionRequest,
    pub(crate) request_id: String,
    /// `/chat` dispatch: forward every parsed event to Socket.IO (the
    /// `WebSocketResultEmitter` half) instead of persisting only.
    pub(crate) forward: bool,
    /// `_build_start_event_data(request)`: the START frame's `shell_type` and
    /// optional `bot_name`.
    pub(crate) start_data: Value,
    /// The START frame's `task:created` identity.
    pub(crate) created_task: Option<crate::internal_callback::emitter::CreatedTask>,
}

/// The `chat:start` frame the dispatcher emits after the executor
/// acknowledgement (`dispatcher.py:730-747` ->
/// `webpage_websocket_chat_emitter.py:88-99`), plus the `task:created` frame
/// the same emitter's START branch emits for the creator.
pub(crate) struct ExecutorStart<R: Redis> {
    pub(crate) redis: R,
    pub(crate) task_id: i64,
    pub(crate) subtask_id: i64,
    pub(crate) bot_name: Value,
    pub(crate) shell_type: String,
    pub(crate) message_id: Option<i64>,
    pub(crate) created_task: Option<crate::internal_callback::emitter::CreatedTask>,
}

/// `_build_start_event_data` + `_get_bot_name` (`dispatcher.py:468-493`): the
/// START event's shell type and first bot name.
pub(crate) fn start_event<R: Redis>(
    redis: R,
    request: &ExecutionRequest,
    created_task: Option<crate::internal_callback::emitter::CreatedTask>,
) -> ExecutorStart<R> {
    let bot_name = request
        .bot
        .as_array()
        .and_then(|bots| bots.first())
        .and_then(|bot| bot.get("name"))
        .filter(|name| name.as_str().is_some_and(|name| !name.trim().is_empty()))
        .cloned()
        .unwrap_or(Value::Null);
    ExecutorStart {
        redis,
        task_id: request.task_id,
        subtask_id: request.subtask_id,
        bot_name,
        shell_type: crate::responses::create::routing::shell_type(request),
        message_id: request.message_id,
        created_task,
    }
}

/// Input to an executor dispatch job.
pub(crate) enum ExecutorDispatchBody {
    Prepared(Value),
    Recover(Box<ExecutionRequest>),
}

/// One background dispatch the create flow hands to the supervisor.
pub(crate) enum DispatchJob<M: Mysql, R: Redis> {
    /// `_dispatch_http_callback`: `POST {target}/v1/responses` with
    /// `stream=false, background=true`, then the `chat:start` emit.
    Executor {
        url: String,
        body: ExecutorDispatchBody,
        start: Option<ExecutorStart<R>>,
        consumer: Box<ConsumerState<M, R>>,
        task_id: i64,
        subtask_id: i64,
        user_id: i64,
        message_id: Option<i64>,
    },
    /// `_dispatch_sse`: the chat-shell SSE consumer. Boxed because the job is
    /// far larger than the executor arm and every dispatch is already an owned
    /// hand-off to the supervisor.
    ChatShell(Box<ChatShellJob<M, R>>),
    /// `chat_session.py:137-170`'s fire-and-forget memory save: the prepared
    /// context goes to the mem0 client off the request path.
    MemorySave(crate::responses::create::memory_context::SaveRequest),
}

/// The production job type (`AppState`'s specialization).
pub(crate) type DefaultDispatchJob = DispatchJob<MysqlService, RedisService>;

/// The task identity a supervisor or admission log carries.
struct JobContext {
    task_id: i64,
    subtask_id: i64,
    request_id: String,
    target: String,
}

impl<M: Mysql, R: Redis> DispatchJob<M, R> {
    fn context(&self) -> JobContext {
        match self {
            Self::Executor {
                url,
                task_id,
                subtask_id,
                ..
            } => JobContext {
                task_id: *task_id,
                subtask_id: *subtask_id,
                request_id: String::new(),
                target: url.clone(),
            },
            Self::ChatShell(job) => JobContext {
                task_id: job.task_id,
                subtask_id: job.subtask_id,
                request_id: job.request_id.clone(),
                target: job.target_url.clone(),
            },
            Self::MemorySave(_) => JobContext {
                task_id: 0,
                subtask_id: 0,
                request_id: String::new(),
                target: "memory".to_string(),
            },
        }
    }
}

/// The startup-owned responses dispatch supervisor.
pub struct ResponsesDispatch<M: Mysql = MysqlService, R: Redis = RedisService> {
    sender: mpsc::Sender<DispatchJob<M, R>>,
    /// The startup-owned supervisor; retained for the process lifetime.
    _supervisor: std::thread::JoinHandle<()>,
}

impl<M, R> ResponsesDispatch<M, R>
where
    M: Mysql + Send + 'static,
    R: Redis + Send + Clone + 'static,
{
    /// Spawn the process-owned supervisor. Called once at startup.
    ///
    /// The source runs every background turn on its single asyncio event loop
    /// (`openapi_responses.py:960-980`), so the supervisor owns one dedicated
    /// current-thread runtime with a `LocalSet`. That is not an optimisation:
    /// the completion persistence awaits
    /// `Mysql::with_transaction`, whose future is not `Send`, so the consumer
    /// must stay on one thread. A `LocalSet` still interleaves every admitted
    /// consumer, matching the source loop.
    #[must_use]
    pub(crate) fn spawn() -> Self {
        let (sender, receiver) = mpsc::channel::<DispatchJob<M, R>>(QUEUE_DEPTH);
        let supervisor = std::thread::Builder::new()
            .name("responses-dispatch".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        tracing::error!(%error, "failed to build the responses dispatch runtime");
                        return;
                    }
                };
                let local = tokio::task::LocalSet::new();
                local.block_on(&runtime, supervise(receiver));
            })
            .expect("spawn the responses dispatch supervisor thread");
        Self {
            sender,
            _supervisor: supervisor,
        }
    }
}

/// The supervisor loop: reap finished local tasks and admit new jobs under the
/// bounded consumer permits.
async fn supervise<M, R>(mut receiver: mpsc::Receiver<DispatchJob<M, R>>)
where
    M: Mysql + Send + 'static,
    R: Redis + Send + Clone + 'static,
{
    // The source's OpenAI/httpx client keeps a 300-second per-read timeout for
    // the executor acknowledgement; the chat-shell consumer builds its own
    // client with the same policy.
    let http = match HttpClient::builder().read_timeout(DISPATCH_TIMEOUT).build() {
        Ok(http) => http,
        Err(error) => {
            tracing::error!(%error, "failed to build the responses dispatch client");
            return;
        }
    };
    let permits = Arc::new(Semaphore::new(MAX_CONSUMER_JOBS));
    let mut jobs: JoinSet<()> = JoinSet::new();
    let mut contexts: HashMap<Id, JobContext> = HashMap::new();
    loop {
        tokio::select! {
            biased;
            Some(finished) = jobs.join_next_with_id(), if !jobs.is_empty() => {
                observe_finished(finished, &mut contexts);
            }
            job = receiver.recv() => {
                let Some(job) = job else { break };
                // Wait for one of the bounded consumer slots. This is not the
                // request path: admission already happened.
                let permit = match Arc::clone(&permits).acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => break,
                };
                let context = job.context();
                let http = http.clone();
                let handle = jobs.spawn_local(async move {
                    let _permit = permit;
                    run(&http, job).await;
                });
                contexts.insert(handle.id(), context);
            }
        }
    }
    // Drain the admitted jobs before the supervisor exits.
    while let Some(finished) = jobs.join_next_with_id().await {
        observe_finished(finished, &mut contexts);
    }
}

impl<M: Mysql, R: Redis> ResponsesDispatch<M, R> {
    /// Admit one background job.
    ///
    /// The bounded queue is admission. When it is full the job is rejected
    /// (never a silent block or a silent drop) and the rejection is logged with
    /// the job identity.
    pub(crate) fn submit(&self, job: DispatchJob<M, R>) -> bool {
        match self.sender.try_send(job) {
            Ok(()) => true,
            Err(mpsc::error::TrySendError::Full(job)) => {
                let context = job.context();
                tracing::warn!(
                    task_id = context.task_id,
                    subtask_id = context.subtask_id,
                    request_id = %context.request_id,
                    target = %context.target,
                    queue_depth = QUEUE_DEPTH,
                    "background dispatch queue is full; rejecting the job"
                );
                false
            }
            Err(mpsc::error::TrySendError::Closed(job)) => {
                let context = job.context();
                tracing::warn!(
                    task_id = context.task_id,
                    subtask_id = context.subtask_id,
                    request_id = %context.request_id,
                    target = %context.target,
                    "background dispatch supervisor is closed; rejecting the job"
                );
                false
            }
        }
    }
}

/// Record one finished task: remove its identity, and log a panic or an
/// aborted/early-exiting join failure with the task's context.
fn observe_finished(
    finished: Result<(Id, ()), tokio::task::JoinError>,
    contexts: &mut HashMap<Id, JobContext>,
) {
    match finished {
        Ok((id, ())) => {
            contexts.remove(&id);
        }
        Err(error) => {
            let context = contexts.remove(&error.id());
            let task_id = context.as_ref().map_or(0, |context| context.task_id);
            let subtask_id = context.as_ref().map_or(0, |context| context.subtask_id);
            let request_id = context
                .as_ref()
                .map_or_else(String::new, |context| context.request_id.clone());
            let target = context.map_or_else(String::new, |context| context.target);
            tracing::error!(
                task_id,
                subtask_id,
                request_id = %request_id,
                target = %target,
                %error,
                "background dispatch task failed"
            );
        }
    }
}

/// Perform one dispatch against the retained client.
async fn run<M, R>(http: &HttpClient, job: DispatchJob<M, R>)
where
    M: Mysql + 'static,
    R: Redis + Clone + 'static,
{
    match job {
        DispatchJob::Executor {
            url,
            body,
            start,
            consumer,
            task_id,
            subtask_id,
            user_id,
            message_id,
        } => {
            let body = match body {
                ExecutorDispatchBody::Prepared(body) => body,
                ExecutorDispatchBody::Recover(mut request) => {
                    let Some(app) = consumer.app.upgrade() else {
                        tracing::warn!(
                            task_id,
                            subtask_id,
                            "application stopped before executor dispatch"
                        );
                        return;
                    };
                    let Ok(recovered) =
                        super::create::seam::recover_before_dispatch(&app, &mut request, None)
                            .await
                    else {
                        return;
                    };
                    if !super::create::seam::claim_executor_dispatch(&app, subtask_id).await {
                        if recovered {
                            super::create::discard_recovered_executor(&app, &request).await;
                        }
                        return;
                    }
                    let payload = super::create::dispatch::assemble(&request, false, true);
                    serde_json::to_value(payload).unwrap_or(Value::Null)
                }
            };
            match send_executor(http, &url, &body).await {
                Ok(()) => {
                    if let Some(start) = start {
                        emit_executor_start(start).await;
                    }
                }
                Err(error) => {
                    tracing::warn!(task_id, subtask_id, %error, "executor dispatch failed");
                    finalize_executor_failure(
                        &consumer,
                        task_id,
                        subtask_id,
                        user_id,
                        message_id,
                        (
                            "Could not dispatch execution to the executor",
                            "EXECUTOR_DISPATCH_FAILED",
                        ),
                    )
                    .await;
                }
            }
        }
        DispatchJob::ChatShell(job) => {
            let _ = run_chat_shell(*job).await;
        }
        DispatchJob::MemorySave(save) => {
            crate::responses::create::memory_context::post_save(http, save).await;
        }
    }
}

async fn send_executor(http: &HttpClient, url: &str, body: &Value) -> Result<(), String> {
    let request = executor_request(http, url, body)
        .ok_or_else(|| "Could not build executor dispatch request".to_owned())?;
    let response = request
        .timeout(DISPATCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Executor returned HTTP {}", response.status()));
    }
    Ok(())
}

async fn emit_executor_start<R: Redis>(start: ExecutorStart<R>) {
    if let Err(error) = crate::internal_callback::publish_chat_start(
        &start.redis,
        start.task_id,
        start.subtask_id,
        start.bot_name,
        &start.shell_type,
        start.message_id,
    )
    .await
    {
        tracing::warn!(%error, "chat:start emit failed (fire-and-forget)");
    }
    if let Some(created) = &start.created_task
        && let Err(error) =
            crate::internal_callback::publish_task_created(&start.redis, start.task_id, created)
                .await
    {
        tracing::warn!(%error, "task:created emit failed (fire-and-forget)");
    }
}

pub(crate) async fn finalize_executor_failure<M: Mysql, R: Redis>(
    consumer: &ConsumerState<M, R>,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    message_id: Option<i64>,
    (message, code): (&str, &str),
) {
    use crate::internal_callback::{
        completion, emitter,
        event::{EventType, ExecutionEvent},
    };
    let app = consumer.app.upgrade();
    let ctx = consumer.redis.as_ref().map(|redis| completion::Completion {
        app: app.as_deref(),
        mysql: &consumer.mysql,
        redis,
        tables: consumer.tables,
        executor_manager: &consumer.executor_manager,
    });
    let result = completion::complete_executor_failure(
        &consumer.mysql,
        consumer.tables,
        ctx.as_ref(),
        task_id,
        subtask_id,
        message,
        code,
    )
    .await;
    let (Some(redis), Some(result)) = (consumer.redis.as_ref(), result) else {
        return;
    };
    let mut event = ExecutionEvent::new(EventType::Error, task_id, subtask_id);
    event.message_id = message_id;
    event.error = Some(message.to_owned());
    event.error_code = Some(code.to_owned());
    if let Err(error) =
        crate::internal_callback::session::publish_callback_event(redis, subtask_id, &event).await
    {
        tracing::warn!(%error, task_id, subtask_id, "executor failure callback publish failed");
    }
    if let Err(error) =
        emitter::emit_terminal_frames(redis, &event, Some(user_id), &result, None).await
    {
        tracing::warn!(%error, task_id, subtask_id, "executor failure notification failed");
    }
}

/// Run the real chat-shell SSE consumer for one admitted job.
///
/// `sse_sync::collect` owns the Source lifecycle: it clears
/// `chat:cancel:{subtask}` before sending the request (the early DEL), polls
/// the key while the stream runs, persists each event, and deletes the key in
/// its finally (the late, strategy-ending DEL). A 500, a mid-stream error and a
/// stream without a terminal frame all surface as an error here and are logged
/// with the job identity; they are never reported as completion.
async fn run_chat_shell<M, R>(job: ChatShellJob<M, R>) -> Result<Collected, String>
where
    M: Mysql,
    R: Redis + Clone,
{
    let app = job.consumer.app.upgrade();
    let consumer = sse_sync::ConsumerContext {
        package_mode: super::create::package_runtime::is_target(&job.target_url),
        mysql: &job.consumer.mysql,
        redis: job.consumer.redis.as_ref(),
        tables: job.consumer.tables,
        executor_manager: &job.consumer.executor_manager,
        app: app.as_deref(),
        forward: job.forward,
        start_data: job.start_data.clone(),
        created_task: job.created_task.clone(),
        owner_user_id: job.forward.then_some(job.request.user_id),
    };
    let result = sse_sync::collect(
        &consumer,
        &job.target_url,
        &job.request,
        &job.request_id,
        job.request.message_id,
    )
    .await;
    match &result {
        Ok(collected) => tracing::info!(
            task_id = job.task_id,
            subtask_id = job.subtask_id,
            request_id = %job.request_id,
            content_len = collected.content.len(),
            "chat-shell background consumer completed"
        ),
        Err(error) => tracing::warn!(
            task_id = job.task_id,
            subtask_id = job.subtask_id,
            request_id = %job.request_id,
            target = %job.target_url,
            %error,
            "chat-shell background consumer failed"
        ),
    }
    result
}

/// Build one executor dispatch request with the shared Source client identity.
fn executor_request(
    http: &HttpClient,
    url: &str,
    body: &Value,
) -> Option<brz_http::RequestBuilder> {
    Some(
        crate::responses::create::openai_client::apply_openai_client_headers(
            http.post(url)
                .ok()?
                .header("content-type", "application/json")
                .header(
                    "accept",
                    crate::responses::create::openai_client::OPENAI_ACCEPT,
                )
                .header(
                    "authorization",
                    crate::responses::create::openai_client::OPENAI_DUMMY_AUTHORIZATION,
                ),
        )
        .json(body),
    )
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod dispatch_tests;
