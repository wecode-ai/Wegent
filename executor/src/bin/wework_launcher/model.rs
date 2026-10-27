// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const SCHEMA_VERSION: u32 = 2;
pub const DEFAULT_HEALTH_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub schema_version: u32,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub data_schema_version: u32,
    pub entry_point: String,
    pub files: Vec<ReleaseFile>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledRelease {
    pub version: String,
    pub path: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LauncherReplacement {
    pub schema_version: u32,
    pub install_root: PathBuf,
    pub release: InstalledRelease,
    pub parent_pid: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Candidate {
    pub version: String,
    pub path: String,
    pub transaction_id: String,
    pub attempted: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub schema_version: u32,
    pub active: InstalledRelease,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous: Option<InstalledRelease>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<Candidate>,
    pub data_schema_version: u32,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApplyRequest {
    pub schema_version: u32,
    pub install_root: PathBuf,
    pub candidate_path: PathBuf,
    pub parent_pid: u32,
    pub launch_args: Vec<String>,
    #[serde(default = "default_health_timeout")]
    pub health_timeout_ms: u64,
}

fn default_health_timeout() -> u64 {
    DEFAULT_HEALTH_TIMEOUT_MS
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Health {
    pub schema_version: u32,
    pub transaction_id: String,
    pub token: String,
}

pub fn host_platform() -> &'static str {
    std::env::consts::OS
}

pub fn host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}
