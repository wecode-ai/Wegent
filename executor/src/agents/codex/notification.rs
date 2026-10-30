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

/// Clones sent to the global router and execution queue share one delivery claim.
/// The claim travels with the notification, so delayed consumers need no dedup cache.
#[derive(Clone, Debug)]
pub struct CodexNotification {
    message: Value,
    sequence: u64,
    runtime_delivery: Arc<AtomicBool>,
}

impl CodexNotification {
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn claim_runtime_delivery(&self) -> bool {
        !self.runtime_delivery.swap(true, Ordering::AcqRel)
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
            runtime_delivery: Arc::new(AtomicBool::new(false)),
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
