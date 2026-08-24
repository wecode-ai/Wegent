// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::task::JoinHandle;

use crate::{
    emitter::{EventEnvelope, ResponsesEventBuilder},
    protocol::{ExecutionRequest, TaskStatus},
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    server::{RunnerResult, TaskRunner},
};

pub trait LocalTaskController: Send + Sync + 'static {
    fn cancel_task<'a>(
        &'a self,
        task_id: String,
        subtask_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

    fn close_task_session<'a>(
        &'a self,
        task_id: String,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

    fn running_task_ids(&self) -> Vec<String>;
}

#[derive(Clone, Default)]
pub struct LocalRunningTaskTracker {
    inner: Arc<Mutex<BTreeSet<String>>>,
}

impl LocalRunningTaskTracker {
    pub fn add(&self, task_id: String) {
        self.inner
            .lock()
            .expect("running task lock")
            .insert(task_id);
    }

    pub fn remove(&self, task_id: &str) {
        self.inner
            .lock()
            .expect("running task lock")
            .remove(task_id);
    }

    pub fn set<I>(&self, task_ids: I)
    where
        I: IntoIterator<Item = String>,
    {
        let mut running = self.inner.lock().expect("running task lock");
        running.clear();
        running.extend(task_ids);
    }

    pub fn running_task_ids(&self) -> Vec<String> {
        self.inner
            .lock()
            .expect("running task lock")
            .iter()
            .cloned()
            .collect()
    }
}

#[derive(Clone)]
pub struct ManagedLocalTaskRunner<E, S>
where
    E: AgentEngine,
    S: EventSink,
{
    engine: E,
    sink: S,
    running_tasks: LocalRunningTaskTracker,
    handles: Arc<Mutex<BTreeMap<String, ManagedTaskHandle>>>,
}

struct ManagedTaskHandle {
    identity: Arc<()>,
    builder: ResponsesEventBuilder,
    cancellation: Arc<CancellationState>,
    handle: JoinHandle<()>,
}

struct CancellationState {
    cancelled: tokio::sync::RwLock<bool>,
}

impl CancellationState {
    fn new() -> Self {
        Self {
            cancelled: tokio::sync::RwLock::new(false),
        }
    }

    async fn cancel(&self) {
        *self.cancelled.write().await = true;
    }
}

#[derive(Clone)]
struct CancellationAwareEventSink<S> {
    inner: S,
    cancellation: Arc<CancellationState>,
}

impl<S> EventSink for CancellationAwareEventSink<S>
where
    S: EventSink,
{
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let inner = self.inner.clone();
        let cancellation = Arc::clone(&self.cancellation);
        Box::pin(async move {
            let cancelled = cancellation.cancelled.read().await;
            if *cancelled {
                return Ok(());
            }
            inner.send(event).await
        })
    }
}

impl<E, S> ManagedLocalTaskRunner<E, S>
where
    E: AgentEngine,
    S: EventSink,
{
    pub fn new(engine: E, sink: S, running_tasks: LocalRunningTaskTracker) -> Self {
        Self {
            engine,
            sink,
            running_tasks,
            handles: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }

    async fn abort_task(&self, task_id: String, message: &str) -> bool {
        let Some(state) = self
            .handles
            .lock()
            .expect("managed task lock")
            .remove(&task_id)
        else {
            self.running_tasks.remove(&task_id);
            return false;
        };
        state.cancellation.cancel().await;
        state.handle.abort();
        let _ = state.handle.await;
        self.running_tasks.remove(&task_id);
        self.sink
            .send(state.builder.response_cancelled(message))
            .await
            .is_ok()
    }
}

impl<E, S> LocalTaskController for ManagedLocalTaskRunner<E, S>
where
    E: AgentEngine,
    S: EventSink,
{
    fn cancel_task<'a>(
        &'a self,
        task_id: String,
        _subtask_id: Option<String>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { self.abort_task(task_id, "Task cancelled").await })
    }

    fn close_task_session<'a>(
        &'a self,
        task_id: String,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { self.abort_task(task_id, "Task session closed").await })
    }

    fn running_task_ids(&self) -> Vec<String> {
        self.running_tasks.running_task_ids()
    }
}

