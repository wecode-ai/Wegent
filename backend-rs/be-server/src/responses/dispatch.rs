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
#[cfg(test)]
use std::sync::Arc;
use std::sync::Weak;
use std::time::Duration;

use brz_http::Client as HttpClient;
use brz_mysql::{Mysql, MysqlService};
use brz_redis::{Redis, RedisService};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::executor_manager::ExecutorManager;
use crate::internal_callback::completion::Tables;
use crate::state::AppState;
use wegent_execution_runtime::dispatch_queue::{DispatchQueue, JobContext};

use super::create::dispatch::ExecutionRequest;
use super::create::sse_sync::{self, Collected};

/// `httpx`'s 300-second executor/chat-shell timeout.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(300);
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
    #[cfg(test)]
    Prepared(Result<crate::executor_binding::DispatchRequest, String>),
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
    /// An automatic handoff is acknowledged only after its destination accepts.
    Pipeline(Box<DispatchJob<M, R>>, oneshot::Sender<Result<(), String>>),
    /// A device turn accepted after its callback reader exists. The supervisor
    /// owns submission so dropping the client stream cannot cancel the
    /// transition from PENDING to RUNNING or the later `task:execute` publish.
    Device {
        request: Box<ExecutionRequest>,
        device_route: String,
        consumer: Box<ConsumerState<M, R>>,
    },
}

/// The production job type (`AppState`'s specialization).
pub(crate) type DefaultDispatchJob = DispatchJob<MysqlService, RedisService>;

impl<M: Mysql, R: Redis> DispatchJob<M, R> {
    fn context(&self) -> JobContext {
        match self {
            Self::Pipeline(job, _) => job.context(),
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
            Self::Device {
                request,
                device_route,
                ..
            } => JobContext {
                task_id: request.task_id,
                subtask_id: request.subtask_id,
                request_id: request.request_id.clone(),
                target: format!("device:{device_route}"),
            },
        }
    }
}

pub struct ResponsesDispatch<M: Mysql = MysqlService, R: Redis = RedisService> {
    queue: DispatchQueue<DispatchJob<M, R>>,
}

impl<M: Mysql, R: Redis> ResponsesDispatch<M, R> {
    pub(crate) fn reserve(&self) -> Option<mpsc::Permit<'_, DispatchJob<M, R>>> {
        self.queue.reserve()
    }

    pub(crate) fn submit(&self, job: DispatchJob<M, R>) -> bool {
        self.queue.submit(job)
    }
}

pub(crate) fn spawn<M, R>() -> ResponsesDispatch<M, R>
where
    M: Mysql + Send + 'static,
    R: Redis + Send + Clone + 'static,
{
    ResponsesDispatch {
        queue: DispatchQueue::spawn(
            executor_dispatch_http_client,
            DispatchJob::context,
            |http, job| Box::pin(run(http, job)),
        ),
    }
}

fn executor_dispatch_http_client() -> brz_http::Result<HttpClient> {
    // The source creates a client per non-idempotent queue submission. Reusing
    // an idle socket can lose the submission when the receiver expires it.
    HttpClient::builder()
        .read_timeout(DISPATCH_TIMEOUT)
        .pool_max_idle_per_host(0)
        .build()
}

