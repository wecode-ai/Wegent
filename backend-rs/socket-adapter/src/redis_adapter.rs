// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Redis adapter frames and acknowledgement sequencing.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::mpsc;
use wegent_socket_events::{callback_sequencer, socketio_emit};
use wegent_terminal::TerminalRelay;

use crate::SocketEmitters;

/// Runtime call bounds from the device command service.
#[derive(Clone, Copy)]
pub struct DeviceCommandAckLimits {
    pub default_seconds: i64,
    pub max_seconds: i64,
    pub grace_seconds: i64,
}

/// The `/local-executor` event one inbound adapter call delivers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeCallEvent {
    /// `runtime:rpc`: the executor's downlink call.
    RuntimeRpc,
    /// `device:sync_capabilities`: the capability-sync `sio.call`.
    SyncCapabilities,
    /// `device:execute_command`: the remote device command round trip.
    ExecuteCommand,
    StartTerminalSession,
    StartCodeServerSession,
    Terminal(TerminalRelay),
}

/// One inbound adapter `/local-executor` call waiting for the real client ACK.
pub struct RuntimeRpcCall {
    pub event: RuntimeCallEvent,
    pub room: String,
    pub namespace: String,
    pub host_id: String,
    pub id: u64,
    pub arg: Value,
}

impl RuntimeRpcCall {
    pub fn ack_timeout(&self, limits: DeviceCommandAckLimits) -> std::time::Duration {
        if matches!(self.event, RuntimeCallEvent::Terminal(_)) {
            return wegent_terminal::TERMINAL_ATTACH_TIMEOUT;
        }
        if matches!(
            self.event,
            RuntimeCallEvent::StartTerminalSession | RuntimeCallEvent::StartCodeServerSession
        ) {
            return std::time::Duration::from_secs(15);
        }
        if self.event != RuntimeCallEvent::ExecuteCommand {
            return RUNTIME_RPC_TIMEOUT;
        }
        let seconds = self.arg["timeout_seconds"]
            .as_i64()
            .filter(|value| *value > 0)
            .unwrap_or(limits.default_seconds)
            .min(limits.max_seconds);
        std::time::Duration::from_secs((seconds + limits.grace_seconds) as u64)
    }
}

/// `socketio/async_pubsub_manager.py` inbound `emit`: an acknowledged
/// executor call addressed to one local session by the
/// translated Target SID, with the original three-element callback identity,
/// becomes a worker job.
///
/// A capability-sync frame this process published is skipped: its local
/// dispatcher already delivered it to the socket and published the frame only
/// for other hosts, so processing the echo would deliver it twice and publish
/// an unowned callback. `runtime:rpc` keeps accepting its own frame, because
/// that echo is how this process's outbound `sio.call` reaches its own socket.
pub fn inbound_rpc_job(message: Value) -> Option<RuntimeRpcCall> {
    if message.get("method").and_then(Value::as_str) != Some("emit") {
        return None;
    }
    let event = match message.get("event").and_then(Value::as_str)? {
        "runtime:rpc" => RuntimeCallEvent::RuntimeRpc,
        "device:sync_capabilities" => RuntimeCallEvent::SyncCapabilities,
        "device:execute_command" => RuntimeCallEvent::ExecuteCommand,
        "device:start_terminal_session" => RuntimeCallEvent::StartTerminalSession,
        "device:start_code_server_session" => RuntimeCallEvent::StartCodeServerSession,
        "terminal:attach" => RuntimeCallEvent::Terminal(TerminalRelay::Attach),
        "terminal:ack" => RuntimeCallEvent::Terminal(TerminalRelay::Ack),
        "terminal:resize" => RuntimeCallEvent::Terminal(TerminalRelay::Resize),
        "terminal:close" => RuntimeCallEvent::Terminal(TerminalRelay::Close),
        _ => return None,
    };
    if message.get("namespace").and_then(Value::as_str) != Some("/local-executor") {
        return None;
    }
    if event == RuntimeCallEvent::SyncCapabilities
        && message.get("host_id").and_then(Value::as_str) == Some(socketio_emit::host_id())
    {
        return None;
    }
    let callback = message.get("callback")?.as_array()?;
    let [sid, namespace, id] = callback.as_slice() else {
        return None;
    };
    let room = message.get("room")?.as_str()?;
    let host_id = message.get("host_id")?.as_str()?;
    let arg = message.get("data")?.as_array()?.first()?.clone();
    if sid.as_str()? != room || namespace.as_str()? != "/local-executor" {
        return None;
    }
    Some(RuntimeRpcCall {
        event,
        room: room.to_owned(),
        namespace: namespace.as_str()?.to_owned(),
        host_id: host_id.to_owned(),
        id: id.as_u64()?,
        arg,
    })
}

