// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Startup-built Socket.IO emitters and framework-owned terminal room bindings.

use brz_socket_io::extract::SocketRef;
use brz_socket_io::{EmitterError, EventEmitter, Server, SocketIo};
use serde_json::Value;

use super::{
    CHAT_NAMESPACE, EXECUTOR_NAMESPACE, RuntimeCallEvent, TERMINAL_NAMESPACE, TerminalRelay, fanout,
};

/// Roll back a newly joined room if executor admission fails or is cancelled.
pub(crate) struct TerminalRoomBinding {
    socket: SocketRef,
    room: String,
    previous: Option<String>,
    keep: bool,
}

impl TerminalRoomBinding {
    pub(crate) fn commit(mut self) {
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

/// The startup-built outgoing events used by device handlers.
pub struct SocketEmitters {
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
    pub(crate) fn bind_terminal_room(
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

    pub(super) fn new(server: &Server) -> Result<Self, EmitterError> {
        Ok(Self {
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
            runtime_event: server.emitter(
                crate::socketio::device_runtime_event::RUNTIME_NAMESPACE,
                crate::socketio::device_runtime_event::RUNTIME_EVENT,
            )?,
            project_chat_created: server.emitter(
                crate::socketio::device_runtime_event::RUNTIME_NAMESPACE,
                crate::socketio::device_runtime_event::PROJECT_CHAT_CREATED_EVENT,
            )?,
            project_chat_chunk: server.emitter(
                crate::socketio::device_runtime_event::RUNTIME_NAMESPACE,
                crate::socketio::device_runtime_event::PROJECT_CHAT_AGENT_CHUNK_EVENT,
            )?,
            loop_item_changed: server.emitter(
                crate::socketio::device_runtime_event::RUNTIME_NAMESPACE,
                crate::socketio::device_runtime_event::LOOP_ITEM_CHANGED_EVENT,
            )?,
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
    pub(crate) fn has_local_runtime_recipient(&self, room: &str) -> bool {
        self.io
            .of(EXECUTOR_NAMESPACE)
            .is_some_and(|namespace| !namespace.to(room.to_owned()).sockets().is_empty())
    }

    /// `manager.is_connected(sid, namespace)`: whether this worker owns the
    /// addressed socket (the `ignore_queue=True` local-call decision).
    pub(crate) fn has_local_socket(&self, namespace: &str, socket_id: &str) -> bool {
        self.io
            .of(namespace)
            .is_some_and(|operator| !operator.to(socket_id.to_owned()).sockets().is_empty())
    }

    /// Whether this process still holds the addressed `/local-executor`
    /// session. A disconnected client has no local socket, so the source's
    /// `sio.call` has no local receiver and only the adapter frame is sent.
    pub(crate) fn has_local_executor_socket(&self, socket_id: &str) -> bool {
        self.has_local_runtime_recipient(socket_id)
    }

    /// `_handle_emit`'s local half for a plain adapter broadcast: deliver the
    /// event to the frame's own room, honoring `skip_sid`.
    pub(crate) async fn emit_room(
        &self,
        namespace: &str,
        event: &str,
        room: &str,
        skip_sid: Option<&str>,
        args: &crate::socketio::device_sync::ArgsTuple<'_>,
    ) -> (usize, usize) {
        let Some(operators) = self.io.of(namespace) else {
            // No such local namespace: the frame is not delivered anywhere.
            return (0, 1);
        };
        // `skip_sid` names the source socket, not a room: socketioxide keeps no
        // per-socket room for it, so the broadcast is delivered per recipient
        // and the excluded session is filtered by its socket id.
        let sockets = operators.to(room.to_owned()).sockets();
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

    /// A live transport can outlast its Redis presence and an App rebind.
    /// Deliver assigned work to the published socket, even if older sockets
    /// still belong to the room.
    pub(in crate::socketio) async fn emit_current_device_work(
        &self,
        state: &crate::state::AppState,
        owner: i64,
        route: &str,
        frame: &crate::socketio::device_sync::AdapterEmit,
    ) {
        let Some(namespace) = self.io.of(EXECUTOR_NAMESPACE) else {
            return;
        };
        let sockets = namespace.to(frame.room.clone()).sockets();
        let guarded = |socket: &SocketRef| {
            brz_socket_io::__private::session::<crate::socketio::session::DeviceSession, _>(socket)
                .is_ok_and(|session| {
                    crate::socketio::device_heartbeat::requires_current_app_binding(
                        state,
                        &session.snapshot(),
                    )
                })
        };
        let current = if sockets.iter().any(&guarded) {
            crate::device_online_state::read_online_state::<Value>(state, owner, route)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let current_id = current
            .as_ref()
            .and_then(|value| value["socket_id"].as_str());
        let args = crate::socketio::device_sync::ArgsTuple(&frame.args);
        for socket in sockets {
            let id = socket.id.to_string();
            if frame.skip_sid.as_deref() == Some(&id)
                || (guarded(&socket) && current_id != Some(&id))
            {
                continue;
            }
            if let Err(error) = socket.emit(&frame.event, &args) {
                tracing::warn!(%error, owner, route, socket_id = id, "device task delivery failed");
            }
        }
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
        let emitter = if delta {
            &self.project_chat_chunk
        } else {
            &self.project_chat_created
        };
        emitter.clone().to(room.to_owned()).emit(data).await
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
            .to(crate::socketio::device_runtime_event::runtime_user_room(
                user_id,
            ))
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
        self.runtime_rpc
            .clone()
            .to(socket_id.to_owned())
            .request(data, timeout)
            .await
    }

    /// Deliver a device command and wait for its real acknowledgement.
    pub(crate) async fn call_execute_command(
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

    pub(crate) async fn call_start_session(
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

#[cfg(test)]
impl SocketEmitters {
    /// Test-only constructor: the wire tests need the production emitter
    /// handles without widening the production constructor's visibility.
    pub(crate) fn for_test(server: &Server) -> Result<Self, EmitterError> {
        Self::new(server)
    }
}
