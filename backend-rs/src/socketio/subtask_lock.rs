// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Per-subtask serialisation for `/local-executor` Responses API events.
//!
//! Source: `DeviceNamespace._get_subtask_lock` / `_cleanup_subtask_lock`
//! (`device_namespace.py:1210-1229`). Every ordered Responses event for one
//! subtask runs inside that subtask's `asyncio.Lock`, including the queue
//! write-back's database awaits, so concurrent `response.output_text.delta`
//! frames cannot append text out of order. The Source keeps the dict entry
//! until a terminal event or an error pops it.
//!
//! The Rust transport spawns each inbound frame independently, so the lock is
//! acquired inside the spawned future with `tokio`'s fair async mutex. The map
//! mirrors the Source's population bound: an entry lives only while a subtask
//! has an event in flight or until its terminal event/error cleans it up.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

type LockMap = Mutex<HashMap<i64, Arc<AsyncMutex<()>>>>;

fn locks() -> &'static LockMap {
    static LOCKS: OnceLock<LockMap> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_for(subtask_id: i64) -> Arc<AsyncMutex<()>> {
    let mut locks = locks().lock().expect("subtask lock map");
    Arc::clone(locks.entry(subtask_id).or_default())
}

/// `_get_subtask_lock` plus the `async with lock` acquisition.
///
/// The guard releases the subtask's turn when dropped, including on the error
/// path, exactly like leaving the Source's `async with` block.
pub(crate) async fn acquire(subtask_id: i64) -> OwnedMutexGuard<()> {
    lock_for(subtask_id).lock_owned().await
}

/// `_cleanup_subtask_lock`: drop the map entry after a terminal event or error.
///
/// A frame still holding or waiting on the old lock keeps its own `Arc`, so
/// cleanup never breaks an in-flight section; the next event creates a fresh
/// entry, just like the Source's `dict.pop`.
pub(crate) fn cleanup(subtask_id: i64) {
    locks()
        .lock()
        .expect("subtask lock map")
        .remove(&subtask_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_same_subtask_serialises_and_cleanup_replaces_the_entry() {
        let held = acquire(7).await;
        assert!(locks().lock().expect("lock map").contains_key(&7));
        cleanup(7);
        assert!(!locks().lock().expect("lock map").contains_key(&7));
        drop(held);
        // The old guard's Arc outlives the map entry; a new acquire creates a
        // new entry without waiting on the dropped one.
        let _fresh = acquire(7).await;
        assert!(locks().lock().expect("lock map").contains_key(&7));
        cleanup(7);
    }

    #[tokio::test]
    async fn different_subtasks_do_not_block_each_other() {
        let first = acquire(11).await;
        let second = tokio::time::timeout(std::time::Duration::from_millis(50), acquire(12)).await;
        assert!(second.is_ok());
        drop(second);
        drop(first);
        cleanup(11);
        cleanup(12);
    }
}
