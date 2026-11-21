// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/v1/responses` create flow
//! (`app/api/endpoints/openapi_responses.py:create_response`).
//!
//! The flow is staged incrementally in this work item before the route is cut
//! over:
//!
//! * request resolution — the `namespace#team#model_id` model string, the
//!   team/bot lookup, and the requested model;
//! * task/workspace/user+assistant-subtask creation (the sharded store and the
//!   CRD payloads);
//! * execution dispatch and the `network_error` / `"Connection error."`
//!   mapping;
//! * SSE framing.
//!
//! The pieces land here ahead of the handler that ties them together, so this
//! module is not yet reached from a registered route. The staged entries are
//! removed once the create handler consumes them.
#![allow(dead_code)]

mod background;
pub use wegent_execution_preparation::bot_config;
pub mod bound_knowledge;
pub(crate) mod callback_source;
mod connectors;
pub mod contexts;
pub mod continuation;
mod device;
pub use wegent_protocol::dispatch;
pub mod executor_client;
pub use wegent_execution_preparation::ghost;
pub(crate) mod kb_context_creation;
mod kb_meta_prompt;
mod kb_resolver;
pub mod kb_tool_access_mode;
pub mod kind_reload;
pub mod knowledge;
pub mod knowledge_access;
pub mod knowledge_folder_scope;
pub mod knowledge_prompt;
pub mod knowledge_resolution;
pub use wegent_execution_preparation::mcp_servers;
pub(crate) mod memory_context;
pub use wegent_execution_preparation::model;
pub use wegent_execution_preparation::model_config;
pub use wegent_execution_preparation::model_selection;
pub(crate) mod openai_client;
pub(crate) mod package_runtime;
mod preflight;
mod project_workspace;
pub use wegent_execution_preparation::reasoning;
mod recover_executor;
pub(crate) use recover_executor::{discard_recovered_executor, recover_executor_if_needed};
pub mod request;
pub use wegent_execution_preparation::resolution;
pub mod response_object;
pub mod routing;
pub mod runtime_config;
pub mod schema;
pub mod seam;
pub mod selected_knowledge;
pub mod session;
mod session_context;
pub mod shell;
pub mod skill_generation;
pub use wegent_execution_preparation::skills;
pub(crate) mod sse_sync;
pub mod streaming;
mod streaming_bridge;
pub(crate) mod subscription_window;
pub use wegent_execution_preparation::subtask_bot;
pub mod task_default_knowledge_bases;
pub mod team_access;
pub(crate) mod tokens;

pub(crate) mod handler;
pub(crate) use handler::{publish_inserted_assistant_subtask_metrics, team_member_context};
pub(crate) mod wework;

mod socket_runtime_model;
