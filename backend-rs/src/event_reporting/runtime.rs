// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::{mpsc, oneshot};

use super::config::{ConfigErrorCode, ReporterConfig};
#[cfg(test)]
use super::document_read::DocumentReadOutcome;
use super::document_read::{DocumentReadEvent, encode};
use super::kafka::KafkaTransport;
use super::transport::EventTransport;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum SenderState {
    Disabled,
    Misconfigured,
    Running,
    Stopping,
    Stopped,
    Failed,
}

impl SenderState {
    fn from_byte(value: u8) -> Self {
        match value {
            1 => Self::Misconfigured,
            2 => Self::Running,
            3 => Self::Stopping,
            4 => Self::Stopped,
            5 => Self::Failed,
            _ => Self::Disabled,
        }
    }
}

struct ReporterInner {
    config: Option<Arc<ReporterConfig>>,
    sender: Option<mpsc::Sender<Bytes>>,
    state: AtomicU8,
    configuration_error: Option<ConfigErrorCode>,
    enqueued: AtomicU64,
    dropped: AtomicU64,
    acknowledged: AtomicU64,
    delivery_failed: AtomicU64,
}

impl ReporterInner {
    fn inactive(state: SenderState, configuration_error: Option<ConfigErrorCode>) -> Arc<Self> {
        Arc::new(Self {
            config: None,
            sender: None,
            state: AtomicU8::new(state as u8),
            configuration_error,
            enqueued: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            acknowledged: AtomicU64::new(0),
            delivery_failed: AtomicU64::new(0),
        })
    }

    fn set_state(&self, state: SenderState) {
        self.state.store(state as u8, Ordering::Release);
    }

