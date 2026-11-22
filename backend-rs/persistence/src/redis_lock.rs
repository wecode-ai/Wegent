// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Owner-checked release for source-compatible Redis leases.

/// `redis/lock.py` (`LUA_RELEASE_SCRIPT`); the recorded witness runs
/// `EVALSHA c3f8721cbb97f72bc19e972846bd7aaf91901658 1 <key> <token>`.
/// Shared with the DingTalk writer lease so both releases send the same
/// canonical bytes and digest.
pub const RELEASE_SCRIPT: &str = "\n        local token = redis.call('get', KEYS[1])\n        if not token or token ~= ARGV[1] then\n            return 0\n        end\n        redis.call('del', KEYS[1])\n        return 1\n    ";
/// `sha1(RELEASE_SCRIPT)`.
pub const RELEASE_SHA: &str = "c3f8721cbb97f72bc19e972846bd7aaf91901658";

/// The lock's owner token: 32 lowercase hex characters, like the
/// `uuid.uuid1().hex` redis-py stores, so only the acquirer can release the
/// key. The value is a per-acquisition random draw; nothing downstream reads
/// it.
pub fn lock_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

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
