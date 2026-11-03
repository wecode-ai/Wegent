// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::future::join_all;
use tokio::sync::oneshot;

use super::config::{ConfigErrorCode, QUEUE_MAX_EVENTS, ReporterConfig};
use super::contract::EventKind;
use super::envelope::{EncodeError, encode};
use super::fact::{FactBuildError, FactDraft};
use super::kafka::KafkaTransport;
use super::metrics::{AtomicCounters, CounterKind, MetricsPublisher, ReporterCounters};
use super::queue::{ByteBoundedQueue, QueueReceiver, QueueSnapshot, QueuedEvent};
use super::transport::{EventTransport, TransportError, TransportErrorKind};

const SENDER_BATCH_MAX_EVENTS: usize = 128;
const INITIAL_RETRY_DELAY: Duration = Duration::from_millis(250);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SenderState {
    Disabled,
    Misconfigured,
    Starting,
    HalfOpen,
    Running,
    Degraded,
    Stopping,
    Stopped,
    Failed,
}

impl SenderState {
    fn from_byte(value: u8) -> Self {
        match value {
            1 => Self::Misconfigured,
            2 => Self::Starting,
            3 => Self::HalfOpen,
            4 => Self::Running,
            5 => Self::Degraded,
            6 => Self::Stopping,
            7 => Self::Stopped,
            8 => Self::Failed,
            _ => Self::Disabled,
        }
    }
}

struct ReporterInner {
    config: Option<Arc<ReporterConfig>>,
    queue: Option<ByteBoundedQueue>,
    state: AtomicU8,
    probe_taken: AtomicBool,
    configuration_error: Option<ConfigErrorCode>,
    counters: AtomicCounters,
    last_ack_unix_seconds: AtomicU64,
}

impl ReporterInner {
    fn inactive(state: SenderState, error: Option<ConfigErrorCode>) -> Arc<Self> {
        Arc::new(Self {
            config: None,
            queue: None,
            state: AtomicU8::new(state as u8),
            probe_taken: AtomicBool::new(false),
            configuration_error: error,
            counters: AtomicCounters::default(),
            last_ack_unix_seconds: AtomicU64::new(0),
        })
    }

    fn state(&self) -> SenderState {
        SenderState::from_byte(self.state.load(Ordering::Acquire))
    }

    fn set_state(&self, state: SenderState) {
        self.state.store(state as u8, Ordering::Release);
    }

    fn claim_admission(&self) -> Option<bool> {
        match self.state() {
            SenderState::Running => Some(false),
            SenderState::HalfOpen => self
                .probe_taken
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
                .ok()
                .map(|_| true),
            _ => None,
        }
    }

    fn release_probe(&self, was_probe: bool) {
        if was_probe {
            self.probe_taken.store(false, Ordering::Release);
        }
    }

    fn health(&self) -> ReporterHealth {
        let QueueSnapshot {
            queued_events,
            queued_bytes,
            in_flight_events,
            in_flight_bytes,
        } = self
            .queue
            .as_ref()
            .map(ByteBoundedQueue::snapshot)
            .unwrap_or_default();
        let last_ack = self.last_ack_unix_seconds.load(Ordering::Relaxed);
        ReporterHealth {
            state: self.state(),
            configuration_error: self.configuration_error,
            queue_events: queued_events,
            queue_bytes: queued_bytes,
            in_flight_events,
            in_flight_bytes,
            last_ack_unix_seconds: (last_ack != 0).then_some(last_ack),
            counters: self.counters.snapshot(),
        }
    }
}

#[derive(Clone)]
pub struct ReporterHandle {
    inner: Arc<ReporterInner>,
}

