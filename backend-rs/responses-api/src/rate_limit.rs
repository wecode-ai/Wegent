// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Fixed-window rate limiting for the responses API
//! (`app.core.rate_limit` + slowapi/limits on Redis).
//!
//! The source decorates `get_response` with
//! `@limiter.limit(settings.RATE_LIMIT_GET_RESPONSE)`: the window comes from the
//! `RATE_LIMIT_GET_RESPONSE` environment setting (`app.core.config.Settings`,
//! default `120/minute`, fixed-window). Each request runs the `limits`
//! `incr_expire` Lua script through `EVALSHA` on the key
//! `LIMITS:LIMITER/<key>/<path>/<amount>/<multiples>/<granularity>` where
//! `<key>` is `apikey:<wg-key>` (or `ip:<client>`), and rejects with `429`
//! when the returned count exceeds the limit.
use brz_redis::Redis;

use crate::config::env_or_dotenv;

/// SHA-1 digest of the `limits` `incr_expire.lua` script
/// (`redis.register_script`); stable across limits releases.
pub const INCR_EXPIRE_SHA: &str = "628bd136a573a06b346879695681af12ccef300f";

/// `RATE_LIMIT_CREATE_RESPONSE` (`app/core/config.py:338`).
pub const CREATE_RESPONSE_LIMIT_ENV: &str = "RATE_LIMIT_CREATE_RESPONSE";

/// Source setting holding the `GET /api/v1/responses/{response_id}` window
/// (`app.core.config.Settings.RATE_LIMIT_GET_RESPONSE`).
pub const GET_RESPONSE_LIMIT_ENV: &str = "RATE_LIMIT_GET_RESPONSE";

/// Source setting holding the `DELETE /api/v1/responses/{response_id}` window
/// (`app.core.config.Settings.RATE_LIMIT_DELETE_RESPONSE`).
pub const DELETE_RESPONSE_LIMIT_ENV: &str = "RATE_LIMIT_DELETE_RESPONSE";

/// `RATE_LIMIT_GET_RESPONSE` parsed as `(amount, multiples, granularity)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RateLimit {
    pub amount: i64,
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

    /// The `GET /api/v1/responses/{response_id}` fixed window for this process:
    /// `settings.RATE_LIMIT_GET_RESPONSE` (`RATE_LIMIT_GET_RESPONSE`), falling
    /// back to the source default (`120/minute`) when it is absent or malformed.
    #[must_use]
    pub fn get_response() -> Self {
        env_or_dotenv(GET_RESPONSE_LIMIT_ENV)
            .and_then(|value| Self::parse(&value))
            .unwrap_or_default()
    }

    /// Parses a `limits` rate string: `<amount>/<granularity>` or
    /// `<amount>/<multiples>/<granularity>` (e.g. `120/minute`). Returns `None`
    /// for a malformed value so the caller keeps the source default.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        let mut fields = value.split('/');
        let amount = fields.next()?;
        let second = fields.next()?;
        let third = fields.next();
        if fields.next().is_some() {
            return None;
        }
        let (multiples, granularity) = match third {
            Some(granularity) => (second.trim().parse().ok()?, granularity),
            None => (1, second),
        };
        let amount: i64 = amount.trim().parse().ok()?;
        let (granularity, expiry) = granularity_seconds(granularity.trim())?;
        if amount <= 0 || multiples <= 0 {
            return None;
        }
        Some(Self {
            amount,
            multiples,
            granularity,
            expiry,
        })
    }

    /// `settings.RATE_LIMIT_CREATE_RESPONSE` (`app/core/config.py:338`,
    /// `60/minute`): read from the environment so a deployment's configured
    /// window reaches the limiter key.
    pub fn create_response() -> Self {
        crate::config::env_or_dotenv(CREATE_RESPONSE_LIMIT_ENV)
            .and_then(|value| Self::parse(&value))
            .unwrap_or_else(|| Self::per_minute(60))
    }

    /// `@limiter.limit(settings.RATE_LIMIT_CANCEL_RESPONSE)` on
    /// `cancel_response`. The source default is `30/minute`; a deployment may
    /// override it (the source deployment sets `10000/minute`).
    pub fn cancel_response() -> Self {
        crate::config::env_or_dotenv("RATE_LIMIT_CANCEL_RESPONSE")
            .as_deref()
            .and_then(Self::parse)
            .unwrap_or_else(|| Self::per_minute(30))
    }

    /// `@limiter.limit(settings.RATE_LIMIT_DELETE_RESPONSE)` on
    /// `delete_response`. The source default is `30/minute`.
    pub fn delete_response() -> Self {
        crate::config::env_or_dotenv(DELETE_RESPONSE_LIMIT_ENV)
            .as_deref()
            .and_then(Self::parse)
            .unwrap_or_else(|| Self::per_minute(30))
    }

    /// `RateLimitItem.key_for` namespace (`LIMITER`).
    fn namespace(&self) -> &'static str {
        "LIMITER"
    }
}

