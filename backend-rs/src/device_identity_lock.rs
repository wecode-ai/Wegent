// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The owned-device identity lock shared by device registration and removal.
//!
//! Source: `app/services/device/record_operations.py::device_identity_lock`:
//!
//! ```python
//! async with client.lock(
//!     f"device:identity-lock:{user_id}", timeout=30, blocking_timeout=10
//! ):
//!     async with asyncio.timeout(20):
//!         yield client
//! ```
//!
//! redis-py's asyncio `Lock` acquires with `SET key token NX PX 30000`, retries
//! every 100 ms until the 10 s blocking budget expires, and releases through
//! the `LUA_RELEASE_SCRIPT` `EVALSHA`, which returns `1` only while this token
//! still owns the key. `on_device_register` wraps registrations in this
//! lock so deletion cannot race the database-to-online transition; the record
//! delete endpoint holds it across its transaction too.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use brz_redis::{ErrorKind, Redis, RedisError, SetExpiration, SetOptions};

use crate::plugins_installed::write_coordination::{RELEASE_SCRIPT, RELEASE_SHA};

/// `Lock(timeout=30)`: the lock key's TTL.
const IDENTITY_LOCK_TIMEOUT_MS: u64 = 30_000;
/// Bound the work under the lock before the Redis lease can expire.
pub(crate) const IDENTITY_LOCK_BODY_TIMEOUT: Duration = Duration::from_secs(20);

/// `Lock(blocking_timeout=10)`: how long acquisition keeps retrying.
const IDENTITY_LOCK_BLOCKING_TIMEOUT: Duration = Duration::from_secs(10);

/// redis-py `Lock.sleep`: the pause between acquisition attempts.
const IDENTITY_LOCK_RETRY_INTERVAL: Duration = Duration::from_millis(100);

/// The Redis lock shared by registration and removal.
///
/// redis-py's `Lock` releases only when the stored value still equals its
/// token, so an expired or stolen lock is never released by its former owner.
pub(crate) struct IdentityLock<'a, R: Redis> {
    redis: &'a R,
    key: String,
    token: String,
}

impl<'a, R: Redis> IdentityLock<'a, R> {
    /// `Lock.acquire`: retry every 100 ms until the 10 s blocking budget
    /// expires. `Ok(None)` is redis-py's `LockError`; `Err` is the propagated
    /// request failure the callers map to their unavailable branch.
    pub(crate) async fn acquire(redis: &'a R, user_id: i64) -> Result<Option<Self>, RedisError> {
        let key = identity_lock_key(user_id);
        let token = lock_token();
        let options = SetOptions::default()
            .with_expiration(SetExpiration::Milliseconds(IDENTITY_LOCK_TIMEOUT_MS))
            .if_absent();
        let deadline = tokio::time::Instant::now() + IDENTITY_LOCK_BLOCKING_TIMEOUT;
        loop {
            if redis
                .set_with(key.as_str(), token.as_str(), options)
                .await?
            {
                return Ok(Some(Self { redis, key, token }));
            }
            if tokio::time::Instant::now() + IDENTITY_LOCK_RETRY_INTERVAL > deadline {
                return Ok(None);
            }
            tokio::time::sleep(IDENTITY_LOCK_RETRY_INTERVAL).await;
        }
    }

    /// `Lock.release`: `EVALSHA` of the redis-py release script, which returns
    /// `1` only when this token still owns the key.
    pub(crate) async fn release(&self) -> Result<(), RedisError> {
        let result = self
            .redis
            .evalsha::<_, _, _, i64>(RELEASE_SHA, [self.key.as_str()], [self.token.as_str()])
            .await;
        let released = match result {
            Err(error) if error.kind() == ErrorKind::NoScript => {
                self.redis
                    .eval(RELEASE_SCRIPT, [self.key.as_str()], [self.token.as_str()])
                    .await?
            }
            result => result?,
        };
        release_outcome(released)
    }
}

/// The lock key: `device:identity-lock:{user_id}`.
pub(crate) fn identity_lock_key(user_id: i64) -> String {
    format!("device:identity-lock:{user_id}")
}

