// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod binary_replacer;
mod factory;
mod github;
mod process_manager;
mod registry;
mod updater_service;
mod version_checker;

pub use binary_replacer::BinaryReplacer;
pub use factory::{create_version_checker_kind, VersionCheckerKind};
pub use github::GithubVersionChecker;
pub use process_manager::{ProcessInfo, ProcessManager, ProcessOperations, RestartPlan};
pub use registry::RegistryVersionChecker;
pub use updater_service::{
    has_sufficient_update_space, parse_update_confirmation, BinaryInstaller,
    DefaultBinaryInstaller, DefaultUpdateChecker, SystemUpdateRuntime, UpdateChecker, UpdateResult,
    UpdateRuntime, UpdaterService,
};
pub use version_checker::{binary_name_for, compare_versions, UpdateInfo};
