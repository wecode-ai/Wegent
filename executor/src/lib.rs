// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub mod agents;
pub mod app;
pub mod attachments;
pub mod browser_mcp;
pub mod callback;
mod claude_session;
mod codex_phase;
pub mod config;
mod connector_gateway;
pub mod connector_mcp;
pub mod emitter;
pub mod envd;
pub mod heartbeat;
pub mod hooks;
pub mod image_preprocessor;
pub mod local;
pub mod logging;
pub mod mcp_utils;
pub mod process;
pub mod process_environment;
pub mod prompt_enrichment;
pub mod protocol;
pub mod runner;
pub mod runtime_work;
pub mod server;
pub mod services;
pub mod stream;
pub mod version;

#[cfg(test)]
pub(crate) mod test_env {
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        // Recover from poisoning so a single panicking test does not cascade
        // into unrelated PoisonError failures across the shared test binary.
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