/// Deliver one inbound `/local-executor` call to the real session and publish
/// the client's real acknowledgement as the source's `method: callback`
/// message.
///
/// A timeout or closed socket publishes nothing: the source's `sio.call`
/// failure path produces no callback, and an acknowledgement is never
/// synthesized.
async fn forward_runtime_rpc(
    emitters: &SocketEmitters,
    sequencer: &std::sync::Arc<callback_sequencer::CallbackSequencer>,
    call: RuntimeRpcCall,
    limits: DeviceCommandAckLimits,
) {
    let timeout = call.ack_timeout(limits);
    let RuntimeRpcCall {
        event,
        room,
        namespace,
        host_id,
        id,
        arg,
    } = call;
    let ack = match event {
        RuntimeCallEvent::Terminal(event) => {
            emitters.terminal_call(event, &room, &arg, timeout).await
        }
        RuntimeCallEvent::RuntimeRpc => emitters.runtime_rpc(&room, &arg, timeout).await,
        RuntimeCallEvent::SyncCapabilities => {
            emitters.call_sync_capabilities(&room, &arg, timeout).await
        }
        RuntimeCallEvent::ExecuteCommand => {
            emitters.call_execute_command(&room, &arg, timeout).await
        }
        RuntimeCallEvent::StartTerminalSession | RuntimeCallEvent::StartCodeServerSession => {
            emitters
                .call_start_session(event, &room, &arg, timeout)
                .await
        }
    };
    let ack = match ack {
        Ok(ack) => ack,
        Err(error) => {
            tracing::warn!(
                %error,
                ?event,
                room,
                id,
                "inbound adapter call failed; no callback is published"
            );
            return;
        }
    };
    let callback = callback_sequencer::SequencedCallback {
        host_id,
        room,
        namespace,
        id,
        ack,
    };
    // Capability sync calls prepare independent packages on the same device.
    // Return each result when ready, even if an earlier download is held.
    if event == RuntimeCallEvent::SyncCapabilities {
        sequencer.publish_unordered(callback).await;
    } else {
        sequencer.submit(callback);
    }
}

/// The source's `_return_callback` message: the original remote identity is
/// echoed and the client's acknowledgement is the single result item.
pub fn callback_message(host_id: &str, sid: &str, namespace: &str, id: u64, ack: Value) -> Value {
    json!({
        "method": "callback",
        "host_id": host_id,
        "sid": sid,
        "namespace": namespace,
        "id": id,
        "args": [ack],
    })
}

/// Startup-owned consumer for inbound `runtime:rpc` calls.
pub async fn run_rpc_worker(
    calls: Arc<tokio::sync::Mutex<mpsc::Receiver<RuntimeRpcCall>>>,
    emitters: Arc<SocketEmitters>,
    sequencer: Arc<callback_sequencer::CallbackSequencer>,
    limits: DeviceCommandAckLimits,
) {
    loop {
        let call = {
            let mut calls = calls.lock().await;
            calls.recv().await
        };
        let Some(call) = call else {
            return;
        };
        forward_runtime_rpc(&emitters, &sequencer, call, limits).await;
    }
}

/// The Socket.IO argument tuple: `operators.emit` wraps a non-tuple value into
/// a single argument, so the frame's positional arguments must serialize
/// through `serialize_tuple` to reach the wire as `[event, a, b]` — including
/// a lone array argument, which stays one argument.
pub struct ArgsTuple<'a>(pub &'a [Value]);

