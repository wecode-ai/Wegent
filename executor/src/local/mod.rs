// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub mod app_ipc;
pub mod backend;
pub mod bundled_plugins;
pub mod capabilities;
pub mod codex_home;
pub mod command;
mod event_stream;
pub mod git_commands;
pub mod git_commit_message;
pub mod harnesses;
pub mod local_skills;
pub mod native_git;
pub mod plugin_catalog;
pub mod plugin_import;
pub mod pty;
pub mod session;
pub mod session_gateway;
pub mod turn_file_changes_commands;
pub mod workspace_files;

pub(crate) const RUNTIME_EVENT_BUFFER_CAPACITY: usize = 8192;
