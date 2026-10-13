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
use serde_json::Value;

use super::py_json::python_dumps;
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message};

/// Publish one Socket.IO emit for the `/chat` namespace into `task:{task_id}`.
pub(crate) async fn publish_emit<R: Redis>(
    redis: &R,
    event: &str,
    task_id: i64,
    payload: Value,
) -> RedisResult<i64> {
    let data = python_dumps(&Value::Array(vec![payload]));
    let room = format!("task:{task_id}");
    let message = emit_message(event, &data, "/chat", &room);
    redis.publish(SOCKETIO_CHANNEL, message).await
}
