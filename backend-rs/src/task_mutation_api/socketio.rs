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

use brz_redis::{Redis, RedisResult};

/// `AsyncPubSubManager.emit`'s queued message for one device room, serialized
/// exactly like `json.dumps(message)`.
pub(crate) fn close_session_message(user_id: i64, device_id: &str, task_id: i64) -> String {
    let room = format!("device:{user_id}:{device_id}");
    let data = format!("[{{\"task_id\": {task_id}}}]");
    crate::socketio_emit::emit_message("task:close-session", &data, "/local-executor", &room)
}

/// Publish the `task:close-session` emit for one device room.
pub(crate) async fn publish_close_session<R: Redis>(
    redis: &R,
    user_id: i64,
    device_id: &str,
    task_id: i64,
) -> RedisResult<i64> {
    let message = close_session_message(user_id, device_id, task_id);
    redis
        .publish(crate::socketio_emit::SOCKETIO_CHANNEL, message)
        .await
}
