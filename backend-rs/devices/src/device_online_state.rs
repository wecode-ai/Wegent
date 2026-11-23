// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Device online-state Redis reads shared by the migrated device endpoints.
//!
//! `LocalDeviceProvider.generate_online_key` and `_get_online_info` define the
//! key layout and the strict read (`cache_manager.get_or_raise`) that every
//! device endpoint uses before dispatching work to a device socket. The
//! listing projection degrades a failed read to "offline"
//! (`cache_manager.get`), so those callers keep their own tolerant read.

use brz_redis::{Redis, RedisBytes};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::http_compat::FastApiError;

/// `DEVICE_ONLINE_KEY_PREFIX`.
const DEVICE_ONLINE_KEY_PREFIX: &str = "device:online:";

/// Redis online-state key (`LocalDeviceProvider.generate_online_key`; the
/// deployment's cloud device provider uses the same layout).
///
/// Re-exported from [`crate::devices`], the device domain module applications
/// use.
pub fn online_key(user_id: i64, device_id: &str) -> String {
    format!("{DEVICE_ONLINE_KEY_PREFIX}{user_id}:{device_id}")
}

/// Source `cache_manager.get_or_raise`: one `GET device:online:<user_id>:<device_id>`
/// decoded as JSON. Missing and empty values are `None`; a connection failure
/// or an undecodable non-empty payload raises in the source, so the endpoint
/// renders it as an unhandled 500 instead of an offline device.
pub async fn read_online_state<T: DeserializeOwned>(
    redis: Option<&brz_redis::RedisService>,
    user_id: i64,
    device_id: &str,
) -> Result<Option<T>, FastApiError> {
    let Some(redis) = redis else {
        tracing::error!("device online state unavailable: no Redis service");
        return Err(FastApiError::unhandled());
    };
    let Some(bytes) = read_online_bytes(redis, user_id, device_id)
        .await
        .map_err(|_| FastApiError::unhandled())?
    else {
        return Ok(None);
    };
    serde_json::from_slice(bytes.as_slice())
        .map(Some)
        .map_err(|error| {
            tracing::error!(%error, "device online state decode failure");
            FastApiError::unhandled()
        })
}

#[derive(Debug)]
pub struct OnlineStateReadError;

/// The strict read against one explicit client, for callers that must tell a
/// cache miss (`Ok(None)`) from a transport or decode failure (`Err`).
///
/// Used by the `on_disconnect` boundary, whose source equivalent is
/// `cache_manager.get_or_raise`; the soft `cache_manager.get` helpers keep
/// degrading failures to "offline" elsewhere.
pub async fn read_online_state_with<R: Redis + ?Sized>(
    redis: &R,
    user_id: i64,
    device_id: &str,
) -> Result<Option<Value>, OnlineStateReadError> {
    let Some(bytes) = read_online_bytes(redis, user_id, device_id).await? else {
        return Ok(None);
    };
    serde_json::from_slice(bytes.as_slice())
        .map(Some)
        .map_err(|error| {
            tracing::error!(%error, "device online state decode failure");
            OnlineStateReadError
        })
}

const REPLACE_UNCHANGED_SCRIPT: &str = "
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1";

/// Apply an update only while the online document belongs to this socket.
pub async fn update_online_state(
    redis: Option<&brz_redis::RedisService>,
    user_id: i64,
    route_id: &str,
    socket_id: &str,
    ttl: u64,
    update: impl Fn(&mut Map<String, Value>),
) -> bool {
    let Some(redis) = redis else {
        return false;
    };
    let key = online_key(user_id, route_id);
    let ttl = ttl.to_string();
    for _ in 0..3 {
        let Ok(Some(raw)) = read_online_bytes(redis, user_id, route_id).await else {
            return false;
        };
        let Ok(Value::Object(mut document)) = serde_json::from_slice(&raw) else {
            return false;
        };
        if document.get("socket_id").and_then(Value::as_str) != Some(socket_id) {
            return false;
        }
        update(&mut document);
        let value = Value::Object(document).to_string();
        let result: Result<i64, _> = redis
            .eval(
                REPLACE_UNCHANGED_SCRIPT,
                [key.as_str()],
                [raw.as_slice(), value.as_bytes(), ttl.as_bytes()],
            )
            .await;
        match result {
            Ok(1) => return true,
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(%error, user_id, route_id, "device online state update failed");
                return false;
            }
        }
    }
    false
}

/// Read the raw bytes, with missing and empty values represented by `None`.
async fn read_online_bytes<R: Redis + ?Sized>(
    redis: &R,
    user_id: i64,
    device_id: &str,
) -> Result<Option<Vec<u8>>, OnlineStateReadError> {
    match redis
        .get::<_, RedisBytes>(online_key(user_id, device_id))
        .await
    {
        Ok(None) => Ok(None),
        // `cache_manager._decode` keeps a non-JSON payload as raw bytes, which
        // the source then indexes as a dict and raises on. An empty value is
        // falsy, so it behaves like a missing key.
        Ok(Some(bytes)) if bytes.as_ref().is_empty() => Ok(None),
        Ok(Some(bytes)) => Ok(Some(bytes.as_ref().to_vec())),
        Err(error) => {
            tracing::error!(%error, "device online state read failure");
            Err(OnlineStateReadError)
        }
    }
}

/// Source `cache_manager.get`: read one key and decode its orjson payload;
/// errors and missing keys degrade to `None`.
///
/// Deployments whose provider modules read the same online-state or version
/// keys share this helper instead of constructing their own client.
pub async fn cache_manager_get<T: DeserializeOwned>(
    redis: Option<&brz_redis::RedisService>,
    key: &str,
) -> Option<T> {
    redis?
        .get::<_, brz_redis::RedisBytes>(key)
        .await
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice(bytes.as_ref()).ok())
}

/// Source `cache_manager.mget`: read a batch of keys over the shared pooled
/// connection; errors degrade to an all-missing map, which yields offline
/// devices exactly like the source's error swallow.
pub async fn cache_manager_mget<T: DeserializeOwned>(
    redis: Option<&brz_redis::RedisService>,
    keys: Vec<String>,
) -> Vec<Option<T>> {
    let Some(redis) = redis else {
        return keys.iter().map(|_| None).collect();
    };
    match redis.mget::<_, brz_redis::RedisBytes>(keys.clone()).await {
        Ok(values) => values
            .into_iter()
            .map(|bytes| bytes.and_then(|bytes| serde_json::from_slice(bytes.as_ref()).ok()))
            .collect(),
        Err(_) => keys.iter().map(|_| None).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_layout_matches_the_source_provider() {
        assert_eq!(
            online_key(86, "app-record-1"),
            "device:online:86:app-record-1"
        );
        assert_eq!(online_key(-1, ""), "device:online:-1:");
    }
}
