// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Route execution events through local Socket.IO subscribers and Redis.

use brz_redis::{Redis, RedisResult};
use serde_json::Value;
use wegent_execution_emission::{LocalEmit, socketio};

use super::emitter::CreatedTask;

pub(crate) use socketio::publish_terminal_emit;

#[derive(Clone, Default)]
pub(crate) struct ProcessLocalEmit;

impl LocalEmit for ProcessLocalEmit {
    async fn deliver(
        &self,
        namespace: &str,
        event: &str,
        room: &str,
        skip_sid: Option<&str>,
        payload: &Value,
    ) {
        crate::socketio::runtime::deliver_local_emit(namespace, event, room, skip_sid, payload)
            .await;
    }
}

pub(crate) async fn publish_chat_start<R: Redis>(
    redis: &R,
    task_id: i64,
    subtask_id: i64,
    bot_name: Value,
    shell_type: &str,
    message_id: Option<i64>,
) -> RedisResult<i64> {
    socketio::publish_chat_start(
        &ProcessLocalEmit,
        redis,
        task_id,
        subtask_id,
        bot_name,
        shell_type,
        message_id,
    )
    .await
}

pub(crate) async fn publish_task_created<R: Redis>(
    redis: &R,
    task_id: i64,
    created: &CreatedTask,
) -> RedisResult<i64> {
    socketio::publish_task_created(&ProcessLocalEmit, redis, task_id, created).await
}

pub(crate) async fn publish_emit_in_room<R: Redis>(
    redis: &R,
    event: &str,
    room: &str,
    payload: Value,
) -> RedisResult<i64> {
    socketio::publish_emit_in_room(&ProcessLocalEmit, redis, event, room, payload).await
}

pub(crate) async fn publish_emit_in_room_skipping<R: Redis>(
    redis: &R,
    event: &str,
    room: &str,
    payload: Value,
    skip_sid: Option<&str>,
) -> RedisResult<i64> {
    socketio::publish_emit_in_room_skipping(
        &ProcessLocalEmit,
        redis,
        event,
        room,
        payload,
        skip_sid,
    )
    .await
}
