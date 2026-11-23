// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;

use async_trait::async_trait;
use brz_mysql::MysqlResult;
use serde_json::Value;
use wegent_execution_completion::StoredTerminal;
use wegent_http_compat::FastApiError;
use wegent_protocol::dispatch::ExecutionRequest;

use crate::callback_source::CallbackSubscriptions;

use super::CallbackDispatchTarget;

/// Hold the callback provider and its dispatch host for one subscription.
pub struct CallbackSession {
    pub subscriptions: Arc<dyn CallbackSubscriptions>,
    pub dispatcher: Box<dyn CallbackDispatch>,
}

#[async_trait]
pub trait CallbackDispatch: Send + Sync {
    async fn submit(
        &self,
        target: &CallbackDispatchTarget,
        request: &mut ExecutionRequest,
        request_id: &str,
    ) -> Result<(), FastApiError>;
}

pub struct TerminalUpdate<'a> {
    pub task_id: i64,
    pub subtask_id: i64,
    pub status: &'a str,
    pub result: Option<&'a Value>,
    pub error: Option<&'a str>,
    pub error_code: Option<&'a str>,
}

pub struct CommittedResult {
    pub result: Option<Value>,
}

/// Host effects that must use the running gateway's dispatch and completion services.
#[async_trait]
pub trait BridgeHost: Send + Sync {
    fn callback_session(&self) -> Result<CallbackSession, String>;

    /// Returns whether the running dispatcher was available to settle the failure.
    async fn settle_device_admission_failure(
        &self,
        request: &ExecutionRequest,
        error: &str,
    ) -> bool;

    async fn complete(&self, update: TerminalUpdate<'_>) -> MysqlResult<Option<CommittedResult>>;

    async fn read_terminal_result(
        &self,
        task_id: i64,
        subtask_id: i64,
    ) -> MysqlResult<Option<StoredTerminal>>;
}
