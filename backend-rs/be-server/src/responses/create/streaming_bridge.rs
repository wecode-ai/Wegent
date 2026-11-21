// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Connect the Responses streaming consumer to gateway dispatch and completion.

use std::sync::{Arc, Weak};

use async_trait::async_trait;
use brz_mysql::{MysqlError, MysqlResult, MysqlService};
use brz_redis::RedisService;
use wegent_execution_completion::StoredTerminal;
use wegent_responses_streaming::streaming_bridge::{
    self as streaming, BridgeHost, CallbackDispatch, CallbackDispatchTarget, CallbackSession,
    CommittedResult, TerminalUpdate,
};

use crate::executor_manager::ExecutorManager;
use crate::http_compat::FastApiError;
use crate::internal_callback::completion::{self, Completion, Tables};
use crate::state::AppState;

use super::{dispatch::ExecutionRequest, seam};

pub(super) use streaming::BridgeInput;

pub(super) fn stream(
    state: &AppState,
    request: &ExecutionRequest,
    input: &BridgeInput<'_>,
) -> Result<seam::BodyStream, FastApiError> {
    streaming::stream(
        Box::new(GatewayBridge::new(state)),
        state.redis.clone(),
        request,
        input,
    )
}

pub(super) fn stream_callback(
    state: &AppState,
    request: &ExecutionRequest,
    input: &BridgeInput<'_>,
    device_route: Option<&str>,
) -> Result<seam::BodyStream, FastApiError> {
    streaming::stream_callback(
        Box::new(GatewayBridge::new(state)),
        state.redis.clone(),
        request,
        input,
        device_route,
    )
}

struct GatewayBridge {
    app: Weak<AppState>,
    mysql: MysqlService,
    redis: Option<RedisService>,
    tables: Tables,
    executor_manager: ExecutorManager,
}

impl GatewayBridge {
    fn new(state: &AppState) -> Self {
        Self {
            app: state.completion_app.get().cloned().unwrap_or_default(),
            mysql: state.mysql.clone(),
            redis: state.redis.clone(),
            tables: crate::internal_callback::tables(state),
            executor_manager: state.executor_manager.clone(),
        }
    }
}

#[async_trait]
impl BridgeHost for GatewayBridge {
    fn callback_session(&self) -> Result<CallbackSession, String> {
        let app = self.app.upgrade().ok_or("Application state unavailable")?;
        let subscriptions = app
            .callback_subscriptions
            .clone()
            .ok_or("Failed to subscribe to callback stream channel")?;
        Ok(CallbackSession {
            subscriptions,
            dispatcher: Box::new(GatewayCallback(app)),
        })
    }

    async fn settle_device_admission_failure(
        &self,
        request: &ExecutionRequest,
        error: &str,
    ) -> bool {
        let Some(app) = self.app.upgrade() else {
            return false;
        };
        seam::settle_responses_device_failure(&app, request, error, false).await;
        true
    }

    async fn complete(&self, update: TerminalUpdate<'_>) -> MysqlResult<Option<CommittedResult>> {
        let Some(redis) = &self.redis else {
            return Err(MysqlError::InvalidConfig {
                reason: "Redis is required for execution completion".into(),
            });
        };
        let app = self.app.upgrade();
        if app.is_none() {
            tracing::error!(
                task_id = update.task_id,
                "Application state unavailable during streamed task completion"
            );
        }
        let ctx = Completion {
            app: app.as_deref(),
            mysql: &self.mysql,
            redis,
            tables: self.tables,
            executor_manager: &self.executor_manager,
        };
        completion::complete_terminal_event(
            &ctx,
            update.task_id,
            update.subtask_id,
            update.status,
            update.result,
            update.error,
            update.error_code,
            None,
            None,
        )
        .await
        .map(|completed| {
            completed.map(|value| CommittedResult {
                result: value.result,
            })
        })
    }

    async fn read_terminal_result(
        &self,
        task_id: i64,
        subtask_id: i64,
    ) -> MysqlResult<Option<StoredTerminal>> {
        let app = self.app.upgrade();
        let (_, subtask_table) = completion::resolve_tables(app.as_deref(), self.tables, task_id)
            .await
            .inspect_err(|error| {
                tracing::warn!(%error, task_id, "terminal result table read failed");
            })?;
        completion::read_terminal_result(&self.mysql, &subtask_table, task_id, subtask_id).await
    }
}

struct GatewayCallback(Arc<AppState>);

#[async_trait]
impl CallbackDispatch for GatewayCallback {
    async fn submit(
        &self,
        target: &CallbackDispatchTarget,
        request: &mut ExecutionRequest,
        request_id: &str,
    ) -> Result<(), FastApiError> {
        match target {
            CallbackDispatchTarget::Executor { url } => {
                seam::dispatch_executor_after_subscribe(
                    &self.0,
                    request,
                    url.as_deref(),
                    request_id,
                )
                .await
            }
            CallbackDispatchTarget::Device { route } => {
                seam::enqueue_responses_device(&self.0, request, route)
            }
        }
    }
}

#[cfg(test)]
#[path = "streaming_bridge/tests.rs"]
mod tests;