impl serde::Serialize for ArgsTuple<'_> {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeTuple;
        let mut tuple = serializer.serialize_tuple(self.0.len())?;
        for argument in self.0 {
            tuple.serialize_element(argument)?;
        }
        tuple.end()
    }
}

/// One ordinary inbound adapter broadcast for local room delivery.
pub struct AdapterEmit {
    pub namespace: String,
    pub event: String,
    pub room: String,
    pub skip_sid: Option<String>,
    /// The frame's positional event arguments, unwrapped.
    pub args: Vec<Value>,
}

/// `AsyncPubSubManager._handle_emit` for a plain `emit` message: deliver the
/// event to this host's named room and never re-publish it.
///
/// `_listen` ignores every message whose `host_id` is this manager's own
/// identity, so a frame this process published is not delivered twice. Frames
/// that carry a callback identity stay on the inbound RPC path; the
/// `/local-executor` `runtime:rpc` guard is unchanged.
pub fn adapter_emit_job(message: Value) -> Option<AdapterEmit> {
    if message.get("method").and_then(Value::as_str) != Some("emit") {
        return None;
    }
    if message.get("host_id").and_then(Value::as_str) == Some(socketio_emit::host_id()) {
        return None;
    }
    if message
        .get("callback")
        .is_some_and(|callback| !callback.is_null())
    {
        return None;
    }
    let event = message.get("event").and_then(Value::as_str)?.to_owned();
    let namespace = message.get("namespace").and_then(Value::as_str)?.to_owned();
    let room = message.get("room").and_then(Value::as_str)?.to_owned();
    if room.is_empty() {
        return None;
    }
    let skip_sid = message
        .get("skip_sid")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let args = match message.get("data")? {
        Value::Array(items) => items.clone(),
        data => vec![data.clone()],
    };
    Some(AdapterEmit {
        namespace,
        event,
        room,
        skip_sid,
        args,
    })
}

/// Startup-owned consumer for ordinary inbound adapter broadcasts.
pub async fn run_adapter_emit_worker(
    emits: Arc<tokio::sync::Mutex<mpsc::Receiver<AdapterEmit>>>,
    emitters: Arc<SocketEmitters>,
) {
    loop {
        let emit = {
            let mut emits = emits.lock().await;
            emits.recv().await
        };
        let Some(emit) = emit else {
            return;
        };
        let (sent, failed) = emitters
            .emit_room(
                &emit.namespace,
                &emit.event,
                &emit.room,
                emit.skip_sid.as_deref(),
                &ArgsTuple(&emit.args),
            )
            .await;
        if failed > 0 {
            tracing::warn!(
                namespace = emit.namespace,
                event = emit.event,
                room = emit.room,
                sent,
                failed,
                "inbound adapter broadcast delivery failures"
            );
        }
    }
}

/// `sio.call`'s default acknowledgement timeout.
pub const RUNTIME_RPC_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(test)]
mod runtime_rpc_tests {
    use super::*;

    const ACK_LIMITS: DeviceCommandAckLimits = DeviceCommandAckLimits {
        default_seconds: 60,
        max_seconds: 600,
        grace_seconds: 5,
    };

    fn frame(room: &str, callback_sid: &str) -> Value {
        json!({
            "method": "emit",
            "event": "runtime:rpc",
            "data": [{"method": "runtime.tasks.list", "payload": {}}],
            "binary": false,
            "namespace": "/local-executor",
            "room": room,
            "skip_sid": null,
            "callback": [callback_sid, "/local-executor", 1],
            "host_id": "fefecc7979634ba187ec89eaaabf1233",
        })
    }

