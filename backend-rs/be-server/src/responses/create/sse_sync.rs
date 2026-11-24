// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Connect synchronous stream consumers to gateway execution completion.

use brz_mysql::Mysql;
use brz_redis::Redis;
use serde_json::Value;
use wegent_responses_streaming::{sse_protocol::Failure, sse_sync};

use crate::executor_manager::ExecutorManager;
use crate::internal_callback::ProcessLocalEmit;
use crate::internal_callback::completion::{self, Tables};
use crate::internal_callback::event::{EventType, ExecutionEvent};
use crate::state::AppState;

use super::dispatch::ExecutionRequest;

pub(crate) use sse_sync::{Collected, DispatchAcceptance};

/// The dependencies one chat-shell SSE consumer needs.
///
/// The synchronous create branch builds this from `AppState`; the background
/// dispatch worker owns its handles in
/// [`crate::responses::dispatch::ConsumerState`] and upgrades the request-time
/// `Weak<AppState>` for the completion notification path. Keeping the inputs
/// explicit lets a focused test drive the real consumer through the worker with
/// recording MySQL/Redis doubles.
pub(crate) struct ConsumerContext<'a, M: Mysql, R: Redis> {
    pub package_mode: bool,
    pub mysql: &'a M,
    pub redis: Option<&'a R>,
    pub tables: Tables,
    pub executor_manager: &'a ExecutorManager,
    /// `Completion.app`: the subscription notification handler reads it.
    pub app: Option<&'a AppState>,
    /// `/chat` dispatch: forward every parsed event to the Socket.IO emitter
    /// and emit the dispatcher's START frame before the stream opens, exactly
    /// like `WebSocketResultEmitter`.
    pub forward: bool,
    /// `_build_start_event_data(request)`: the START frame's `shell_type` and
    /// optional `bot_name`.
    pub start_data: Value,
    /// The START frame's `task:created` identity.
    pub created_task: Option<crate::internal_callback::emitter::CreatedTask>,
    /// `request.user.id`: the owner room the terminal `task:status` frame
    /// addresses when forwarding to Socket.IO.
    pub owner_user_id: Option<i64>,
    pub acceptance: Option<DispatchAcceptance>,
    pub recover_terminal: bool,
}

impl<'a> ConsumerContext<'a, brz_mysql::MysqlService, brz_redis::RedisService> {
    /// The production context for one request whose dispatch runs inside the
    /// request (the synchronous create branch and the background job paths).
    pub(crate) fn from_app(state: &'a AppState) -> Self {
        Self {
            package_mode: false,
            mysql: &state.mysql,
            redis: state.redis.as_ref(),
            tables: crate::internal_callback::tables(state),
            executor_manager: &state.executor_manager,
            app: Some(state),
            forward: false,
            start_data: Value::Null,
            created_task: None,
            owner_user_id: None,
            acceptance: None,
            recover_terminal: false,
        }
    }
}

pub(crate) async fn collect<M: Mysql, R: Redis + Clone>(
    ctx: &ConsumerContext<'_, M, R>,
    target_url: &str,
    request: &ExecutionRequest,
    request_id: &str,
    message_id: Option<i64>,
) -> Result<Collected, String> {
    let consumer = sse_sync::ConsumerContext {
        host: ctx,
        local: ProcessLocalEmit,
        package_mode: ctx.package_mode,
        redis: ctx.redis,
        forward: ctx.forward,
        start_data: &ctx.start_data,
        created_task: ctx.created_task.as_ref(),
        acceptance: ctx.acceptance.as_ref(),
    };
    sse_sync::collect(&consumer, target_url, request, request_id, message_id).await
}