/// The lock's owner token: 32 lowercase hex characters, like the
/// `uuid.uuid1().hex` redis-py stores, so only the acquirer can release the
/// key. The value is a per-acquisition random draw; nothing downstream reads
/// it.
pub(crate) fn lock_token() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos() as u64)
        .unwrap_or(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut token = String::with_capacity(32);
    for half in 0..2u64 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(nanos);
        hasher.write_u64(sequence);
        hasher.write_u64(half);
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

/// redis-py raises `LockNotOwnedError` (`RedisError`) when the release script
/// reports that another token now owns the key.
fn release_outcome(released: i64) -> Result<(), RedisError> {
    if released == 1 {
        Ok(())
    } else {
        Err(RedisError::new(
            ErrorKind::ResponseError,
            "Cannot release a lock that's no longer owned",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use brz_redis::{
        EncodeRedisArg, EncodeRedisArgs, FromRedisBulk, FromRedisValue, RedisResult, RedisValues,
    };

    #[test]
    fn identity_lock_key_matches_the_source_prefix() {
        assert_eq!(identity_lock_key(157), "device:identity-lock:157");
    }

    #[test]
    fn lock_tokens_are_unique_hex_of_the_redis_py_length() {
        let first = lock_token();
        let second = lock_token();
        assert_eq!(first.len(), 32);
        assert!(first.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn the_release_script_result_decides_ownership() {
        assert!(release_outcome(1).is_ok());
        assert!(release_outcome(0).is_err());
    }

    /// Simulate a Redis server whose script cache is empty.
    struct LockRedis {
        acquired: bool,
    }

    impl Redis for LockRedis {
        async fn get<K, R>(&self, _key: K) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            panic!("the identity lock never reads")
        }

        async fn set<K, V>(&self, _key: K, _value: V) -> RedisResult<()>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            panic!("the identity lock uses SET ... NX")
        }

        async fn set_with<K, V>(
            &self,
            _key: K,
            _value: V,
            _options: SetOptions,
        ) -> RedisResult<bool>
        where
            K: EncodeRedisArg + Send,
            V: EncodeRedisArg + Send,
        {
            Ok(self.acquired)
        }

        async fn evalsha<D, K, A, R>(&self, _digest: D, _keys: K, _arguments: A) -> RedisResult<R>
        where
            D: EncodeRedisArg + Send,
            K: EncodeRedisArgs + Send,
            A: EncodeRedisArgs + Send,
            R: FromRedisValue + Send,
        {
            Err(RedisError::new(
                ErrorKind::NoScript,
                "script cache is empty",
            ))
        }

        async fn eval<S, K, A, R>(&self, _script: S, _keys: K, _arguments: A) -> RedisResult<R>
        where
            S: EncodeRedisArg + Send,
            K: EncodeRedisArgs + Send,
            A: EncodeRedisArgs + Send,
            R: FromRedisValue + Send,
        {
            R::from_redis_value(&brz_redis::Value::Int(1))
        }

        async fn mget<K, R>(&self, _keys: K) -> RedisResult<Vec<Option<R>>>
        where
            K: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Ok(Vec::new())
        }

        async fn del_many<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn pfcount<K>(&self, _keys: K) -> RedisResult<i64>
        where
            K: EncodeRedisArgs + Send,
        {
            Ok(0)
        }

        async fn hget<K, F, R>(&self, _key: K, _field: F) -> RedisResult<Option<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArg + Send,
            R: FromRedisBulk + Send,
        {
            Ok(None)
        }

        async fn hmget<K, F, R>(&self, _key: K, _fields: F) -> RedisResult<RedisValues<R>>
        where
            K: EncodeRedisArg + Send,
            F: EncodeRedisArgs + Send,
            R: FromRedisBulk + Send,
        {
            Err(brz_redis::RedisError::new(
                brz_redis::ErrorKind::ClientError,
                "stub does not serve HMGET",
            ))
        }
    }

    #[tokio::test]
    async fn a_free_lock_is_acquired_and_released_with_an_empty_script_cache() {
        let redis = LockRedis { acquired: true };
        let lock = IdentityLock::acquire(&redis, 9)
            .await
            .expect("no request failure")
            .expect("the lock is free");
        assert_eq!(lock.key, identity_lock_key(9));
        assert_eq!(lock.token.len(), 32);
        lock.release().await.expect("release the owned lock");
    }

    #[tokio::test(start_paused = true)]
    async fn a_held_lock_expires_the_blocking_budget() {
        // redis-py retries every 100 ms until `blocking_timeout=10` elapses,
        // then raises `LockError` (the source's unavailable branch).
        let redis = LockRedis { acquired: false };
        assert!(
            IdentityLock::acquire(&redis, 9)
                .await
                .expect("no request failure")
                .is_none()
        );
    }
}
