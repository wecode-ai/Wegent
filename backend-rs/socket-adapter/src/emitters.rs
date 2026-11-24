// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Startup-built Socket.IO emitters and framework-owned terminal room bindings.

use brz_socket_io::extract::SocketRef;
use brz_socket_io::{EmitterError, EventEmitter, Server, SocketIo};
use serde::de::{Error as _, IgnoredAny, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::Value;

use crate::redis_adapter::{ArgsTuple, RuntimeCallEvent};
use crate::{CHAT_NAMESPACE, EXECUTOR_NAMESPACE, TERMINAL_NAMESPACE};
use wegent_terminal::TerminalRelay;

/// Revalidates a room's captured recipients before a project Issue emit.
#[async_trait::async_trait]
pub trait IssueRoomAccess: Send + Sync {
    async fn authorize(
        &self,
        room: &str,
        project_id: &str,
        issue_id: &str,
        sockets: Vec<SocketRef>,
    ) -> Vec<SocketRef>;
}

/// Keep Socket.IO's first-argument ACK contract without traversing escaped map
/// keys through the parser's binary-placeholder visitor.
struct RuntimeRpcAck(Value);

impl<'de> Deserialize<'de> for RuntimeRpcAck {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct FirstArgument;

        impl<'de> Visitor<'de> for FirstArgument {
            type Value = RuntimeRpcAck;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a Socket.IO ACK with a JSON first argument")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut args: A) -> Result<Self::Value, A::Error> {
                let raw: Box<serde_json::value::RawValue> = args
                    .next_element()?
                    .ok_or_else(|| A::Error::custom("first ACK argument not found"))?;
                while args.next_element::<IgnoredAny>()?.is_some() {}
                serde_json::from_str(raw.get())
                    .map(RuntimeRpcAck)
                    .map_err(A::Error::custom)
            }
        }

        // Socket.IO treats tuple types as the ACK argument list.
        deserializer.deserialize_tuple(1, FirstArgument)
    }
}

/// Roll back a newly joined room if executor admission fails or is cancelled.
pub struct TerminalRoomBinding {
    socket: SocketRef,
    room: String,
    previous: Option<String>,
    keep: bool,
}

impl wegent_terminal::RoomBinding for TerminalRoomBinding {
    fn commit(mut self) {
        if let Some(previous) = &self.previous
            && previous != &self.room
        {
            self.socket.leave(previous.to_owned());
        }
        self.keep = true;
    }
}

impl Drop for TerminalRoomBinding {
    fn drop(&mut self) {
        if !self.keep {
            self.socket.leave(self.room.clone());
        }
    }
}

/// A finite recipient snapshot; later room joins cannot receive this frame.
struct MessageRoomBinding {
    room: String,
    sockets: Vec<SocketRef>,
}

impl MessageRoomBinding {
    fn new(sockets: Vec<SocketRef>) -> Self {
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let room = format!(
            "wework-project-chat:delivery:{}:{sequence}",
            std::process::id()
        );
        for socket in &sockets {
            socket.join(room.clone());
        }
        Self { room, sockets }
    }
}

impl Drop for MessageRoomBinding {
    fn drop(&mut self) {
        for socket in &self.sockets {
            socket.leave(self.room.clone());
        }
    }
}

