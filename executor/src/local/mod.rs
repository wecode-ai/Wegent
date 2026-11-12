// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub mod app_ipc;
pub mod backend;
pub use wegent_plugin_packages::local::bundled_plugins;
pub use wegent_plugin_packages::local::capabilities;
pub mod codex_home;
pub mod codex_provider_migration;
pub mod command;
pub mod environment_prepare;
pub(crate) mod event_scope;
pub use event_scope::RuntimeEventSource;
mod event_stream;
pub(crate) mod git_access;
pub mod git_commands;
pub mod harnesses;
mod linked_change_requests;
mod terminal_event_journal;
pub use wegent_plugin_packages::local::local_skills;
pub(crate) use wegent_plugin_packages::local::personal_marketplace_lock;
pub(crate) use wegent_plugin_packages::local::plugin_cache;
pub use wegent_plugin_packages::local::plugin_catalog;
pub use wegent_plugin_packages::local::plugin_creator;
pub use wegent_plugin_packages::local::plugin_images;
pub use wegent_plugin_packages::local::plugin_import;
pub use wegent_plugin_packages::local::plugin_recovery;
pub use wegent_workspace::native_git;
pub mod pty;
pub mod session;
pub mod session_gateway;
pub mod turn_file_changes_commands;
pub mod workbench_codex_migration;
pub mod workbench_lock;
pub mod workbench_schema;
pub use wegent_workspace::workspace_files;

pub(crate) const RUNTIME_EVENT_BUFFER_CAPACITY: usize = 8192;