/// Perform one dispatch against the retained client.
async fn run<M, R>(http: &HttpClient, job: DispatchJob<M, R>)
where
    M: Mysql + 'static,
    R: Redis + Clone + 'static,
{
    let (job, accepted) = match job {
        DispatchJob::Pipeline(job, sender) => (*job, Some(sender)),
        job => (job, None),
    };
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
                #[cfg(test)]
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
                    let recovered = if accepted.is_some() {
                        match super::create::recover_executor_if_needed(
                            &app,
                            &mut request,
                            None,
                            true,
                        )
                        .await
                        {
                            Ok(recovered) => recovered,
                            Err(error) => {
                                if let Some(accepted) = accepted {
                                    let _ = accepted.send(Err(error.to_string()));
                                }
                                return;
                            }
                        }
                    } else {
                        let Ok(recovered) =
                            super::create::seam::recover_before_dispatch(&app, &mut request, None)
                                .await
                        else {
                            return;
                        };
                        recovered
                    };
                    if let Err(error) =
                        super::create::seam::mark_subtask_running(&app, &request).await
                    {
                        if recovered {
                            super::create::discard_recovered_executor(&app, &request).await;
                        }
                        if let Some(accepted) = accepted {
                            let _ = accepted.send(Err(format!("{error:?}")));
                            return;
                        }
                        if !error.status().is_server_error() {
                            return;
                        }
                        finalize_executor_failure(
                            &consumer,
                            task_id,
                            subtask_id,
                            user_id,
                            message_id,
                            (
                                "Could not commit executor startup state",
                                "EXECUTOR_DISPATCH_FAILED",
                            ),
                        )
                        .await;
                        return;
                    }
                    crate::executor_binding::dispatch_request(&app, &request)
                }
            };
            let outcome = match body {
                Ok(body) => send_executor(http, &url, &body).await,
                Err(error) => Err(error),
            };
            match outcome {
                Ok(()) => {
                    if let Some(accepted) = accepted {
                        let _ = accepted.send(Ok(()));
                    }
                    if let Some(start) = start {
                        emit_executor_start(start).await;
                    }
                }
                Err(error) => {
                    tracing::warn!(task_id, subtask_id, %error, "executor dispatch failed");
                    if let Some(accepted) = accepted {
                        let _ = accepted.send(Err(error));
                        return;
                    }
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
            let _ = run_chat_shell(*job, accepted).await;
        }
        DispatchJob::Pipeline(..) => unreachable!("nested pipeline dispatch"),
        DispatchJob::MemorySave(save) => {
            crate::responses::create::memory_context::post_save(http, save).await;
        }
        DispatchJob::Device {
            mut request,
            device_route,
            consumer,
        } => {
            let Some(app) = consumer.app.upgrade() else {
                finalize_executor_failure(
                    &consumer,
                    request.task_id,
                    request.subtask_id,
                    request.user_id,
                    request.message_id,
                    (
                        "Application stopped before device dispatch",
                        "EXECUTOR_DISPATCH_FAILED",
                    ),
                )
                .await;
                tracing::warn!(
                    task_id = request.task_id,
                    subtask_id = request.subtask_id,
                    "application stopped before device dispatch"
                );
                return;
            };
            // Keep ownership of a rejected submission until recovery can index it.
            let retry_index_write = true;
            if let Err(error) = super::create::seam::dispatch_responses_device(
                &app,
                &mut request,
                &device_route,
                retry_index_write,
            )
            .await
            {
                tracing::warn!(
                    task_id = request.task_id,
                    subtask_id = request.subtask_id,
                    ?error,
                    "background device dispatch failed"
                );
            }
        }
    }
}

