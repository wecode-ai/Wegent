// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wecode model API key exchange for the decision router.
//!
//! The decision upstream accepts a Wecode model API key and rejects the Wework
//! login token. The Executor therefore trades the current login token for that
//! key at the Wegent backend and keeps the result in memory only: the key is
//! never written to disk, to a log line, or to a Smart App response.

use std::fmt;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use url::Url;

use crate::logging::log_executor_event;

/// Path appended to the backend API base.
const EXCHANGE_PATH: &str = "/internal/apikey/wegent-model-key";
/// How long one exchanged key is reused before the login token is traded again.
const EXCHANGE_KEY_TTL: Duration = Duration::from_secs(10 * 60);
/// One exchange must not hold a decision request for longer than this.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
struct ModelKeyResponse {
    api_key: String,
}

struct CachedModelKey {
    login_fingerprint: String,
    api_key: String,
    fetched_at: Instant,
}

/// Trades the current Wework login token for a Wecode model API key.
pub(crate) struct ModelKeyExchanger {
    client: reqwest::Client,
    cached: Mutex<Option<CachedModelKey>>,
    key_ttl: Duration,
    timeout: Duration,
}

/// Renders without the cached key: this type is reachable from `AppState`,
/// which derives `Debug`, and a credential must never reach a log line.
impl fmt::Debug for ModelKeyExchanger {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ModelKeyExchanger")
            .finish_non_exhaustive()
    }
}

impl ModelKeyExchanger {
    pub(crate) fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
            cached: Mutex::new(None),
            key_ttl: EXCHANGE_KEY_TTL,
            timeout: EXCHANGE_TIMEOUT,
        }
    }

    /// Credential to send to the decision upstream for the current login state.
    ///
    /// Returns `None` when the login token is missing, the backend URL is
    /// unusable, or the exchange fails; the caller answers
    /// `credential_unavailable` instead of calling the upstream unauthenticated.
    ///
    /// The cache lock is held across the exchange, so concurrent requests share
    /// one trade instead of stampeding the backend.
    pub(crate) async fn key_for(&self, backend_url: &str, login_token: &str) -> Option<String> {
        let login_token = login_token.trim();
        if login_token.is_empty() {
            return None;
        }
        let login_fingerprint = fingerprint(login_token);
        let mut cached = self.cached.lock().await;
        if let Some(entry) = cached.as_ref() {
            if entry.login_fingerprint == login_fingerprint
                && entry.fetched_at.elapsed() < self.key_ttl
            {
                return Some(entry.api_key.clone());
            }
        }
        let url = exchange_url(backend_url)?;
        let api_key = match self.exchange(&url, login_token).await {
            Ok(api_key) => api_key,
            Err(reason) => {
                *cached = None;
                log_executor_event(
                    "decision_proxy.model_key",
                    &[
                        ("result", "failed".to_owned()),
                        ("reason", reason.to_owned()),
                    ],
                );
                return None;
            }
        };
        *cached = Some(CachedModelKey {
            login_fingerprint,
            api_key: api_key.clone(),
            fetched_at: Instant::now(),
        });
        log_executor_event(
            "decision_proxy.model_key",
            &[("result", "exchanged".to_owned())],
        );
        Some(api_key)
    }

    /// Drops the cached key so the next lookup trades the login token again.
    ///
    /// Used when the upstream rejects the key: a key that was revoked or
    /// rotated server-side must not stay cached until the TTL expires.
    pub(crate) async fn invalidate(&self) {
        *self.cached.lock().await = None;
    }

    async fn exchange(&self, url: &Url, login_token: &str) -> Result<String, &'static str> {
        let response = self
            .client
            .post(url.as_str())
            .bearer_auth(login_token)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .timeout(self.timeout)
            .json(&json!({}))
            .send()
            .await
            .map_err(|_| "unreachable")?;
        let status = response.status();
        if !status.is_success() {
            return Err(match status.as_u16() {
                401 | 403 => "unauthorized",
                _ => "backend_error",
            });
        }
        let body = response
            .json::<ModelKeyResponse>()
            .await
            .map_err(|_| "invalid_response")?;
        let api_key = body.api_key.trim().to_owned();
        if api_key.is_empty() {
            return Err("invalid_response");
        }
        Ok(api_key)
    }
}

/// Builds `{backend_api_base}/internal/apikey/wegent-model-key`.
///
/// `ConnectionConfig.backend_url` is the backend origin and may carry a
/// deployment path prefix; the API base is that URL plus `/api`. Wework
/// normalizes the connection URL without `/api`, but a deployment can point the
/// Executor straight at an API base, so a trailing `/api` is not doubled.
fn exchange_url(backend_url: &str) -> Option<Url> {
    let mut url = Url::parse(backend_url.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/').to_owned();
    let api_path = if path.ends_with("/api") {
        path
    } else {
        format!("{path}/api")
    };
    url.set_path(&format!("{api_path}{EXCHANGE_PATH}"));
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

/// Short stable digest so a login token never reaches the log in clear text.
fn fingerprint(login_token: &str) -> String {
    Sha256::digest(login_token.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange_url_str(backend_url: &str) -> Option<String> {
        exchange_url(backend_url).map(|url| url.to_string())
    }

    #[test]
    fn backend_origin_gets_the_api_prefix() {
        assert_eq!(
            exchange_url_str("https://wegent.example.com").as_deref(),
            Some("https://wegent.example.com/api/internal/apikey/wegent-model-key")
        );
    }

    #[test]
    fn deployment_path_prefix_is_kept() {
        assert_eq!(
            exchange_url_str("https://example.com/wework").as_deref(),
            Some("https://example.com/wework/api/internal/apikey/wegent-model-key")
        );
    }

    #[test]
    fn trailing_api_and_slash_are_not_doubled() {
        for backend_url in [
            "https://example.com/api",
            "https://example.com/api/",
            "  https://example.com/api  ",
        ] {
            assert_eq!(
                exchange_url_str(backend_url).as_deref(),
                Some("https://example.com/api/internal/apikey/wegent-model-key"),
                "backend_url={backend_url}"
            );
        }
    }

    #[test]
    fn query_and_fragment_are_dropped() {
        assert_eq!(
            exchange_url_str("http://127.0.0.1:8000/api?token=1#frag").as_deref(),
            Some("http://127.0.0.1:8000/api/internal/apikey/wegent-model-key")
        );
    }

    #[test]
    fn unusable_backend_urls_are_rejected() {
        for backend_url in [
            "",
            "   ",
            "not-a-url",
            "ftp://example.com",
            "file:///etc/passwd",
            "https://user:secret@example.com",
        ] {
            assert!(
                exchange_url_str(backend_url).is_none(),
                "backend_url={backend_url:?} must be rejected"
            );
        }
    }

    #[test]
    fn fingerprint_is_stable_short_and_not_the_token() {
        let token = "login-token-value";
        let digest = fingerprint(token);
        assert_eq!(digest, fingerprint(token));
        assert_eq!(digest.len(), 16);
        assert!(!digest.contains(token));
        assert_ne!(digest, fingerprint("other-token"));
    }
}
