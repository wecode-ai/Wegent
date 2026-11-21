// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Settings read by the protected plugin publication pipeline
//! (`app.core.config.Settings`).
//!
//! Every value is an application-owned environment setting; unset values keep
//! the source defaults so the endpoint reports the same configuration
//! rejections as the Python service.

use crate::config::env_or_dotenv;

/// `WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID` (default empty).
pub fn gitlab_project_id() -> String {
    env_or_dotenv("WEWORK_PLUGIN_PUBLICATION_GITLAB_PROJECT_ID").unwrap_or_default()
}

/// `WEWORK_PLUGIN_PUBLICATION_GITLAB_TARGET_BRANCH` (default `master`).
pub fn gitlab_target_branch() -> String {
    env_or_dotenv("WEWORK_PLUGIN_PUBLICATION_GITLAB_TARGET_BRANCH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "master".to_owned())
}

/// `WEWORK_PLUGIN_PUBLICATION_GITLAB_API_URL` (default empty).
pub fn gitlab_api_url() -> String {
    env_or_dotenv("WEWORK_PLUGIN_PUBLICATION_GITLAB_API_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_owned()
}

/// `WEWORK_PLUGIN_PUBLICATION_GITLAB_TOKEN` (default empty).
pub fn gitlab_token() -> String {
    env_or_dotenv("WEWORK_PLUGIN_PUBLICATION_GITLAB_TOKEN").unwrap_or_default()
}

/// `WEWORK_PLUGIN_PUBLICATION_GITLAB_MATERIALIZER_USER_ID` (default 0).
pub fn gitlab_materializer_user_id() -> i64 {
    env_or_dotenv("WEWORK_PLUGIN_PUBLICATION_GITLAB_MATERIALIZER_USER_ID")
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

/// `WEWORK_PLUGIN_PUBLICATION_GITLAB_MAX_FILES` (default 500).
pub fn gitlab_max_files() -> usize {
    env_or_dotenv("WEWORK_PLUGIN_PUBLICATION_GITLAB_MAX_FILES")
        .and_then(|value| value.trim().parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(500)
}

/// `REPOSITORY_READ_TIMEOUT_SECONDS` (default 15).
pub fn repository_read_timeout_seconds() -> u64 {
    env_or_dotenv("REPOSITORY_READ_TIMEOUT_SECONDS")
        .and_then(|value| value.trim().parse().ok())
        .filter(|value| *value > 0)
        .unwrap_or(15)
}