/// `limits.Granularity` name -> (canonical lowercase name, `Granularity.seconds`).
fn granularity_seconds(name: &str) -> Option<(&'static str, i64)> {
    Some(match name.to_ascii_lowercase().as_str() {
        "second" => ("second", 1),
        "minute" => ("minute", 60),
        "hour" => ("hour", 3_600),
        "day" => ("day", 86_400),
        "month" => ("month", 2_592_000),
        "year" => ("year", 31_536_000),
        _ => return None,
    })
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
    fn parses_the_configured_get_response_window() {
        // The recording environment sets `RATE_LIMIT_GET_RESPONSE=10000/minute`;
        // the recorded EVALSHA key carries that amount.
        let limit = RateLimit::parse("10000/minute").expect("valid rate string");
        assert_eq!(limit.amount, 10000);
        assert_eq!(limit.multiples, 1);
        assert_eq!(limit.granularity, "minute");
        assert_eq!(limit.expiry, 60);

        // The key with the configured amount matches the recorded exchange.
        let key = format!(
            "LIMITS:{}/{}/{}/{}/{}/{}",
            limit.namespace(),
            "apikey:wg-fN7frakn5vlYOTiQET3_XZ7m_1HNA424pJpQn8tVMqw",
            "/api/v1/responses/resp_801406538445657",
            limit.amount,
            limit.multiples,
            limit.granularity
        );
        assert_eq!(
            key,
            "LIMITS:LIMITER/apikey:wg-fN7frakn5vlYOTiQET3_XZ7m_1HNA424pJpQn8tVMqw//api/v1/responses/resp_801406538445657/10000/1/minute"
        );
    }

    #[test]
    fn parses_multiples_and_granularity_variants() {
        let with_multiples = RateLimit::parse("10/2/second").expect("valid rate string");
        assert_eq!(
            with_multiples,
            RateLimit {
                amount: 10,
                multiples: 2,
                granularity: "second",
                expiry: 1,
            }
        );

        let hour = RateLimit::parse("5/hour").expect("valid rate string");
        assert_eq!(hour.expiry, 3_600);
        assert_eq!(hour.granularity, "hour");
    }

    #[test]
    fn malformed_rate_strings_fall_back_to_default() {
        for value in [
            "",
            "minute",
            "0/minute",
            "-1/minute",
            "abc/minute",
            "10/fortnight",
            "10/0/minute",
        ] {
            assert!(
                RateLimit::parse(value).is_none(),
                "{value:?} must not parse"
            );
        }
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

    #[test]
    fn parses_the_configured_create_window() {
        assert_eq!(
            RateLimit::parse("10000/minute"),
            Some(RateLimit::per_minute(10_000))
        );
        assert_eq!(
            RateLimit::parse("60/hour").map(|limit| limit.expiry),
            Some(3600)
        );
        assert_eq!(
            RateLimit::parse("60/second").map(|limit| limit.granularity),
            Some("second")
        );
        // Unparsable / non-positive values fall back to the source default.
        assert_eq!(RateLimit::parse("bogus"), None);
        assert_eq!(RateLimit::parse("0/minute"), None);
        assert_eq!(RateLimit::parse("many/minute"), None);
    }
}
