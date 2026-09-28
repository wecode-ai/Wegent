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
}
