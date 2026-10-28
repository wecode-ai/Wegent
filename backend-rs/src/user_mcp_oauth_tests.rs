// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the request-building OAuth token lookup, without credentials or
//! network: plain (unencrypted) synthetic values exercise the stored-token and
//! refresh-input decisions, and the HTTP refresh is not reached.
#![cfg(test)]

use super::*;
use serde_json::json;

/// `mcps.dingtalk.services.table` with a stored access token and the cached
/// provider OAuth client when `with_client` is set.
fn preferences(access_token: &str, expires_at: i64, with_client: bool) -> String {
    let mut provider = json!({
        "services": {
            "table": {
                "enabled": true,
                "auth_mode": "oauth",
                "credentials": {
                    "access_token": access_token,
                    "refresh_token": "synthetic-refresh-token",
                    "expires_at": expires_at,
                    "url": "https://mcp-gw.dingtalk.com/server/abc",
                },
            }
        }
    });
    if with_client {
        provider["oauth"] = json!({
            "token_endpoint": "https://auth.example.invalid/token",
            "client_id": "synthetic-client",
        });
    }
    json!({"mcps": {"dingtalk": provider}}).to_string()
}

/// `_usable_token`: a stored token outside the refresh skew is used as-is.
#[test]
fn usable_token_returns_the_stored_token_far_from_expiry() {
    let expires_at = Utc::now().timestamp() + 7200;
    let stored = preferences("synthetic-access-token", expires_at, true);
    assert_eq!(
        usable_token(&stored, "dingtalk", "table").expect("token"),
        Some("synthetic-access-token".to_string())
    );
}

/// `REFRESH_SKEW_SECONDS`: a token inside the skew is refreshed, not used.
#[test]
fn usable_token_refreshes_inside_the_skew() {
    let expires_at = Utc::now().timestamp() + 600;
    let stored = preferences("synthetic-access-token", expires_at, true);
    assert_eq!(
        usable_token(&stored, "dingtalk", "table").expect("token"),
        None
    );
}

/// `expires_at == 0` means the provider issued no expiry.
#[test]
fn usable_token_accepts_a_non_expiring_token() {
    let stored = preferences("synthetic-access-token", 0, true);
    assert_eq!(
        usable_token(&stored, "dingtalk", "table").expect("token"),
        Some("synthetic-access-token".to_string())
    );
}

/// `_refresh_target`: the refresh needs the stored grant, the token endpoint,
/// and the client id.
#[test]
fn refresh_target_requires_the_stored_client_registration() {
    let without_client = preferences("synthetic-access-token", 0, false);
    assert!(
        refresh_target(&without_client, "dingtalk", "table")
            .expect("target")
            .is_none()
    );
    let with_client = preferences("synthetic-access-token", 0, true);
    let target = refresh_target(&with_client, "dingtalk", "table")
        .expect("target")
        .expect("refreshable");
    assert_eq!(target.token_endpoint, "https://auth.example.invalid/token");
    assert_eq!(target.client_id, "synthetic-client");
    assert_eq!(target.refresh_token, "synthetic-refresh-token");
}

/// A missing refresh token makes the refresh impossible even with a client.
#[test]
fn refresh_target_requires_a_refresh_token() {
    let stored = json!({
        "mcps": {
            "dingtalk": {
                "services": {"table": {"enabled": true, "credentials": {"access_token": "synthetic"}}},
                "oauth": {"token_endpoint": "https://auth.example.invalid/token", "client_id": "synthetic-client"},
            }
        }
    })
    .to_string();
    assert!(
        refresh_target(&stored, "dingtalk", "table")
            .expect("target")
            .is_none()
    );
}

/// `is_secure_mcp_url`: `https` with a hostname, or `http` to a loopback host.
#[test]
fn is_secure_mcp_url_matches_the_source() {
    assert!(is_secure_mcp_url("https://mcp-gw.dingtalk.com/server/abc"));
    assert!(is_secure_mcp_url("http://localhost:8080/mcp"));
    assert!(is_secure_mcp_url("http://127.0.0.1:8080/mcp"));
    assert!(is_secure_mcp_url(
        "  https://mcp-gw.dingtalk.com/server/abc  "
    ));
    assert!(!is_secure_mcp_url("http://mcp-gw.dingtalk.com/server/abc"));
    assert!(!is_secure_mcp_url("https://"));
    assert!(!is_secure_mcp_url(""));
    // `urlsplit(...).hostname` strips IPv6 brackets, so the source's `[::1]`
    // member never matches; the port keeps that behavior.
    assert!(!is_secure_mcp_url("http://[::1]:8080/mcp"));
}

/// `_expires_at`: a positive `expires_in` becomes an absolute timestamp.
#[test]
fn expires_at_converts_a_positive_lifetime() {
    let now = Utc::now().timestamp();
    let converted = expires_at(&json!({"expires_in": 3600}));
    assert!((converted - (now + 3600)).abs() <= 2);
    let from_string = expires_at(&json!({"expires_in": " 3600 "}));
    assert!((from_string - (now + 3600)).abs() <= 2);
    assert_eq!(expires_at(&json!({"expires_in": -5})), 0);
    assert_eq!(expires_at(&json!({"expires_in": "not-a-number"})), 0);
    assert_eq!(expires_at(&json!({})), 0);
}

/// `_require_token_payload`: an object with an access token and no error.
#[test]
fn token_payload_usable_requires_an_access_token() {
    assert!(token_payload_usable(&json!({"access_token": "synthetic"})));
    assert!(!token_payload_usable(&json!({"error": "invalid_grant"})));
    assert!(!token_payload_usable(&json!({"access_token": ""})));
    assert!(!token_payload_usable(&json!([])));
}
