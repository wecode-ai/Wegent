// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use wegent_native_home::agent_session;
pub mod agents;
pub mod app;
pub mod artifact_cli;
mod artifact_workspace;
pub use wegent_multimodal::attachments;
pub mod browser_mcp;
pub mod callback;
mod codex_phase;
pub mod computer_use_mcp;
pub use wegent_runtime_config as config;
mod connector_gateway;
pub mod connector_mcp;
pub use wegent_execution_contracts::emitter;
pub(crate) use wegent_filesystem::directory_link;
pub mod envd;
pub(crate) use wegent_filesystem::file_lease;
pub mod heartbeat;
pub use wegent_hooks as hooks;
pub use wegent_multimodal::image_preprocessor;
pub mod local;
pub(crate) use wegent_filesystem::path_compat;
pub use wegent_mcp_runtime::mcp_utils;
pub use wegent_runtime_logging as logging;
pub mod plugin_account_auth;
pub mod plugin_workspace_cli;
pub use wegent_claude_harness::process;
pub mod process_environment;
pub use wegent_multimodal::prompt_enrichment;
mod prompt_mentions;
pub use wegent_protocol as protocol;
use wegent_workspace::repository_identity;
pub mod runner;
pub mod runtime_work;
pub mod server;
pub mod services;
pub use wegent_claude_harness::stream;
pub mod task_runtime;
pub mod version;
pub(crate) mod workbench_control;
pub(crate) use wegent_runtime_config::workspace_paths;
pub use workspace_paths::metadata::migrate as migrate_workspace_metadata;

#[cfg(test)]
pub(crate) use wegent_executor_test_support as test_env;
