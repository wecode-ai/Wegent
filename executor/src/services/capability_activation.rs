// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

// A writer cannot replace native capability entries while a turn reads them.
// Keep exactly one read lease per turn; nested reads can deadlock behind a writer.
static ACTIVATION: RwLock<()> = RwLock::const_new(());
static REVISION: AtomicU64 = AtomicU64::new(0);

pub async fn begin_execution() -> RwLockReadGuard<'static, ()> {
    ACTIVATION.read().await
}

pub async fn activate() -> RwLockWriteGuard<'static, ()> {
    ACTIVATION.write().await
}

pub fn revision() -> u64 {
    REVISION.load(Ordering::Acquire)
}

// Call while holding the activation writer, including after partial publication.
pub fn mark_changed() {
    REVISION.fetch_add(1, Ordering::AcqRel);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn activation_waits_for_every_running_turn() {
        let first = begin_execution().await;
        let second = begin_execution().await;
        assert!(ACTIVATION.try_write().is_err());
        drop(first);
        assert!(ACTIVATION.try_write().is_err());
        drop(second);
        let activation = activate().await;
        assert!(ACTIVATION.try_read().is_err());
        let previous = revision();
        mark_changed();
        assert_eq!(revision(), previous + 1);
        drop(activation);
        assert!(ACTIVATION.try_read().is_ok());
    }
}
