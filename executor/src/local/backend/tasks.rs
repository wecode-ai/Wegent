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
    emitter::ResponsesEventBuilder,
    protocol::{ExecutionRequest, TaskStatus},
    runner::{AgentEngine, EventSink, ExecutionOutcome},
    server::{RunnerResult, TaskRunner},
};

pub trait LocalTaskController: Send + Sync + 'static {
    fn cancel_task<'a>(
        &'a self,
        task_id: i64,
        subtask_id: Option<i64>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

    fn close_task_session<'a>(
        &'a self,
        task_id: i64,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;

    fn running_task_ids(&self) -> Vec<i64>;
}

#[derive(Clone, Default)]
pub struct LocalRunningTaskTracker {
    inner: Arc<Mutex<BTreeSet<i64>>>,
}

impl LocalRunningTaskTracker {
    pub fn add(&self, task_id: i64) {
        self.inner
            .lock()
            .expect("running task lock")
            .insert(task_id);
    }

    pub fn remove(&self, task_id: i64) {
        self.inner
            .lock()
            .expect("running task lock")
            .remove(&task_id);
    }

    pub fn set<I>(&self, task_ids: I)
    where
        I: IntoIterator<Item = i64>,
    {
        let mut running = self.inner.lock().expect("running task lock");
        running.clear();
        running.extend(task_ids);
    }

    pub fn running_task_ids(&self) -> Vec<i64> {
        self.inner
            .lock()
            .expect("running task lock")
            .iter()
            .copied()
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
    handles: Arc<Mutex<BTreeMap<i64, ManagedTaskHandle>>>,
}

struct ManagedTaskHandle {
    builder: ResponsesEventBuilder,
    handle: JoinHandle<()>,
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

    async fn abort_task(&self, task_id: i64, message: &str) -> bool {
        let Some(state) = self
            .handles
            .lock()
            .expect("managed task lock")
            .remove(&task_id)
        else {
            self.running_tasks.remove(task_id);
            return false;
        };
        state.handle.abort();
        self.running_tasks.remove(task_id);
        let _ = self
            .sink
            .send(state.builder.error(message, "cancelled"))
            .await;
        true
    }
}

impl<E, S> LocalTaskController for ManagedLocalTaskRunner<E, S>
where
    E: AgentEngine,
    S: EventSink,
{
    fn cancel_task<'a>(
        &'a self,
        task_id: i64,
        _subtask_id: Option<i64>,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { self.abort_task(task_id, "Task cancelled").await })
    }

    fn close_task_session<'a>(
        &'a self,
        task_id: i64,
    ) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
        Box::pin(async move { self.abort_task(task_id, "Task session closed").await })
    }

    fn running_task_ids(&self) -> Vec<i64> {
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
            let task_id = request.task_id;
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

            running_tasks.add(task_id);
            let mut guard = handles.lock().expect("managed task lock");
            let handle = tokio::spawn(run_managed_task(
                engine,
                sink,
                builder.clone(),
                request,
                running_tasks.clone(),
                Arc::clone(&handles),
            ));
            if let Some(previous) = guard.insert(task_id, ManagedTaskHandle { builder, handle }) {
                previous.handle.abort();
            }
            drop(guard);

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
    handles: Arc<Mutex<BTreeMap<i64, ManagedTaskHandle>>>,
) where
    E: AgentEngine,
    S: EventSink,
{
    let task_id = request.task_id;
    let outcome = engine
        .run_with_events(request, sink.clone(), builder.clone())
        .await;
    running_tasks.remove(task_id);
    handles.lock().expect("managed task lock").remove(&task_id);

    let event = match outcome {
        ExecutionOutcome::Completed { content } => builder.response_completed(&content),
        ExecutionOutcome::WaitingForUserInput { stop_reason } => {
            builder.response_waiting_for_user_input(&stop_reason)
        }
        ExecutionOutcome::Failed { message } => builder.error(&message, "runtime_error"),
        ExecutionOutcome::Cancelled { message } => builder.error(&message, "cancelled"),
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
    ResponsesEventBuilder::new(request.task_id, request.subtask_id, model)
        .with_message_id(request.message_id)
        .with_executor_info(
            request.executor_name.as_deref(),
            request.executor_namespace.as_deref(),
        )
}