/// The startup-built outgoing events used by device handlers.
pub struct SocketEmitters {
    issue_access: Option<std::sync::Arc<dyn IssueRoomAccess>>,
    /// The native handle ordinary inbound adapter broadcasts are delivered
    /// through: one room per frame, never re-published.
    io: SocketIo,
    /// `device:online` in the user's chat rooms.
    online: EventEmitter,
    /// `device:offline` in the user's chat rooms.
    offline: EventEmitter,
    /// `device:slot_update` in the user's chat rooms.
    slot_update: EventEmitter,
    /// `device:status` in the user's chat rooms.
    device_status: EventEmitter,
    /// `device:upgrade_status` in the user's chat rooms.
    device_upgrade_status: EventEmitter,
    /// `chat:status_updated` to one chat socket.
    status_updated: EventEmitter,
    /// `chat:chunk` to one chat socket (`chat:resume`'s cached suffix).
    chat_chunk: EventEmitter,
    /// `chat:guidance_queued` in one task room (`chat:guide`).
    guidance_queued: EventEmitter,
    /// `task:cancel` in one device room (`chat:cancel`'s WebSocket branch).
    task_cancel: EventEmitter,
    /// `task:close-session` in one device room (`task:close-session`).
    close_session: EventEmitter,
    /// `terminal:attach` to one device socket (`/terminal` attach call).
    terminal_attach: EventEmitter,
    /// `terminal:input` to one device socket (fire-and-forget relay).
    terminal_input: EventEmitter,
    /// `terminal:ack` to one device socket (awaiting acknowledgement).
    terminal_ack: EventEmitter,
    /// `terminal:resize` to one device socket (awaiting acknowledgement).
    terminal_resize: EventEmitter,
    /// `terminal:close` to one device socket (awaiting acknowledgement).
    terminal_close: EventEmitter,
    /// `auth_error` to one `/terminal` browser socket.
    terminal_auth_error: EventEmitter,
    /// `sio.call("terminal:exit", ..., to=browser_socket_id)` for the forced
    /// terminal-end rejection dispatch.
    terminal_exit_call: EventEmitter,
    /// `auth_error` to one chat socket (`_handle_token_expired`).
    auth_error: EventEmitter,
    /// `chat:error` in one task room (`emit_chat_error`).
    chat_error: EventEmitter,
    /// `sio.call("device:sync_capabilities", ...)` to one device socket.
    sync_capabilities: EventEmitter,
    /// `runtime:event` in the user's Wework Runtime room.
    runtime_event: EventEmitter,
    /// `wework:project_chat:message:created` in a project chat room.
    project_chat_created: EventEmitter,
    /// `wework:project_chat:agent:chunk` in a project chat room.
    project_chat_chunk: EventEmitter,
    /// `wework:loop_item:changed` in one Wework Runtime user room.
    loop_item_changed: EventEmitter,
    /// `runtime:rpc` to one `/local-executor` session (inbound adapter call).
    runtime_rpc: EventEmitter,
    execute_command: EventEmitter,
    start_terminal_session: EventEmitter,
    start_code_server_session: EventEmitter,
}

impl SocketEmitters {
    /// Call only after authorizing the browser against the stored terminal.
    /// PTY replay can precede the attach ACK, so membership must precede RPC.
    pub fn bind_terminal_room(
        &self,
        socket_id: &str,
        session_id: &str,
        previous_session: Option<&str>,
    ) -> Option<TerminalRoomBinding> {
        let socket = self
            .io
            .of(TERMINAL_NAMESPACE)?
            .get_socket(socket_id.parse().ok()?)?;
        let room = format!("terminal:{session_id}");
        let previous = previous_session.map(|id| format!("terminal:{id}"));
        let keep = previous.as_ref() == Some(&room);
        socket.join(room.clone());
        Some(TerminalRoomBinding {
            socket,
            room,
            previous,
            keep,
        })
    }

    pub fn new(
        server: &Server,
        issue_access: Option<std::sync::Arc<dyn IssueRoomAccess>>,
    ) -> Result<Self, EmitterError> {
        Ok(Self {
            issue_access,
            io: server.io().clone(),
            online: server.emitter(CHAT_NAMESPACE, "device:online")?,
            offline: server.emitter(CHAT_NAMESPACE, "device:offline")?,
            slot_update: server.emitter(CHAT_NAMESPACE, "device:slot_update")?,
            device_status: server.emitter(CHAT_NAMESPACE, "device:status")?,
            device_upgrade_status: server.emitter(CHAT_NAMESPACE, "device:upgrade_status")?,
            status_updated: server.emitter(CHAT_NAMESPACE, "chat:status_updated")?,
            chat_chunk: server.emitter(CHAT_NAMESPACE, "chat:chunk")?,
            guidance_queued: server.emitter(CHAT_NAMESPACE, "chat:guidance_queued")?,
            task_cancel: server.emitter(EXECUTOR_NAMESPACE, "task:cancel")?,
            close_session: server.emitter(EXECUTOR_NAMESPACE, "task:close-session")?,
            terminal_attach: server.emitter(EXECUTOR_NAMESPACE, "terminal:attach")?,
            terminal_input: server.emitter(EXECUTOR_NAMESPACE, "terminal:input")?,
            terminal_ack: server.emitter(EXECUTOR_NAMESPACE, "terminal:ack")?,
            terminal_resize: server.emitter(EXECUTOR_NAMESPACE, "terminal:resize")?,
            terminal_close: server.emitter(EXECUTOR_NAMESPACE, "terminal:close")?,
            terminal_auth_error: server.emitter(TERMINAL_NAMESPACE, "auth_error")?,
            terminal_exit_call: server.emitter(TERMINAL_NAMESPACE, "terminal:exit")?,
            auth_error: server.emitter(CHAT_NAMESPACE, "auth_error")?,
            chat_error: server.emitter(CHAT_NAMESPACE, "chat:error")?,
            sync_capabilities: server.emitter(EXECUTOR_NAMESPACE, "device:sync_capabilities")?,
            runtime_event: server.emitter(crate::RUNTIME_NAMESPACE, crate::RUNTIME_EVENT)?,
            project_chat_created: server
                .emitter(crate::RUNTIME_NAMESPACE, crate::PROJECT_CHAT_CREATED_EVENT)?,
            project_chat_chunk: server.emitter(
                crate::RUNTIME_NAMESPACE,
                crate::PROJECT_CHAT_AGENT_CHUNK_EVENT,
            )?,
            loop_item_changed: server
                .emitter(crate::RUNTIME_NAMESPACE, crate::LOOP_ITEM_CHANGED_EVENT)?,
            runtime_rpc: server.emitter(EXECUTOR_NAMESPACE, "runtime:rpc")?,
            execute_command: server.emitter(EXECUTOR_NAMESPACE, "device:execute_command")?,
            start_terminal_session: server
                .emitter(EXECUTOR_NAMESPACE, "device:start_terminal_session")?,
            start_code_server_session: server
                .emitter(EXECUTOR_NAMESPACE, "device:start_code_server_session")?,
        })
    }

