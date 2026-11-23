// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Persist execution stream updates and publish their Socket.IO frames.

#![forbid(unsafe_code)]

use std::future::Future;

use serde_json::Value;

mod block_frames;
pub mod emitter;
pub mod socketio;
mod status_frames;

#[cfg(any(test, feature = "test-support"))]
pub mod test_support;

/// Deliver to the owning process before publishing the Redis adapter frame.
pub trait LocalEmit: Send + Sync {
    fn deliver<'a>(
        &'a self,
        namespace: &'a str,
        event: &'a str,
        room: &'a str,
        skip_sid: Option<&'a str>,
        payload: &'a Value,
    ) -> impl Future<Output = ()> + Send + 'a;
}
