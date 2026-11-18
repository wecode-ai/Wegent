// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Mutex as StdMutex, Weak};

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::*;

use crate::runtime_work::transcript_work::{
    MAX_CONCURRENT_HISTORY_READS, MAX_PENDING_HISTORY_READS,
};

pub(super) const MAX_CONCURRENT_CONNECTION_READS: usize = 2;
pub(super) const MAX_PENDING_CONNECTION_READS: usize = MAX_CONCURRENT_CONNECTION_READS + 8;

pub(super) struct ReadAdmission {
    active: Arc<Semaphore>,
    pending: Arc<Semaphore>,
}

impl ReadAdmission {
    fn new(max_active: usize, max_pending: usize) -> Self {
        Self {
            active: Arc::new(Semaphore::new(max_active)),
            pending: Arc::new(Semaphore::new(max_pending)),
        }
    }
}

pub(super) fn new_history_read_admission() -> Arc<ReadAdmission> {
    Arc::new(ReadAdmission::new(
        MAX_CONCURRENT_HISTORY_READS,
        MAX_PENDING_HISTORY_READS,
    ))
}

pub(super) fn new_connection_read_admission() -> Arc<ReadAdmission> {
    Arc::new(ReadAdmission::new(
        MAX_CONCURRENT_CONNECTION_READS,
        MAX_PENDING_CONNECTION_READS,
    ))
}

const HISTORY_READ_METHOD: &str = "runtime.tasks.transcript";
const CONNECTION_READ_METHODS: &[&str] = &[
    "runtime.connections.git.read",
    "runtime.connections.mcp",
    "runtime.connections.cli",
];

pub(super) fn cancellable_read_methods() -> impl Iterator<Item = &'static str> {
    std::iter::once(HISTORY_READ_METHOD).chain(CONNECTION_READ_METHODS.iter().copied())
}

#[derive(Clone, Copy)]
enum ReadAdmissionKind {
    History,
    Connection,
}

fn admission_kind(method: Option<&str>) -> Option<ReadAdmissionKind> {
    let method = method?;
    if method == HISTORY_READ_METHOD {
        Some(ReadAdmissionKind::History)
    } else if CONNECTION_READ_METHODS.contains(&method) {
        Some(ReadAdmissionKind::Connection)
    } else {
        None
    }
}

type PendingReads = StdMutex<HashMap<String, watch::Sender<bool>>>;

pub(super) struct ConnectionReadRequests {
    pending: Arc<PendingReads>,
    history_admission: Arc<ReadAdmission>,
    connection_admission: Arc<ReadAdmission>,
}

impl ConnectionReadRequests {
    pub(super) fn new(
        history_admission: Arc<ReadAdmission>,
        connection_admission: Arc<ReadAdmission>,
    ) -> Self {
        Self {
            pending: Arc::new(StdMutex::new(HashMap::new())),
            history_admission,
            connection_admission,
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
        method: Option<&str>,
        id: &str,
    ) -> Option<Result<(ReadRequestGuard, watch::Receiver<bool>), AppIpcError>> {
        let admission = match admission_kind(method)? {
            ReadAdmissionKind::History => &self.history_admission,
            ReadAdmissionKind::Connection => &self.connection_admission,
        };
        Some(self.admit_with(admission, id))
    }

    fn admit_with(
        &self,
        admission: &Arc<ReadAdmission>,
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
        let permit = admission.pending.clone().try_acquire_owned().map_err(|_| {
            AppIpcError::new(
                "runtime_read_busy",
                "Read queue is full; retry after a current read finishes",
            )
        })?;
        let (sender, receiver) = watch::channel(false);
        pending.insert(id.to_owned(), sender);
        Ok((
            ReadRequestGuard {
                pending: Arc::downgrade(&self.pending),
                id: id.to_owned(),
                admission: admission.active.clone(),
                _pending_permit: permit,
                active_permit: None,
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
    admission: Arc<Semaphore>,
    _pending_permit: OwnedSemaphorePermit,
    active_permit: Option<OwnedSemaphorePermit>,
}

impl ReadRequestGuard {
    pub(super) async fn wait_for_admission(&mut self) -> Result<(), AppIpcError> {
        // Waiting stays inside the request's cancellation and deadline boundary.
        self.active_permit = Some(self.admission.clone().acquire_owned().await.map_err(|_| {
            AppIpcError::new("runtime_read_busy", "History read admission is closed")
        })?);
        Ok(())
    }
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
