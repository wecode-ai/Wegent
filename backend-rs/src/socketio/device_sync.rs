// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Registration-time device follow-up work.
//!
//! Source: `app/api/ws/device_namespace.py::
//! _sync_global_capabilities_to_registered_device` (`register` ACK first, then
//! a best-effort background sync). The source schedules it on the event loop;
//! this module runs it on one long-lived bounded worker started with the
//! Socket.IO service, so a registration never spawns detached work.
//!
//! The dispatch half mirrors `AsyncPubSubManager.emit`: the adapter message is
//! published for the other workers while the local `EventEmitter` delivers to
//! the socket and waits for the executor's ACK.

use std::sync::Arc;
use std::time::Duration;

use brz_socket_io::EmitterError;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::json_compat::python_json_value;
use crate::plugins_installed::{
    CapabilityDispatch, DispatchOutcome, prepare_plugins_for_registered_device,
    record_registration_sync_result, sync_registration_capabilities,
};
use crate::state::AppState;

use super::runtime::{CallbackIds, DeviceJob, RuntimeRpcCall, SocketEmitters};

/// `SYNC_EVENT`.
const SYNC_EVENT: &str = "device:sync_capabilities";
/// `SYNC_NAMESPACE`.
const SYNC_NAMESPACE: &str = "/local-executor";

/// The worker loop. Runs until the queue closes or the process shuts down.
pub(crate) async fn run_worker(
    mut jobs: mpsc::Receiver<DeviceJob>,
    state: Arc<AppState>,
    emitters: Arc<SocketEmitters>,
    callbacks: Arc<CallbackIds>,
) {
    loop {
        let job = tokio::select! {
            job = jobs.recv() => job,
            () = tokio::time::sleep(Duration::from_secs(1)) => {
                if state.shutdown.is_shutting_down() {
                    return;
                }
                continue;
            }
        };
        let Some(job) = job else {
            return;
        };
        if state.shutdown.is_shutting_down() {
            return;
        }
        match job {
            DeviceJob::RegisterSync { user_id, device_id } => {
                sync_after_register(&state, &emitters, &callbacks, user_id, device_id).await;
            }
            DeviceJob::PluginRemoval { user_id, device_id } => {
                crate::plugins_installed::removal_sync::run_pending_removals(
                    &state, user_id, &device_id,
                )
                .await;
            }
        }
    }
}

/// `_sync_global_capabilities_to_registered_device`.
async fn sync_after_register(
    state: &AppState,
    emitters: &SocketEmitters,
    callbacks: &CallbackIds,
    user_id: i64,
    device_id: String,
) {
    let include_plugins =
        match prepare_plugins_for_registered_device(state, user_id, &device_id).await {
            crate::plugins_installed::PluginPreparation::Ready => true,
            crate::plugins_installed::PluginPreparation::Deferred => false,
            crate::plugins_installed::PluginPreparation::Failed => return,
        };
    let dispatch = LocalDispatch {
        state,
        emitters,
        callbacks,
    };
    let Some(result) =
        sync_registration_capabilities(state, user_id, &device_id, include_plugins, &dispatch)
            .await
    else {
        return;
    };
    if !result.success {
        tracing::warn!(
            user_id,
            device_id,
            error = result.error,
            "capability sync after registration failed"
        );
    }
    if include_plugins {
        record_registration_sync_result(state, user_id, &result).await;
    }
}

/// The registration path's local socket plus adapter publish.
struct LocalDispatch<'a> {
    state: &'a AppState,
    emitters: &'a SocketEmitters,
    callbacks: &'a CallbackIds,
}

impl CapabilityDispatch for LocalDispatch<'_> {
    async fn dispatch(
        &self,
        socket_id: &str,
        payload: &Value,
        timeout: Duration,
    ) -> DispatchOutcome {
        let callback_id = self.callbacks.next(socket_id);
        if !publish_sync_call(self.state, socket_id, callback_id, payload).await {
            return DispatchOutcome::Failure("Socket.IO Redis adapter is unavailable");
        }
        match self
            .emitters
            .call_sync_capabilities(socket_id, payload, timeout)
            .await
        {
            Ok(args) => DispatchOutcome::Ack(args),
            Err(error) => DispatchOutcome::Failure(emitter_error_text(&error)),
        }
    }
}

/// `AsyncPubSubManager.emit`'s Redis half for one `sio.call`.
async fn publish_sync_call(
    state: &AppState,
    socket_id: &str,
    callback_id: u64,
    payload: &Value,
) -> bool {
    let Some(redis) = state.redis.as_ref() else {
        return false;
    };
    use brz_redis::Redis as _;
    let data = python_json_value(&Value::Array(vec![payload.clone()]));
    let message = crate::socketio_emit::emit_message_with_callback(
        SYNC_EVENT,
        &data,
        SYNC_NAMESPACE,
        socket_id,
        Some((socket_id, callback_id)),
    );
    match redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "registration capability adapter publish failed");
            false
        }
    }
}

