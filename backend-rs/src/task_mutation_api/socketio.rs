// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket.IO Redis publish for the task delete path.
//!
//! `delete_task` sends a `task:close-session` event to a device room through
//! `app.core.socketio.get_sio()`. The server uses socket.io's Redis pub/sub
//! manager (`AsyncRedisManager`), so an `emit` is serialized to JSON and
//! `PUBLISH`ed on the `socketio` channel with the manager's per-process
//! `host_id` (`uuid.uuid4().hex`).

use std::sync::OnceLock;

use brz_redis::{Redis, RedisResult};

/// The manager's channel (`AsyncRedisManager` default).
const SOCKETIO_CHANNEL: &str = "socketio";

/// `AsyncPubSubManager.host_id`: a process-lifetime `uuid4().hex`. The value
/// is random per process, so it cannot match a recorded value; the message
/// shape and channel are what the publish preserves.
fn host_id() -> &'static str {
    static HOST_ID: OnceLock<String> = OnceLock::new();
    HOST_ID.get_or_init(|| {
        use std::hash::{BuildHasher, Hasher};
        use std::time::{SystemTime, UNIX_EPOCH};

        let mut out = String::with_capacity(32);
        for _ in 0..2 {
            let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos() as u64)
                .unwrap_or_default();
            hasher.write_u64(nanos);
            out.push_str(&format!("{:016x}", hasher.finish()));
        }
        out
    })
}

/// `AsyncPubSubManager.emit`'s queued message, serialized exactly like
/// `json.dumps(message)` (default `", "` / `": "` separators, key order as
/// constructed).
pub(crate) fn close_session_message(user_id: i64, device_id: &str, task_id: i64) -> String {
    let room = format!("device:{user_id}:{device_id}");
    format!(
        "{{\"method\": \"emit\", \"event\": \"task:close-session\", \"data\": [{{\"task_id\": {task_id}}}], \
         \"binary\": false, \"namespace\": \"/local-executor\", \"room\": \"{room}\", \
         \"skip_sid\": null, \"callback\": null, \"host_id\": \"{}\"}}",
        host_id()
    )
}

/// Publish the `task:close-session` emit for one device room.
pub(crate) async fn publish_close_session<R: Redis>(
    redis: &R,
    user_id: i64,
    device_id: &str,
    task_id: i64,
) -> RedisResult<i64> {
    let message = close_session_message(user_id, device_id, task_id);
    redis.publish(SOCKETIO_CHANNEL, message).await
}
