// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wire contracts between Backend producers and Executor consumers.
//!
//! [`dispatch::ExecutionRequest`] is the fully resolved producer projection;
//! [`ExecutionRequest`] is the tolerant consumer projection with opaque metadata.
//! Consumer helpers only transform in-memory data. Its `agent_home_runtime_task_id`
//! is trusted local metadata and is never populated by deserialization.

#![forbid(unsafe_code)]

pub mod connector;
pub mod dispatch;
mod execution;
mod openai;
mod status;

pub use execution::{AgentKind, ExecutionRequest, KnowledgeBaseScope, FULL_KB_TOOL_ACCESS_MODE};
pub use openai::{OpenAIResponsesRequest, ProtocolError};
pub use status::TaskStatus;

pub const CODEX_FILES_MENTIONED_HEADER: &str = "# Files mentioned by the user:";
pub const CODEX_REQUEST_MARKER: &str = "## My request for Codex:";
pub const CODEX_IMAGE_REFERENCE_PREFIX: &str = "<image ";
