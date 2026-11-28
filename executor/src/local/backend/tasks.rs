// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{future::Future, pin::Pin, sync::Arc};

use serde_json::Value;
use wegent_execution_contracts::ipc::{BoxFuture, PlatformTurn, RuntimeWorkHandler, TurnObserver};

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

pub(super) use crate::runner::platform_command_id;

#[derive(Clone)]
pub struct PlatformTaskAdapter<E, S> {
    engine: E,
    sink: S,
    scheduler: Arc<dyn RuntimeWorkHandler>,
    scope: String,
    connection: Option<DeliveryConnection>,
}

#[derive(Clone)]
struct DeliveryConnection {
    config: Arc<super::LocalBackendConfig>,
    snapshot: crate::agents::model_gateway::ConnectionSnapshot,
}

impl DeliveryConnection {
    fn current(&self) -> bool {
        self.snapshot
            .lock()
            .expect("connection snapshot poisoned")
            .as_ref()
            .is_some_and(|connection| {
                super::handlers::matches_task_connection(&self.config, connection)
            })
    }
}

struct CancellationState {
    cancelled: tokio::sync::RwLock<bool>,
    observer: std::sync::OnceLock<TurnObserver>,
    connection: Option<DeliveryConnection>,
}

impl CancellationState {
    fn new(connection: Option<DeliveryConnection>) -> Self {
        Self {
            connection,
            cancelled: tokio::sync::RwLock::new(false),
            observer: Default::default(),
        }
    }

    fn authorize(&self) -> Result<(), String> {
        if self
            .connection
            .as_ref()
            .is_some_and(|binding| !binding.current())
        {
            return Err("The execution connection is no longer authorized".into());
        }
        Ok(())
    }

    fn observe(&self, event: &EventEnvelope) {
        if let Some(observer) = self.observer.get() {
            observer(event);
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
            cancellation.authorize()?;
            cancellation.observe(&event);
            inner.send(event).await
        })
    }
}

impl<E: AgentEngine, S: EventSink> PlatformTaskAdapter<E, S> {
    pub fn new(engine: E, sink: S, scheduler: Arc<dyn RuntimeWorkHandler>, scope: String) -> Self {
        Self {
            engine,
            sink,
            scheduler,
            scope,
            connection: None,
        }
    }

    pub(super) fn with_connection(
        mut self,
        config: Arc<super::LocalBackendConfig>,
        snapshot: crate::agents::model_gateway::ConnectionSnapshot,
    ) -> Self {
        self.connection = Some(DeliveryConnection { config, snapshot });
        self
    }

    fn session(&self, task: &str) -> String {
        crate::runner::platform_session_key(&self.scope, task)
    }
    fn stop(
        &self,
        task_id: String,
        subtask_id: Option<String>,
        remember: bool,
    ) -> BoxFuture<'_, bool> {
        let engine = self.engine.clone();
        let sink = self.sink.clone();
        let session = self.session(&task_id);
        let attempt = subtask_id.clone();
        self.scheduler.cancel_platform_turn(
            session,
            subtask_id,
            remember,
            Box::new(move || {
                let event = engine.cancel_pending(&task_id, attempt.as_deref())?;
                let command =
                    platform_command_id(&event.subtask_id, event.execution_attempt_id.as_deref());
                Some((
                    command,
                    Box::pin(async move { sink.send(event).await.is_ok() }),
                ))
            }),
        )
    }
}

struct PlatformDelivery<S> {
    builder: ResponsesEventBuilder,
    cancellation: Arc<CancellationState>,
    sink: S,
    request: ExecutionRequest,
}

impl<S: EventSink> PlatformTurn for PlatformDelivery<S> {
    fn request(&self) -> ExecutionRequest {
        self.request.clone()
    }
    fn task_id(&self) -> &str {
        &self.request.task_id
    }
    fn authorized(&self) -> bool {
        self.cancellation.authorize().is_ok()
    }
    fn backend_origin(&self) -> Option<&str> {
        self.cancellation
            .connection
            .as_ref()
            .filter(|binding| binding.current())
            .map(|binding| binding.config.backend_url.as_str())
    }
    fn starting(&self, observer: Option<TurnObserver>) {
        if let Some(observer) = observer {
            let _ = self.cancellation.observer.set(observer);
        }
    }

    fn created(&self) -> BoxFuture<'_, Result<(), String>> {
        if let Err(error) = self.cancellation.authorize() {
            return Box::pin(async { Err(error) });
        }
        let event = self
            .builder
            .response_created(self.request.resolved_shell_type().as_deref());
        self.cancellation.observe(&event);
        Box::pin(self.sink.send(event))
    }

    fn terminal(&self, outcome: ExecutionOutcome) -> BoxFuture<'_, Option<EventEnvelope>> {
        Box::pin(async move {
            self.cancellation.cancel().await;
            let builder = self
                .builder
                .clone()
                .with_executor_session(crate::agent_session::saved_executor_session(&self.request));

            let event = crate::runner::result_event(&builder, outcome)?;
            if self.cancellation.authorize().is_ok() {
                self.cancellation.observe(&event);
            }
            Some(event)
        })
    }

    fn deliver_terminal(&self, event: EventEnvelope) -> BoxFuture<'_, Result<(), String>> {
        if let Err(error) = self.cancellation.authorize() {
            return Box::pin(async { Err(error) });
        }
        Box::pin(self.sink.send(event))
    }
}

