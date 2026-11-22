// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bind stream emission to the process-local Socket.IO transport.

use brz_redis::{Redis, RedisResult};
use serde_json::Value;
use wegent_execution_emission::emitter;

use super::completion::CollaborationStatus;
use super::event::ExecutionEvent;
#[cfg(test)]
use super::session;
use super::socketio::ProcessLocalEmit;

pub(crate) use emitter::CreatedTask;
#[cfg(test)]
pub(crate) use emitter::chunk_payload_for_test;

pub(crate) type StatusUpdatingEmitter<R> = emitter::StatusUpdatingEmitter<R, ProcessLocalEmit>;

pub(crate) async fn emit_terminal_frames<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    result: &Value,
    contexts: Option<&Value>,
) -> RedisResult<()> {
    emitter::emit_terminal_frames(&ProcessLocalEmit, redis, event, user_id, result, contexts).await
}

pub(crate) async fn emit_terminal_frames_once<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
    user_id: Option<i64>,
    result: &Value,
    task: &CollaborationStatus,
    contexts: Option<&Value>,
) -> RedisResult<()> {
    emitter::emit_terminal_frames_once(
        redis,
        event,
        user_id,
        result,
        (&task.status, task.progress),
        contexts,
    )
    .await
}

#[cfg(test)]
#[path = "emitter_form_tests.rs"]
mod emitter_form_tests;
#[cfg(test)]
#[path = "streaming_activity_redis_tests.rs"]
mod streaming_activity_redis_tests;
