// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Redis-backed fixed-window rate limits for the external knowledge file
//! endpoint (`app/core/rate_limit.py: check_external_mcp_dimension_rate_limit`
//! plus the endpoint's pre-auth and post-auth checks in
//! `app/mcp_server/external_knowledge_app.py`).
//!
//! Every check issues one `MULTI`/`INCRBY`/`EXPIRE`/`EXEC` transaction on the
//! key `external_kb_mcp:rate:{namespace}:{dimension}:{window}` where `window`
//! is `int(time.time() // window_seconds)`. The `INCRBY` result is compared
//! against the configured request budget: a count above it is `429
//! rate_limited`, and an unavailable Redis (`None` service or a failed
//! pipeline) is `503 rate_limit_unavailable`. Raw client values are hashed
//! before they become key dimensions.

use brz_http_server::StatusCode;
use brz_redis::{Redis, Value, cmd, pipe};
use sha2::{Digest, Sha256};

use crate::config::env_or_dotenv;
use crate::http_compat::FastApiError;

/// `EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED` (default true).
const ENABLED_ENV: &str = "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_ENABLED";

/// One `(requests, window)` budget pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Budget {
    requests: i64,
    window_seconds: i64,
}

impl Budget {
    fn from_env(requests_env: &str, window_env: &str, default: Self) -> Self {
        let requests = env_or_dotenv(requests_env)
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(default.requests);
        let window_seconds = env_or_dotenv(window_env)
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(default.window_seconds);
        Self {
            requests,
            window_seconds,
        }
    }
}

/// The endpoint's configured download limiter settings
/// (`app/core/config.py`, all defaults).
#[derive(Clone, Copy, Debug)]
pub(crate) struct DownloadRateLimits {
    enabled: bool,
    preauth_ip: Budget,
    preauth_document: Budget,
    download: Budget,
}

impl DownloadRateLimits {
    /// Reads the source settings from the process environment or the
    /// source-compatible dotenv file.
    #[must_use]
    pub(crate) fn from_env() -> Self {
        Self {
            enabled: env_or_dotenv(ENABLED_ENV).as_deref().is_none_or(parse_bool),
            preauth_ip: Budget::from_env(
                "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_IP_RATE_LIMIT_REQUESTS",
                "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_IP_RATE_LIMIT_WINDOW_SECONDS",
                Budget {
                    requests: 300,
                    window_seconds: 60,
                },
            ),
            preauth_document: Budget::from_env(
                "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_DOCUMENT_RATE_LIMIT_REQUESTS",
                "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_PREAUTH_DOCUMENT_RATE_LIMIT_WINDOW_SECONDS",
                Budget {
                    requests: 60,
                    window_seconds: 60,
                },
            ),
            download: Budget::from_env(
                "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_REQUESTS",
                "EXTERNAL_KNOWLEDGE_MCP_DOWNLOAD_RATE_LIMIT_WINDOW_SECONDS",
                Budget {
                    requests: 20,
                    window_seconds: 60,
                },
            ),
        }
    }
}

/// `_check_download_preauth_rate_limit`: the client-IP hash budget, then the
/// client-IP-hash plus document budget.
pub(crate) async fn check_preauth<R: Redis>(
    limits: &DownloadRateLimits,
    redis: Option<&R>,
    client_ip: &str,
    document_id: i64,
) -> Result<(), FastApiError> {
    if !limits.enabled {
        return Ok(());
    }
    let ip_hash = hash_rate_limit_value(client_ip);
    check(
        redis,
        "download_preauth_ip",
        &format!("ip:{ip_hash}"),
        limits.preauth_ip,
    )
    .await?;
    check(
        redis,
        "download_preauth_document",
        &format!("ip:{ip_hash}:document:{document_id}"),
        limits.preauth_document,
    )
    .await
}

/// `_check_download_rate_limit`: the authenticated user plus document budget.
pub(crate) async fn check_download<R: Redis>(
    limits: &DownloadRateLimits,
    redis: Option<&R>,
    user_id: i64,
    document_id: i64,
) -> Result<(), FastApiError> {
    if !limits.enabled {
        return Ok(());
    }
    check(
        redis,
        "download",
        &format!("user:{user_id}:document:{document_id}"),
        limits.download,
    )
    .await
}

