// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

pub use wegent_plugin_packages::services::api_client;
pub use wegent_plugin_packages::services::capability_activation;
pub(crate) mod git_credentials;
pub(crate) mod github_cli;
pub use wegent_plugin_packages::services::skill_deployer;
pub use wegent_workspace::turn_file_changes;
pub mod updater;
pub use wegent_plugin_packages::services::workbench;
