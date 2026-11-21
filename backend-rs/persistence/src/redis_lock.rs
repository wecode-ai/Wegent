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
