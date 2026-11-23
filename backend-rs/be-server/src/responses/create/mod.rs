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

mod device;
pub use wegent_execution_preparation::ghost;
pub use wegent_execution_preparation::model;
pub use wegent_execution_preparation::model_config;
pub use wegent_execution_preparation::model_selection;
pub use wegent_execution_preparation::reasoning;
pub use wegent_protocol::dispatch;
mod recover_executor;
pub(crate) use recover_executor::{discard_recovered_executor, recover_executor_if_needed};
pub mod request;
pub use wegent_execution_preparation::resolution;
pub use wegent_execution_request::{
    contexts, memory_context, runtime_config, schema, shell, subscription_window, tokens,
};
pub mod seam;
pub mod session;
pub(crate) mod sse_sync;
mod streaming_bridge;
pub use wegent_execution_preparation::subtask_bot;

pub(crate) mod handler;
pub(crate) use handler::{publish_inserted_assistant_subtask_metrics, team_member_context};
pub(crate) mod wework;

mod socket_runtime_model;

pub use wegent_responses_api::continuation;
pub use wegent_responses_streaming::response_object;
pub(crate) use wegent_responses_streaming::{
    callback_source, openai_client, package_runtime, streaming,
};
pub use wegent_responses_streaming::{executor_client, routing};
