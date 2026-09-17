// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Optional Redis dependencies retained for compatibility with the internal
//! application state. Public readers perform direct SQL and do not interpret
//! internal cache keys.
use brz_redis::Redis;

/// Cache TTL from the cached reader.
#[allow(dead_code)]
pub const CACHE_TTL_SECONDS: u64 = 300;
/// Null marker from the cached reader.
#[allow(dead_code)]
pub const NULL_MARKER: &str = "__NULL__";

/// The two independent cache clients built by the source extension.
pub struct CacheClients<R: Redis> {
    /// the cached reader's Redis client.
    // Migrated from the Python source; not yet wired into the gateway.
    #[allow(dead_code)]
    user_cache: Option<R>,
    /// the cached reader's Redis client.
    kinds_cache: Option<R>,
}

impl<R: Redis> CacheClients<R> {
    pub fn new(user_cache: Option<R>, kinds_cache: Option<R>) -> Self {
        Self {
            user_cache,
            kinds_cache,
        }
    }

    /// Build a disabled client used when Redis is unavailable at startup.
    /// Reads report a miss, mirroring the source
    /// the cached reader fallback.
    pub fn disabled() -> Self {
        Self {
            user_cache: None,
            kinds_cache: None,
        }
    }

    /// The optional client retained by the public kinds reader call shape.
    pub fn kinds_cache(&self) -> Option<&R> {
        self.kinds_cache.as_ref()
    }
}