async fn send_executor(
    http: &HttpClient,
    url: &str,
    dispatch: &crate::executor_binding::DispatchRequest,
) -> Result<(), String> {
    let request = executor_request(http, url, dispatch)
        .ok_or_else(|| "Could not build executor dispatch request".to_owned())?;
    let response = request
        .timeout(DISPATCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("{error:?}"))?;
    if !response.status().is_success() {
        return Err(format!("Executor returned HTTP {}", response.status()));
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn test_dispatch_start_failure(
    mysql: MysqlService,
    task_id: i64,
    subtask_id: i64,
) {
    let app = crate::app_test_support::app(mysql);
    app.completion_app.set(Arc::downgrade(&app)).ok().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let request = ExecutionRequest {
        task_id,
        subtask_id,
        ..Default::default()
    };
    let http = HttpClient::builder().build().unwrap();
    Box::pin(run(
        &http,
        DispatchJob::Executor {
            url: format!("http://{}", listener.local_addr().unwrap()),
            body: ExecutorDispatchBody::Recover(Box::new(request)),
            start: None,
            consumer: Box::new(ConsumerState::from_app(&app)),
            task_id,
            subtask_id,
            user_id: 7,
            message_id: None,
        },
    ))
    .await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
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
    let mut event = ExecutionEvent::new(EventType::Error, task_id, subtask_id);
    event.message_id = message_id;
    event.error = Some(message.to_owned());
    event.error_code = Some(code.to_owned());
    if let Some(app) = app.as_ref().filter(|app| app.redis.is_some()) {
        if let Err(error) = Box::pin(crate::internal_callback::process_dispatch_failure(
            app, event,
        ))
        .await
        {
            tracing::warn!(
                ?error,
                task_id,
                subtask_id,
                "executor failure awaits terminal recovery"
            );
        }
        return;
    }
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
/// `sse_sync::collect` registers without erasing admitted cancel intents, polls
/// the flag while the stream runs, persists each event, and atomically clears
/// the intent and flag in its finally. A 500, a mid-stream error and a
/// stream without a terminal frame all surface as an error here and are logged
/// with the job identity; they are never reported as completion.
async fn run_chat_shell<M, R>(
    job: ChatShellJob<M, R>,
    accepted: Option<oneshot::Sender<Result<(), String>>>,
) -> Result<Collected, String>
where
    M: Mysql,
    R: Redis + Clone,
{
    let app = job.consumer.app.upgrade();
    let package_mode = super::create::package_runtime::is_target(&job.target_url);
    // Image retries reuse the subtask ID, so each attempt owns its own terminal frames.
    let image_stream = super::create::package_runtime::is_image_target(&job.target_url);
    let mut consumer = sse_sync::ConsumerContext {
        package_mode,
        mysql: &job.consumer.mysql,
        redis: job.consumer.redis.as_ref(),
        tables: job.consumer.tables,
        executor_manager: &job.consumer.executor_manager,
        app: app.as_deref(),
        forward: job.forward,
        start_data: job.start_data.clone(),
        created_task: job.created_task.clone(),
        owner_user_id: job.forward.then_some(job.request.user_id),
        recover_terminal: accepted.is_some() || package_mode || (job.forward && !image_stream),
        acceptance: accepted.map(sse_sync::DispatchAcceptance::new),
    };
    let result = if consumer.acceptance.is_some() {
        let key =
            crate::internal_callback::pipeline::execution_lease_key(job.task_id, job.subtask_id);
        let Some(redis) = consumer.redis else {
            return Err("Redis is required for pipeline dispatch".to_owned());
        };
        let job_ref = &job;
        let consumer_ref = &mut consumer;
        crate::internal_callback::completion::with_owned_lease(
            redis,
            &key,
            || "Pipeline execution is already owned or Redis is unavailable".to_owned(),
            Some(|| Collected {
                content: String::new(),
            }),
            move |receipt| async move {
                consumer_ref
                    .acceptance
                    .as_mut()
                    .expect("pipeline acceptance")
                    .receipt = Some(receipt);
                let (_, subtask_table) = crate::internal_callback::completion::resolve_tables(
                    consumer_ref.app,
                    consumer_ref.tables,
                    job_ref.task_id,
                )
                .await
                .map_err(|error| error.to_string())?;
                match crate::internal_callback::completion::read_terminal_result(
                    consumer_ref.mysql,
                    &subtask_table,
                    job_ref.task_id,
                    job_ref.subtask_id,
                )
                .await
                .map_err(|error| error.to_string())?
                {
                    Some(_) => {
                        if let Some(acceptance) = consumer_ref.acceptance.as_ref() {
                            acceptance.resolve(Ok(()));
                        }
                        Ok(Collected {
                            content: String::new(),
                        })
                    }
                    None => {
                        crate::internal_callback::session::cleanup_streaming_state(
                            redis,
                            job_ref.subtask_id,
                            None,
                        )
                        .await
                        .map_err(|error| error.to_string())?;
                        collect_chat_job(job_ref, consumer_ref).await
                    }
                }
            },
        )
        .await
    } else {
        collect_chat_job(&job, &consumer).await
    };
    if let Some(acceptance) = consumer.acceptance.as_ref() {
        match &result {
            Err(error) => {
                acceptance.resolve(Err(error.clone()));
            }
            // No work closure ran: another live owner supplied the fenced receipt.
            Ok(_) if acceptance.receipt.is_none() => {
                acceptance.resolve(Ok(()));
            }
            Ok(_) => {}
        }
    }
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

async fn collect_chat_job<M: Mysql, R: Redis + Clone>(
    job: &ChatShellJob<M, R>,
    consumer: &sse_sync::ConsumerContext<'_, M, R>,
) -> Result<Collected, String> {
    Box::pin(sse_sync::collect(
        consumer,
        &job.target_url,
        &job.request,
        &job.request_id,
        job.request.message_id,
    ))
    .await
}

/// Build one executor dispatch request with the shared Source client identity.
fn executor_request(
    http: &HttpClient,
    url: &str,
    dispatch: &crate::executor_binding::DispatchRequest,
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
                    format!(
                        "{} {}",
                        crate::executor_binding::AUTHORIZATION_SCHEME,
                        dispatch.binding_token
                    ),
                ),
        )
        .json(&dispatch.body),
    )
}

#[cfg(test)]
#[path = "dispatch_tests.rs"]
mod dispatch_tests;
