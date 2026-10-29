// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc,
    },
};

use serde_json::Value;
use tokio::{
    sync::{oneshot, Mutex, Notify},
    time::Instant,
};

use super::config_diagnostics::observed_method;
use crate::logging::log_executor_event;

const PREPARED: u8 = 0;
const SENDING: u8 = 1;
const CANCELLED: u8 = 2;

struct PendingRequest {
    sender: Option<oneshot::Sender<Result<Value, String>>>,
    method: String,
    deadline: Instant,
    timeout_seconds: u64,
    state: Arc<AtomicU8>,
}

#[derive(Default)]
pub(super) struct PendingCodexRequests {
    entries: Mutex<HashMap<u64, PendingRequest>>,
    changed: Notify,
}

pub(super) struct PreparedCodexRequest {
    pub(super) id: u64,
    pub(super) deadline: Instant,
    state: Arc<AtomicU8>,
    registry: Arc<PendingCodexRequests>,
}

impl Drop for PreparedCodexRequest {
    fn drop(&mut self) {
        if self
            .state
            .compare_exchange(PREPARED, CANCELLED, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            self.registry.changed.notify_waiters();
        }
    }
}

impl PendingCodexRequests {
    pub(super) async fn insert(
        self: &Arc<Self>,
        id: u64,
        method: &str,
        deadline: Instant,
        timeout_seconds: u64,
        sender: oneshot::Sender<Result<Value, String>>,
    ) -> PreparedCodexRequest {
        self.prune().await;
        let state = Arc::new(AtomicU8::new(PREPARED));
        self.entries.lock().await.insert(
            id,
            PendingRequest {
                sender: Some(sender),
                method: method.to_owned(),
                deadline,
                timeout_seconds,
                state: Arc::clone(&state),
            },
        );
        PreparedCodexRequest {
            id,
            deadline,
            state,
            registry: Arc::clone(self),
        }
    }

    pub(super) async fn len(&self) -> usize {
        self.prune().await;
        self.entries.lock().await.len()
    }

    pub(super) async fn mark_sending(&self, id: u64) -> Result<(), String> {
        let entries = self.entries.lock().await;
        let entry = entries
            .get(&id)
            .ok_or("codex request is no longer pending")?;
        entry
            .state
            .compare_exchange(PREPARED, SENDING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| "codex request was cancelled before sending".to_owned())
    }

    pub(super) async fn send_failed(&self, id: u64) {
        let mut entries = self.entries.lock().await;
        let retain = entries.get(&id).is_some_and(|entry| {
            observed_method(&entry.method).is_some()
                && entry.state.load(Ordering::Acquire) == SENDING
        });
        if !retain {
            entries.remove(&id);
        }
        drop(entries);
        self.changed.notify_waiters();
    }

    pub(super) async fn complete(
        &self,
        id: u64,
        result: impl FnOnce() -> Result<Value, String>,
    ) -> bool {
        let entry = self.entries.lock().await.remove(&id);
        if let Some(entry) = entry {
            if let Some(sender) = entry.sender {
                let _ = sender.send(result());
            }
            self.changed.notify_waiters();
            true
        } else {
            false
        }
    }

    pub(super) async fn fail_all(&self, message: String) {
        let entries = std::mem::take(&mut *self.entries.lock().await);
        for (_, entry) in entries {
            entry.state.store(CANCELLED, Ordering::Release);
            if let Some(sender) = entry.sender {
                let _ = sender.send(Err(message.clone()));
            }
        }
        self.changed.notify_waiters();
    }

    pub(super) async fn fail_waiters(&self, message: String) {
        let mut entries = self.entries.lock().await;
        for entry in entries.values_mut() {
            if let Some(sender) = entry.sender.take() {
                let _ = sender.send(Err(message.clone()));
            }
        }
        // A broken stdout transport does not prove the native writer has exited.
        entries.retain(|_, entry| {
            observed_method(&entry.method).is_some()
                && entry.state.load(Ordering::Acquire) == SENDING
        });
        drop(entries);
        self.changed.notify_waiters();
    }

    async fn prune(&self) {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;
        let obsolete = entries
            .iter()
            .filter_map(|(id, entry)| {
                (entry.state.load(Ordering::Acquire) == CANCELLED
                    || (observed_method(&entry.method).is_some() && entry.deadline <= now))
                    .then_some(*id)
            })
            .collect::<Vec<_>>();
        let removed = obsolete
            .into_iter()
            .filter_map(|id| entries.remove(&id).map(|entry| (id, entry)))
            .collect::<Vec<_>>();
        drop(entries);
        if !removed.is_empty() {
            self.changed.notify_waiters();
        }
        for (id, entry) in removed {
            if entry.state.swap(CANCELLED, Ordering::AcqRel) == CANCELLED {
                continue;
            }
            log_executor_event(
                "codex configuration request deadline expired",
                &[
                    ("request_id", id.to_string()),
                    ("method", entry.method.clone()),
                    ("timeout_seconds", entry.timeout_seconds.to_string()),
                ],
            );
            if let Some(sender) = entry.sender {
                let _ = sender.send(Err(format!(
                    "codex app-server {} timed out after {}s",
                    entry.method, entry.timeout_seconds
                )));
            }
        }
    }

