// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `session_manager.subscribe_callback_channel`
//! (`app/services/chat/storage/session.py:613-660`) for the create flow's
//! HTTP+Callback streaming branch.
//!
//! The source opens a dedicated Redis Pub/Sub client per streaming request,
//! subscribes to `callback:channel:{subtask_id}`, and reads the execution
//! events `/internal/callback` publishes there until a terminal event. The
//! events never travel over the pooled Redis session: an unsolicited push must
//! not be mistaken for a command reply, which is why the source keeps a
//! separate client and the SDK provides a dedicated subscription handle.
//!
//! [`CallbackSubscriptions`] is the only transport surface the create flow
//! sees. The adapter below is the single file that changes when the SDK's
//! subscription API lands; the streaming bridge and its tests depend only on
//! the trait.
use async_trait::async_trait;
use brz_http_server::Bytes;

mod redis;
pub(crate) use redis::RedisCallbackSubscriptions;

/// One callback-channel push payload (the `ExecutionEvent` JSON).
pub(crate) struct CallbackMessage {
    pub payload: Bytes,
}

/// A failed `subscribe` or a closed subscription connection.
#[derive(Debug)]
pub(crate) struct CallbackSourceError {
    pub message: String,
}

/// A dedicated callback-channel subscription.
#[async_trait]
pub(crate) trait CallbackEventSource: Send {
    /// The next pushed payload. `Ok(None)` means the read timeout elapsed with
    /// no message (the source polls `pubsub.get_message(timeout=1.0)`); a
    /// closed connection is an error.
    async fn next_message(&mut self) -> Result<Option<CallbackMessage>, CallbackSourceError>;

    /// `pubsub.aclose()`: release the dedicated connection.
    async fn close(self: Box<Self>);
}

/// `SessionManager.subscribe_callback_channel` for one create request.
#[async_trait]
pub(crate) trait CallbackSubscriptions: Send + Sync {
    async fn subscribe(
        &self,
        channel: &str,
    ) -> Result<Box<dyn CallbackEventSource>, CallbackSourceError>;
}

/// The callback Pub/Sub channel for a subtask
/// (`session.py:619-621` / `_get_callback_channel_key`).
pub(crate) fn callback_channel(subtask_id: i64) -> String {
    crate::internal_callback::session::callback_channel(subtask_id)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    /// A provider whose subscriptions replay a fixed payload sequence.
    #[derive(Clone)]
    pub(crate) struct ScriptedSubscriptions {
        payloads: Arc<Mutex<VecDeque<Vec<u8>>>>,
        channels: Arc<Mutex<Vec<String>>>,
        connected: Arc<Mutex<bool>>,
        fail: bool,
    }

    impl ScriptedSubscriptions {
        pub(crate) fn new(payloads: Vec<Vec<u8>>) -> Self {
            Self {
                payloads: Arc::new(Mutex::new(payloads.into())),
                channels: Arc::new(Mutex::new(Vec::new())),
                connected: Arc::new(Mutex::new(false)),
                fail: false,
            }
        }

        pub(crate) fn failing() -> Self {
            Self {
                payloads: Arc::default(),
                channels: Arc::default(),
                connected: Arc::default(),
                fail: true,
            }
        }

        /// A subscription that replays `payloads` and reports whether it was
        /// closed.
        pub(crate) fn source(
            payloads: Vec<Vec<u8>>,
        ) -> (Box<dyn CallbackEventSource>, Arc<Mutex<bool>>) {
            scripted_source(payloads)
        }

        pub(crate) fn channels(&self) -> Vec<String> {
            self.channels.lock().unwrap().clone()
        }

        pub(crate) fn connected(&self) -> bool {
            *self.connected.lock().unwrap()
        }
    }

    #[async_trait]
    impl CallbackSubscriptions for ScriptedSubscriptions {
        async fn subscribe(
            &self,
            channel: &str,
        ) -> Result<Box<dyn CallbackEventSource>, CallbackSourceError> {
            if self.fail {
                return Err(CallbackSourceError {
                    message: "scripted subscribe failure".to_string(),
                });
            }
            self.channels.lock().unwrap().push(channel.to_string());
            *self.connected.lock().unwrap() = true;
            Ok(Box::new(ScriptedSource {
                payloads: Arc::clone(&self.payloads),
                connected: Arc::clone(&self.connected),
            }))
        }
    }

    struct ScriptedSource {
        payloads: Arc<Mutex<VecDeque<Vec<u8>>>>,
        connected: Arc<Mutex<bool>>,
    }

    /// One scripted `CallbackEventSource` plus its live flag.
    pub(crate) fn scripted_source(
        payloads: Vec<Vec<u8>>,
    ) -> (Box<dyn CallbackEventSource>, Arc<Mutex<bool>>) {
        let connected = Arc::new(Mutex::new(true));
        let source = ScriptedSource {
            payloads: Arc::new(Mutex::new(payloads.into())),
            connected: Arc::clone(&connected),
        };
        (Box::new(source), connected)
    }

    #[async_trait]
    impl CallbackEventSource for ScriptedSource {
        async fn next_message(&mut self) -> Result<Option<CallbackMessage>, CallbackSourceError> {
            let next = self.payloads.lock().unwrap().pop_front();
            Ok(next.map(|payload| CallbackMessage {
                payload: Bytes::from(payload),
            }))
        }

        async fn close(self: Box<Self>) {
            *self.connected.lock().unwrap() = false;
        }
    }
}
