// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The internal Git credential service behind the current-user response.
//!
//! Mirrors `wecode/service/get_user_gitinfo.py` (`GetUserGitInfo`) together
//! with the `GET /api/users/me` wrapper in `wecode/api/users_endpoint_patch.py`
//! (`_replace_placeholders`). That wrapper resolves the current user's stored
//! Git credentials whenever the built response carries a non-empty `git_info`
//! list.
//!
//! The source's substitution never reaches the response: its loop reads
//! `existing_item.get("git_domain")` on an already validated pydantic `GitInfo`
//! model, which has no `get`, so the `AttributeError` aborts the whole step
//! inside a swallowed `except Exception` before anything is assigned back. The
//! recorded source responses keep every stored placeholder for that reason.
//! What stays observable is the request itself, so the target performs the
//! same request and renders the stored list.
use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use brz_http::{Client as HttpClient, Endpoint};
use wegent_backend_rs::auth::UserRow;
use wegent_backend_rs::user_profile::{GitInfoEntry, UserGitInfoProvider, stored_git_info};

/// `GetUserGitInfo.git_token_api_url`.
const TOKEN_API_URL: &str = "http://paas.intra.weibo.com/2/appnest/api/code-server-new/secret/get";
/// `GetUserGitInfo.git_token_auth`: the fixed internal service credential the
/// source carries in its module constant.
const TOKEN_API_AUTHORIZATION: &str = "Basic L3BhYXMvd2ItcGxhdC1wYWFzL3diLXBsYXQtcGFhcy1hZG1pbiN3ZWdlbnQ6b2JOd0dkS1J4ZUxRRHk4aGQ1Z3B3WGpvMG5nQ05xV3E=";
/// `GetUserGitInfo.target_keys`: the only domains whose tokens are decoded.
const TARGET_DOMAINS: [&str; 3] = [
    "git.intra.weibo.com",
    "git.staff.sina.com.cn",
    "gitlab.weibo.cn",
];
/// `_fetch_git_data`: `httpx.Client(timeout=10)`. httpx applies its timeout to
/// every phase, so the connect phase gets the full 10 seconds as well.
const TOKEN_API_TIMEOUT: Duration = Duration::from_secs(10);
/// `_fetch_git_data`'s `cluster` parameter (`get_real_git_tokens` default).
const TOKEN_CLUSTER: &str = "cn";
/// Stable metric profile for the token-service route: the path is fixed for
/// this deployment while `user` and `cluster` vary per request
/// (`Client::endpoint_named`).
const TOKEN_API_PROFILE: &str = "http://paas/2/appnest/api/code-server-new/:service/get";

/// `_replace_placeholders` for `GET /api/users/me`.
pub(crate) struct WecodeGitInfo {
    http: HttpClient,
    endpoint: Endpoint,
}

impl WecodeGitInfo {
    /// Build the retained token-service client. The source builds a fresh
    /// `httpx.Client()` per call with `timeout=10`; the request carries no
    /// connection-local state, so one pooled client with the same
    /// connect/read budget serves every call. httpx does not follow
    /// redirects, so the transport mirrors that policy.
    pub(crate) fn new() -> Result<Self, brz_http::Error> {
        let http = HttpClient::builder()
            .connect_timeout(TOKEN_API_TIMEOUT)
            .read_timeout(TOKEN_API_TIMEOUT)
            .timeout(TOKEN_API_TIMEOUT)
            .configure(|builder| builder.redirect(brz_http::reqwest::redirect::Policy::none()))
            .build()?;
        let endpoint = http.endpoint_named(TOKEN_API_URL, TOKEN_API_PROFILE)?;
        Ok(Self { http, endpoint })
    }