    #[test]
    fn an_addressed_runtime_rpc_frame_becomes_a_job() {
        let job = inbound_rpc_job(frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9"))
            .expect("an addressed call");
        let RuntimeRpcCall {
            event,
            room,
            namespace,
            host_id,
            id,
            arg,
        } = job;
        assert_eq!(event, RuntimeCallEvent::RuntimeRpc);
        assert_eq!(room, "7xY2AeTaWTsb2AJ9");
        assert_eq!(namespace, "/local-executor");
        assert_eq!(host_id, "fefecc7979634ba187ec89eaaabf1233");
        assert_eq!(id, 1);
        assert_eq!(arg, json!({"method": "runtime.tasks.list", "payload": {}}));
    }

    #[test]
    fn a_remote_capability_sync_frame_becomes_a_job() {
        let mut message = frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9");
        message["event"] = json!("device:sync_capabilities");
        message["data"] = json!([{"mode": "replace", "skills": [], "plugins": []}]);
        let call = inbound_rpc_job(message).expect("a remote capability sync");
        assert_eq!(call.event, RuntimeCallEvent::SyncCapabilities);
        assert_eq!(call.room, "7xY2AeTaWTsb2AJ9");
        assert_eq!(call.namespace, "/local-executor");
        assert_eq!(call.host_id, "fefecc7979634ba187ec89eaaabf1233");
        assert_eq!(call.id, 1);
        assert_eq!(
            call.arg,
            json!({"mode": "replace", "skills": [], "plugins": []})
        );
    }

    #[test]
    fn a_device_command_echo_preserves_the_callback_identity() {
        let mut message = frame("device-socket", "device-socket");
        message["event"] = json!("device:execute_command");
        message["host_id"] = json!(socketio_emit::host_id());
        message["data"] = json!([{"command": "pwd"}]);
        let call = inbound_rpc_job(message).expect("an addressed device command");
        assert_eq!(call.event, RuntimeCallEvent::ExecuteCommand);
        assert_eq!(call.room, "device-socket");
        assert_eq!(call.id, 1);
        assert_eq!(call.arg, json!({"command": "pwd"}));
    }

    #[test]
    fn session_start_calls_preserve_the_python_callback() {
        for (name, event) in [
            (
                "device:start_terminal_session",
                RuntimeCallEvent::StartTerminalSession,
            ),
            (
                "device:start_code_server_session",
                RuntimeCallEvent::StartCodeServerSession,
            ),
        ] {
            let mut message = frame("device-socket", "device-socket");
            message["event"] = json!(name);
            message["data"] = json!([{"session_id": "session"}]);
            let call = inbound_rpc_job(message).expect("an addressed session start call");
            assert_eq!(call.event, event);
            assert_eq!(call.room, "device-socket");
            assert_eq!(call.id, 1);
            assert_eq!(call.arg, json!({"session_id": "session"}));
            assert_eq!(call.ack_timeout(ACK_LIMITS), Duration::from_secs(15));
        }
    }

    #[test]
    fn terminal_controls_preserve_the_cross_process_callback() {
        for event in [
            TerminalRelay::Attach,
            TerminalRelay::Ack,
            TerminalRelay::Resize,
            TerminalRelay::Close,
        ] {
            let mut message = frame("device-socket", "device-socket");
            message["event"] = json!(event.event_name());
            message["data"] = json!([{"session_id": "terminal-session", "protocol_version": 2}]);
            let call =
                inbound_rpc_job(message).expect("terminal control is routed to the socket owner");
            assert_eq!(call.event, RuntimeCallEvent::Terminal(event));
            assert_eq!(call.room, "device-socket");
            assert_eq!(call.id, 1);
            assert_eq!(call.arg["session_id"], "terminal-session");
            assert_eq!(call.ack_timeout(ACK_LIMITS), Duration::from_secs(5));
        }
    }

    #[test]
    fn a_capability_sync_self_echo_is_not_a_job() {
        let mut message = frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9");
        message["event"] = json!("device:sync_capabilities");
        message["host_id"] = json!(socketio_emit::host_id());
        assert!(inbound_rpc_job(message).is_none());
        // The runtime:rpc echo stays accepted: it is how this process's own
        // outbound `sio.call` reaches its local socket.
        let mut rpc = frame("7xY2AeTaWTsb2AJ9", "7xY2AeTaWTsb2AJ9");
        rpc["host_id"] = json!(socketio_emit::host_id());
        assert!(inbound_rpc_job(rpc).is_some());
    }

    #[test]
    fn a_mismatched_or_unrelated_frame_is_ignored() {
        assert!(inbound_rpc_job(frame("room-1", "room-2")).is_none());
        let mut other = frame("room-1", "room-1");
        other["event"] = json!("device:slot_update");
        assert!(inbound_rpc_job(other).is_none());
        let mut no_callback = frame("room-1", "room-1");
        no_callback["callback"] = Value::Null;
        assert!(inbound_rpc_job(no_callback).is_none());
    }

    #[test]
    fn the_callback_echoes_the_remote_identity_with_one_result() {
        let callback = callback_message(
            "fefecc7979634ba187ec89eaaabf1233",
            "7xY2AeTaWTsb2AJ9",
            "/local-executor",
            1,
            json!({"success": true, "workspaces": []}),
        );
        assert_eq!(
            callback,
            json!({
                "method": "callback",
                "host_id": "fefecc7979634ba187ec89eaaabf1233",
                "sid": "7xY2AeTaWTsb2AJ9",
                "namespace": "/local-executor",
                "id": 1,
                "args": [{"success": true, "workspaces": []}],
            })
        );
    }
}

#[cfg(test)]
mod adapter_emit_tests {
    use super::*;
    use serde_json::json;

