// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Fixed-window rate limiting for the responses API
//! (`app.core.rate_limit` + slowapi/limits on Redis).
//!
//! The source decorates `get_response` with
//! `@limiter.limit(settings.RATE_LIMIT_GET_RESPONSE)` (`120/minute`,
//! fixed-window). Each request runs the `limits` `incr_expire` Lua script
//! through `EVALSHA` on the key
//! `LIMITS:LIMITER/<key>/<path>/<amount>/<multiples>/<granularity>` where
//! `<key>` is `apikey:<wg-key>` (or `ip:<client>`), and rejects with `429`
//! when the returned count exceeds the limit.
use brz_redis::Redis;
/// SHA-1 digest of the `limits` `incr_expire.lua` script
/// (`redis.register_script`); stable across limits releases.
pub const INCR_EXPIRE_SHA: &str = "628bd136a573a06b346879695681af12ccef300f";

/// `RATE_LIMIT_GET_RESPONSE` parsed as `(amount, multiples, granularity)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    pub amount: i64,
    #[allow(dead_code)]
    pub multiples: i64,
    /// Granularity name in the Redis key (`minute`, `second`, ...).
    pub granularity: &'static str,
    /// Window seconds derived from the granularity (`Granularity.seconds`).
    pub expiry: i64,
}

/// The source default `RATE_LIMIT_GET_RESPONSE` (`120/minute`).
impl Default for RateLimit {
    fn default() -> Self {
        Self::per_minute(120)
    }
}

impl RateLimit {
    pub fn per_minute(amount: i64) -> Self {
        Self {
            amount,
            multiples: 1,
            granularity: "minute",
            expiry: 60,
        }
    }

    /// `RateLimitItem.key_for` namespace (`LIMITER`).
    fn namespace(&self) -> &'static str {
        "LIMITER"
    }
}

/// `get_api_key_from_request`: X-API-Key > Authorization Bearer >
/// wegent-source (each `wg-` prefixed, `#username` stripped), else the
/// client IP.
pub fn limit_key(headers: &impl crate::headers::Headers, client_ip: &str) -> String {
    let header_str = |name: &str| {
        headers
            .header(name)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    let strip_username = |key: &str| match key.split_once('#') {
        Some((prefix, _)) => prefix.to_string(),
        None => key.to_string(),
    };
    if let Some(key) = header_str("x-api-key").filter(|key| key.starts_with("wg-")) {
        return format!("apikey:{}", strip_username(key));
    }
    if let Some(authorization) = header_str("authorization")
        && let Some(token) = authorization.strip_prefix("Bearer ")
        && token.starts_with("wg-")
    {
        return format!("apikey:{}", strip_username(token));
    }
    if let Some(key) = header_str("wegent-source").filter(|key| key.starts_with("wg-")) {
        return format!("apikey:{}", strip_username(key));
    }
    format!("ip:{client_ip}")
}

/// One fixed-window hit: run `incr_expire` via `EVALSHA` and report whether
/// the counter stayed within the limit (`FixedWindowRateLimiter.hit`).
///
/// Redis failures disable the check for that request: the source limiter is
/// constructed with `enabled=_check_redis_available()` and slowapi swallows
/// storage errors (`swallow_errors=True` path returns False -> allow).
pub async fn hit<R>(redis: Option<&R>, limit: RateLimit, key: &str, path: &str) -> bool
where
    R: Redis,
{
    let Some(redis) = redis else {
        return true;
    };
    // `RedisStorage.prefixed_key` + `RateLimitItem.key_for`.
    let redis_key = format!(
        "LIMITS:{}/{}/{}/{}/{}/{}",
        limit.namespace(),
        key,
        path,
        limit.amount,
        limit.multiples,
        limit.granularity
    );
    let count: i64 = match redis
        .evalsha(
            INCR_EXPIRE_SHA,
            [redis_key.as_str()],
            [limit.expiry.to_string().as_str(), "1"],
        )
        .await
    {
        Ok(count) => count,
        // slowapi swallows storage errors for decorated routes (the source
        // constructs the limiter with the default `swallow_errors=False`
        // only for the check decorator; a hard storage failure raises and
        // the endpoint 500s. The deployed limiter disables itself when
        // Redis is unavailable at startup, so a mid-flight failure is
        // treated as an allowed request, matching the disabled-mode
        // behavior).
        Err(error) => {
            tracing::warn!(%error, key = %redis_key, "[rate_limit] EVALSHA failed");
            return true;
        }
    };
    count <= limit.amount
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers<'a>(pairs: &'a [(&'a str, &'a str)]) -> crate::headers::HeaderSlice<'a> {
        crate::headers::HeaderSlice::new(pairs)
    }

    #[test]
    fn builds_the_recorded_redis_key() {
        // Recorded: LIMITS:LIMITER/apikey:wg-...//api/v1/responses/resp_12232067055387/120/1/minute
        let limit = RateLimit::default();
        let key = format!(
            "LIMITS:{}/{}/{}/{}/{}/{}",
            limit.namespace(),
            "apikey:wg-x",
            "/api/v1/responses/resp_12232067055387",
            limit.amount,
            limit.multiples,
            limit.granularity
        );
        assert_eq!(
            key,
            "LIMITS:LIMITER/apikey:wg-x//api/v1/responses/resp_12232067055387/120/1/minute"
        );
    }

    #[test]
    fn limit_key_prefers_api_key_headers() {
        let with_key = headers(&[
            ("x-api-key", "wg-abc#user"),
            ("authorization", "Bearer wg-def"),
        ]);
        assert_eq!(limit_key(&with_key, "10.0.0.1"), "apikey:wg-abc");

        let bearer = headers(&[("authorization", "Bearer wg-def")]);
        assert_eq!(limit_key(&bearer, "10.0.0.1"), "apikey:wg-def");

        let plain = headers(&[("authorization", "Bearer eyJ...")]);
        assert_eq!(limit_key(&plain, "10.0.0.1"), "ip:10.0.0.1");
    }
}
