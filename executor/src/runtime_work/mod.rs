// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod codex_global_state;
mod codex_notifications;
mod codex_rollout;
mod connectors;
mod events;
pub mod fork_transfer;
mod handler;
mod notification_mapping;
mod response;
mod runtime_handle_messages;
mod store;
mod transcript;
mod transcript_page;
mod util;
mod worktrees;

pub use handler::RuntimeWorkRpcHandler;
pub(crate) use notification_mapping::codex_stream_debug_enabled;

pub(crate) fn codex_workspace_roots() -> Vec<std::path::PathBuf> {
    codex_global_state::CodexGlobalProjectIndex::load()
        .projects()
        .iter()
        .flat_map(|project| project.roots.iter())
        .map(std::path::PathBuf::from)
        .collect()
}
