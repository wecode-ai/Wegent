// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device identity, host directories, and workspace metadata ownership.

pub mod device;
pub mod home;
pub mod paths;
pub mod url_origin;
pub mod workspace_paths;
#[cfg(test)]
pub use wegent_executor_test_support as test_env;
pub use wegent_filesystem::{directory_link, file_lease};

pub mod executables;
