// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use tokio::{sync::oneshot, task::JoinHandle};

use crate::{
    claude_session,
    emitter::{EventEnvelope, ResponsesEventBuilder},
    logging::{log_executor_event, task_fields},
    protocol::{AgentKind, ExecutionRequest, TaskStatus},
    server::{RunnerResult, TaskRunner},
};

pub trait AgentEngine: Clone + Send + Sync + 'static {
    type RunFuture: Future<Output = ExecutionOutcome> + Send + 'static;

    fn run(&self, request: ExecutionRequest) -> Self::RunFuture;

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

#[derive(Debug, Clone)]
pub struct BackgroundTaskRunner<E, S> {
    engine: E,
    sink: S,
    handles: Arc<Mutex<BTreeMap<(String, String), BackgroundTaskHandle>>>,
}

#[derive(Debug)]
struct BackgroundTaskHandle {
    identity: Arc<()>,
    builder: ResponsesEventBuilder,
    handle: JoinHandle<()>,
}

struct BackgroundTaskRegistration {
    handles: Arc<Mutex<BTreeMap<(String, String), BackgroundTaskHandle>>>,
    key: (String, String),
    identity: Arc<()>,
}

impl BackgroundTaskRegistration {
    fn remove_if_current(&self) {
        let mut guard = self.handles.lock().expect("background task lock");
        if guard
            .get(&self.key)
            .is_some_and(|state| Arc::ptr_eq(&state.identity, &self.identity))
        {
            guard.remove(&self.key);
        }
    }
}

impl<E, S> BackgroundTaskRunner<E, S> {
    pub fn new(engine: E, sink: S) -> Self {
        Self {
            engine,
            sink,
            handles: Arc::new(Mutex::new(BTreeMap::new())),
        }
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
        let handles = Arc::clone(&self.handles);
        Box::pin(async move {
            let builder = event_builder(&request);
            let fields = task_fields(&request.task_id, &request.subtask_id);
            log_executor_event("sending response.created callback", &fields);
            if let Err(message) = sink
                .send(builder.response_created(request.resolved_shell_type().as_deref()))
                .await
            {
                let mut failed_fields = fields.clone();
                failed_fields.push(("error_len", message.len().to_string()));
                failed_fields.push(("error", truncate_for_log(&message)));
                log_executor_event("response.created callback failed", &failed_fields);
                return RunnerResult {
                    status: TaskStatus::Failed,
                    message: Some(message),
                };
            }

            log_executor_event("queued background task", &fields);
            let key = (request.task_id.clone(), request.subtask_id.clone());
            let identity = Arc::new(());
            let (start_tx, start_rx) = oneshot::channel();
            let handle = tokio::spawn(run_in_background(
                engine,
                sink,
                builder.clone(),
                request,
                BackgroundTaskRegistration {
                    handles: Arc::clone(&handles),
                    key: key.clone(),
                    identity: Arc::clone(&identity),
                },
                start_rx,
            ));
            let previous = handles.lock().expect("background task lock").insert(
                key,
                BackgroundTaskHandle {
                    identity,
                    builder,
                    handle,
                },
            );
            if let Some(previous) = previous {
                previous.handle.abort();
            }
            let _ = start_tx.send(());
            RunnerResult::accepted(TaskStatus::Running)
        })
    }

    fn cancel(
        &self,
        task_id: String,
        subtask_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        let handles = Arc::clone(&self.handles);
        let sink = self.sink.clone();
        Box::pin(async move {
            let mut fields = task_fields(&task_id, subtask_id.as_deref().unwrap_or(""));
            log_executor_event("task cancellation requested", &fields);
            let state = {
                let mut guard = handles.lock().expect("background task lock");
                let key = subtask_id
                    .as_ref()
                    .map(|subtask_id| (task_id.clone(), subtask_id.clone()))
                    .or_else(|| guard.keys().find(|key| key.0 == task_id).cloned());
                key.and_then(|key| guard.remove(&key))
            };
            let Some(state) = state else {
                fields.push(("result", "not_running".to_owned()));
                log_executor_event("task cancellation skipped", &fields);
                return false;
            };
            state.handle.abort();
            match state.handle.await {
                Ok(()) => {
                    fields.push(("abort_result", "already_finished".to_owned()));
                }
                Err(error) if error.is_cancelled() => {
                    fields.push(("abort_result", "cancelled".to_owned()));
                }
                Err(error) => {
                    fields.push(("abort_result", "join_failed".to_owned()));
                    fields.push(("abort_error", truncate_for_log(&error.to_string())));
                }
            }
            log_executor_event("task execution stop confirmed", &fields);
            fields.push(("callback_event", "response.incomplete".to_owned()));
            match sink
                .send(state.builder.response_cancelled("Task cancelled"))
                .await
            {
                Ok(()) => {
                    log_executor_event("task cancellation completed", &fields);
                    true
                }
                Err(message) => {
                    fields.push(("error_len", message.len().to_string()));
                    fields.push(("error", truncate_for_log(&message)));
                    log_executor_event("task cancellation callback failed", &fields);
                    false
                }
            }
        })
    }
}

