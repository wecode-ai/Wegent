// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket.IO Redis-adapter publishing shared by migrated endpoints.
//!
//! The source server configures socket.io with an `AsyncRedisManager`, so every
//! `sio.emit` is serialized to JSON and `PUBLISH`ed on the `socketio` channel
//! with the manager's per-process `host_id` (`uuid.uuid4().hex`). Because the
//! Socket.IO server itself is not migrated, a Rust endpoint that would emit
//! through it reproduces the same publish so the running server (and the other
//! workers bound to the same Redis adapter) deliver the event to its rooms.

use std::sync::OnceLock;

/// The manager's channel (`AsyncRedisManager` default).
pub const SOCKETIO_CHANNEL: &str = "socketio";

/// `AsyncPubSubManager.host_id`: a process-lifetime `uuid.uuid4().hex`.
///
/// `uuid4()` draws 16 random bytes and forces the UUID v4 version and RFC 4122
/// variant bits; `.hex` renders them as 32 lowercase hex characters. The value
/// is random per process, so it cannot match a recorded value; the message
/// shape and channel are what a publish preserves. It is shared by every
/// migrated emit so one process keeps a single manager identity.
pub fn host_id() -> &'static str {
    static HOST_ID: OnceLock<String> = OnceLock::new();
    HOST_ID.get_or_init(|| {
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).expect("OS randomness is available");
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    })
}

/// `AsyncPubSubManager.emit`'s queued message, serialized exactly like
/// `json.dumps(message)` (default `", "` / `": "` separators, key order as
/// constructed). `data` is the JSON array of positional arguments.
pub fn emit_message(event: &str, data: &str, namespace: &str, room: &str) -> String {
    emit_message_with_callback(event, data, namespace, room, None)
}

/// `AsyncPubSubManager.emit` with the optional RPC callback identity that
/// `Server.call` adds: `[sid, namespace, id]`.
pub fn emit_message_with_callback(
    event: &str,
    data: &str,
    namespace: &str,
    room: &str,
    callback: Option<(&str, u64)>,
) -> String {
    let callback = match callback {
        Some((sid, id)) => format!("[\"{sid}\", \"{namespace}\", {id}]"),
        None => "null".to_string(),
    };
    emit_message_with_skip_sid(event, data, namespace, room, "null", callback)
}

/// `AsyncPubSubManager.emit` with `skip_sid` set to one connection id.
///
/// `socketio.AsyncServer.emit(..., skip_sid=sid)` puts the excluded socket in
/// the published message so every worker delivers it to the room except that
/// socket; `None` keeps the source's JSON `null`.
pub fn emit_message_skipping(
    event: &str,
    data: &str,
    namespace: &str,
    room: &str,
    skip_sid: Option<&str>,
) -> String {
    let skip_sid = match skip_sid {
        Some(sid) => format!("\"{sid}\""),
        None => "null".to_string(),
    };
    emit_message_with_skip_sid(event, data, namespace, room, &skip_sid, "null".to_string())
}

/// The shared message envelope with the rendered `skip_sid` and `callback`.
fn emit_message_with_skip_sid(
    event: &str,
    data: &str,
    namespace: &str,
    room: &str,
    skip_sid: &str,
    callback: String,
) -> String {
    format!(
        "{{\"method\": \"emit\", \"event\": \"{event}\", \"data\": {data}, \"binary\": false, \
         \"namespace\": \"{namespace}\", \"room\": \"{room}\", \"skip_sid\": {skip_sid}, \
         \"callback\": {callback}, \"host_id\": \"{}\"}}",
        host_id()
    )
}

/// `device_socketio.publish_device_execution`'s direct-publish message:
/// `method,event,data,namespace,room,host_id` only (no `binary`, `callback`,
/// or `skip_sid`).
///
/// The Source builds a fresh `uuid.uuid4().hex` per publish instead of the
/// manager's stable identity, so `adapter_emit_job` does not treat the emit as
/// its own echo and delivers it to the device room exactly once.
pub fn device_execution_message(
    event: &str,
    payload: &serde_json::Value,
    namespace: &str,
    room: &str,
) -> String {
    let data =
        wegent_python_compat::json_compat::python_json_value(&serde_json::Value::Array(vec![
            payload.clone(),
        ]));
    format!(
        "{{\"method\": \"emit\", \"event\": {event:?}, \"data\": {data}, \
         \"namespace\": {namespace:?}, \"room\": {room:?}, \"host_id\": {:?}}}",
        fresh_host_id()
    )
}

/// `uuid.uuid4().hex`, freshly generated for one direct publish.
fn fresh_host_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("OS randomness is available");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_id_is_a_stable_uuid4_hex_identity() {
        let first = host_id();
        assert_eq!(first, host_id());
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        // `uuid.uuid4().hex`: version nibble 4 at position 12 and the RFC 4122
        // variant (8/9/a/b) at position 16.
        assert!(first.chars().nth(12).is_some_and(|c| c == '4'));
        let variant = first.chars().nth(16).expect("hex digit at 16");
        assert!(matches!(variant, '8' | '9' | 'a' | 'b'));
    }

    #[test]
    fn the_device_execution_message_carries_the_source_six_keys_and_a_fresh_host() {
        let payload = serde_json::json!({"task_id": 1});
        let first =
            device_execution_message("task:execute", &payload, "/local-executor", "device:157:d");
        let second =
            device_execution_message("task:execute", &payload, "/local-executor", "device:157:d");
        assert!(first.contains("\"method\": \"emit\""));
        assert!(first.contains("\"event\": \"task:execute\""));
        assert!(first.contains("\"data\": [{\"task_id\": 1}]"));
        assert!(first.contains("\"namespace\": \"/local-executor\""));
        assert!(first.contains("\"room\": \"device:157:d\""));
        for absent in ["\"binary\"", "\"callback\"", "\"skip_sid\""] {
            assert!(!first.contains(absent), "unexpected {absent}");
        }
        assert_ne!(first, second, "each publish gets a fresh identity");
    }

    #[test]
    fn emit_message_matches_the_python_json_dumps_shape() {
        let message = emit_message(
            "chat:guidance_applied",
            "[{\"task_id\": 1}]",
            "/chat",
            "task:1",
        );
        let prefix = "{\"method\": \"emit\", \"event\": \"chat:guidance_applied\", \
             \"data\": [{\"task_id\": 1}], \"binary\": false, \"namespace\": \"/chat\", \
             \"room\": \"task:1\", \"skip_sid\": null, \"callback\": null, \"host_id\": \"";
        assert!(message.starts_with(prefix), "{message}");
        let host = message
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix("\"}"))
            .expect("host_id suffix");
        assert_eq!(host.len(), 32);
    }

    #[test]
    fn callback_messages_carry_the_rpc_identity() {
        let message = emit_message_with_callback(
            "device:sync_capabilities",
            "[{\"mode\": \"replace\"}]",
            "/local-executor",
            "socket-1",
            Some(("socket-1", 7)),
        );
        assert!(message.contains(
            "\"room\": \"socket-1\", \"skip_sid\": null, \
             \"callback\": [\"socket-1\", \"/local-executor\", 7],"
        ));
        assert!(message.starts_with(
            "{\"method\": \"emit\", \"event\": \"device:sync_capabilities\", \
             \"data\": [{\"mode\": \"replace\"}], \"binary\": false, \
             \"namespace\": \"/local-executor\", "
        ));
    }
}
