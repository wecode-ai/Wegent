// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/internal/chat/guidance/{task_id}/{subtask_id}/consume` — pop the
//! next queued Chat Shell guidance item for one subtask.
//!
//! Mirrors `app/api/endpoints/internal/chat_storage.py:consume_guidance` and
//! `app/services/chat/guidance_queue.py:GuidanceQueue.consume` (router prefix
//! `/chat` mounted under `/internal` with API_PREFIX `/api`).
//!
//! Pipeline (the recorded dependency topology):
//! 1. `verify_internal_service_token` (the router-level `Depends`).
//! 2. `LPOP chat:guidance:{task_id}:{subtask_id}`; a missing key yields
//!    `{"item": null}`.
//! 3. A popped value is decoded as a `GuidanceQueueItem`; the source then
//!    emits `chat:guidance_applied` to the `task:{task_id}` room of the `/chat`
//!    Socket.IO namespace and returns `{"item": {...}}`.
use brz_redis::Redis;
use serde::{Deserialize, Serialize};

use crate::chat_guidance::queue_key;
use crate::internal_auth::http_error::HttpError;
use crate::socketio_emit::{SOCKETIO_CHANNEL, emit_message};
use crate::state::AppState;

/// `GuidanceConsumeResponse`: the consumed item, or `null` when the queue is
/// empty. Field order matches the source model.
#[derive(Debug, Serialize)]
pub struct GuidanceConsumeResponse {
    item: Option<GuidanceQueueItem>,
}

/// `GuidanceQueueItem` (`app/services/chat/guidance_queue.py`), whose
/// `to_dict` (`asdict`) preserves this field order.
#[derive(Debug, Deserialize, Serialize)]
struct GuidanceQueueItem {
    #[serde(default)]
    task_id: i64,
    #[serde(default)]
    subtask_id: i64,
    #[serde(default)]
    team_id: i64,
    #[serde(default)]
    user_id: i64,
    #[serde(default)]
    guidance_id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    created_at: String,
}

/// POST /api/internal/chat/guidance/{task_id}/{subtask_id}/consume: the
/// consume free function, injecting the process-lifetime application state.
#[brz_http_server::post("/api/internal/chat/guidance/:task_id/:subtask_id/consume")]
async fn consume_guidance(
    #[inject(state)] state: &AppState,
    task_id: i64,
    subtask_id: i64,
    #[auth] _service: crate::internal_auth::InternalService,
) -> Result<GuidanceConsumeResponse, crate::http_compat::FastApiError> {
    consume_guidance_value(state, task_id, subtask_id)
        .await
        .map_err(crate::http_compat::FastApiError::from)
}

/// Handler body exposed to tests; verifies the router-level internal-service
/// token dependency first.
pub async fn consume_guidance_value(
    state: &AppState,
    task_id: i64,
    subtask_id: i64,
) -> Result<GuidanceConsumeResponse, HttpError> {
    let key = queue_key(task_id, subtask_id);
    let Some(redis) = state.redis.as_ref() else {
        // The source always has a `cache_manager` client; a missing client is
        // an unexpected failure, so it surfaces as the unhandled 500 body.
        tracing::error!(task_id, subtask_id, "guidance consume without Redis");
        return Err(HttpError::internal_unhandled());
    };

    let raw = redis
        .lpop::<_, brz_redis::RedisBytes>(key.as_str())
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, subtask_id, "guidance consume LPOP failed");
            HttpError::internal_unhandled()
        })?;
    let Some(raw) = raw else {
        return Ok(GuidanceConsumeResponse { item: None });
    };

    let item: GuidanceQueueItem = serde_json::from_slice(raw.as_ref()).map_err(|error| {
        tracing::error!(%error, task_id, subtask_id, "guidance item decode failed");
        HttpError::internal_unhandled()
    })?;

    emit_guidance_applied(redis, task_id, subtask_id, &item.guidance_id).await?;

    Ok(GuidanceConsumeResponse { item: Some(item) })
}