impl<E: AgentEngine, S: EventSink> LocalTaskController for PlatformTaskAdapter<E, S> {
    fn cancel_task<'a>(
        &'a self,
        task_id: String,
        subtask_id: Option<String>,
    ) -> BoxFuture<'a, bool> {
        self.stop(task_id, subtask_id, true)
    }
    fn close_task_session<'a>(&'a self, task_id: String) -> BoxFuture<'a, bool> {
        self.stop(task_id, None, false)
    }
    fn running_task_ids(&self) -> Vec<String> {
        self.scheduler.running_platform_task_ids(&self.scope)
    }
}

impl<E: AgentEngine, S: EventSink> TaskRunner for PlatformTaskAdapter<E, S> {
    type SubmitFuture = Pin<Box<dyn Future<Output = RunnerResult> + Send>>;
    fn submit(&self, request: ExecutionRequest) -> Self::SubmitFuture {
        let scheduler = self.scheduler.clone();
        let session = self.session(&request.task_id);
        let subtask = crate::runner::execution_command_id(&request);
        let builder = local_event_builder(&request);
        let cancellation = Arc::new(CancellationState::new(self.connection.clone()));
        let shell = Arc::new(crate::runner::EngineTurn {
            engine: self.engine.clone(),
            request: request.clone(),
            builder: builder.clone(),
            sink: CancellationAwareEventSink {
                inner: self.sink.clone(),
                cancellation: cancellation.clone(),
            },
        });
        let job = Arc::new(PlatformDelivery {
            builder,
            cancellation,
            sink: self.sink.clone(),
            request,
        });
        Box::pin(async move {
            scheduler
                .submit_platform_turn(session, subtask, job, shell)
                .await
                .unwrap_or_else(|error| RunnerResult {
                    status: TaskStatus::Failed,
                    message: Some(error.message),
                })
        })
    }
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
        .with_execution_attempt_id(
            request
                .extra
                .get("execution_attempt_id")
                .and_then(Value::as_str),
        )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
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

    #[test]
    fn cancellation_blocks_events_from_detached_streaming_callbacks() {
        crate::test_env::run_with_executor_home(verify_detached_callback_cancellation());
    }

    async fn verify_detached_callback_cancellation() {
        let release_late_event = Arc::new(Notify::new());
        let sink = RecordingSink::default();
        let runner = PlatformTaskAdapter::new(
            DetachedLateEventEngine {
                release_late_event: Arc::clone(&release_late_event),
            },
            sink.clone(),
            Arc::new(crate::runtime_work::RuntimeWorkRpcHandler::new(
                "test", "unused",
            )),
            uuid::Uuid::new_v4().to_string(),
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

    #[test]
    fn late_cancellation_cannot_abort_a_newer_turn_of_the_same_task() {
        crate::test_env::run_with_executor_home(verify_late_cancellation());
    }

    async fn verify_late_cancellation() {
        let sink = RecordingSink::default();
        let runner = PlatformTaskAdapter::new(
            DetachedLateEventEngine {
                release_late_event: Arc::new(Notify::new()),
            },
            sink.clone(),
            Arc::new(crate::runtime_work::RuntimeWorkRpcHandler::new(
                "test", "unused",
            )),
            uuid::Uuid::new_v4().to_string(),
        );
        let request = |id: &str| ExecutionRequest {
            task_id: "282".into(),
            subtask_id: id.into(),
            ..Default::default()
        };
        assert_eq!(
            runner.submit(request("536")).await.status,
            TaskStatus::Running
        );
        assert_eq!(
            runner.submit(request("536")).await.status,
            TaskStatus::Running
        );
        assert_eq!(
            runner.submit(request("537")).await.status,
            TaskStatus::Pending
        );
        assert!(runner.cancel_task("282".into(), Some("536".into())).await);
        assert!(!runner.cancel_task("282".into(), Some("536".into())).await);
        assert_eq!(runner.running_task_ids(), vec!["282"]);
        assert!(
            runner
                .cancel_task("282".to_owned(), Some("537".to_owned()))
                .await
        );
        assert!(runner.running_task_ids().is_empty());
        {
            let events = sink.events.lock().expect("event sink lock");
            assert_eq!(events.len(), 4);
            assert_eq!(events[2].event_type, "response.created");
            assert_eq!(events[3].event_type, "response.incomplete");
            assert_eq!(events[3].subtask_id, "537");
            assert_eq!(events[3].data["response"]["status"], "cancelled");
        }

        let mut retry = request("537");
        retry
            .extra
            .insert("execution_attempt_id".into(), serde_json::json!("retry"));
        assert_eq!(runner.submit(retry).await.status, TaskStatus::Running);
        assert!(!runner.cancel_task("282".into(), Some("537".into())).await);
        assert_eq!(runner.running_task_ids(), vec!["282"]);
        assert!(
            runner
                .cancel_task(
                    "282".into(),
                    Some(platform_command_id("537", Some("retry")))
                )
                .await
        );
    }
}
