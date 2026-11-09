// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The SDK adapter for [`super::CallbackSubscriptions`].
//!
//! This is the only file that names the Redis subscription API. It targets the
//! frozen `brz-redis` subscription surface (published together with the
//! persistent-push support in `brz-net`):
//!
//! ```text
//! let mut subscription = redis_service.subscribe(channel).await?;
//! subscription.next_message().await -> RedisResult<Option<RedisMessage>>; // channel/payload: bytes::Bytes
//! subscription.close().await -> RedisResult<()>;    // closes the dedicated connection; no UNSUBSCRIBE
//! ```
//!
//! `next_message` returns `Ok(None)` when the read timeout elapses; every
//! unexpected EOF/protocol error is `Err`. The SDK owns the dedicated
//! connection, so ordinary `GET`s keep using the normal pooled service.
//!
//! Once the release is published, register the provider in `startup::app` as
//! `Some(Arc::new(RedisCallbackSubscriptions::new(redis.clone())))`.
use std::time::Duration;

use async_trait::async_trait;
use brz_redis::{RedisService, RedisSubscription};

/// The source's `pubsub.get_message(timeout=1.0)`: one business poll window.
/// The SDK's `next_message` idles until a message or a terminal error, so the
/// window is applied here rather than treated as an SDK timeout.
const POLL_WINDOW: Duration = Duration::from_secs(1);

use super::{CallbackEventSource, CallbackMessage, CallbackSourceError, CallbackSubscriptions};

/// The deployment's callback-channel subscription provider.
pub(crate) struct RedisCallbackSubscriptions {
    redis: RedisService,
}

impl RedisCallbackSubscriptions {
    pub(crate) fn new(redis: RedisService) -> Self {
        Self { redis }
    }
}

#[async_trait]
impl CallbackSubscriptions for RedisCallbackSubscriptions {
    async fn subscribe(
        &self,
        channel: &str,
    ) -> Result<Box<dyn CallbackEventSource>, CallbackSourceError> {
        let subscription = self.redis.subscribe(channel).await.map_err(source_error)?;
        Ok(Box::new(RedisCallbackEventSource { subscription }))
    }
}

fn source_error(error: brz_redis::RedisError) -> CallbackSourceError {
    CallbackSourceError {
        message: error.to_string(),
    }
}

struct RedisCallbackEventSource {
    subscription: RedisSubscription,
}

#[async_trait]
impl CallbackEventSource for RedisCallbackEventSource {
    async fn next_message(&mut self) -> Result<Option<CallbackMessage>, CallbackSourceError> {
        match tokio::time::timeout(POLL_WINDOW, self.subscription.next_message()).await {
            // `get_message(timeout=1.0)` returning `None`: keep polling.
            Err(_elapsed) => Ok(None),
            Ok(Ok(Some(message))) => Ok(Some(CallbackMessage {
                payload: message.payload,
            })),
            // `Ok(None)` means the SDK already closed or reported the end; an
            // inline EOF is an error, never a silent timeout.
            Ok(Ok(None)) => Err(CallbackSourceError {
                message: "callback subscription ended".to_string(),
            }),
            Ok(Err(error)) => Err(source_error(error)),
        }
    }

    /// `pubsub.aclose()`: release the dedicated connection. The current Source
    /// never sends `UNSUBSCRIBE`, so neither does this adapter.
    async fn close(mut self: Box<Self>) {
        let _ = self.subscription.close().await;
    }
}