/// `WebPageSocketEmitter.emit_guidance_applied`: publish the `chat:guidance_applied`
/// event to the `task:{task_id}` room of the `/chat` namespace.
async fn emit_guidance_applied(
    redis: &brz_redis::RedisService,
    task_id: i64,
    subtask_id: i64,
    guidance_id: &str,
) -> Result<(), HttpError> {
    let applied_at = local_isoformat();
    let data = format!(
        "[{{\"task_id\": {task_id}, \"subtask_id\": {subtask_id}, \
         \"guidance_id\": {}, \"applied_at\": {}}}]",
        json_string(guidance_id),
        json_string(&applied_at),
    );
    let room = format!("task:{task_id}");
    let message = emit_message("chat:guidance_applied", &data, "/chat", &room);
    redis
        .publish(SOCKETIO_CHANNEL, message)
        .await
        .map_err(|error| {
            tracing::error!(%error, task_id, subtask_id, "guidance applied publish failed");
            HttpError::internal_unhandled()
        })?;
    Ok(())
}

/// `json.dumps(<str>)` for one scalar: a quoted, escaped JSON string.
fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

/// `datetime.now().isoformat()`: local naive time, microseconds omitted when
/// zero.
fn local_isoformat() -> String {
    let now = chrono::Local::now();
    let base = now.format("%Y-%m-%dT%H:%M:%S").to_string();
    let micros = now.timestamp_subsec_micros();
    if micros == 0 {
        base
    } else {
        format!("{base}.{micros:06}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_queue_renders_a_null_item() {
        let body = serde_json::to_string(&GuidanceConsumeResponse { item: None }).unwrap();
        assert_eq!(body, r#"{"item":null}"#);
    }

    #[test]
    fn queue_key_matches_the_source_template() {
        assert_eq!(
            queue_key(530789238460493, 530789238460540),
            "chat:guidance:530789238460493:530789238460540"
        );
    }

    #[test]
    fn popped_item_preserves_the_source_field_order() {
        let item: GuidanceQueueItem = serde_json::from_str(
            r#"{"task_id":1,"subtask_id":2,"team_id":3,"user_id":4,"guidance_id":"g","message":"m","created_at":"t"}"#,
        )
        .unwrap();
        let body = serde_json::to_string(&GuidanceConsumeResponse { item: Some(item) }).unwrap();
        assert_eq!(
            body,
            r#"{"item":{"task_id":1,"subtask_id":2,"team_id":3,"user_id":4,"guidance_id":"g","message":"m","created_at":"t"}}"#
        );
    }

    #[test]
    fn popped_item_defaults_missing_fields_like_from_dict() {
        let item: GuidanceQueueItem = serde_json::from_str("{}").unwrap();
        let body = serde_json::to_string(&GuidanceConsumeResponse { item: Some(item) }).unwrap();
        assert_eq!(
            body,
            r#"{"item":{"task_id":0,"subtask_id":0,"team_id":0,"user_id":0,"guidance_id":"","message":"","created_at":""}}"#
        );
    }

    #[test]
    fn guidance_applied_message_matches_the_socketio_emit_shape() {
        let data = format!(
            "[{{\"task_id\": 1, \"subtask_id\": 2, \"guidance_id\": {}, \"applied_at\": {}}}]",
            json_string("guidance-abc"),
            json_string("2026-10-10T06:00:13.839153"),
        );
        let message = emit_message("chat:guidance_applied", &data, "/chat", "task:1");
        let prefix = "{\"method\": \"emit\", \"event\": \"chat:guidance_applied\", \
             \"data\": [{\"task_id\": 1, \"subtask_id\": 2, \"guidance_id\": \"guidance-abc\", \
             \"applied_at\": \"2026-10-10T06:00:13.839153\"}], \"binary\": false, \
             \"namespace\": \"/chat\", \"room\": \"task:1\", \"skip_sid\": null, \
             \"callback\": null, \"host_id\": \"";
        assert!(message.starts_with(prefix), "{message}");
    }

    #[test]
    fn json_string_escapes_like_json_dumps() {
        assert_eq!(json_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(json_string("plain"), "\"plain\"");
    }

    #[test]
    fn local_isoformat_omits_zero_microseconds() {
        // The formatter never emits a trailing ".000000".
        let value = local_isoformat();
        assert!(!value.ends_with(".000000"), "{value}");
        assert!(value.contains('T'), "{value}");
    }
}