    fn health(&self) -> ReporterHealth {
        ReporterHealth {
            state: SenderState::from_byte(self.state.load(Ordering::Acquire)),
            configuration_error: self.configuration_error,
            enqueued: self.enqueued.load(Ordering::Relaxed),
            dropped: self.dropped.load(Ordering::Relaxed),
            acknowledged: self.acknowledged.load(Ordering::Relaxed),
            delivery_failed: self.delivery_failed.load(Ordering::Relaxed),
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

    pub fn emit_document_read(&self, event: DocumentReadEvent) {
        let Some(config) = self.inner.config.as_ref() else {
            return;
        };
        if !config.read_events_enabled {
            return;
        }
        let Some(sender) = self.inner.sender.as_ref() else {
            return;
        };
        let payload = match encode(&event, config) {
            Ok(payload) => Bytes::from(payload),
            Err(_) => {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
        };
        match sender.try_send(payload) {
            Ok(()) => {
                self.inner.enqueued.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                self.inner.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

pub struct ReporterRuntime {
    handle: ReporterHandle,
    shutdown: Option<oneshot::Sender<Instant>>,
    sender_task: Option<tokio::task::JoinHandle<()>>,
    shutdown_timeout: Duration,
}

impl ReporterRuntime {
    #[must_use]
    pub fn from_env(service_name: &'static str) -> Self {
        let config = match ReporterConfig::from_env(service_name) {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!(
                    ?error,
                    service_name,
                    "event reporter configuration is invalid"
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
            sender_task: None,
            shutdown_timeout: Duration::ZERO,
        }
    }

    fn start(config: ReporterConfig, transport: Arc<dyn EventTransport>) -> Self {
        let shutdown_timeout = config.shutdown_timeout;
        let (sender, receiver) = mpsc::channel(config.queue_capacity());
        let inner = Arc::new(ReporterInner {
            config: Some(Arc::new(config)),
            sender: Some(sender),
            state: AtomicU8::new(SenderState::Running as u8),
            configuration_error: None,
            enqueued: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            acknowledged: AtomicU64::new(0),
            delivery_failed: AtomicU64::new(0),
        });
        let (shutdown, shutdown_receiver) = oneshot::channel();
        let task_inner = Arc::clone(&inner);
        let sender_task = tokio::spawn(async move {
            sender_loop(task_inner, receiver, transport, shutdown_receiver).await;
        });
        Self {
            handle: ReporterHandle { inner },
            shutdown: Some(shutdown),
            sender_task: Some(sender_task),
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
        if let Some(mut task) = self.sender_task.take()
            && tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), &mut task)
                .await
                .is_err()
        {
            task.abort();
            let _ = task.await;
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
    pub enqueued: u64,
    pub dropped: u64,
    pub acknowledged: u64,
    pub delivery_failed: u64,
}

async fn sender_loop(
    inner: Arc<ReporterInner>,
    mut receiver: mpsc::Receiver<Bytes>,
    transport: Arc<dyn EventTransport>,
    mut shutdown: oneshot::Receiver<Instant>,
) {
    const MAX_IN_FLIGHT: usize = 32;
    let mut in_flight = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            deadline = &mut shutdown => {
                let deadline = deadline.unwrap_or_else(|_| Instant::now());
                receiver.close();
                while Instant::now() < deadline {
                    while in_flight.len() < MAX_IN_FLIGHT {
                        let Ok(payload) = receiver.try_recv() else { break };
                        let task_inner = Arc::clone(&inner);
                        let task_transport = Arc::clone(&transport);
                        in_flight.spawn(async move { deliver(&task_inner, task_transport.as_ref(), payload).await });
                    }
                    if in_flight.is_empty() { break; }
                    if tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), in_flight.join_next()).await.is_err() { break; }
                }
                inner.delivery_failed.fetch_add(in_flight.len() as u64, Ordering::Relaxed);
                in_flight.abort_all();
                while in_flight.join_next().await.is_some() {}
                while receiver.try_recv().is_ok() { inner.dropped.fetch_add(1, Ordering::Relaxed); }
                if transport.stop(deadline).await.is_ok() {
                    inner.set_state(SenderState::Stopped);
                } else {
                    inner.set_state(SenderState::Failed);
                }
                return;
            }
            result = in_flight.join_next(), if !in_flight.is_empty() => {
                if result.is_some_and(|r| r.is_err()) { inner.delivery_failed.fetch_add(1, Ordering::Relaxed); }
            }
            payload = receiver.recv(), if in_flight.len() < MAX_IN_FLIGHT => {
                let Some(payload) = payload else {
                    while in_flight.join_next().await.is_some() {}
                    inner.set_state(SenderState::Stopped);
                    return;
                };
                let task_inner = Arc::clone(&inner);
                let task_transport = Arc::clone(&transport);
                in_flight.spawn(async move { deliver(&task_inner, task_transport.as_ref(), payload).await });
            }
        }
    }
}

async fn deliver(inner: &ReporterInner, transport: &dyn EventTransport, payload: Bytes) {
    let timeout = inner
        .config
        .as_ref()
        .map_or(Duration::from_secs(5), |config| config.delivery_timeout);
    match tokio::time::timeout(timeout, transport.send(payload)).await {
        Ok(Ok(())) => {
            inner.acknowledged.fetch_add(1, Ordering::Relaxed);
        }
        Ok(Err(error)) => {
            inner.delivery_failed.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(?error, "knowledge event delivery failed");
        }
        Err(_) => {
            inner.delivery_failed.fetch_add(1, Ordering::Relaxed);
            tracing::warn!("knowledge event delivery timed out");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use async_trait::async_trait;

    use super::*;
    use crate::event_reporting::transport::TransportError;

    #[derive(Default)]
    struct RecordingTransport {
        payloads: Mutex<Vec<Bytes>>,
    }

    #[async_trait]
    impl EventTransport for RecordingTransport {
        async fn send(&self, payload: Bytes) -> Result<(), TransportError> {
            self.payloads.lock().unwrap().push(payload);
            Ok(())
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

    fn event() -> DocumentReadEvent {
        DocumentReadEvent {
            kb_id: Some(11),
            document_id: 12,
            outcome: DocumentReadOutcome::Success,
            offset: Some(0),
            returned_length: Some(5),
            total_length: Some(5),
            has_more: Some(false),
            actor_user_id: 41,
            effective_reader_id: 42,
            entrypoint: "openapi",
            task_id: None,
            subtask_id: None,
            invocation_id: Some("read-1".into()),
        }
    }

    #[tokio::test]
    async fn sends_document_read_without_blocking_business_code() {
        let transport = Arc::new(RecordingTransport::default());
        let runtime = ReporterRuntime::for_test(config(true), transport.clone());
        runtime.handle().emit_document_read(event());
        tokio::time::timeout(Duration::from_secs(1), async {
            while runtime.health().acknowledged != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let payload: serde_json::Value =
            serde_json::from_slice(&transport.payloads.lock().unwrap()[0]).unwrap();
        assert_eq!(payload["event_type"], "knowledge.document.read.finished");
        runtime
            .shutdown(Instant::now() + Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    async fn pending_delivery_does_not_block_the_next_event() {
        struct PendingTransport {
            started: std::sync::atomic::AtomicUsize,
            release: tokio::sync::Notify,
        }
        #[async_trait]
        impl EventTransport for PendingTransport {
            async fn send(&self, _payload: Bytes) -> Result<(), TransportError> {
                self.started.fetch_add(1, Ordering::Relaxed);
                self.release.notified().await;
                Ok(())
            }
            async fn stop(&self, _deadline: Instant) -> Result<(), TransportError> {
                Ok(())
            }
        }
        let transport = Arc::new(PendingTransport {
            started: std::sync::atomic::AtomicUsize::new(0),
            release: tokio::sync::Notify::new(),
        });
        let runtime = ReporterRuntime::for_test(config(true), transport.clone());
        runtime.handle().emit_document_read(event());
        runtime.handle().emit_document_read(event());
        tokio::time::timeout(Duration::from_secs(1), async {
            while transport.started.load(Ordering::Relaxed) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        transport.release.notify_waiters();
        runtime
            .shutdown(Instant::now() + Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    async fn disabled_read_group_drops_no_work_into_queue() {
        let runtime =
            ReporterRuntime::for_test(config(false), Arc::new(RecordingTransport::default()));
        runtime.handle().emit_document_read(event());
        assert_eq!(runtime.health().enqueued, 0);
        runtime
            .shutdown(Instant::now() + Duration::from_secs(1))
            .await;
    }

    #[tokio::test]
    async fn shutdown_preserves_disabled_state_for_inactive_runtime() {
        let runtime = ReporterRuntime::inactive(SenderState::Disabled, None);

        let health = runtime.shutdown(Instant::now()).await;

        assert_eq!(health.state, SenderState::Disabled);
    }
}
