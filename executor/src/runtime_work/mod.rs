// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod automations;
mod codex_global_state;
mod codex_notifications;
mod codex_rollout;
mod codex_transcript_page;
mod connectors;
mod events;
pub mod fork_transfer;
mod handler;
pub(crate) mod local_connector_auth;
mod notification_mapping;
mod remote_projects;
mod response;
mod runtime_handle_messages;
mod store;
mod task_create_contract;
mod transcript;
mod transcript_page;
mod util;
mod worktrees;

pub use handler::RuntimeWorkRpcHandler;
pub(crate) use notification_mapping::codex_stream_debug_enabled;
pub(crate) use util::runtime_task_title;

pub(crate) fn runtime_features() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 2,
        "runtimeTaskCreate": {
            "schemaVersions": [1, 2],
            "features": {
                "attachments": true,
                "goal": true,
                "supervisor": true,
                "permissionMode": true,
                "projectPlugins": true,
                "skills": true,
                "standaloneWorkspace": true,
                "workspaceInheritance": true,
                "worktree": true
            }
        },
        "worktrees": worktrees::WorktreeManager::capabilities_from_env(),
    })
}

pub(crate) fn codex_workspace_roots() -> Vec<std::path::PathBuf> {
    codex_global_state::CodexGlobalProjectIndex::load()
        .projects()
        .iter()
        .flat_map(|project| project.roots.iter())
        .map(std::path::PathBuf::from)
        .collect()
}