    fn frame(host: &str, room: &str) -> Value {
        json!({
            "method": "emit",
            "event": "device:slot_update",
            "data": [{"device_id": "d-1", "slot_used": 0}],
            "binary": false,
            "namespace": "/chat",
            "room": room,
            "skip_sid": null,
            "callback": null,
            "host_id": host,
        })
    }

    #[test]
    fn an_ordinary_broadcast_keeps_its_own_room_and_payload() {
        for room in ["user:2287", "wework:user:2287"] {
            let job = adapter_emit_job(frame("external-manager", room)).expect("a broadcast");
            assert_eq!(job.namespace, "/chat");
            assert_eq!(job.event, "device:slot_update");
            assert_eq!(job.room, room);
            assert_eq!(job.skip_sid, None);
            assert_eq!(job.args, vec![json!({"device_id": "d-1", "slot_used": 0})]);
        }
    }

    #[test]
    fn a_skip_sid_and_multi_argument_payload_survive() {
        let mut message = frame("external-manager", "user:1");
        message["skip_sid"] = json!("socket-7");
        message["data"] = json!([{"a": 1}, {"b": 2}]);
        let job = adapter_emit_job(message).expect("a broadcast");
        assert_eq!(job.skip_sid.as_deref(), Some("socket-7"));
        assert_eq!(job.args, vec![json!({"a": 1}), json!({"b": 2})]);
    }

    #[test]
    fn this_managers_own_frames_are_not_delivered_again() {
        assert!(adapter_emit_job(frame(socketio_emit::host_id(), "user:1")).is_none());
    }

    #[test]
    fn callback_bearing_and_non_emit_frames_stay_off_the_broadcast_path() {
        let mut message = frame("external-manager", "user:1");
        message["callback"] = json!(["sid", "/local-executor", 1]);
        assert!(adapter_emit_job(message).is_none());
        let mut message = frame("external-manager", "user:1");
        message["method"] = json!("callback");
        assert!(adapter_emit_job(message).is_none());
        let mut message = frame("external-manager", "");
        message["room"] = json!("");
        assert!(adapter_emit_job(message).is_none());
    }
}

#[cfg(test)]
mod adapter_args_tests {
    use super::*;
    use serde::ser::{Impossible, SerializeTuple};
    use serde_json::json;
    use std::fmt;

    /// The error type for the shape recorder.
    #[derive(Debug)]
    struct ShapeError;

