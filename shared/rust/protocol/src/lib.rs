// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wire contracts between Backend producers and Executor consumers.
//!
//! [`dispatch::ExecutionRequest`] is the fully resolved producer projection;
//! [`ExecutionRequest`] is the tolerant consumer projection with opaque metadata.
//! Consumer helpers only transform in-memory data. Trusted local metadata such as
//! `agent_home_runtime_task_id` and `stand_in_task_permissions` is never populated
//! by deserialization.

#![forbid(unsafe_code)]

pub mod chat_errors;
pub mod collaboration;
pub mod connection_events;
pub mod connector;
pub mod dispatch;
mod execution;
mod openai;
mod status;
pub mod workday_calendar;

pub use execution::{
    AgentKind, ExecutionRequest, KnowledgeBaseScope, StandInCommandApproval, StandInPermissionMode,
    StandInTaskPermissions, FULL_KB_TOOL_ACCESS_MODE,
};
pub use openai::{
    map_request_model, OpenAIResponsesRequest, ProtocolError, LEGACY_SESSION_FALLBACK,
};
pub use status::TaskStatus;

pub const CODEX_FILES_MENTIONED_HEADER: &str = "# Files mentioned by the user:";
pub const CODEX_REQUEST_MARKER: &str = "## My request for Codex:";
pub const CODEX_IMAGE_REFERENCE_PREFIX: &str = "<image ";
