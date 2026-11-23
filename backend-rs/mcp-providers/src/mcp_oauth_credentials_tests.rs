// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Tests for the provider OAuth credential store: the decrypted read, the
//! `json.dumps`-shaped write, and the token-only clear. Synthetic values and an
//! injected encryptor keep the tests independent of process environment.
#![cfg(test)]

use super::*;
use serde_json::json;
use std::cell::Cell;

/// `get_service_oauth_credentials` reads and decrypts the stored token
/// material; plain values pass through unchanged.
#[test]
fn service_oauth_credentials_reads_plain_values() {
    let preferences = json!({
        "mcps": {
            "dingtalk": {
                "services": {
                    "table": {
                        "enabled": true,
                        "credentials": {
                            "access_token": "synthetic-access",
                            "refresh_token": "synthetic-refresh",
                            "expires_at": 123,
                            "scope": "read",
                        },
                    }
                }
            }
        }
    })
    .to_string();
    let credentials =
        service_oauth_credentials(&preferences, "dingtalk", "table").expect("credentials");
    assert_eq!(credentials.access_token, "synthetic-access");
    assert_eq!(credentials.refresh_token, "synthetic-refresh");
    assert_eq!(credentials.expires_at, 123);
    assert_eq!(credentials.scope, "read");
}

/// `save_service_oauth_credentials` writes access_token, refresh_token,
/// expires_at, scope into the existing credentials object, marks the
/// service `oauth`, and serializes with Python's `json.dumps` spacing.
#[test]
fn save_service_oauth_credentials_writes_the_source_document() {
    let preferences = json!({
        "mcps": {
            "dingtalk": {
                "services": {
                    "table": {
                        "enabled": true,
                        "credentials": {"url": "https://mcp.example/x"},
                    }
                }
            }
        },
        "other": "kept",
    })
    .to_string();
    let document = save_service_oauth_credentials_with(
        &preferences,
        "dingtalk",
        "table",
        "synthetic-access",
        "synthetic-refresh",
        123,
        "read",
        |value| Ok(format!("enc:{value}")),
    )
    .expect("document");
    assert_eq!(
        document,
        "{\"mcps\": {\"dingtalk\": {\"services\": {\"table\": {\"enabled\": true, \
         \"credentials\": {\"url\": \"https://mcp.example/x\", \"access_token\": \
         \"enc:synthetic-access\", \"refresh_token\": \"enc:synthetic-refresh\", \
         \"expires_at\": 123, \"scope\": \"enc:read\"}, \"auth_mode\": \"oauth\"}}}}, \
         \"other\": \"kept\"}"
    );
}

/// `_encrypt` keeps a value that is already encrypted.
#[test]
fn save_service_oauth_credentials_keeps_an_encrypted_value() {
    let calls = Cell::new(0);
    let already_encrypted = "AAAAAAAAAAAAAAAAAAAAAA==";
    let document = save_service_oauth_credentials_with(
        "{}",
        "dingtalk",
        "table",
        already_encrypted,
        "",
        0,
        "",
        |_value| {
            calls.set(calls.get() + 1);
            Err(FastApiError::unhandled())
        },
    )
    .expect("document");
    assert_eq!(calls.get(), 0);
    assert!(document.contains(already_encrypted));
}

/// `clear_service_oauth_credentials` drops only the OAuth token entries and
/// keeps the rest of the credentials object.
#[test]
fn clear_service_oauth_credentials_drops_only_the_oauth_keys() {
    let preferences = json!({
        "mcps": {
            "dingtalk": {
                "services": {
                    "table": {
                        "enabled": true,
                        "auth_mode": "oauth",
                        "credentials": {
                            "url": "https://mcp.example/x",
                            "access_token": "synthetic-access",
                            "refresh_token": "synthetic-refresh",
                            "expires_at": 123,
                            "scope": "read",
                            "account": "synthetic-account",
                        },
                    }
                }
            }
        }
    })
    .to_string();
    let document =
        clear_service_oauth_credentials(&preferences, "dingtalk", "table").expect("document");
    assert_eq!(
        document,
        "{\"mcps\": {\"dingtalk\": {\"services\": {\"table\": {\"enabled\": true, \
         \"auth_mode\": \"oauth\", \"credentials\": {\"url\": \"https://mcp.example/x\"}}}}}}"
    );
}

/// `get_provider_oauth_client` reads `mcps.<provider>.oauth`.
#[test]
fn provider_oauth_client_reads_the_cached_registration() {
    let preferences = json!({
        "mcps": {
            "dingtalk": {
                "oauth": {
                    "token_endpoint": "https://auth.example.invalid/token",
                    "client_id": "synthetic-client",
                }
            }
        }
    })
    .to_string();
    let client = provider_oauth_client(&preferences, "dingtalk");
    assert_eq!(client.token_endpoint, "https://auth.example.invalid/token");
    assert_eq!(client.client_id, "synthetic-client");
    assert_eq!(
        provider_oauth_client("{}", "dingtalk"),
        ProviderOAuthClient::default()
    );
}