    impl fmt::Display for ShapeError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("unsupported serialization shape")
        }
    }

    impl std::error::Error for ShapeError {}
    impl serde::ser::Error for ShapeError {
        fn custom<T: fmt::Display>(_message: T) -> Self {
            Self
        }
    }

    /// Records which `serde::Serializer` entry point socketioxide's parser
    /// inspects: a tuple keeps its arity, a sequence/array is one argument.
    #[derive(Default)]
    struct Shape {
        tuple_len: Option<usize>,
        seq_len: Option<usize>,
    }

    impl serde::Serializer for &mut Shape {
        type Ok = ();
        type Error = ShapeError;
        type SerializeSeq = Impossible<(), ShapeError>;
        type SerializeTuple = TupleShape;
        type SerializeTupleStruct = Impossible<(), ShapeError>;
        type SerializeTupleVariant = Impossible<(), ShapeError>;
        type SerializeMap = Impossible<(), ShapeError>;
        type SerializeStruct = Impossible<(), ShapeError>;
        type SerializeStructVariant = Impossible<(), ShapeError>;

        fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
            self.seq_len = len;
            Err(ShapeError)
        }
        fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple, Self::Error> {
            self.tuple_len = Some(len);
            Ok(TupleShape)
        }
        fn serialize_tuple_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleStruct, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_tuple_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleVariant, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStruct, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_struct_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStructVariant, Self::Error> {
            Err(ShapeError)
        }
        fn serialize_bool(self, _: bool) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i8(self, _: i8) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i16(self, _: i16) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i32(self, _: i32) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_i64(self, _: i64) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u8(self, _: u8) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u16(self, _: u16) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u32(self, _: u32) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_u64(self, _: u64) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_f32(self, _: f32) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_f64(self, _: f64) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_char(self, _: char) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_str(self, _: &str) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_bytes(self, _: &[u8]) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_none(self) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_some<T: ?Sized + serde::Serialize>(
            self,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(self)
        }
        fn serialize_unit(self) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_unit_struct(self, _: &'static str) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_unit_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
        ) -> Result<(), Self::Error> {
            Err(ShapeError)
        }
        fn serialize_newtype_struct<T: ?Sized + serde::Serialize>(
            self,
            _: &'static str,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(self)
        }
        fn serialize_newtype_variant<T: ?Sized + serde::Serialize>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            value: &T,
        ) -> Result<(), Self::Error> {
            value.serialize(self)
        }
    }

    struct TupleShape;

    impl SerializeTuple for TupleShape {
        type Ok = ();
        type Error = ShapeError;
        fn serialize_element<T: ?Sized + serde::Serialize>(
            &mut self,
            _value: &T,
        ) -> Result<(), Self::Error> {
            Ok(())
        }
        fn end(self) -> Result<(), Self::Error> {
            Ok(())
        }
    }

    /// The arity the parser sees and the JSON the tuple serializes to.
    fn arity(args: &[Value]) -> (Option<usize>, Option<usize>, String) {
        let mut shape = Shape::default();
        serde::Serialize::serialize(&ArgsTuple(args), &mut shape).expect("tuple serializes");
        let json = serde_json::to_string(&ArgsTuple(args)).expect("tuple json");
        (shape.tuple_len, shape.seq_len, json)
    }

    #[test]
    fn zero_one_two_and_nested_array_arguments_stay_positional() {
        // No argument: `[event]` on the wire, not `[event, []]`.
        assert_eq!(arity(&[]), (Some(0), None, "[]".to_owned()));
        assert_eq!(
            arity(&[json!({"a": 1})]),
            (Some(1), None, r#"[{"a":1}]"#.to_owned())
        );
        // Two arguments stay two positional arguments, not one array.
        assert_eq!(
            arity(&[json!({"a": 1}), json!({"b": 2})]),
            (Some(2), None, r#"[{"a":1},{"b":2}]"#.to_owned())
        );
        // A single nested array is still one argument.
        assert_eq!(
            arity(&[json!([1, 2])]),
            (Some(1), None, "[[1,2]]".to_owned())
        );
        // A bare array serializes as a sequence: the parser would wrap it as
        // one argument, which is why the tuple writer is required.
        let mut shape = Shape::default();
        let _ = serde::Serialize::serialize(&json!([1, 2]), &mut shape);
        assert_eq!(shape.tuple_len, None);
    }
}
