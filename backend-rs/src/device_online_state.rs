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

use crate::http_compat::FastApiError;
use crate::state::AppState;

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
pub(crate) async fn read_online_state<T: DeserializeOwned>(
    state: &AppState,
    user_id: i64,
    device_id: &str,
) -> Result<Option<T>, FastApiError> {
    let Some(redis) = state.redis.as_ref() else {
        tracing::error!("device online state unavailable: no Redis service");
        return Err(FastApiError::unhandled());
    };
    let Some(bytes) = read_online_bytes(redis, user_id, device_id)
        .await
        .map_err(|()| FastApiError::unhandled())?
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

/// The strict read against one explicit client, for callers that must tell a
/// cache miss (`Ok(None)`) from a transport or decode failure (`Err`).
///
/// Used by the `on_disconnect` boundary, whose source equivalent is
/// `cache_manager.get_or_raise`; the soft `cache_manager.get` helpers keep
/// degrading failures to "offline" elsewhere.
pub(crate) async fn read_online_state_with<R: Redis + ?Sized>(
    redis: &R,
    user_id: i64,
    device_id: &str,
) -> Result<Option<serde_json::Value>, ()> {
    let Some(bytes) = read_online_bytes(redis, user_id, device_id).await? else {
        return Ok(None);
    };
    serde_json::from_slice(bytes.as_slice())
        .map(Some)
        .map_err(|error| {
            tracing::error!(%error, "device online state decode failure");
        })
}

/// One strict `GET`: missing and empty are `None`; client, transport, and
/// undecodable-bytes failures are `Err(())`.
async fn read_online_bytes<R: Redis + ?Sized>(
    redis: &R,
    user_id: i64,
    device_id: &str,
) -> Result<Option<Vec<u8>>, ()> {
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
            Err(())
        }
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
