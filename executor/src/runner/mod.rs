// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin};

use crate::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    protocol::{ExecutionRequest, TaskStatus},
    server::{RunnerResult, TaskRunner},
};

pub trait AgentEngine: Clone + Send + Sync + 'static {
    type RunFuture: Future<Output = ExecutionOutcome> + Send + 'static;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture;
}

pub trait EventSink: Clone + Send + Sync + 'static {
    type SendFuture: Future<Output = Result<(), String>> + Send + 'static;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionOutcome {
    Completed { content: String },
    Failed { message: String },
    Running,
    Cancelled { message: String },
}

#[derive(Debug, Clone)]
pub struct BackgroundTaskRunner<E, S> {
    engine: E,
    sink: S,
}

impl<E, S> BackgroundTaskRunner<E, S> {
    pub fn new(engine: E, sink: S) -> Self {
        Self { engine, sink }
    }
}

impl<E, S> TaskRunner for BackgroundTaskRunner<E, S>
where
    E: AgentEngine,
    S: EventSink,
{
    type SubmitFuture = Pin<Box<dyn Future<Output = RunnerResult> + Send>>;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        let engine = self.engine.clone();
        let sink = self.sink.clone();
        Box::pin(async move {
            let builder = event_builder(&request);
            if let Err(message) = sink
                .send(builder.response_created(request.resolved_shell_type().as_deref()))
                .await
            {
                return RunnerResult {
                    status: TaskStatus::Failed,
                    message: Some(message),
                };
            }

            tokio::spawn(run_in_background(engine, sink, builder, request));
            RunnerResult::accepted(TaskStatus::Running)
        })
    }
}

async fn run_in_background<E, S>(
    engine: E,
    sink: S,
    builder: ResponsesEventBuilder,
    request: ExecutionRequest,
) where
    E: AgentEngine,
    S: EventSink,
{
    let event = match engine.run(request).await {
        ExecutionOutcome::Completed { content } => builder.response_completed(&content),
        ExecutionOutcome::Failed { message } => builder.error(&message, "runtime_error"),
        ExecutionOutcome::Cancelled { message } => builder.error(&message, "cancelled"),
        ExecutionOutcome::Running => return,
    };
    let _ = sink.send(event).await;
}

fn event_builder(request: &ExecutionRequest) -> ResponsesEventBuilder {
    let model = request
        .model_config
        .get("model_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    ResponsesEventBuilder::new(request.task_id, request.subtask_id, model)
        .with_message_id(request.message_id)
        .with_executor_info(
            request.executor_name.as_deref(),
            request.executor_namespace.as_deref(),
        )
}