    /// `get_participants`: an adapter RPC is delivered only by the process
    /// that has a recipient in the addressed executor room.
    pub fn has_local_runtime_recipient(&self, room: &str) -> bool {
        self.io
            .of(EXECUTOR_NAMESPACE)
            .is_some_and(|namespace| !namespace.to(room.to_owned()).sockets().is_empty())
    }

    /// `manager.is_connected(sid, namespace)`: whether this worker owns the
    /// addressed socket (the `ignore_queue=True` local-call decision).
    pub fn has_local_socket(&self, namespace: &str, socket_id: &str) -> bool {
        self.io
            .of(namespace)
            .is_some_and(|operator| !operator.to(socket_id.to_owned()).sockets().is_empty())
    }

    /// Whether this process still holds the addressed `/local-executor`
    /// session. A disconnected client has no local socket, so the source's
    /// `sio.call` has no local receiver and only the adapter frame is sent.
    pub fn has_local_executor_socket(&self, socket_id: &str) -> bool {
        self.has_local_runtime_recipient(socket_id)
    }

    /// `_handle_emit`'s local half for a plain adapter broadcast: deliver the
    /// event to the frame's own room, honoring `skip_sid`.
    pub async fn emit_room(
        &self,
        namespace: &str,
        event: &str,
        room: &str,
        skip_sid: Option<&str>,
        args: &ArgsTuple<'_>,
    ) -> (usize, usize) {
        let Some(operators) = self.io.of(namespace) else {
            // No such local namespace: the frame is not delivered anywhere.
            return (0, 1);
        };
        // `skip_sid` names the source socket, not a room: socketioxide keeps no
        // per-socket room for it, so the broadcast is delivered per recipient
        // and the excluded session is filtered by its socket id.
        let sockets = operators.to(room.to_owned()).sockets();
        let sockets = if namespace == crate::RUNTIME_NAMESPACE {
            self.authorize_issue_recipients(room, sockets).await
        } else {
            sockets
        };
        fanout(&sockets, |socket| {
            if skip_sid.is_some_and(|sid| socket.id.to_string() == sid) {
                return None;
            }
            let delivered = socket.emit(event, args);
            if let Err(error) = &delivered {
                tracing::warn!(%error, namespace, event, room,
                    socket_id = %socket.id, "Socket.IO local event delivery failed");
            }
            Some(delivered.is_ok())
        })
    }

