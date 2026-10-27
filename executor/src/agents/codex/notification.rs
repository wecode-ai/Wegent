// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    ops::{Deref, DerefMut},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

use serde_json::Value;

/// Clones sent to the global router and execution queue share one delivery claim.
/// The claim travels with the notification, so delayed consumers need no dedup cache.
#[derive(Clone, Debug)]
pub struct CodexNotification {
    message: Value,
    runtime_delivered: Arc<AtomicBool>,
}

impl CodexNotification {
    pub(crate) fn claim_runtime_delivery(&self) -> bool {
        !self.runtime_delivered.swap(true, Ordering::AcqRel)
    }

    pub fn into_value(self) -> Value {
        self.message
    }
}

impl From<Value> for CodexNotification {
    fn from(message: Value) -> Self {
        Self {
            message,
            runtime_delivered: Arc::new(AtomicBool::new(false)),
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