    /// `GetUserGitInfo.get_real_git_tokens`: the configured domains the
    /// service returned a decodable token for. Every failure answers an empty
    /// list, mirroring `GitTokenSourceUnavailableError` being swallowed there.
    ///
    /// The decoded token values are deliberately not returned: the source
    /// never applies them, and this request must not retain credentials it
    /// does not use.
    async fn real_git_tokens(&self, username: &str) -> Vec<String> {
        let request = match self
            .endpoint
            .get()
            .query(&[("user", username), ("cluster", TOKEN_CLUSTER)])
            .header("authorization", TOKEN_API_AUTHORIZATION)
            .build()
        {
            Ok(request) => request,
            Err(error) => {
                tracing::warn!(%error, username, "Git token source request failed");
                return Vec::new();
            }
        };
        let response = match self.http.execute(request).await {
            Ok(response) => response,
            Err(error) => {
                tracing::warn!(%error, username, "Git token source request failed");
                return Vec::new();
            }
        };
        let status = response.status();
        // `response.raise_for_status()`: an HTTP error status is reported
        // before the body is interpreted.
        if !status.is_success() {
            tracing::warn!(%status, username, "Git token source request failed");
            return Vec::new();
        }
        let raw: TokenResponse = match response.json().await {
            Ok(raw) => raw,
            Err(error) => {
                tracing::warn!(%error, username, "Git token source response was not valid JSON");
                return Vec::new();
            }
        };
        match token_payload(raw, username) {
            Some(payload) => decoded_domains(&payload),
            None => Vec::new(),
        }
    }
}

#[async_trait]
impl UserGitInfoProvider for WecodeGitInfo {
    async fn resolved_git_info(&self, user: &UserRow) -> Option<Vec<GitInfoEntry>> {
        let stored = stored_git_info(user);
        // The wrapper returns without resolving anything when the response
        // carries no stored `git_info` entry.
        if stored.as_ref().is_some_and(|entries| !entries.is_empty()) {
            let domains = self.real_git_tokens(&user.user_name).await;
            tracing::debug!(
                username = user.user_name.as_str(),
                domains = domains.len(),
                "resolved stored Git credentials"
            );
        }
        stored
    }
}

/// The token-service envelope. `_fetch_git_data` accepts only an object whose
/// `code` is `0` and whose `data.data` is an object.
#[derive(serde::Deserialize)]
struct TokenEnvelope {
    code: Option<i64>,
    data: Option<TokenData>,
}

#[derive(serde::Deserialize)]
struct TokenData {
    data: Option<HashMap<String, String>>,
}

/// Any non-object body: the source's `not isinstance(data, dict)` branch.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum TokenResponse {
    Envelope(Box<TokenEnvelope>),
    Other(serde::de::IgnoredAny),
}

/// `_fetch_git_data`'s payload checks. Every unusable shape is
/// `GitTokenSourceUnavailableError` and answers `None`.
fn token_payload(raw: TokenResponse, username: &str) -> Option<HashMap<String, String>> {
    // `not isinstance(data, dict)`
    let TokenResponse::Envelope(envelope) = raw else {
        tracing::warn!(username, "Git token source returned an invalid payload");
        return None;
    };
    // `data.get("code") != 0`
    if envelope.code != Some(0) {
        tracing::warn!(
            username,
            code = ?envelope.code,
            "Git token source returned an invalid payload"
        );
        return None;
    }
    // `not isinstance(data.get("data"), dict)`
    match envelope.data.and_then(|data| data.data) {
        Some(payload) => Some(payload),
        None => {
            tracing::warn!(username, "Git token source returned an invalid payload");
            None
        }
    }
}

/// `_decode_git_tokens(strict=False)`: only the configured domains are
/// decoded, an undecodable value is skipped with a warning, and a token that
/// decodes to an empty string is not kept.
fn decoded_domains(payload: &HashMap<String, String>) -> Vec<String> {
    let mut domains = Vec::new();
    for domain in TARGET_DOMAINS {
        // `if not encoded_token: continue`
        let Some(encoded) = payload.get(domain).filter(|value| !value.is_empty()) else {
            continue;
        };
        let Some(token) = decode_token(encoded) else {
            tracing::warn!(domain, "Git token could not be decoded");
            continue;
        };
        if !token.is_empty() {
            domains.push(domain.to_string());
        }
    }
    domains
}

