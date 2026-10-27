// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

// Protect capability preparation and native session initialization, not model work.
// Keep one read lease per startup; nested reads can deadlock behind a writer.
struct ActivationCoordinator {
    lock: RwLock<()>,
    revision: AtomicU64,
}

impl ActivationCoordinator {
    const fn new() -> Self {
        Self {
            lock: RwLock::const_new(()),
            revision: AtomicU64::new(0),
        }
    }

    async fn begin_execution(&self) -> RwLockReadGuard<'_, ()> {
        self.lock.read().await
    }

    async fn activate(&self) -> RwLockWriteGuard<'_, ()> {
        self.lock.write().await
    }

    fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }

    fn mark_changed(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
    }
}

static ACTIVATION: ActivationCoordinator = ActivationCoordinator::new();

pub async fn begin_execution() -> RwLockReadGuard<'static, ()> {
    ACTIVATION.begin_execution().await
}

pub async fn activate() -> RwLockWriteGuard<'static, ()> {
    ACTIVATION.activate().await
}

pub fn revision() -> u64 {
    ACTIVATION.revision()
}

// Call while holding the activation writer, including after partial publication.
pub fn mark_changed() {
    ACTIVATION.mark_changed();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn activation_waits_for_every_session_preparation() {
        // Other tests must not enqueue global writers between these readers.
        let coordinator = ActivationCoordinator::new();
        let first = coordinator.begin_execution().await;
        let second = coordinator.begin_execution().await;
        assert!(coordinator.lock.try_write().is_err());
        drop(first);
        assert!(coordinator.lock.try_write().is_err());
        drop(second);
        let activation = coordinator.activate().await;
        assert!(coordinator.lock.try_read().is_err());
        let previous = coordinator.revision();
        coordinator.mark_changed();
        assert_eq!(coordinator.revision(), previous + 1);
        drop(activation);
        assert!(coordinator.lock.try_read().is_ok());
    }
}
