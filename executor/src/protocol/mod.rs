// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

mod execution;
mod openai;
mod status;

pub use execution::{AgentKind, ExecutionRequest, KnowledgeBaseScope, FULL_KB_TOOL_ACCESS_MODE};
pub use openai::{OpenAIResponsesRequest, ProtocolError};
pub use status::TaskStatus;

pub(crate) const CODEX_FILES_MENTIONED_HEADER: &str = "# Files mentioned by the user:";
pub(crate) const CODEX_REQUEST_MARKER: &str = "## My request for Codex:";
pub(crate) const CODEX_IMAGE_REFERENCE_PREFIX: &str = "<image ";