impl ReporterHandle {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            inner: ReporterInner::inactive(SenderState::Disabled, None),
        }
    }

    pub fn emit<F>(&self, kind: EventKind, factory: F)
    where
        F: FnOnce() -> Result<FactDraft, FactBuildError>,
    {
        let Some(config) = self.inner.config.as_ref() else {
            return;
        };
        if !kind.allowed(config) {
            return;
        }
        self.inner.counters.increment(kind, CounterKind::Attempted);
        let Some(was_probe) = self.inner.claim_admission() else {
            self.inner.counters.increment(kind, CounterKind::Dropped);
            return;
        };
        let Some(queue) = self.inner.queue.as_ref() else {
            self.inner.release_probe(was_probe);
            return;
        };
        let permit = match queue.reserve() {
            Ok(permit) => permit,
            Err(_) => {
                self.inner.release_probe(was_probe);
                self.inner.counters.increment(kind, CounterKind::Dropped);
                return;
            }
        };
        let fact = match factory() {
            Ok(fact) => fact,
            Err(_) => {
                self.inner.release_probe(was_probe);
                self.inner
                    .counters
                    .increment(kind, CounterKind::ContractError);
                return;
            }
        };
        let encoded = match encode(kind, &fact, config) {
            Ok(encoded) => encoded,
            Err(EncodeError::Serialization | EncodeError::RandomId) => {
                self.inner.release_probe(was_probe);
                self.inner
                    .counters
                    .increment(kind, CounterKind::SerializationError);
                return;
            }
            Err(EncodeError::EventTooLarge) => {
                self.inner.release_probe(was_probe);
                self.inner.counters.increment(kind, CounterKind::Dropped);
                return;
            }
        };
        if !matches!(
            self.inner.state(),
            SenderState::Running | SenderState::HalfOpen
        ) {
            self.inner.release_probe(was_probe);
            self.inner.counters.increment(kind, CounterKind::Dropped);
            return;
        }
        let event = QueuedEvent::new(kind, encoded, permit);
        if queue.try_send(event).is_err() {
            self.inner.release_probe(was_probe);
            self.inner.counters.increment(kind, CounterKind::Dropped);
            return;
        }
        self.inner.counters.increment(kind, CounterKind::Enqueued);
    }

    #[must_use]
    pub fn observation_limit(&self, kind: EventKind) -> usize {
        let Some(config) = self.inner.config.as_ref() else {
            return 0;
        };
        let ready = match self.inner.state() {
            SenderState::Running => true,
            SenderState::HalfOpen => !self.inner.probe_taken.load(Ordering::Acquire),
            _ => false,
        };
        if !ready {
            return 0;
        }
        if kind == EventKind::KnowledgeRetrievalResultObserved && kind.allowed(config) {
            config.adv_result_detail_limit
        } else {
            0
        }
    }
}

pub struct ReporterRuntime {
    handle: ReporterHandle,
    shutdown: Option<oneshot::Sender<Instant>>,
    sender: Option<tokio::task::JoinHandle<()>>,
    shutdown_timeout: Duration,
}

