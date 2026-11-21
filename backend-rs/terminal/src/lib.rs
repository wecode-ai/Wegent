// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Terminal session authorization, browser relay, and executor PTY events.

#![forbid(unsafe_code)]

use std::future::Future;
use std::time::Duration;

use serde_json::Value;

mod browser;
mod device;
mod sessions;

pub use browser::{TerminalSession, ack, attach, close, input, resize};
pub use device::{ExecutorIdentity, relay_device_event};
pub use sessions::start_invalidation_listener;

/// Executor acknowledgement budget for a terminal relay request.
pub const TERMINAL_ATTACH_TIMEOUT: Duration = Duration::from_secs(5);

/// An authorized browser's tentative subscription to a terminal room.
/// An uncommitted binding rolls back when dropped.
pub trait RoomBinding: Send {
    fn commit(self);
}

/// Socket delivery and online-device lookup supplied by the application.
pub trait TerminalTransport: Sync {
    type Binding: RoomBinding;

    fn bind_browser_room(
        &self,
        socket_id: &str,
        session_id: &str,
        previous_session: Option<&str>,
    ) -> Option<Self::Binding>;

    fn online_socket(
        &self,
        user_id: i64,
        device_id: &str,
    ) -> impl Future<Output = Result<String, ()>> + Send;

    fn call_executor(
        &self,
        user_id: i64,
        event: TerminalRelay,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> impl Future<Output = Result<Value, String>> + Send;

    fn send_input(&self, socket_id: &str, payload: &Value) -> impl Future<Output = ()> + Send;

    fn send_auth_error(&self, socket_id: &str, payload: &Value) -> impl Future<Output = ()> + Send;

    fn publish_browser_event(
        &self,
        event: &str,
        room: &str,
        payload: &Value,
    ) -> impl Future<Output = ()> + Send;

    fn call_browser_exit(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> impl Future<Output = Option<Value>> + Send;
}

/// The `/local-executor` event one browser terminal relay emits.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalRelay {
    /// `terminal:attach`: the attach `sio.call`.
    Attach,
    /// `terminal:input`: the fire-and-forget input relay.
    Input,
    /// `terminal:ack`: the acknowledged output acknowledgement.
    Ack,
    /// `terminal:resize`: the acknowledged PTY resize.
    Resize,
    /// `terminal:close`: the acknowledged PTY close.
    Close,
}

impl TerminalRelay {
    pub fn event_name(self) -> &'static str {
        match self {
            Self::Attach => "terminal:attach",
            Self::Input => "terminal:input",
            Self::Ack => "terminal:ack",
            Self::Resize => "terminal:resize",
            Self::Close => "terminal:close",
        }
    }
}
