// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use tokio::sync::mpsc;

use super::contract::EventKind;

pub(crate) struct QueueBudget {
    max_bytes: usize,
    reserved_bytes: AtomicUsize,
    queued_events: AtomicUsize,
    queued_bytes: AtomicUsize,
    in_flight_events: AtomicUsize,
    in_flight_bytes: AtomicUsize,
}

impl QueueBudget {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            reserved_bytes: AtomicUsize::new(0),
            queued_events: AtomicUsize::new(0),
            queued_bytes: AtomicUsize::new(0),
            in_flight_events: AtomicUsize::new(0),
            in_flight_bytes: AtomicUsize::new(0),
        }
    }

    fn reserve(self: &Arc<Self>, requested: usize) -> Option<BytePermit> {
        let mut current = self.reserved_bytes.load(Ordering::Relaxed);
        loop {
            let next = current.checked_add(requested)?;
            if next > self.max_bytes {
                return None;
            }
            match self.reserved_bytes.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => {
                    return Some(BytePermit {
                        budget: Arc::clone(self),
                        reserved: requested,
                    });
                }
                Err(observed) => current = observed,
            }
        }
    }

    pub(crate) fn snapshot(&self) -> QueueSnapshot {
        QueueSnapshot {
            queued_events: self.queued_events.load(Ordering::Relaxed),
            queued_bytes: self.queued_bytes.load(Ordering::Relaxed),
            in_flight_events: self.in_flight_events.load(Ordering::Relaxed),
            in_flight_bytes: self.in_flight_bytes.load(Ordering::Relaxed),
        }
    }
}

pub(crate) struct BytePermit {
    budget: Arc<QueueBudget>,
    reserved: usize,
}

impl BytePermit {
    pub(crate) fn shrink_to(&mut self, actual: usize) {
        debug_assert!(actual <= self.reserved);
        let released = self.reserved.saturating_sub(actual);
        self.reserved = actual;
        if released > 0 {
            self.budget
                .reserved_bytes
                .fetch_sub(released, Ordering::AcqRel);
        }
    }
}

impl Drop for BytePermit {
    fn drop(&mut self) {
        self.budget
            .reserved_bytes
            .fetch_sub(self.reserved, Ordering::AcqRel);
    }
}

pub(crate) struct QueuedEvent {
    pub(crate) kind: EventKind,
    pub(crate) encoded: Bytes,
    _permit: BytePermit,
}

impl QueuedEvent {
    pub(crate) fn new(kind: EventKind, encoded: Vec<u8>, mut permit: BytePermit) -> Self {
        permit.shrink_to(encoded.len());
        Self {
            kind,
            encoded: Bytes::from(encoded),
            _permit: permit,
        }
    }

    pub(crate) fn size(&self) -> usize {
        self.encoded.len()
    }
}

#[derive(Clone)]
pub(crate) struct ByteBoundedQueue {
    max_event_bytes: usize,
    budget: Arc<QueueBudget>,
    sender: mpsc::Sender<QueuedEvent>,
}

pub(crate) struct QueueReceiver {
    budget: Arc<QueueBudget>,
    receiver: mpsc::Receiver<QueuedEvent>,
}

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct QueueSnapshot {
    pub(crate) queued_events: usize,
    pub(crate) queued_bytes: usize,
    pub(crate) in_flight_events: usize,
    pub(crate) in_flight_bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum QueueError {
    BytesFull,
    EventsFull,
    Closed,
}

impl ByteBoundedQueue {
    pub(crate) fn new(
        max_bytes: usize,
        max_event_bytes: usize,
        max_events: usize,
    ) -> (Self, QueueReceiver) {
        let budget = Arc::new(QueueBudget::new(max_bytes));
        let (sender, receiver) = mpsc::channel(max_events);
        (
            Self {
                max_event_bytes,
                budget: Arc::clone(&budget),
                sender,
            },
            QueueReceiver { budget, receiver },
        )
    }

    pub(crate) fn reserve(&self) -> Result<BytePermit, QueueError> {
        self.budget
            .reserve(self.max_event_bytes)
            .ok_or(QueueError::BytesFull)
    }

    pub(crate) fn try_send(&self, event: QueuedEvent) -> Result<(), QueueError> {
        let size = event.size();
        self.budget.queued_events.fetch_add(1, Ordering::AcqRel);
        self.budget.queued_bytes.fetch_add(size, Ordering::AcqRel);
        match self.sender.try_send(event) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.budget.queued_events.fetch_sub(1, Ordering::AcqRel);
                self.budget.queued_bytes.fetch_sub(size, Ordering::AcqRel);
                match error {
                    mpsc::error::TrySendError::Full(_) => Err(QueueError::EventsFull),
                    mpsc::error::TrySendError::Closed(_) => Err(QueueError::Closed),
                }
            }
        }
    }

    pub(crate) fn snapshot(&self) -> QueueSnapshot {
        self.budget.snapshot()
    }
}

impl QueueReceiver {
    pub(crate) async fn recv(&mut self) -> Option<QueuedEvent> {
        let event = self.receiver.recv().await?;
        self.mark_in_flight(&event);
        Some(event)
    }

    pub(crate) fn try_recv(&mut self) -> Result<QueuedEvent, mpsc::error::TryRecvError> {
        let event = self.receiver.try_recv()?;
        self.mark_in_flight(&event);
        Ok(event)
    }

    fn mark_in_flight(&self, event: &QueuedEvent) {
        let size = event.size();
        self.budget.queued_events.fetch_sub(1, Ordering::AcqRel);
        self.budget.queued_bytes.fetch_sub(size, Ordering::AcqRel);
        self.budget.in_flight_events.fetch_add(1, Ordering::AcqRel);
        self.budget
            .in_flight_bytes
            .fetch_add(size, Ordering::AcqRel);
    }

    pub(crate) fn finish(&self, event: &QueuedEvent) {
        self.budget.in_flight_events.fetch_sub(1, Ordering::AcqRel);
        self.budget
            .in_flight_bytes
            .fetch_sub(event.size(), Ordering::AcqRel);
    }

    pub(crate) fn discard_queued(&mut self) -> Vec<QueuedEvent> {
        let mut discarded = Vec::new();
        while let Ok(event) = self.try_recv() {
            self.finish(&event);
            discarded.push(event);
        }
        discarded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permit_releases_after_failed_send() {
        let (queue, receiver) = ByteBoundedQueue::new(16, 16, 1);
        drop(receiver);
        let permit = queue.reserve().unwrap();
        let event = QueuedEvent::new(EventKind::KnowledgeBaseCreated, vec![1; 8], permit);
        assert_eq!(queue.try_send(event), Err(QueueError::Closed));
        assert_eq!(queue.snapshot().queued_bytes, 0);
        assert!(queue.reserve().is_ok());
    }

    #[tokio::test]
    async fn queued_and_in_flight_share_byte_budget() {
        let (queue, mut receiver) = ByteBoundedQueue::new(16, 16, 2);
        let permit = queue.reserve().unwrap();
        queue
            .try_send(QueuedEvent::new(
                EventKind::KnowledgeBaseCreated,
                vec![1; 16],
                permit,
            ))
            .unwrap();
        let event = receiver.recv().await.unwrap();
        assert_eq!(queue.reserve().err(), Some(QueueError::BytesFull));
        receiver.finish(&event);
        drop(event);
        assert!(queue.reserve().is_ok());
    }
}