    /// `_broadcast_device_online`'s local delivery.
    pub async fn device_online(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.online, user_id, data).await
    }
    /// `_broadcast_device_offline`'s local delivery.
    pub async fn device_offline(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.offline, user_id, data).await
    }

    /// `_broadcast_device_slot_update`'s local delivery.
    pub async fn device_slot_update(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.slot_update, user_id, data)
            .await
    }

    /// `_broadcast_device_status`'s local delivery.
    pub async fn device_status(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.device_status, user_id, data)
            .await
    }

    /// `_broadcast_device_upgrade_status`'s local delivery.
    pub async fn device_upgrade_status(
        &self,
        user_id: i64,
        data: &Value,
    ) -> Result<(), EmitterError> {
        self.emit_to_user_rooms(&self.device_upgrade_status, user_id, data)
            .await
    }

    async fn emit_to_user_rooms(
        &self,
        emitter: &EventEmitter,
        user_id: i64,
        data: &Value,
    ) -> Result<(), EmitterError> {
        // `emit_chat_user_event` addresses the personal chat rooms.
        emitter
            .clone()
            .to(format!("user:{user_id}"))
            .emit(data)
            .await?;
        emitter
            .clone()
            .to(format!("wework:user:{user_id}"))
            .emit(data)
            .await
    }

    /// `chat:status_updated` to one socket (`task:join`'s cached metrics).
    pub async fn chat_status_updated(
        &self,
        socket_id: &str,
        data: &Value,
    ) -> Result<(), EmitterError> {
        self.status_updated
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// `chat:chunk` to one socket (`chat:resume`'s cached suffix).
    pub async fn chat_chunk(&self, socket_id: &str, data: &Value) -> Result<(), EmitterError> {
        self.chat_chunk
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// `chat:guidance_queued` in one task room (`chat:guide`).
    pub async fn chat_guidance_queued(&self, room: &str, data: &Value) -> Result<(), EmitterError> {
        self.guidance_queued
            .clone()
            .to(room.to_owned())
            .emit(data)
            .await
    }

    /// `sio.emit("task:cancel", ...)` into one `/local-executor` device room.
    pub async fn task_cancel(&self, room: &str, data: &Value) -> Result<(), EmitterError> {
        self.task_cancel
            .clone()
            .to(room.to_owned())
            .emit(data)
            .await
    }

    /// `sio.emit("task:close-session", ...)` into one device room.
    pub async fn task_close_session(&self, room: &str, data: &Value) -> Result<(), EmitterError> {
        self.close_session
            .clone()
            .to(room.to_owned())
            .emit(data)
            .await
    }

    /// One `/terminal` → `/local-executor` relay event.
    pub async fn terminal_emit(
        &self,
        event: TerminalRelay,
        socket_id: &str,
        data: &Value,
    ) -> Result<(), EmitterError> {
        self.terminal_emitter(event)
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// One `/terminal` → `/local-executor` relay call awaiting the device ACK.
    pub async fn terminal_call(
        &self,
        event: TerminalRelay,
        socket_id: &str,
        data: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        self.terminal_emitter(event)
            .clone()
            .to(socket_id.to_owned())
            .request(data, timeout)
            .await
    }

    fn terminal_emitter(&self, event: TerminalRelay) -> &EventEmitter {
        match event {
            TerminalRelay::Attach => &self.terminal_attach,
            TerminalRelay::Input => &self.terminal_input,
            TerminalRelay::Ack => &self.terminal_ack,
            TerminalRelay::Resize => &self.terminal_resize,
            TerminalRelay::Close => &self.terminal_close,
        }
    }

    /// `auth_error` to one `/terminal` browser socket.
    pub async fn terminal_auth_error(
        &self,
        socket_id: &str,
        data: &Value,
    ) -> Result<(), EmitterError> {
        self.terminal_auth_error
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// `sio.call("terminal:exit", payload, to=browser_socket_id)` on
    /// `/terminal`, awaiting the browser's acknowledgement.
    pub async fn terminal_exit_call(
        &self,
        socket_id: &str,
        data: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        self.terminal_exit_call
            .clone()
            .to(socket_id.to_owned())
            .request(data, timeout)
            .await
    }

    /// `emit_chat_error`'s local delivery to one task room.
    pub async fn chat_error(&self, task_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.chat_error
            .clone()
            .to(format!("task:{task_id}"))
            .emit(data)
            .await
    }

    /// `auth_error` to one socket (`_handle_token_expired`).
    pub async fn chat_auth_error(&self, socket_id: &str, data: &Value) -> Result<(), EmitterError> {
        self.auth_error
            .clone()
            .to(socket_id.to_owned())
            .emit(data)
            .await
    }

    /// `sio.emit(PROJECT_CHAT_*, message, room=project_chat_room(...))`'s local
    /// delivery half.
    pub async fn project_chat_message(
        &self,
        room: &str,
        delta: bool,
        data: &Value,
    ) -> Result<(), EmitterError> {
        let namespace = crate::RUNTIME_NAMESPACE;
        let recipients = self
            .io
            .of(namespace)
            .ok_or(EmitterError::Namespace(namespace))?
            .to(room.to_owned())
            .sockets();
        let recipients = self.authorize_issue_recipients(room, recipients).await;
        let binding = MessageRoomBinding::new(recipients);
        let emitter = if delta {
            &self.project_chat_chunk
        } else {
            &self.project_chat_created
        };
        emitter.clone().to(binding.room.clone()).emit(data).await
    }

    async fn authorize_issue_recipients(
        &self,
        room: &str,
        sockets: Vec<SocketRef>,
    ) -> Vec<SocketRef> {
        let Some(scope) = room.strip_prefix("wework-project-chat:task:") else {
            return sockets;
        };
        let Some((project_id, issue_id)) = scope.split_once(':') else {
            return Vec::new();
        };
        let Some(access) = &self.issue_access else {
            return Vec::new();
        };
        access.authorize(room, project_id, issue_id, sockets).await
    }

    /// `wework:loop_item:changed` to one Wework Runtime user room.
    pub async fn loop_item_changed(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.loop_item_changed
            .clone()
            .to(format!("wework-runtime:user:{user_id}"))
            .emit(data)
            .await
    }

    /// `_forward_runtime_event`'s `sio.emit(WEWORK_RUNTIME_EVENT, ...)`.
    pub async fn runtime_event(&self, user_id: i64, data: &Value) -> Result<(), EmitterError> {
        self.runtime_event
            .clone()
            .to(crate::runtime_user_room(user_id))
            .emit(data)
            .await
    }

    /// One inbound `runtime:rpc` call: `sio.call(event, data, to=sid)` against
    /// the real local session, awaiting the client's real acknowledgement.
    pub async fn runtime_rpc(
        &self,
        socket_id: &str,
        data: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        // The executor's RPC ACK is JSON. Decode its first argument as raw JSON
        // before materializing the object: the Socket.IO parser's generic map
        // visitor requires borrowed keys and rejects escaped workspace keys.
        let ack: RuntimeRpcAck = self
            .runtime_rpc
            .clone()
            .to(socket_id.to_owned())
            .request(data, timeout)
            .await?;
        Ok(ack.0)
    }

    /// Deliver a device command and wait for its real acknowledgement.
    pub async fn call_execute_command(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        self.execute_command
            .clone()
            .to(socket_id.to_owned())
            .request(payload, timeout)
            .await
    }

    pub async fn call_start_session(
        &self,
        event: RuntimeCallEvent,
        socket_id: &str,
        payload: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        let emitter = match event {
            RuntimeCallEvent::StartTerminalSession => &self.start_terminal_session,
            RuntimeCallEvent::StartCodeServerSession => &self.start_code_server_session,
            _ => unreachable!("only session start events are dispatched here"),
        };
        emitter
            .clone()
            .to(socket_id.to_owned())
            .request(payload, timeout)
            .await
    }

    /// One `sio.call("device:sync_capabilities", payload, to=socket_id)`.
    pub async fn call_sync_capabilities(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: std::time::Duration,
    ) -> Result<Value, EmitterError> {
        self.sync_capabilities
            .clone()
            .to(socket_id.to_owned())
            .request(payload, timeout)
            .await
    }
}

#[cfg(feature = "test-support")]
impl SocketEmitters {
    /// Build emitters for wire tests without an Issue admission service.
    pub fn for_test(server: &Server) -> Result<Self, EmitterError> {
        Self::new(server, None)
    }
}

/// Deliver one event to every selected recipient, even after a peer fails.
///
/// The source's `_handle_emit` emits to each participant of the room; a closed
/// or saturated recipient must not stop the remaining peers. `deliver` returns
/// `None` for an excluded recipient and `Some(ok)` for an attempted delivery;
/// the returned `(sent, failed)` counts attempted deliveries.
fn fanout<T>(recipients: &[T], mut deliver: impl FnMut(&T) -> Option<bool>) -> (usize, usize) {
    let (mut sent, mut failed) = (0, 0);
    for recipient in recipients {
        match deliver(recipient) {
            Some(true) => sent += 1,
            Some(false) => failed += 1,
            None => {}
        }
    }
    (sent, failed)
}

#[cfg(test)]
mod fanout_tests {
    use super::fanout;

    /// A failed or excluded recipient never stops the remaining peers.
    #[test]
    fn a_failed_peer_does_not_stop_the_remaining_recipients() {
        let recipients = ["healthy-a", "failed", "excluded", "healthy-b"];
        let mut delivered = Vec::new();
        let (sent, failed) = fanout(&recipients, |peer| match *peer {
            "excluded" => None,
            "failed" => Some(false),
            peer => {
                delivered.push(peer);
                Some(true)
            }
        });
        assert_eq!((sent, failed), (2, 1));
        assert_eq!(delivered, vec!["healthy-a", "healthy-b"]);
    }
}
