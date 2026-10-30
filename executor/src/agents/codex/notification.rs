// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    ops::{Deref, DerefMut},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

use serde_json::Value;
use tokio::sync::Notify;

#[derive(Debug, Default)]
struct RuntimeDelivery {
    claimed: AtomicBool,
    published: AtomicBool,
    ready: Notify,
}

pub(crate) struct RuntimePublicationGuard(Arc<RuntimeDelivery>);

impl Drop for RuntimePublicationGuard {
    fn drop(&mut self) {
        self.0.published.store(true, Ordering::Release);
        self.0.ready.notify_waiters();
    }
}

/// Clones sent to the global router and execution queue share one delivery claim.
/// The claim travels with the notification, so delayed consumers need no dedup cache.
#[derive(Clone, Debug)]
pub struct CodexNotification {
    message: Value,
    sequence: u64,
    runtime_delivery: Arc<RuntimeDelivery>,
}

impl CodexNotification {
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn claim_runtime_delivery(&self) -> bool {
        !self.runtime_delivery.claimed.swap(true, Ordering::AcqRel)
    }

    pub(crate) fn publication_guard(&self) -> RuntimePublicationGuard {
        RuntimePublicationGuard(Arc::clone(&self.runtime_delivery))
    }

    pub(crate) async fn wait_runtime_publication(&self) {
        let notified = self.runtime_delivery.ready.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !self.runtime_delivery.published.load(Ordering::Acquire) {
            notified.await;
        }
    }

    pub fn into_value(self) -> Value {
        self.message
    }
}

impl From<Value> for CodexNotification {
    fn from(message: Value) -> Self {
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        Self {
            sequence: SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1,
            message,
            runtime_delivery: Arc::new(RuntimeDelivery::default()),
        }
    }
}

impl Deref for CodexNotification {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.message
    }
}

impl DerefMut for CodexNotification {
    fn deref_mut(&mut self) -> &mut Value {
        &mut self.message
    }
}
