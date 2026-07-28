// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::BTreeMap, path::PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const DEFAULT_TIMEOUT_SECONDS: u64 = 10;
pub const MAX_TIMEOUT_SECONDS: u64 = 300;
pub const OUTPUT_PREVIEW_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum HookEventName {
    PostToolUse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HookUser {
    pub id: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PostToolUseInput {
    pub user: HookUser,
    pub session_id: String,
    pub turn_id: String,
    pub agent_id: Option<String>,
    pub agent_type: Option<String>,
    pub transcript_path: Option<String>,
    pub cwd: PathBuf,
    pub hook_event_name: HookEventName,
    pub model: Option<String>,
    pub permission_mode: String,
    pub tool_name: String,
    pub tool_use_id: String,
    pub tool_input: Value,
    pub tool_response: Value,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPluginManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct HooksConfig {
    #[serde(rename = "PostToolUse", default)]
    pub post_tool_use: Vec<HookMatcherGroup>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct HookMatcherGroup {
    pub matcher: String,
    pub hooks: Vec<CommandHookConfig>,
}

#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHookConfig {
    #[serde(rename = "type")]
    pub handler_type: String,
    pub command: String,
    pub command_windows: Option<String>,
    #[serde(default)]
    pub commands: BTreeMap<String, String>,
    #[serde(default = "default_timeout")]
    pub timeout: u64,
    #[serde(rename = "async", default)]
    pub asynchronous: bool,
    pub status_message: Option<String>,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECONDS
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HookCommandResponse {
    #[serde(flatten)]
    pub metadata: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CommandHookOutcome {
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub response: Option<HookCommandResponse>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookSource {
    User,
    Bundled,
    Managed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookPolicy {
    pub can_disable: bool,
    pub can_edit: bool,
    pub can_delete: bool,
}

impl HookPolicy {
    pub fn for_source(source: HookSource) -> Self {
        match source {
            HookSource::User => Self {
                can_disable: true,
                can_edit: true,
                can_delete: true,
            },
            HookSource::Bundled => Self {
                can_disable: true,
                can_edit: false,
                can_delete: false,
            },
            HookSource::Managed => Self {
                can_disable: false,
                can_edit: false,
                can_delete: false,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "message", rename_all = "snake_case")]
pub enum HookHealth {
    Ready,
    Disabled,
    InvalidConfig(String),
    MissingCommand(String),
    NotExecutable(String),
    Unsupported(String),
    DuplicatePluginId,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HookRunStatus {
    Succeeded,
    Failed,
    TimedOut,
    SkippedCapacity,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookRunSummary {
    pub run_id: String,
    pub plugin_id: String,
    pub handler_id: String,
    pub status: HookRunStatus,
    pub started_at_ms: i64,
    pub duration_ms: u64,
    pub exit_code: Option<i32>,
    pub stdout_preview: String,
    pub stderr_preview: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHookHandlerView {
    pub id: String,
    pub matcher: String,
    pub config: CommandHookConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHookPluginView {
    pub manifest: HookPluginManifest,
    pub enabled: bool,
    pub source: HookSource,
    pub install_path: PathBuf,
    pub policy: HookPolicy,
    pub health: HookHealth,
    pub handlers: Vec<ResolvedHookHandlerView>,
    pub recent_runs: Vec<HookRunSummary>,
}
