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
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message_skipping};

use super::emitter::CreatedTask;

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

/// `WebPageSocketEmitter.emit_task_created`
/// (`webpage_ws_chat_emitter.py:551-587`): the `task:created` frame for the
/// owner's user room, published right after `chat:start`.
pub(crate) async fn publish_task_created<R: Redis>(
    redis: &R,
    task_id: i64,
    created: &CreatedTask,
) -> RedisResult<i64> {
    let payload = task_created_payload(task_id, created);
    publish_emit_in_room(
        redis,
        "task:created",
        &format!("user:{}", created.user_id),
        payload,
    )
    .await
}

/// The `task:created` payload: the task identity, the creator's team/title/
/// project, and the emit's local timestamp.
pub(crate) fn task_created_payload(task_id: i64, created: &CreatedTask) -> Value {
    json!({
        "task_id": task_id,
        "title": created.title,
        "team_id": created.team_id,
        "team_name": created.team_name,
        "created_at": chrono::Local::now()
            .naive_local()
            .format("%Y-%m-%dT%H:%M:%S%.6f")
            .to_string(),
        "is_group_chat": created.is_group_chat,
        "project_id": created.project_id,
    })
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
    publish_emit_in_room_skipping(redis, event, room, payload, None).await
}

/// `publish_emit_in_room` with `skip_sid` (the sender's own socket).
///
/// `ChatNamespace._broadcast_user_message` emits `chat:message` with
/// `skip_sid=sid` so the sender does not receive its own broadcast.
pub(crate) async fn publish_emit_in_room_skipping<R: Redis>(
    redis: &R,
    event: &str,
    room: &str,
    payload: Value,
    skip_sid: Option<&str>,
) -> RedisResult<i64> {
    // `AsyncPubSubManager.emit` delivers to the local subscribers first
    // (`_handle_emit`) and only then publishes the adapter message; the
    // process's own Redis echo is ignored by `adapter_emit_job`, so a local
    // subscriber receives the frame exactly once.
    crate::socketio::runtime::deliver_local_emit("/chat", event, room, skip_sid, &payload).await;
    let data = python_dumps(&Value::Array(vec![payload]));
    let message = emit_message_skipping(event, &data, "/chat", room, skip_sid);
    redis.publish(SOCKETIO_CHANNEL, message).await
}
