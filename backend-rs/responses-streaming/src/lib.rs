// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP and Redis stream consumers and Responses API event projection.

#![forbid(unsafe_code)]

pub mod callback_source;
pub mod executor_client;
pub mod openai_client;
pub mod package_runtime;
mod polling;
pub mod response_object;
pub mod routing;
mod sse_acceptance;
pub mod sse_protocol;
pub mod sse_sync;
pub mod streaming;
pub mod streaming_bridge;
pub mod transport;

#[cfg(feature = "test-support")]
pub mod test_support {
    pub use crate::polling::{poll_cancellation, poll_once};
}