/// Package execution and automatic pipeline stages use the callback's durable
/// terminal and notification path.
impl<M: Mysql, R: Redis> sse_sync::ExecutionLifecycle for ConsumerContext<'_, M, R> {
    async fn emit_package_event(&self, event: &ExecutionEvent) -> Result<(), Failure> {
        let app = self.app.ok_or_else(|| {
            Failure::persisted("Chat Shell dispatch lost application state".to_owned())
        })?;
        let result = if self.recover_terminal {
            crate::internal_callback::process_background_shell_event(app, event.clone()).await
        } else {
            crate::internal_callback::process_execution_event(
                app,
                event.clone(),
                Some("inprocess-chat"),
                Some("standalone"),
            )
            .await
        };
        result.map_err(|error| {
        tracing::error!(task_id = event.task_id, error = ?error, "package event processing failed");
        if completion::terminal_status(&event.event_type).is_some() {
            Failure::terminal_persistence("Could not save the execution result")
        } else {
            Failure::persisted("Chat Shell event processing failed".into())
        }
    })
    }

    /// `StatusUpdatingEmitter`'s terminal branch: collect, persist, publish.
    async fn complete(&self, event: &ExecutionEvent) -> Result<(), Failure> {
        if self.package_mode || self.recover_terminal {
            return self.emit_package_event(event).await;
        }
        let Some(redis) = self.redis else {
            return Ok(());
        };
        let Some(status) = completion::terminal_status(&event.event_type) else {
            return Ok(());
        };
        let completion = completion::Completion {
            app: self.app,
            mysql: self.mysql,
            redis,
            tables: self.tables,
            executor_manager: self.executor_manager,
        };
        // `StatusUpdatingEmitter`'s terminal branch. The create flow wraps an
        // `SSEResultEmitter`, so the callback's `task:status` owner pre-read does
        // not run here.
        let committed = completion::complete_terminal_event(
            &completion,
            event.task_id,
            event.subtask_id,
            status,
            event.result.as_ref(),
            event.error.as_deref(),
            event.error_code.as_deref(),
            None,
            None,
        )
        .await
        .map_err(|_| Failure::terminal_persistence("Could not save the execution result"))?;
        let Some(committed) = committed else {
            if let Err(error) = crate::internal_callback::session::cleanup_settled_streaming_state(
                redis,
                event.subtask_id,
                event.task_id,
            )
            .await
            {
                tracing::warn!(%error, task_id = event.task_id, subtask_id = event.subtask_id, "already-settled streaming cleanup failed");
            }
            return Err(Failure::terminal_persistence(
                "The execution was already settled",
            ));
        };
        let final_result = committed.result;
        // `WebSocketResultEmitter.emit`'s terminal branch for the `/chat` dispatch:
        // the event's frame (`chat:done` / `chat:error` / `chat:cancelled`) then
        // `task:status`. The OpenAPI path wraps an `SSEResultEmitter` and stops at
        // the persisted terminal state.
        if self.forward {
            let result = final_result
                .or_else(|| event.result.clone())
                .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));
            let mut frame = event.clone();
            frame.result = Some(result.clone());
            // `websocket.py:_load_context_briefs`: the DONE frame carries the
            // completed subtask's committed context briefs.
            let contexts = match crate::responses::create::contexts::context_briefs(
                self.mysql,
                frame.subtask_id,
            )
            .await
            {
                Ok(briefs) => Some(briefs),
                Err(error) => {
                    tracing::warn!(%error, "chat:done context briefs load failed");
                    None
                }
            };
            if let Err(error) = crate::internal_callback::emitter::emit_terminal_frames(
                redis,
                &frame,
                self.owner_user_id,
                &result,
                contexts.as_ref(),
            )
            .await
            {
                tracing::warn!(%error, "chat-shell terminal frames failed");
            }
        }
        Ok(())
    }

    /// The dispatcher's `except` branch: `emit_error` persists FAILED.
    async fn complete_failure(&self, request: &ExecutionRequest, failure: &Failure) {
        if self.package_mode || self.recover_terminal {
            let mut event =
                ExecutionEvent::new(EventType::Error, request.task_id, request.subtask_id);
            event.error = Some(failure.message.clone());
            event.error_code = failure.error_code.map(str::to_owned);
            event.result = failure.result();
            if self.emit_package_event(&event).await.is_err() {
                tracing::error!(
                    task_id = request.task_id,
                    "package terminal failure could not be delivered"
                );
            }
            return;
        }
        let Some(redis) = self.redis else {
            return;
        };
        let completion = completion::Completion {
            app: self.app,
            mysql: self.mysql,
            redis,
            tables: self.tables,
            executor_manager: self.executor_manager,
        };
        // `collect_completed_result` (`chat/trigger/lifecycle.py:590-591`) sets
        // `result.error_type` from the classified error code, so the persisted
        // terminal row carries the Source's result payload instead of a NULL one.
        let result = failure.result();
        let Ok(Some(committed)) = completion::complete_terminal_event(
            &completion,
            request.task_id,
            request.subtask_id,
            "FAILED",
            result.as_ref(),
            Some(&failure.message),
            failure.error_code,
            None,
            None,
        )
        .await
        else {
            return;
        };
        if self.forward {
            // `_trigger_ai`'s failure branch emits `chat:error` with the classified
            // error type and message id, then `task:status FAILED`.
            let mut event =
                ExecutionEvent::new(EventType::Error, request.task_id, request.subtask_id);
            event.message_id = request.message_id;
            event.error = Some(failure.message.clone());
            event.error_code = failure.error_code.map(str::to_owned);
            event.result = committed.result;
            if let Err(error) = crate::internal_callback::emitter::emit_terminal_frames(
                redis,
                &event,
                self.owner_user_id,
                event.result.as_ref().unwrap_or(&serde_json::Value::Null),
                None,
            )
            .await
            {
                tracing::warn!(%error, "chat-shell failure frames failed");
            }
        }
    }
}

#[cfg(test)]
#[path = "sse_sync_tests.rs"]
mod consumer_tests;
