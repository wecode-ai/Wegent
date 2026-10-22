// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `session_manager` streaming Redis state shared by the responses cancel and
//! delete flows (`app/services/chat/storage/session.py`).
//!
//! `cancel_stream` sets the cross-worker cancellation flag, `unregister_stream`
//! clears it again, `delete_streaming_content` drops the accumulated partial
//! content, and `streaming_content` reads it back. Each helper mirrors the
//! source's `except Exception` swallow: a Redis failure is logged and treated
//! as absent.
use brz_redis::{Redis, RedisKey2};

/// `session_manager.CANCEL_KEY_PREFIX`.
const CANCEL_KEY_PREFIX: &str = "chat:cancel:";
/// `session_manager.STREAMING_KEY_PREFIX`.
const STREAMING_KEY_PREFIX: &str = "chat:streaming:";
/// `session_manager.CANCEL_FLAG_TTL` (seconds).
const CANCEL_FLAG_TTL: u64 = 300;

/// `session_manager.cancel_stream`: `SET chat:cancel:{subtask_id} true EX 300`.
pub async fn cancel_stream<R>(redis: Option<&R>, subtask_id: i64)
where
    R: Redis,
{
    let Some(redis) = redis else {
        return;
    };
    let key = RedisKey2(CANCEL_KEY_PREFIX, subtask_id);
    let options = brz_redis::SetOptions::default()
        .with_expiration(brz_redis::SetExpiration::Seconds(CANCEL_FLAG_TTL));
    if let Err(error) = redis.set_with(key, "true", options).await {
        tracing::error!(%error, subtask_id, "failed to set Redis cancel flag");
    }
}

/// `session_manager.delete_streaming_content`: `DEL chat:streaming:{id}`.
pub async fn delete_streaming_content<R>(redis: Option<&R>, subtask_id: i64)
where
    R: Redis,
{
    let Some(redis) = redis else {
        return;
    };
    let key = RedisKey2(STREAMING_KEY_PREFIX, subtask_id);
    if let Err(error) = redis.del(key).await {
        tracing::error!(%error, subtask_id, "failed to delete streaming content");
    }
}

/// `session_manager.unregister_stream`: drop the local event and `DEL
/// chat:cancel:{id}`.
pub async fn unregister_stream<R>(redis: Option<&R>, subtask_id: i64)
where
    R: Redis,
{
    let Some(redis) = redis else {
        return;
    };
    let key = RedisKey2(CANCEL_KEY_PREFIX, subtask_id);
    if let Err(error) = redis.del(key).await {
        tracing::warn!(%error, subtask_id, "failed to delete Redis cancel flag");
    }
}

/// `session_manager.get_streaming_content`: the raw string accumulated under
/// `chat:streaming:{subtask_id}`, or `None` on a miss or Redis error (the
/// source swallows the exception).
pub async fn streaming_content<R>(redis: Option<&R>, subtask_id: i64) -> Option<String>
where
    R: Redis,
{
    let redis = redis?;
    let key = RedisKey2(STREAMING_KEY_PREFIX, subtask_id);
    let content: Option<Vec<u8>> = match redis.get(key).await {
        Ok(content) => content,
        Err(error) => {
            tracing::error!(%error, subtask_id, "error getting streaming content");
            None
        }
    };
    content.map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}
