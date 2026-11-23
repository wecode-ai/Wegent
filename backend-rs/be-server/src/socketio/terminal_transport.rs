// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wires terminal delivery to the shared Socket.IO runtime.

use std::time::Duration;

use brz_socket_io::ClientError;
use serde_json::Value;
use wegent_terminal::{ExecutorIdentity, TerminalRelay, TerminalTransport};

use super::device_lifecycle::publish_room_event;
use super::runtime::{
    EXECUTOR_NAMESPACE, SocketRuntime, TERMINAL_NAMESPACE, TerminalRoomBinding, deliver_local_emit,
};
use super::session::SessionSnapshot;
use crate::state::AppState;

pub(super) struct SocketTerminalTransport<'a> {
    app: &'a AppState,
    runtime: &'a SocketRuntime,
}

impl<'a> SocketTerminalTransport<'a> {
    pub(super) fn new(app: &'a AppState, runtime: &'a SocketRuntime) -> Self {
        Self { app, runtime }
    }

    pub(super) async fn relay_device_event(
        &self,
        snapshot: &SessionSnapshot,
        socket_id: &str,
        data: &Value,
        output: bool,
    ) -> Result<Value, ClientError> {
        let executor = ExecutorIdentity {
            user_id: snapshot.user_id,
            device_id: snapshot
                .device
                .device_id
                .as_deref()
                .or(snapshot.device.reported_device_id.as_deref())
                .unwrap_or_default(),
            socket_id,
        };
        wegent_terminal::relay_device_event(self.app.redis.as_ref(), self, &executor, data, output)
            .await
    }
}

impl TerminalTransport for SocketTerminalTransport<'_> {
    type Binding = TerminalRoomBinding;

    fn bind_browser_room(
        &self,
        socket_id: &str,
        session_id: &str,
        previous_session: Option<&str>,
    ) -> Option<Self::Binding> {
        self.runtime
            .emitters()
            .bind_terminal_room(socket_id, session_id, previous_session)
    }

    async fn online_socket(&self, user_id: i64, device_id: &str) -> Result<String, ()> {
        let redis = self.app.redis.as_ref().ok_or(())?;
        let online = crate::device_online_state::read_online_state_with(redis, user_id, device_id)
            .await
            .map_err(|_| ())?;
        Ok(online
            .as_ref()
            .and_then(|info| info.get("socket_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned())
    }

    async fn call_executor(
        &self,
        user_id: i64,
        event: TerminalRelay,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let emitters = self.runtime.emitters();
        if emitters.has_local_executor_socket(socket_id) {
            return emitters
                .terminal_call(event, socket_id, payload, timeout)
                .await
                .map_err(|error| error.to_string());
        }
        wegent_runtime_work::call_socketio_event(
            crate::runtime_work::transport(self.app),
            user_id,
            socket_id,
            EXECUTOR_NAMESPACE,
            event.event_name(),
            payload.clone(),
            timeout,
        )
        .await
        .map_err(|error| error.to_string())
    }

    async fn send_input(&self, socket_id: &str, payload: &Value) {
        let event = TerminalRelay::Input;
        if let Err(error) = self
            .runtime
            .emitters()
            .terminal_emit(event, socket_id, payload)
            .await
        {
            tracing::warn!(%error, "terminal:input delivery failed");
        }
        publish_room_event(
            self.app,
            event.event_name(),
            payload,
            EXECUTOR_NAMESPACE,
            socket_id,
        )
        .await;
    }

    async fn send_auth_error(&self, socket_id: &str, payload: &Value) {
        if let Err(error) = self
            .runtime
            .emitters()
            .terminal_auth_error(socket_id, payload)
            .await
        {
            tracing::warn!(%error, "terminal auth_error local delivery failed");
        }
        publish_room_event(
            self.app,
            "auth_error",
            payload,
            TERMINAL_NAMESPACE,
            socket_id,
        )
        .await;
    }

    async fn publish_browser_event(&self, event: &str, room: &str, payload: &Value) {
        deliver_local_emit(TERMINAL_NAMESPACE, event, room, None, payload).await;
        publish_room_event(self.app, event, payload, TERMINAL_NAMESPACE, room).await;
    }

    async fn call_browser_exit(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> Option<Value> {
        let emitters = self.runtime.emitters();
        if emitters.has_local_socket(TERMINAL_NAMESPACE, socket_id) {
            return emitters
                .terminal_exit_call(socket_id, payload, timeout)
                .await
                .ok();
        }
        // Register the callback before publishing to a remote browser.
        let rpc = self.app.socketio_rpc.as_ref()?;
        let redis = self.app.redis.as_ref()?;
        let call = rpc.begin(socket_id, TERMINAL_NAMESPACE).ok()?;
        let data = crate::json_compat::python_json_value(&Value::Array(vec![payload.clone()]));
        let message = crate::socketio_emit::emit_message_with_callback(
            "terminal:exit",
            &data,
            TERMINAL_NAMESPACE,
            socket_id,
            Some((socket_id, call.id())),
        );
        use brz_redis::Redis as _;
        redis
            .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
            .await
            .ok()?;
        call.wait(timeout).await.ok()
    }
}
