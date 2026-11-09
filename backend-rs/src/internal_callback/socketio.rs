// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Socket.IO Redis publish for the execution callback.
//!
//! `WebPageSocketEmitter` emits through a `socketio.AsyncServer` whose
//! `AsyncRedisManager` serializes each emit and `PUBLISH`es it on the
//! `socketio` channel. The envelope is the shared
//! [`crate::socketio_emit::emit_message`] shape (the same manager identity and
//! channel used by every migrated emit), and the positional arguments are
//! serialized with CPython's `json.dumps` (`super::py_json::python_dumps`).
use brz_redis::{Redis, RedisResult};
use serde_json::{Value, json};

use super::py_json::python_dumps;
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message};

/// Publish one Socket.IO emit for the `/chat` namespace into `task:{task_id}`.
pub(crate) async fn publish_emit<R: Redis>(
    redis: &R,
    event: &str,
    task_id: i64,
    payload: Value,
) -> RedisResult<i64> {
    let room = format!("task:{task_id}");
    publish_emit_in_room(redis, event, &room, payload).await
}

/// `WebPageSocketEmitter.emit_chat_start`: the `chat:start` frame the
/// dispatcher emits after the executor acknowledgement
/// (`webpage_websocket_chat_emitter.py:88-99`).
pub(crate) async fn publish_chat_start<R: Redis>(
    redis: &R,
    task_id: i64,
    subtask_id: i64,
    bot_name: Value,
    shell_type: &str,
    message_id: Option<i64>,
) -> RedisResult<i64> {
    let payload = json!({
        "task_id": task_id,
        "subtask_id": subtask_id,
        "bot_name": bot_name,
        "shell_type": shell_type,
        "message_id": message_id,
    });
    publish_emit(redis, "chat:start", task_id, payload).await
}

/// Publish one Socket.IO emit for the `/chat` namespace into an explicit room.
///
/// The wrapped emitters address different rooms: result frames use
/// `task:{task_id}` while task-status and pet frames use `user:{user_id}`.
pub(crate) async fn publish_emit_in_room<R: Redis>(
    redis: &R,
    event: &str,
    room: &str,
    payload: Value,
) -> RedisResult<i64> {
    let data = python_dumps(&Value::Array(vec![payload]));
    let message = emit_message(event, &data, "/chat", room);
    redis.publish(SOCKETIO_CHANNEL, message).await
}