impl ReporterRuntime {
    #[must_use]
    pub fn from_env(service_name: &'static str) -> Self {
        let config = match ReporterConfig::from_env(service_name) {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!(
                    implementation = "backend-rs",
                    service = service_name,
                    configuration_error = ?error,
                    "event reporter is disabled by invalid configuration"
                );
                return Self::inactive(SenderState::Misconfigured, Some(error));
            }
        };
        if !config.enabled {
            return Self::inactive(SenderState::Disabled, None);
        }
        let transport = match KafkaTransport::new(&config) {
            Ok(transport) => Arc::new(transport) as Arc<dyn EventTransport>,
            Err(_) => {
                tracing::warn!(
                    implementation = "backend-rs",
                    service = service_name,
                    configuration_error = ?ConfigErrorCode::KafkaInitialization,
                    "event reporter Kafka Adapter initialization failed"
                );
                return Self::inactive(
                    SenderState::Failed,
                    Some(ConfigErrorCode::KafkaInitialization),
                );
            }
        };
        Self::start(config, transport)
    }

    fn inactive(state: SenderState, error: Option<ConfigErrorCode>) -> Self {
        Self {
            handle: ReporterHandle {
                inner: ReporterInner::inactive(state, error),
            },
            shutdown: None,
            sender: None,
            shutdown_timeout: Duration::ZERO,
        }
    }

    fn start(config: ReporterConfig, transport: Arc<dyn EventTransport>) -> Self {
        let shutdown_timeout = config.shutdown_timeout;
        let (queue, receiver) = ByteBoundedQueue::new(
            config.queue_max_bytes,
            config.event_max_bytes,
            QUEUE_MAX_EVENTS,
        );
        let inner = Arc::new(ReporterInner {
            config: Some(Arc::new(config)),
            queue: Some(queue),
            state: AtomicU8::new(SenderState::Starting as u8),
            probe_taken: AtomicBool::new(false),
            configuration_error: None,
            counters: AtomicCounters::default(),
            last_ack_unix_seconds: AtomicU64::new(0),
        });
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let sender_inner = Arc::clone(&inner);
        let sender = tokio::spawn(async move {
            sender_loop(sender_inner, receiver, transport, shutdown_receiver).await;
        });
        Self {
            handle: ReporterHandle { inner },
            shutdown: Some(shutdown),
            sender: Some(sender),
            shutdown_timeout,
        }
    }

    #[must_use]
    pub fn handle(&self) -> ReporterHandle {
        self.handle.clone()
    }

    #[must_use]
    pub fn health(&self) -> ReporterHealth {
        self.handle.inner.health()
    }

    #[must_use]
    pub fn shutdown_timeout(&self) -> Duration {
        self.shutdown_timeout
    }

    pub async fn shutdown(mut self, deadline: Instant) -> ReporterHealth {
        if let Some(shutdown) = self.shutdown.take() {
            self.handle.inner.set_state(SenderState::Stopping);
            let _ = shutdown.send(deadline);
        }
        if let Some(mut sender) = self.sender.take()
            && tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), &mut sender)
                .await
                .is_err()
        {
            let snapshot = self.handle.inner.health();
            self.handle
                .inner
                .counters
                .add_unattributed(CounterKind::Discarded, snapshot.queue_events as u64);
            self.handle.inner.counters.add_unattributed(
                CounterKind::DeliveryUnknown,
                snapshot.in_flight_events as u64,
            );
            sender.abort();
            let _ = sender.await;
            self.handle.inner.set_state(SenderState::Failed);
        }
        self.health()
    }

    #[cfg(test)]
    pub(crate) fn for_test(config: ReporterConfig, transport: Arc<dyn EventTransport>) -> Self {
        Self::start(config, transport)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReporterHealth {
    pub state: SenderState,
    pub configuration_error: Option<ConfigErrorCode>,
    pub queue_events: usize,
    pub queue_bytes: usize,
    pub in_flight_events: usize,
    pub in_flight_bytes: usize,
    pub last_ack_unix_seconds: Option<u64>,
    pub counters: ReporterCounters,
}

enum DeliveryOutcome {
    Acked,
    Failed(TransportError),
    Unknown,
}

async fn sender_loop(
    inner: Arc<ReporterInner>,
    mut receiver: QueueReceiver,
    transport: Arc<dyn EventTransport>,
    mut shutdown: oneshot::Receiver<Instant>,
) {
    inner.set_state(SenderState::HalfOpen);
    let mut retry_delay = INITIAL_RETRY_DELAY;
    let mut metrics = MetricsPublisher::new();
    let mut next_diagnostic = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        tokio::select! {
            deadline = &mut shutdown => {
                let deadline = deadline.unwrap_or_else(|_| Instant::now());
                drain_for_shutdown(&inner, &mut receiver, transport.as_ref(), deadline).await;
                publish_metrics(&mut metrics, &inner);
                return;
            }
            event = receiver.recv() => {
                let Some(event) = event else {
                    inner.set_state(SenderState::Failed);
                    return;
                };
                let state = deliver_batch(&inner, &mut receiver, transport.as_ref(), event).await;
                match state {
                    SenderState::Running => retry_delay = INITIAL_RETRY_DELAY,
                    SenderState::Degraded => {
                        discard_queued(&inner, &mut receiver);
                        let delay = tokio::time::sleep(retry_delay);
                        tokio::pin!(delay);
                        tokio::select! {
                            deadline = &mut shutdown => {
                                let deadline = deadline.unwrap_or_else(|_| Instant::now());
                                drain_for_shutdown(
                                    &inner,
                                    &mut receiver,
                                    transport.as_ref(),
                                    deadline,
                                ).await;
                                publish_metrics(&mut metrics, &inner);
                                return;
                            }
                            () = &mut delay => {}
                        }
                        retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
                        if inner.state() == SenderState::Degraded {
                            inner.probe_taken.store(false, Ordering::Release);
                            inner.set_state(SenderState::HalfOpen);
                        }
                    }
                    SenderState::Misconfigured | SenderState::Failed => {
                        discard_queued(&inner, &mut receiver);
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep_until(next_diagnostic) => {
                publish_metrics(&mut metrics, &inner);
                tracing::info!(
                    implementation = "backend-rs",
                    service = "backend",
                    health = ?inner.health(),
                    "event reporter health"
                );
                next_diagnostic = tokio::time::Instant::now() + Duration::from_secs(30);
            }
        }
    }
}

async fn deliver_batch(
    inner: &Arc<ReporterInner>,
    receiver: &mut QueueReceiver,
    transport: &dyn EventTransport,
    first: QueuedEvent,
) -> SenderState {
    let mut batch = vec![first];
    while batch.len() < SENDER_BATCH_MAX_EVENTS {
        match receiver.try_recv() {
            Ok(event) => batch.push(event),
            Err(_) => break,
        }
    }
    let timeout = inner
        .config
        .as_ref()
        .map_or(Duration::from_secs(5), |config| config.delivery_timeout);
    let outcomes = join_all(batch.iter().map(|event| async move {
        match tokio::time::timeout(timeout, transport.send(event.encoded.clone())).await {
            Ok(Ok(())) => DeliveryOutcome::Acked,
            Ok(Err(error)) => DeliveryOutcome::Failed(error),
            Err(_) => DeliveryOutcome::Unknown,
        }
    }))
    .await;
    let mut state = SenderState::Running;
    for (event, outcome) in batch.iter().zip(outcomes) {
        match outcome {
            DeliveryOutcome::Acked => {
                inner.counters.increment(event.kind, CounterKind::Acked);
                inner
                    .last_ack_unix_seconds
                    .store(now_seconds(), Ordering::Relaxed);
            }
            DeliveryOutcome::Unknown => {
                inner
                    .counters
                    .increment(event.kind, CounterKind::DeliveryUnknown);
                state = SenderState::Degraded;
            }
            DeliveryOutcome::Failed(error) => {
                inner
                    .counters
                    .increment(event.kind, CounterKind::DeliveryFailed);
                inner
                    .counters
                    .increment(event.kind, CounterKind::TransportErrors);
                state = worse_state(state, state_for_error(error));
            }
        }
        receiver.finish(event);
    }
    drop(batch);
    inner.probe_taken.store(false, Ordering::Release);
    inner.set_state(state);
    state
}

fn state_for_error(error: TransportError) -> SenderState {
    match error.kind {
        TransportErrorKind::Configuration
        | TransportErrorKind::Authentication
        | TransportErrorKind::Authorization => SenderState::Misconfigured,
        TransportErrorKind::Fatal => SenderState::Failed,
        TransportErrorKind::QueueFull | TransportErrorKind::Retriable => SenderState::Degraded,
    }
}

fn worse_state(left: SenderState, right: SenderState) -> SenderState {
    fn rank(state: SenderState) -> u8 {
        match state {
            SenderState::Failed => 3,
            SenderState::Misconfigured => 2,
            SenderState::Degraded => 1,
            _ => 0,
        }
    }
    if rank(right) > rank(left) {
        right
    } else {
        left
    }
}

fn discard_queued(inner: &ReporterInner, receiver: &mut QueueReceiver) {
    let discarded = receiver.discard_queued();
    for event in &discarded {
        inner.counters.increment(event.kind, CounterKind::Discarded);
    }
}

async fn drain_for_shutdown(
    inner: &ReporterInner,
    receiver: &mut QueueReceiver,
    transport: &dyn EventTransport,
    deadline: Instant,
) {
    inner.set_state(SenderState::Stopping);
    while Instant::now() < deadline {
        let event = match receiver.try_recv() {
            Ok(event) => event,
            Err(_) => break,
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        let outcome = tokio::time::timeout(remaining, transport.send(event.encoded.clone())).await;
        match outcome {
            Ok(Ok(())) => {
                inner.counters.increment(event.kind, CounterKind::Acked);
                inner
                    .last_ack_unix_seconds
                    .store(now_seconds(), Ordering::Relaxed);
            }
            Ok(Err(_)) => {
                inner
                    .counters
                    .increment(event.kind, CounterKind::DeliveryFailed);
            }
            Err(_) => {
                inner
                    .counters
                    .increment(event.kind, CounterKind::DeliveryUnknown);
            }
        }
        receiver.finish(&event);
        drop(event);
    }
    discard_queued(inner, receiver);
    if transport.stop(deadline).await.is_err() {
        inner.set_state(SenderState::Failed);
    } else {
        inner.set_state(SenderState::Stopped);
    }
}

fn publish_metrics(metrics: &mut MetricsPublisher, inner: &ReporterInner) {
    let health = inner.health();
    metrics.publish(
        &inner.counters,
        health.state,
        health.queue_events,
        health.queue_bytes,
        health.in_flight_events,
        health.in_flight_bytes,
        health.last_ack_unix_seconds,
    );
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use bytes::Bytes;

    use super::*;
    use crate::event_reporting::{FactDraft, Field, Scalar};

    #[derive(Default)]
    struct RecordingTransport {
        payloads: Mutex<Vec<Bytes>>,
        error: Mutex<Option<TransportError>>,
    }

    #[async_trait]
    impl EventTransport for RecordingTransport {
        async fn send(&self, payload: Bytes) -> Result<(), TransportError> {
            self.payloads.lock().unwrap().push(payload);
            self.error.lock().unwrap().take().map_or(Ok(()), Err)
        }

        async fn stop(&self, _deadline: Instant) -> Result<(), TransportError> {
            Ok(())
        }
    }

    struct HangingTransport;

    #[async_trait]
    impl EventTransport for HangingTransport {
        async fn send(&self, _payload: Bytes) -> Result<(), TransportError> {
            std::future::pending().await
        }

        async fn stop(&self, _deadline: Instant) -> Result<(), TransportError> {
            Ok(())
        }
    }

    fn config(read_enabled: bool) -> ReporterConfig {
        ReporterConfig::from_mapping(
            "backend",
            &HashMap::from([
                ("EVENT_REPORTING_ENABLED".into(), "true".into()),
                ("EVENT_REPORTING_BACKEND_RS_ENABLED".into(), "true".into()),
                ("EVENT_KAFKA_BOOTSTRAP_SERVERS".into(), "unused".into()),
                ("EVENT_KAFKA_ENVIRONMENT".into(), "test".into()),
                (
                    "EVENT_KAFKA_ADV_READ_WIKI_ENABLED".into(),
                    read_enabled.to_string(),
                ),
            ]),
        )
        .unwrap()
    }

    async fn wait_for(condition: impl Fn() -> bool) {
        tokio::time::timeout(Duration::from_secs(1), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn disabled_advanced_group_never_runs_factory() {
        let transport = Arc::new(RecordingTransport::default());
        let runtime = ReporterRuntime::for_test(config(false), transport);
        let handle = runtime.handle();
        handle.emit(EventKind::KnowledgeDocumentReadFinished, || {
            panic!("disabled ADV factory must not run")
        });
        assert_eq!(runtime.health().counters.attempted, 0);
        runtime
            .shutdown(Instant::now() + Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    async fn sends_read_fact_without_business_waiting() {
        let transport = Arc::new(RecordingTransport::default());
        let runtime = ReporterRuntime::for_test(config(true), transport.clone());
        wait_for(|| runtime.health().state == SenderState::HalfOpen).await;
        runtime
            .handle()
            .emit(EventKind::KnowledgeDocumentReadFinished, || {
                FactDraft::success().with_field(Field::Entrypoint, Scalar::text("openapi")?)
            });
        wait_for(|| runtime.health().counters.acked == 1).await;
        let payload = transport.payloads.lock().unwrap()[0].clone();
        let value: serde_json::Value = serde_json::from_slice(&payload).unwrap();
        assert_eq!(value["data"]["entrypoint"], "openapi");
        runtime
            .shutdown(Instant::now() + Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    async fn retriable_failure_reuses_transport_and_recovers() {
        let transport = Arc::new(RecordingTransport::default());
        *transport.error.lock().unwrap() = Some(TransportError::new(TransportErrorKind::Retriable));
        let runtime = ReporterRuntime::for_test(config(true), transport.clone());
        wait_for(|| runtime.health().state == SenderState::HalfOpen).await;
        let emit = || {
            runtime
                .handle()
                .emit(EventKind::KnowledgeDocumentReadFinished, || {
                    FactDraft::success().with_field(Field::Entrypoint, Scalar::text("openapi")?)
                });
        };
        emit();
        wait_for(|| runtime.health().state == SenderState::Degraded).await;
        wait_for(|| runtime.health().state == SenderState::HalfOpen).await;
        emit();
        wait_for(|| runtime.health().counters.acked == 1).await;
        assert_eq!(transport.payloads.lock().unwrap().len(), 2);
        runtime
            .shutdown(Instant::now() + Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    async fn shutdown_deadline_aborts_unknown_delivery_without_hanging() {
        let runtime = ReporterRuntime::for_test(config(true), Arc::new(HangingTransport));
        wait_for(|| runtime.health().state == SenderState::HalfOpen).await;
        runtime
            .handle()
            .emit(EventKind::KnowledgeDocumentReadFinished, || {
                Ok(FactDraft::success())
            });
        wait_for(|| runtime.health().in_flight_events == 1).await;

        let health = tokio::time::timeout(
            Duration::from_secs(1),
            runtime.shutdown(Instant::now() + Duration::from_millis(20)),
        )
        .await
        .expect("reporter shutdown must obey its absolute deadline");

        assert_eq!(health.state, SenderState::Failed);
        assert_eq!(health.counters.delivery_unknown, 1);
    }
}
