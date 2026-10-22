// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Graceful shutdown state shared by the /api/shutdown/* endpoints.
// Mirrors the process-local portion of source app/core/shutdown.py.

use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub(crate) struct ShutdownState {
    shutting_down: AtomicBool,
}

impl ShutdownState {
    pub(crate) fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

    /// `ShutdownManager.initiate_shutdown` process-local half: flip the flag
    /// once, mirroring the manager's locked check-then-set. Returns `true`
    /// only for the call that actually initiated the shutdown; later callers
    /// take the source's "Shutdown already initiated" early return.
    pub(crate) fn initiate(&self) -> bool {
        !self.shutting_down.swap(true, Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initiate_flips_the_flag_exactly_once() {
        let state = ShutdownState::default();
        assert!(!state.is_shutting_down());
        assert!(state.initiate());
        assert!(state.is_shutting_down());
        assert!(!state.initiate());
        assert!(state.is_shutting_down());
    }
}
