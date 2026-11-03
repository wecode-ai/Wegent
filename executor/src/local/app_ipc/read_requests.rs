// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex as StdMutex, Weak};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::*;

pub(super) const MAX_CONCURRENT_HISTORY_READS: usize = 2;

pub(super) fn is_cancellable_read(method: Option<&str>) -> bool {
    method == Some("runtime.tasks.transcript")
}

type PendingReads = StdMutex<HashMap<String, watch::Sender<bool>>>;

pub(super) struct ConnectionReadRequests {
    pending: Arc<PendingReads>,
    admission: Arc<Semaphore>,
}

impl ConnectionReadRequests {
    pub(super) fn new(admission: Arc<Semaphore>) -> Self {
        Self {
            pending: Arc::new(StdMutex::new(HashMap::new())),
            admission,
        }
    }

    pub(super) fn handle_cancel(&self, line: &str) -> bool {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        if message["type"] != "cancel" {
            return false;
        }
        if let Some(id) = message["id"].as_str() {
            if let Some(sender) = self
                .pending
                .lock()
                .expect("history read registry should not be poisoned")
                .get(id)
            {
                sender.send_replace(true);
            }
        }
        // Cancel frames only address reads owned by this authenticated connection.
        true
    }

    pub(super) fn admit(
        &self,
        id: &str,
    ) -> Result<(ReadRequestGuard, watch::Receiver<bool>), AppIpcError> {
        let mut pending = self
            .pending
            .lock()
            .expect("history read registry should not be poisoned");
        if pending.contains_key(id) {
            return Err(AppIpcError::new(
                "duplicate_request_id",
                "A history read with this request id is already running",
            ));
        }
        let permit = self.admission.clone().try_acquire_owned().map_err(|_| {
            AppIpcError::new(
                "runtime_read_busy",
                "History reads are busy; retry after the current read finishes",
            )
        })?;
        let (sender, receiver) = watch::channel(false);
        pending.insert(id.to_owned(), sender);
        Ok((
            ReadRequestGuard {
                pending: Arc::downgrade(&self.pending),
                id: id.to_owned(),
                _permit: permit,
            },
            receiver,
        ))
    }
}

impl Drop for ConnectionReadRequests {
    fn drop(&mut self) {
        for (_, sender) in self
            .pending
            .lock()
            .expect("history read registry should not be poisoned")
            .drain()
        {
            sender.send_replace(true);
        }
    }
}

pub(super) struct ReadRequestGuard {
    pending: Weak<PendingReads>,
    id: String,
    _permit: OwnedSemaphorePermit,
}

impl Drop for ReadRequestGuard {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.upgrade() {
            pending
                .lock()
                .expect("history read registry should not be poisoned")
                .remove(&self.id);
        }
    }
}

pub(super) async fn wait_for_cancellation(receiver: &mut Option<watch::Receiver<bool>>) {
    let Some(receiver) = receiver else {
        return std::future::pending().await;
    };
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests;