impl<E, S> TaskRunner for ManagedLocalTaskRunner<E, S>
where
    E: AgentEngine,
    S: EventSink,
{
    type SubmitFuture = Pin<Box<dyn Future<Output = RunnerResult> + Send>>;

    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        let engine = self.engine.clone();
        let sink = self.sink.clone();
        let running_tasks = self.running_tasks.clone();
        let handles = Arc::clone(&self.handles);
        Box::pin(async move {
            let task_id = request.task_id.clone();
            let builder = local_event_builder(&request);
            if let Err(message) = sink
                .send(builder.response_created(request.resolved_shell_type().as_deref()))
                .await
            {
                return RunnerResult {
                    status: TaskStatus::Failed,
                    message: Some(message),
                };
            }

            running_tasks.add(task_id.clone());
            let identity = Arc::new(());
            let cancellation = Arc::new(CancellationState::new());
            let task_sink = CancellationAwareEventSink {
                inner: sink,
                cancellation: Arc::clone(&cancellation),
            };
            let handle = tokio::spawn(run_managed_task(
                engine,
                task_sink,
                builder.clone(),
                request,
                running_tasks.clone(),
                Arc::clone(&handles),
                Arc::clone(&identity),
            ));
            let previous = {
                let mut guard = handles.lock().expect("managed task lock");
                guard.insert(
                    task_id,
                    ManagedTaskHandle {
                        identity,
                        builder,
                        cancellation,
                        handle,
                    },
                )
            };
            if let Some(previous) = previous {
                previous.cancellation.cancel().await;
                previous.handle.abort();
            }

            RunnerResult::accepted(TaskStatus::Running)
        })
    }
}

async fn run_managed_task<E, S>(
    engine: E,
    sink: S,
    builder: ResponsesEventBuilder,
    request: ExecutionRequest,
    running_tasks: LocalRunningTaskTracker,
    handles: Arc<Mutex<BTreeMap<String, ManagedTaskHandle>>>,
    identity: Arc<()>,
) where
    E: AgentEngine,
    S: EventSink,
{
    let task_id = request.task_id.clone();
    let outcome = engine
        .run_with_events(request, sink.clone(), builder.clone())
        .await;
    running_tasks.remove(&task_id);
    {
        let mut guard = handles.lock().expect("managed task lock");
        if guard
            .get(&task_id)
            .is_some_and(|state| Arc::ptr_eq(&state.identity, &identity))
        {
            guard.remove(&task_id);
        }
    }

    let event = match outcome {
        ExecutionOutcome::Completed { content } => builder.response_completed(&content),
        ExecutionOutcome::WaitingForUserInput { stop_reason } => {
            builder.response_waiting_for_user_input(&stop_reason)
        }
        ExecutionOutcome::Failed { message } => builder.error(&message, "runtime_error"),
        ExecutionOutcome::Cancelled { message } => builder.response_cancelled(&message),
        ExecutionOutcome::Running => return,
    };
    let _ = sink.send(event).await;
}

fn local_event_builder(request: &ExecutionRequest) -> ResponsesEventBuilder {
    let model = request
        .model_config
        .get("model_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let validation_id = request
        .validation_params
        .get("validation_id")
        .and_then(Value::as_str);
    ResponsesEventBuilder::new(&request.task_id, &request.subtask_id, model)
        .with_message_id(request.message_id)
        .with_executor_info(
            request.executor_name.as_deref(),
            request.executor_namespace.as_deref(),
        )
        .with_validation_id(validation_id)
}

#[cfg(test)]
mod tests {
    use tokio::sync::Notify;

    use super::*;

    #[derive(Clone)]
    struct DetachedLateEventEngine {
        release_late_event: Arc<Notify>,
    }

    impl AgentEngine for DetachedLateEventEngine {
        type RunFuture = std::future::Pending<ExecutionOutcome>;

        fn run(&self, _request: ExecutionRequest) -> Self::RunFuture {
            std::future::pending()
        }

        fn run_with_events<T>(
            &self,
            _request: ExecutionRequest,
            sink: T,
            builder: ResponsesEventBuilder,
        ) -> Pin<Box<dyn Future<Output = ExecutionOutcome> + Send>>
        where
            T: EventSink,
        {
            let release_late_event = Arc::clone(&self.release_late_event);
            tokio::spawn(async move {
                release_late_event.notified().await;
                let _ = sink
                    .send(builder.response_text_delta("late output", 0))
                    .await;
            });
            Box::pin(std::future::pending())
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
    async fn cancellation_blocks_events_from_detached_streaming_callbacks() {
        let release_late_event = Arc::new(Notify::new());
        let sink = RecordingSink::default();
        let runner = ManagedLocalTaskRunner::new(
            DetachedLateEventEngine {
                release_late_event: Arc::clone(&release_late_event),
            },
            sink.clone(),
            LocalRunningTaskTracker::default(),
        );
        let request = ExecutionRequest {
            task_id: "282".to_owned(),
            subtask_id: "536".to_owned(),
            ..ExecutionRequest::default()
        };

        let accepted = runner.submit(request).await;
        assert_eq!(accepted.status, TaskStatus::Running);
        assert!(runner.cancel_task("282".to_owned(), None).await);
        release_late_event.notify_one();
        tokio::task::yield_now().await;

        let events = sink.events.lock().expect("event sink lock");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "response.created");
        assert_eq!(events[1].event_type, "response.incomplete");
        assert_eq!(events[1].data["response"]["status"], "cancelled");
    }
}
