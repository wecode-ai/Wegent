// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Redis distributed lock used by the device claim.
//!
//! Mirrors `app.core.distributed_lock.DistributedLock`: `SET key 1 EX <ttl> NX`
//! acquires, `DEL key` releases, and a Redis failure fails open so a degraded
//! deployment keeps serving the single-instance claim path.
use brz_redis::{Redis, RedisService, SetExpiration, SetOptions};

/// `LOCK_KEY_PREFIX`.
const LOCK_KEY_PREFIX: &str = "wegent:lock:";

/// The Redis key of one named lock (`DistributedLock.acquire`/`release`).
pub(crate) fn lock_key(lock_name: &str) -> String {
    format!("{LOCK_KEY_PREFIX}{lock_name}")
}

/// `DistributedLock.acquire`: `True` only when the `NX` write performed.
pub(crate) async fn acquire(
    redis: Option<&RedisService>,
    lock_name: &str,
    ttl_seconds: u64,
) -> bool {
    let Some(redis) = redis else {
        return true;
    };
    let options = SetOptions::default()
        .with_expiration(SetExpiration::Seconds(ttl_seconds))
        .if_absent();
    match redis.set_with(lock_key(lock_name), "1", options).await {
        Ok(acquired) => acquired,
        Err(error) => {
            tracing::error!(%error, lock_name, "distributed lock acquire failed");
            true
        }
    }
}

/// `DistributedLock.release`: `DELETE` the lock key.
pub(crate) async fn release(redis: Option<&RedisService>, lock_name: &str) -> bool {
    let Some(redis) = redis else {
        return true;
    };
    match redis.del(lock_key(lock_name)).await {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, lock_name, "distributed lock release failed");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_keys_use_the_source_prefix() {
        assert_eq!(
            lock_key("robot_exec_owner:157"),
            "wegent:lock:robot_exec_owner:157"
        );
        assert_eq!(
            lock_key("robot_exec:157:runtime:runtime-a5cfdcea95b0020028430374"),
            "wegent:lock:robot_exec:157:runtime:runtime-a5cfdcea95b0020028430374"
        );
    }
}