async fn run_in_background<E, S>(
    engine: E,
    sink: S,
    builder: ResponsesEventBuilder,
    request: ExecutionRequest,
    registration: BackgroundTaskRegistration,
    start_rx: oneshot::Receiver<()>,
) where
    E: AgentEngine,
    S: EventSink,
{
    let _ = start_rx.await;
    let fields = task_fields(&request.task_id, &request.subtask_id);
    log_executor_event("background task started", &fields);
    let session_request = request.clone();
    let outcome = engine
        .run_with_events(request, sink.clone(), builder.clone())
        .await;
    let executor_session = (session_request.resolved_agent_kind() == AgentKind::ClaudeCode)
        .then(|| claude_session::saved_executor_session(&session_request))
        .flatten();
    let builder = builder.with_executor_session(executor_session);
    let mut outcome_fields = fields.clone();
    outcome_fields.push(("outcome", outcome_name(&outcome).to_owned()));
    log_executor_event("background task finished", &outcome_fields);
    registration.remove_if_current();

    let event = match outcome {
        ExecutionOutcome::Completed { content } => builder.response_completed(&content),
        ExecutionOutcome::WaitingForUserInput { stop_reason } => {
            builder.response_waiting_for_user_input(&stop_reason)
        }
        ExecutionOutcome::Failed { message } => builder.error(&message, "runtime_error"),
        ExecutionOutcome::Cancelled { message } => builder.response_cancelled(&message),
        ExecutionOutcome::Running => return,
    };
    match sink.send(event).await {
        Ok(()) => log_executor_event("final callback sent", &outcome_fields),
        Err(message) => {
            outcome_fields.push(("error_len", message.len().to_string()));
            outcome_fields.push(("error", truncate_for_log(&message)));
            log_executor_event("final callback failed", &outcome_fields);
        }
    }
}

fn truncate_for_log(value: &str) -> String {
    const LIMIT: usize = 500;
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(LIMIT).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn event_builder(request: &ExecutionRequest) -> ResponsesEventBuilder {
    let model = request
        .model_config
        .get("model_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let executor_name = request
        .executor_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| env_value("EXECUTOR_NAME"));
    let executor_namespace = request
        .executor_namespace
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| env_value("EXECUTOR_NAMESPACE"));
    let validation_id = request
        .validation_params
        .get("validation_id")
        .and_then(|value| value.as_str());
    ResponsesEventBuilder::new(&request.task_id, &request.subtask_id, model)
        .with_message_id(request.message_id)
        .with_executor_info(executor_name.as_deref(), executor_namespace.as_deref())
        .with_validation_id(validation_id)
}

fn outcome_name(outcome: &ExecutionOutcome) -> &'static str {
    match outcome {
        ExecutionOutcome::Completed { .. } => "completed",
        ExecutionOutcome::WaitingForUserInput { .. } => "waiting_for_user_input",
        ExecutionOutcome::Failed { .. } => "failed",
        ExecutionOutcome::Running => "running",
        ExecutionOutcome::Cancelled { .. } => "cancelled",
    }
}

fn env_value(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct PendingEngine;

    impl AgentEngine for PendingEngine {
        type RunFuture = std::future::Pending<ExecutionOutcome>;

        fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
            std::future::pending()
        }
    }

    #[derive(Clone, Default)]
    struct RecordingSink {
        events: Arc<Mutex<Vec<EventEnvelope>>>,
    }

    impl EventSink for RecordingSink {
        type SendFuture = std::future::Ready<Result<(), String>>;

        fn send(&self, event: EventEnvelope) -> Self::SendFuture {
            self.events.lock().expect("event sink lock").push(event);
            std::future::ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn cancellation_aborts_active_task_and_emits_runtime_terminal_event() {
        let sink = RecordingSink::default();
        let runner = BackgroundTaskRunner::new(PendingEngine, sink.clone());
        let request = ExecutionRequest {
            task_id: "282".to_owned(),
            subtask_id: "536".to_owned(),
            ..ExecutionRequest::default()
        };

        let accepted = runner.submit(request).await;
        assert_eq!(accepted.status, TaskStatus::Running);
        assert!(
            runner
                .cancel("282".to_owned(), Some("536".to_owned()))
                .await
        );
        assert!(!runner.cancel("282".to_owned(), None).await);

        let events = sink.events.lock().expect("event sink lock");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "response.created");
        assert_eq!(events[1].event_type, "response.incomplete");
        assert_eq!(events[1].data["response"]["status"], "cancelled");
        assert_eq!(events[1].data["response"]["error"]["code"], "cancelled");
    }
}