/// `str(exc)` for the mapped dispatch failure, matching the Redis-RPC path.
fn emitter_error_text(error: &EmitterError) -> &'static str {
    match error {
        EmitterError::Ack(brz_socket_io::AckError::Timeout) => "",
        EmitterError::Namespace(_) => "namespace is unavailable",
        EmitterError::InvalidTimeout => "invalid timeout",
        EmitterError::Broadcast(_) | EmitterError::Publish(_) => {
            "Socket.IO Redis adapter is unavailable"
        }
        EmitterError::Ack(_) => "connection closed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dispatch_failures_keep_the_source_text() {
        assert_eq!(
            emitter_error_text(&EmitterError::Namespace("/local-executor")),
            "namespace is unavailable"
        );
        assert_eq!(
            emitter_error_text(&EmitterError::InvalidTimeout),
            "invalid timeout"
        );
    }
}

/// `socketio/async_pubsub_manager.py` inbound `emit`: only a `runtime:rpc`
/// call addressed to one local session by the translated Target SID, with the
/// original three-element callback identity, becomes a worker job.
pub(crate) fn inbound_rpc_job(message: Value) -> Option<RuntimeRpcCall> {
    if message.get("method").and_then(Value::as_str) != Some("emit") {
        return None;
    }
    if message.get("event").and_then(Value::as_str) != Some("runtime:rpc") {
        return None;
    }
    if message.get("namespace").and_then(Value::as_str) != Some("/local-executor") {
        return None;
    }
    let callback = message.get("callback")?.as_array()?;
    let [sid, namespace, id] = callback.as_slice() else {
        return None;
    };
    let room = message.get("room")?.as_str()?;
    let host_id = message.get("host_id")?.as_str()?;
    let arg = message.get("data")?.as_array()?.first()?.clone();
    if sid.as_str()? != room {
        return None;
    }
    Some(RuntimeRpcCall {
        room: room.to_owned(),
        namespace: namespace.as_str()?.to_owned(),
        host_id: host_id.to_owned(),
        id: id.as_u64()?,
        arg,
    })
}

/// Deliver one inbound `runtime:rpc` call to the real session and publish the
/// client's real acknowledgement as the source's `method: callback` message.
///
/// A timeout or closed socket publishes nothing: the source's `sio.call`
/// failure path produces no callback, and an acknowledgement is never
/// synthesized.
async fn forward_runtime_rpc(state: &AppState, emitters: &SocketEmitters, call: RuntimeRpcCall) {
    let RuntimeRpcCall {
        room,
        namespace,
        host_id,
        id,
        arg,
    } = call;
    let ack = match emitters.runtime_rpc(&room, &arg, RUNTIME_RPC_TIMEOUT).await {
        Ok(ack) => ack,
        Err(error) => {
            tracing::warn!(
                %error,
                room,
                id,
                "runtime:rpc call failed; no callback is published"
            );
            return;
        }
    };
    let Some(redis) = state.redis.as_ref() else {
        tracing::warn!(
            room,
            id,
            "runtime:rpc Redis adapter is unavailable; no callback is published"
        );
        return;
    };
    use brz_redis::Redis as _;
    let callback = callback_message(&host_id, &room, &namespace, id, ack);
    let message = crate::json_compat::python_json_value(&callback);
    if let Err(error) = redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
    {
        tracing::error!(%error, room, id, "runtime:rpc callback publish failed");
    }
}

/// The source's `_return_callback` message: the original remote identity is
/// echoed and the client's acknowledgement is the single result item.
fn callback_message(host_id: &str, sid: &str, namespace: &str, id: u64, ack: Value) -> Value {
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
pub(crate) async fn run_rpc_worker(
    calls: Arc<tokio::sync::Mutex<mpsc::Receiver<RuntimeRpcCall>>>,
    state: Arc<AppState>,
    emitters: Arc<SocketEmitters>,
) {
    loop {
        let call = {
            let mut calls = calls.lock().await;
            calls.recv().await
        };
        let Some(call) = call else {
            return;
        };
        forward_runtime_rpc(&state, &emitters, call).await;
    }
}

/// The Socket.IO argument tuple: `operators.emit` wraps a non-tuple value into
/// a single argument, so the frame's positional arguments must serialize
/// through `serialize_tuple` to reach the wire as `[event, a, b]` — including
/// a lone array argument, which stays one argument.
pub(crate) struct ArgsTuple<'a>(pub &'a [Value]);

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
pub(crate) struct AdapterEmit {
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
pub(crate) fn adapter_emit_job(message: Value) -> Option<AdapterEmit> {
    if message.get("method").and_then(Value::as_str) != Some("emit") {
        return None;
    }
    if message.get("host_id").and_then(Value::as_str) == Some(crate::socketio_emit::host_id()) {
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
pub(crate) async fn run_adapter_emit_worker(
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
const RUNTIME_RPC_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(test)]
mod runtime_rpc_tests {
    use super::*;

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
            room,
            namespace,
            host_id,
            id,
            arg,
        } = job;
        assert_eq!(room, "7xY2AeTaWTsb2AJ9");
        assert_eq!(namespace, "/local-executor");
        assert_eq!(host_id, "fefecc7979634ba187ec89eaaabf1233");
        assert_eq!(id, 1);
        assert_eq!(arg, json!({"method": "runtime.tasks.list", "payload": {}}));
    }

    #[test]
    fn a_mismatched_or_unrelated_frame_is_ignored() {
        assert!(inbound_rpc_job(frame("room-1", "room-2")).is_none());
        let mut other = frame("room-1", "room-1");
        other["event"] = json!("device:sync_capabilities");
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
        assert!(adapter_emit_job(frame(crate::socketio_emit::host_id(), "user:1")).is_none());
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
