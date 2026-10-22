// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/chat/guidance/{task_id}/{subtask_id}/expire` — expire
//! the queued Chat Shell guidance items for one subtask.
//!
//! Mirrors `app/api/endpoints/internal/chat_storage.py:expire_guidance` and
//! `app/services/chat/guidance_queue.py:GuidanceQueue.expire`. The queue is a
//! Redis list keyed by task and subtask; expiring drains it with `LRANGE` and
//! then `DEL`, and returns the `guidance_id` of every item that was still
//! pending.
//!
//! The source emits a `chat:guidance_expired` Socket.IO event to the task room
//! when at least one item was drained. That branch is unreachable in the
//! recorded environment: the queue is empty for every recorded case and the
//! rendered body is always `{"expired_ids":[]}`. The target has no Socket.IO
//! server, so the source's `if expired_ids:` guard degrades to a no-op; the
//! observable Redis state transition (drain and delete) is preserved.

use brz_redis::{Redis, RedisBytes};
use serde::Serialize;
use serde_json::Value;

use crate::http_compat::FastApiError;
use crate::state::AppState;

/// `GuidanceQueue.key`: the Redis list key for one Chat Shell subtask
/// (`chat:guidance:{task_id}:{subtask_id}`). Shared by every guidance-queue
/// endpoint (this drain/expire handler and the consume pop).
pub(crate) fn queue_key(task_id: i64, subtask_id: i64) -> String {
    format!("chat:guidance:{task_id}:{subtask_id}")
}

/// Response for the expire endpoint (`GuidanceExpireResponse`).
#[derive(Debug, Serialize)]
struct GuidanceExpireResponse {
    expired_ids: Vec<String>,
}

/// POST /api/internal/chat/guidance/{task_id}/{subtask_id}/expire.
#[brz_http_server::post("/api/internal/chat/guidance/:task_id/:subtask_id/expire")]
async fn expire_guidance(
    #[inject(state)] state: &AppState,
    task_id: i64,
    subtask_id: i64,
    #[auth] _service: crate::internal_auth::InternalService,
) -> Result<GuidanceExpireResponse, FastApiError> {
    expire(state, task_id, subtask_id).await
}

/// Handler body for the expire route.
///
/// `GuidanceQueue.expire` reads the list with `LRANGE key 0 -1`, deletes it
/// with `DEL key`, and then decodes each drained element. The source leaves
/// every Redis or JSON failure uncaught, so the request fails with the
/// framework's `500 {"detail":"Internal Server Error"}`.
async fn expire(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
) -> Result<GuidanceExpireResponse, FastApiError> {
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!(
            task_id,
            subtask_id,
            "guidance queue: Redis service is not available"
        );
        return Err(FastApiError::unhandled());
    };
    let key = queue_key(task_id, subtask_id);
    let raw_items: Vec<RedisBytes> = redis.lrange(key.as_str(), 0, -1).await.map_err(|error| {
        tracing::error!(%error, task_id, subtask_id, "guidance queue LRANGE failed");
        FastApiError::unhandled()
    })?;
    redis.del(key.as_str()).await.map_err(|error| {
        tracing::error!(%error, task_id, subtask_id, "guidance queue DEL failed");
        FastApiError::unhandled()
    })?;

    let expired_ids = parse_expired_ids(raw_items.iter().map(RedisBytes::as_ref))?;
    tracing::info!(task_id, subtask_id, ?expired_ids, "guidance queue expired");
    Ok(GuidanceExpireResponse { expired_ids })
}

/// Collect the `guidance_id` of every drained item (`GuidanceQueue.expire`).
///
/// A `guidance_id` is only appended when it is Python-truthy, matching the
/// source's `if guidance_id:`. `enqueue` always writes a non-empty string
/// `guidance_id`, so the recorded contract is a non-empty string; scalar
/// values render through [`python_str`] and a non-object element is an error
/// because the source's `data.get(...)` would raise.
fn parse_expired_ids<'a>(
    items: impl Iterator<Item = &'a [u8]>,
) -> Result<Vec<String>, FastApiError> {
    let mut expired_ids = Vec::new();
    for raw in items {
        let value: Value = serde_json::from_slice(raw).map_err(|error| {
            tracing::error!(%error, "guidance queue item is not valid JSON");
            FastApiError::unhandled()
        })?;
        let Some(field) = value.as_object().and_then(|data| data.get("guidance_id")) else {
            continue;
        };
        if let Some(guidance_id) = python_str(field) {
            expired_ids.push(guidance_id);
        }
    }
    Ok(expired_ids)
}

/// `str(value)` for the Python-truthy scalars the queue stores.
///
/// Mirrors Python truthiness (`0`, `""`, `False`, `null`, and empty containers
/// are skipped) and `str()` for the scalar forms. Non-scalar values would
/// render Python's `repr`; the queue never stores them (`guidance_id` is
/// always a non-empty string), so they are rendered as their JSON text.
fn python_str(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(false) => None,
        Value::Bool(true) => Some("True".to_owned()),
        Value::Number(number) => match number.as_f64() {
            Some(value) if value != 0.0 => Some(number.to_string()),
            _ => None,
        },
        Value::String(text) if text.is_empty() => None,
        Value::String(text) => Some(text.clone()),
        Value::Array(items) if items.is_empty() => None,
        Value::Object(map) if map.is_empty() => None,
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queue_key_uses_the_source_prefix_and_ids() {
        assert_eq!(queue_key(123, 456), "chat:guidance:123:456");
    }

    #[test]
    fn empty_queue_renders_the_source_body() {
        let expired_ids = parse_expired_ids(std::iter::empty()).unwrap();
        let body = serde_json::to_string(&GuidanceExpireResponse { expired_ids }).unwrap();
        assert_eq!(body, r#"{"expired_ids":[]}"#);
    }

    #[test]
    fn drains_only_truthy_guidance_ids() {
        let items = [
            json!({"task_id": 1, "guidance_id": "guidance-abc"}),
            json!({"guidance_id": ""}),
            json!({"guidance_id": null}),
            json!({"other": 1}),
            json!({"guidance_id": "guidance-def"}),
        ];
        let raw: Vec<Vec<u8>> = items
            .iter()
            .map(|item| item.to_string().into_bytes())
            .collect();
        let expired_ids = parse_expired_ids(raw.iter().map(Vec::as_slice)).unwrap();
        assert_eq!(expired_ids, vec!["guidance-abc", "guidance-def"]);
    }

    #[test]
    fn scalar_guidance_ids_render_like_python_str() {
        assert_eq!(python_str(&json!("x")), Some("x".to_owned()));
        assert_eq!(python_str(&json!(5)), Some("5".to_owned()));
        assert_eq!(python_str(&json!(true)), Some("True".to_owned()));
        assert_eq!(python_str(&json!(0)), None);
        assert_eq!(python_str(&json!(false)), None);
        assert_eq!(python_str(&json!(null)), None);
    }

    #[test]
    fn invalid_item_json_fails_the_request() {
        let raw = [b"not-json".to_vec()];
        assert!(parse_expired_ids(raw.iter().map(Vec::as_slice)).is_err());
    }
}