    pub(super) async fn drain_configuration(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            self.prune().await;
            let deadline = self
                .entries
                .lock()
                .await
                .values()
                .filter(|entry| {
                    observed_method(&entry.method).is_some()
                        && entry.state.load(Ordering::Acquire) != CANCELLED
                })
                .map(|entry| entry.deadline)
                .min();
            let Some(deadline) = deadline else {
                return;
            };
            tokio::select! {
                _ = changed => {},
                _ = tokio::time::sleep_until(deadline) => {},
            }
        }
    }

    #[cfg(test)]
    pub(super) async fn hold_entries(&self) -> impl Drop + '_ {
        self.entries.lock().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    async fn enqueue(
        registry: &Arc<PendingCodexRequests>,
        id: u64,
        method: &str,
    ) -> (
        PreparedCodexRequest,
        oneshot::Receiver<Result<Value, String>>,
    ) {
        let (sender, receiver) = oneshot::channel();
        let request = registry
            .insert(
                id,
                method,
                Instant::now() + Duration::from_secs(10),
                10,
                sender,
            )
            .await;
        (request, receiver)
    }

    fn drain(registry: &Arc<PendingCodexRequests>) -> tokio::task::JoinHandle<()> {
        let registry = Arc::clone(registry);
        tokio::spawn(async move { registry.drain_configuration().await })
    }

    #[tokio::test]
    async fn caller_cancellation_does_not_complete_a_sent_native_write() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (request, receiver) = enqueue(&registry, 1, "marketplace/add").await;
        registry.mark_sending(1).await.unwrap();
        drop(receiver);
        drop(request);
        let waiting = drain(&registry);
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        registry.complete(1, || Ok(Value::Null)).await;
        waiting.await.unwrap();
        assert_eq!(registry.len().await, 0);
    }

    #[tokio::test]
    async fn cancellation_before_sending_is_removed_and_cannot_send_later() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (request, _receiver) = enqueue(&registry, 1, "config/batchWrite").await;
        drop(request);
        registry.drain_configuration().await;
        assert_eq!(registry.len().await, 0);
        assert!(registry.mark_sending(1).await.is_err());
    }

    #[tokio::test]
    async fn partially_failed_send_remains_protected_until_native_response() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (request, _receiver) = enqueue(&registry, 1, "config/value/write").await;
        registry.mark_sending(1).await.unwrap();
        registry.send_failed(1).await;
        drop(request);
        assert_eq!(registry.len().await, 1);
        registry
            .complete(1, || Err("native write failed".to_owned()))
            .await;
        registry.drain_configuration().await;
    }

    #[tokio::test]
    async fn ordinary_reads_do_not_delay_configuration_drain() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (_request, receiver) = enqueue(&registry, 1, "config/read").await;
        registry.mark_sending(1).await.unwrap();
        registry.drain_configuration().await;
        assert_eq!(registry.len().await, 1);
        registry.fail_all("stopped".to_owned()).await;
        assert_eq!(receiver.await.unwrap(), Err("stopped".to_owned()));
    }

    #[tokio::test(start_paused = true)]
    async fn transport_failure_keeps_protection_until_the_original_deadline() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (_request, receiver) = enqueue(&registry, 1, "plugin/list").await;
        registry.mark_sending(1).await.unwrap();
        registry.fail_waiters("stdout closed".to_owned()).await;
        assert_eq!(receiver.await.unwrap(), Err("stdout closed".to_owned()));
        assert_eq!(registry.len().await, 1);
        let waiting = drain(&registry);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(9)).await;
        assert!(!waiting.is_finished());
        tokio::time::advance(Duration::from_secs(1)).await;
        waiting.await.unwrap();
        assert_eq!(registry.len().await, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn notifications_do_not_extend_the_admitted_rpc_deadline() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (_request, receiver) = enqueue(&registry, 1, "marketplace/remove").await;
        registry.mark_sending(1).await.unwrap();
        let waiting = drain(&registry);
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        let (_read, _) = enqueue(&registry, 2, "config/read").await;
        registry.complete(2, || Ok(Value::Null)).await;
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        waiting.await.unwrap();
        assert_eq!(
            receiver.await.unwrap(),
            Err("codex app-server marketplace/remove timed out after 10s".to_owned())
        );
        assert!(registry.mark_sending(1).await.is_err());
    }

    #[tokio::test]
    async fn completion_after_drain_registration_wakes_the_waiter() {
        let registry = Arc::new(PendingCodexRequests::default());
        let (_request, receiver) = enqueue(&registry, 1, "skills/config/write").await;
        registry.mark_sending(1).await.unwrap();
        let mut waiting = Box::pin(registry.drain_configuration());
        assert!(futures_util::poll!(&mut waiting).is_pending());
        registry
            .complete(1, || Err("native error".to_owned()))
            .await;
        assert_eq!(receiver.await.unwrap(), Err("native error".to_owned()));
        assert!(futures_util::poll!(&mut waiting).is_ready());
    }

    #[tokio::test]
    async fn separate_process_registries_do_not_block_each_other() {
        let first = Arc::new(PendingCodexRequests::default());
        let second = Arc::new(PendingCodexRequests::default());
        let (_request, _) = enqueue(&first, 1, "marketplace/add").await;
        first.mark_sending(1).await.unwrap();
        second.drain_configuration().await;
        assert_eq!(first.len().await, 1);
        first.complete(1, || Ok(Value::Null)).await;
    }
}