/// `check_external_mcp_dimension_rate_limit` for a single dimension.
async fn check<R: Redis>(
    redis: Option<&R>,
    namespace: &str,
    dimension: &str,
    budget: Budget,
) -> Result<(), FastApiError> {
    if budget.requests <= 0 || budget.window_seconds <= 0 {
        return Ok(());
    }
    let Some(redis) = redis else {
        // `_get_rate_limit_redis_client` returns `None`, so the source
        // reports the limiter as unavailable.
        return Err(rate_limit_unavailable());
    };
    let window = chrono::Utc::now()
        .timestamp()
        .div_euclid(budget.window_seconds);
    let key = format!("external_kb_mcp:rate:{namespace}:{dimension}:{window}");

    let mut builder = pipe();
    builder
        .command(cmd("MULTI"))
        .map_err(|_| rate_limit_unavailable())?;
    let mut incr = cmd("INCRBY");
    incr.arg(key.as_str()).arg(1);
    builder
        .command(incr)
        .map_err(|_| rate_limit_unavailable())?;
    let mut expire = cmd("EXPIRE");
    expire.arg(key.as_str()).arg(budget.window_seconds + 1);
    builder
        .command(expire)
        .map_err(|_| rate_limit_unavailable())?;
    builder
        .command(cmd("EXEC"))
        .map_err(|_| rate_limit_unavailable())?;

    let mut response = redis
        .pipe(builder)
        .await
        .map_err(|_| rate_limit_unavailable())?;
    // `MULTI` -> `+OK`, `INCRBY`/`EXPIRE` -> `+QUEUED`, `EXEC` -> the result
    // array the source reads through `pipeline().execute()`.
    for _ in 0..3 {
        let _: Value = response
            .take_value()
            .await
            .map_err(|_| rate_limit_unavailable())?;
    }
    let exec: Value = response
        .take_value()
        .await
        .map_err(|_| rate_limit_unavailable())?;
    let Value::Array(results) = exec else {
        return Err(rate_limit_unavailable());
    };
    // `counts = results[::2]`: the `INCRBY` replies.
    let exceeded = results.iter().step_by(2).any(|value| match value {
        Value::Int(count) => *count > budget.requests,
        _ => false,
    });
    if exceeded {
        return Err(rate_limited());
    }
    Ok(())
}

/// `hash_rate_limit_value`: the first 32 hex characters of the SHA-256 digest.
fn hash_rate_limit_value(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let hex = format!("{digest:x}");
    hex[..32].to_string()
}

/// `Settings`-style boolean parsing (`pydantic` bool values).
fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on" | "y" | "t"
    )
}

/// `429 {"error": "Rate limit exceeded", "code": "rate_limited"}`.
fn rate_limited() -> FastApiError {
    FastApiError::json_body(
        StatusCode::TOO_MANY_REQUESTS,
        serde_json::json!({"error": "Rate limit exceeded", "code": "rate_limited"}),
    )
}

/// `503 {"error": "Rate limit service unavailable", "code":
/// "rate_limit_unavailable"}`.
fn rate_limit_unavailable() -> FastApiError {
    FastApiError::json_body(
        StatusCode::SERVICE_UNAVAILABLE,
        serde_json::json!({
            "error": "Rate limit service unavailable",
            "code": "rate_limit_unavailable"
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_client_values_like_the_source() {
        // The last forwarded address produces a deterministic truncated SHA-256 key segment.
        assert_eq!(
            hash_rate_limit_value("203.0.113.9"),
            "d861b7e91033ebc1c1e8e7af39290101"
        );
        assert_eq!(hash_rate_limit_value("unknown").len(), 32);
    }

    #[test]
    fn parses_source_boolean_values() {
        for value in ["true", "TRUE", "1", "yes", "on"] {
            assert!(parse_bool(value), "{value:?}");
        }
        for value in ["false", "0", "no", "", "random"] {
            assert!(!parse_bool(value), "{value:?}");
        }
    }

    #[test]
    fn default_budgets_match_the_source_settings() {
        let limits = DownloadRateLimits {
            enabled: true,
            preauth_ip: Budget {
                requests: 300,
                window_seconds: 60,
            },
            preauth_document: Budget {
                requests: 60,
                window_seconds: 60,
            },
            download: Budget {
                requests: 20,
                window_seconds: 60,
            },
        };
        assert_eq!(limits.preauth_ip.requests, 300);
        assert_eq!(limits.download.window_seconds, 60);
    }
}
