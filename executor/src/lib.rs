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
pub mod project_workflows;
pub mod prompt_enrichment;
pub mod protocol;
pub mod runner;
pub mod runtime_work;
pub mod server;
pub mod services;
pub mod stream;
pub mod task_runtime;
pub mod version;

#[cfg(test)]
pub(crate) mod test_env {
    use std::sync::{Mutex, MutexGuard};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    // The desktop app exports host-specific WEGENT_* variables (for example
    // WEGENT_BUNDLED_HOOKS_DIR pointing inside the installed app bundle) into
    // every process it spawns, including `cargo test`. Tests that rely on a
    // hermetic environment must not observe them, so scrub the variables that
    // leak host machine state before any test runs. Constructors execute
    // single-threaded ahead of main, which makes the mutation safe. Keep this
    // list narrow: variables like WEGENT_EXTRA_PATHS configure the runner and
    // must survive.
    const HOST_STATE_VARS: &[&str] = &[
        "WEGENT_BUNDLED_HOOKS_DIR",
        "WEGENT_MANAGED_HOOKS_DIR",
        "WEGENT_EXECUTOR_HOME",
    ];

    #[used]
    #[link_section = "__DATA,__mod_init_func"]
    static SCRUB_WEGENT_ENV: extern "C" fn() = {
        extern "C" fn scrub() {
            for key in HOST_STATE_VARS {
                // SAFETY: constructors run single-threaded before main.
                unsafe { std::env::remove_var(key) };
            }
        }
        scrub
    };

    pub(crate) fn lock() -> MutexGuard<'static, ()> {
        // Recover from poisoning so a single panicking test does not cascade
        // into unrelated PoisonError failures across the shared test binary.
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}
