// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `chat:status_updated` frame and the cached context-metrics snapshot.
//!
//! Source:
//! - `WebSocketResultEmitter._emit_status_updated`
//!   (`app/services/execution/emitters/websocket.py:272-318`), which validates
//!   the event, caches the latest snapshot, then emits the frame;
//! - `WebPageSocketEmitter.emit_chat_status_updated`
//!   (`app/services/chat/webpage_ws_chat_emitter.py:257-283`), which builds the
//!   frame payload and omits `context_compaction` when it is not a dict;
//! - `session_manager.save_context_metrics`
//!   (`app/services/chat/storage/session.py:481-497`).

use brz_redis::{Redis, RedisResult};
use serde_json::{Map, Value, json};

use super::event::ExecutionEvent;
use super::session;
use super::socketio::publish_emit;

/// One validated `status_updated` event: the cache snapshot and the frame.
pub(crate) struct StatusUpdate {
    pub(crate) snapshot: Value,
    pub(crate) frame: Value,
}

/// `_emit_status_updated`'s validation and payload construction.
///
/// A falsy `phase` or a non-dict `context_metrics` skips the whole event. A
/// missing `context_metrics` defaults to `{}` (`event.data.get(..., {})`), and
/// `context_compaction` is only carried when it is a dict — the snapshot folds
/// every other value to `null` while the frame omits the key.
pub(crate) fn build(event: &ExecutionEvent) -> Option<StatusUpdate> {
    let phase = event
        .data
        .get("phase")
        .filter(|value| is_truthy(value))?
        .clone();
    let context_metrics = match event.data.get("context_metrics") {
        None => Value::Object(Map::new()),
        Some(Value::Object(metrics)) => Value::Object(metrics.clone()),
        Some(_) => return None,
    };
    let context_compaction = match event.data.get("context_compaction") {
        Some(Value::Object(compaction)) => Some(Value::Object(compaction.clone())),
        _ => None,
    };

    let snapshot = json!({
        "task_id": event.task_id,
        "subtask_id": event.subtask_id,
        "phase": phase,
        "context_metrics": context_metrics,
        "context_compaction": context_compaction.clone().unwrap_or(Value::Null),
    });

    let mut frame = Map::new();
    frame.insert("task_id".into(), json!(event.task_id));
    frame.insert("subtask_id".into(), json!(event.subtask_id));
    frame.insert("phase".into(), phase);
    frame.insert("context_metrics".into(), context_metrics);
    if let Some(compaction) = context_compaction {
        frame.insert("context_compaction".into(), compaction);
    }

    Some(StatusUpdate {
        snapshot,
        frame: Value::Object(frame),
    })
}

/// `_emit_status_updated` + `emit_chat_status_updated`: cache the snapshot,
/// then publish the frame to the task room.
///
/// The cache write is best-effort in the source (`try/except` around
/// `save_context_metrics`), so a failed write is logged and never suppresses
/// the frame.
pub(crate) async fn emit_status_updated<R: Redis>(
    redis: &R,
    event: &ExecutionEvent,
) -> RedisResult<()> {
    let Some(update) = build(event) else {
        tracing::debug!(
            task_id = event.task_id,
            subtask_id = event.subtask_id,
            "skipping invalid status update event"
        );
        return Ok(());
    };
    if let Err(error) =
        session::save_context_metrics(redis, event.subtask_id, &update.snapshot).await
    {
        tracing::warn!(
            %error,
            task_id = event.task_id,
            subtask_id = event.subtask_id,
            "failed to cache context metrics"
        );
    }
    publish_emit(redis, "chat:status_updated", event.task_id, update.frame)
        .await
        .map(|_| ())
}

/// Python truthiness, as used by `if not phase`.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

#[cfg(test)]
#[path = "status_frames_tests.rs"]
mod status_frames_tests;
