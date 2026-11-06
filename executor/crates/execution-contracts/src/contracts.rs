// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use crate::emitter::{EventEnvelope, ResponsesEventBuilder};
use std::{future::Future, pin::Pin};
use wegent_protocol::{ExecutionRequest, TaskStatus};

pub trait AgentEngine: Clone + Send + Sync + 'static {
    type RunFuture: Future<Output = ExecutionOutcome> + Send + 'static;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture;

    /// Release a suspended interaction after its execution callback has completed.
    fn cancel_pending(&self, _task_id: &str, _subtask_id: Option<&str>) -> Option<EventEnvelope> {
        None
    }

    fn run_with_events<S>(
        &self,
        request: ExecutionRequest,
        _sink: S,
        _builder: ResponsesEventBuilder,
    ) -> Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>
    where
        S: EventSink,
    {
        Box::pin(self.run(request))
    }
}

pub trait EventSink: Clone + Send + Sync + 'static {
    type SendFuture: Future<Output = Result<(), String>> + Send + 'static;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionOutcome {
    Completed { content: String },
    WaitingForUserInput { stop_reason: String },
    Failed { message: String },
    Running,
    Cancelled { message: String },
}

pub trait TaskRunner: Clone + Send + Sync + 'static {
    type SubmitFuture: Future<Output = RunnerResult> + Send + 'static;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture;

    fn cancel(
        &self,
        _task_id: String,
        _subtask_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        Box::pin(async { false })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerResult {
    pub status: TaskStatus,
    pub message: Option<String>,
}

impl RunnerResult {
    pub fn accepted(status: TaskStatus) -> Self {
        Self {
            status,
            message: None,
        }
    }
}