/// `base64.b64decode(token, validate=True).decode("utf-8").strip()`.
fn decode_token(encoded: &str) -> Option<String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    Some(decoded.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;
    use serde_json::json;

    fn encoded(token: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(token)
    }

    fn envelope(code: i64, data: Option<HashMap<String, String>>) -> TokenResponse {
        TokenResponse::Envelope(Box::new(TokenEnvelope {
            code: Some(code),
            data: Some(TokenData { data }),
        }))
    }

    fn user_row(git_info: serde_json::Value) -> UserRow {
        UserRow {
            id: 1001,
            user_name: "tom".to_string(),
            users_password_hash: "hash".to_string(),
            email: Some("tom@example.invalid".to_string()),
            git_info: brz_mysql::Json(git_info.into()),
            is_active: 1,
            role: "user".to_string(),
            auth_source: "dingtalk".to_string(),
            preferences: "{}".to_string(),
            created_at: NaiveDate::from_ymd_opt(2025, 12, 24)
                .unwrap()
                .and_hms_opt(17, 42, 56)
                .unwrap(),
            updated_at: NaiveDate::from_ymd_opt(2026, 9, 8)
                .unwrap()
                .and_hms_opt(19, 18, 0)
                .unwrap(),
        }
    }

    #[test]
    fn payload_requires_code_zero_and_a_data_object() {
        let mut data = HashMap::new();
        data.insert(TARGET_DOMAINS[0].to_string(), "YQ==".to_string());
        let payload = token_payload(envelope(0, Some(data)), "tom").unwrap();
        assert_eq!(
            payload.get(TARGET_DOMAINS[0]).map(String::as_str),
            Some("YQ==")
        );
        assert!(token_payload(envelope(1, Some(HashMap::new())), "tom").is_none());
        assert!(token_payload(envelope(0, None), "tom").is_none());
        assert!(token_payload(TokenResponse::Other(serde::de::IgnoredAny), "tom").is_none());
    }

    #[test]
    fn only_configured_domains_with_decodable_tokens_are_kept() {
        let mut payload = HashMap::new();
        payload.insert(TARGET_DOMAINS[0].to_string(), encoded("unit-token"));
        payload.insert(TARGET_DOMAINS[2].to_string(), encoded("  "));
        payload.insert("other.example".to_string(), encoded("ignored"));
        payload.insert(TARGET_DOMAINS[1].to_string(), "not base64!".to_string());
        assert_eq!(
            decoded_domains(&payload),
            vec![TARGET_DOMAINS[0].to_string()]
        );
    }

    #[test]
    fn decoded_token_is_stripped_and_blank_values_are_skipped() {
        assert_eq!(
            decode_token(&encoded("  token  ")).as_deref(),
            Some("token")
        );
        assert_eq!(decode_token(&encoded("")).as_deref(), Some(""));
        assert!(decode_token("!!!").is_none());
        let mut payload = HashMap::new();
        payload.insert(TARGET_DOMAINS[0].to_string(), String::new());
        assert!(decoded_domains(&payload).is_empty());
    }

    #[tokio::test]
    async fn a_response_without_stored_git_info_renders_it_unchanged() {
        // The wrapper returns before resolving credentials for an empty or
        // absent stored list, so neither case contacts the token service.
        let provider = WecodeGitInfo::new().expect("client builds");
        assert_eq!(
            provider
                .resolved_git_info(&user_row(json!([])))
                .await
                .map(|entries| entries.len()),
            Some(0)
        );
        assert!(
            provider
                .resolved_git_info(&user_row(json!(null)))
                .await
                .is_none()
        );
    }
}
