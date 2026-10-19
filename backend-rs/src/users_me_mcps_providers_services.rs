// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/mcps/providers/{provider_id}/services`.
//!
//! Mirrors `app.api.endpoints.users.list_mcp_provider_services` together with
//! `app.services.user_mcp_service.UserMCPService` and
//! `app.services.mcp_provider_registry`: a provider that is unknown or not
//! configured for user-scoped services is rejected with the source's 404, and
//! otherwise every static service of the provider is rendered merged with the
//! current user's stored configuration. A stored MCP URL is decrypted through
//! `shared.utils.crypto` (`GIT_TOKEN_AES_KEY` / `GIT_TOKEN_AES_IV`).
//!
//! The pydantic `MCPProviderServiceConfigResponse` keeps `provider_id`,
//! `service_id`, `server_name`, `detail_url`, `enabled`, `url`, `auth_mode`,
//! `oauth_supported`, `oauth_connected`, `oauth_expires_at`, and
//! `oauth_account`, in that declaration order; the registry's `skill_name`,
//! `display_name`, and `message_keywords` are not part of this response.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Serialize;

use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::state::AppState;
use brz_http_server::StatusCode;

/// One static service definition (`MCPProviderServiceDefinition`). Only the
/// fields this endpoint renders are retained.
struct ServiceDefinition {
    service_id: &'static str,
    server_name: &'static str,
    detail_url: &'static str,
    oauth_supported: bool,
}

/// A provider definition (`MCPProviderDefinition`) reduced to the
/// `configuration_mode` gate and its service list.
struct ProviderDefinition {
    configuration_mode: &'static str,
    services: &'static [ServiceDefinition],
}

/// The built-in `dingtalk` provider (`MCP_PROVIDER_REGISTRY["dingtalk"]`). The
/// declaration order of `services` is contractual: it is the order the source
/// `list_mcp_provider_services("dingtalk")` returns and therefore the response
/// array order.
static DINGTALK_SERVICES: &[ServiceDefinition] = &[
    ServiceDefinition {
        service_id: "docs",
        server_name: "dingtalk_docs",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9629",
        oauth_supported: true,
    },
    ServiceDefinition {
        service_id: "table",
        server_name: "dingtalk_table",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9704",
        oauth_supported: true,
    },
    ServiceDefinition {
        service_id: "ai_table",
        server_name: "dingtalk_ai_table",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9555",
        oauth_supported: true,
    },
    ServiceDefinition {
        service_id: "wikispace",
        server_name: "dingtalk_wikispace",
        detail_url: "https://mcp.dingtalk.com/#/detail?mcpId=9730",
        oauth_supported: true,
    },
];

static DINGTALK_PROVIDER: ProviderDefinition = ProviderDefinition {
    configuration_mode: "user",
    services: DINGTALK_SERVICES,
};

/// `get_mcp_provider(provider_id)`: the deployment's user-mode provider
/// registry. The only user-mode provider is the built-in `dingtalk`; any
/// system-mode provider is rejected by the `configuration_mode == "user"`
/// gate anyway.
fn provider(provider_id: &str) -> Option<&'static ProviderDefinition> {
    match provider_id {
        "dingtalk" => Some(&DINGTALK_PROVIDER),
        _ => None,
    }
}

/// The rendered `MCPProviderServiceConfigResponse`; field order is the pydantic
/// model's declaration order.
#[derive(Serialize)]
struct ProviderServiceConfig {
    provider_id: String,
    service_id: &'static str,
    server_name: &'static str,
    detail_url: &'static str,
    enabled: bool,
    url: String,
    auth_mode: &'static str,
    oauth_supported: bool,
    oauth_connected: bool,
    oauth_expires_at: Option<i64>,
    oauth_account: Option<String>,
}

/// GET /api/users/me/mcps/providers/{provider_id}/services: the free function,
/// injecting the process-lifetime application state.
#[brz_http_server::get("/api/users/me/mcps/providers/:provider_id/services")]
async fn list_mcp_provider_services(
    #[inject(state)] _state: &AppState,
    provider_id: &str,
    #[auth] current_user: SessionUser,
) -> Result<Vec<ProviderServiceConfig>, FastApiError> {
    list_services(provider_id, &current_user.preferences)
}

/// Handler body for `GET /api/users/me/mcps/providers/{provider_id}/services`.
fn list_services(
    provider_id: &str,
    preferences: &str,
) -> Result<Vec<ProviderServiceConfig>, FastApiError> {
    list_services_with(provider_id, preferences, |url| {
        let material = encryption_key()?;
        Ok(decrypt_sensitive_data(&material.key, &material.iv, url))
    })
}

/// [`list_services`] with an explicit URL decryptor.
fn list_services_with(
    provider_id: &str,
    preferences: &str,
    decrypt: impl Fn(&str) -> Result<String, CryptoError>,
) -> Result<Vec<ProviderServiceConfig>, FastApiError> {
    // `has_provider_services`: unknown or non-user providers are 404.
    let Some(provider) = provider(provider_id) else {
        return Err(unsupported_provider(provider_id));
    };
    if provider.configuration_mode != "user" {
        return Err(unsupported_provider(provider_id));
    }

    let mut configs = Vec::with_capacity(provider.services.len());
    for service in provider.services {
        let config = service_config_with(preferences, provider_id, service.service_id, &decrypt)?;
        configs.push(ProviderServiceConfig {
            provider_id: provider_id.to_owned(),
            service_id: service.service_id,
            server_name: service.server_name,
            detail_url: service.detail_url,
            enabled: config.enabled,
            url: config.url,
            auth_mode: config.auth_mode,
            oauth_supported: service.oauth_supported,
            oauth_connected: config.oauth_connected,
            oauth_expires_at: config.oauth_expires_at,
            oauth_account: config.oauth_account,
        });
    }
    Ok(configs)
}

/// `HTTPException(404, f"Unsupported MCP provider: {provider_id}")`.
fn unsupported_provider(provider_id: &str) -> FastApiError {
    FastApiError::detail(
        StatusCode::NOT_FOUND,
        format!("Unsupported MCP provider: {provider_id}"),
    )
}

/// `UserMCPService.get_provider_service_config`: read the stored `enabled` flag,
/// decrypted `url`, and OAuth state for one provider service from the user's
/// preferences.
///
/// The stored URL and OAuth token credentials are decrypted only when they are
/// encrypted, and the configured key material is resolved lazily at that point —
/// matching the source, which never touches `_get_encryption_key` for a plain
/// or absent value. The explicit `decrypt` parameter carries that crypto
/// boundary so it can be exercised without process environment.
fn service_config_with(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
    decrypt: impl Fn(&str) -> Result<String, CryptoError>,
) -> Result<ServiceUserConfig, FastApiError> {
    // `load_preferences`: a non-object or unparsable payload is an empty map.
    let parsed: serde_json::Value =
        serde_json::from_str(preferences).unwrap_or(serde_json::Value::Null);
    let service = parsed
        .get("mcps")
        .and_then(|mcps| mcps.get(provider_id))
        .and_then(|provider| provider.get("services"))
        .and_then(|services| services.get(service_id));
    let credentials = service.and_then(|service| service.get("credentials"));

    // `bool(service.get("enabled", False))`.
    let enabled = service
        .and_then(|service| service.get("enabled"))
        .is_some_and(python_truthy);

    // `credentials.get("url", "")`, then decrypt only an encrypted value.
    let url = decrypt_stored(credentials, "url", &decrypt)?;

    // `bool(access_token or refresh_token)` after `_decrypt` of each.
    let access_token = decrypt_stored(credentials, "access_token", &decrypt)?;
    let refresh_token = decrypt_stored(credentials, "refresh_token", &decrypt)?;
    let oauth_connected = python_truthy_str(&access_token) || python_truthy_str(&refresh_token);

    // `int(expires_at) if isinstance(expires_at, int) else None`.
    let oauth_expires_at = credentials
        .and_then(|credentials| credentials.get("expires_at"))
        .and_then(serde_json::Value::as_i64);

    // `_decrypt(credentials.get("account")) or None`.
    let account = decrypt_stored(credentials, "account", &decrypt)?;
    let oauth_account = if account.is_empty() {
        None
    } else {
        Some(account)
    };

    // `auth_mode` defaults to `"url"` unless stored as `"url"` or `"oauth"`.
    let auth_mode = match service
        .and_then(|service| service.get("auth_mode"))
        .and_then(serde_json::Value::as_str)
    {
        Some("oauth") => "oauth",
        Some("url") => "url",
        _ => "url",
    };

    Ok(ServiceUserConfig {
        enabled,
        url,
        auth_mode,
        oauth_connected,
        oauth_expires_at,
        oauth_account,
    })
}

/// The user-stored part of one provider service configuration
/// (`get_provider_service_config`'s return value).
#[derive(Debug, PartialEq)]
struct ServiceUserConfig {
    enabled: bool,
    url: String,
    auth_mode: &'static str,
    oauth_connected: bool,
    oauth_expires_at: Option<i64>,
    oauth_account: Option<String>,
}

/// `_decrypt(credentials.get(key, None))`: a missing or non-string value is an
/// empty string; an encrypted value is decrypted (failures fall back to the
/// original text), a plain string is passed through.
fn decrypt_stored(
    credentials: Option<&serde_json::Value>,
    key: &str,
    decrypt: &impl Fn(&str) -> Result<String, CryptoError>,
) -> Result<String, FastApiError> {
    let value = credentials
        .and_then(|credentials| credentials.get(key))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if value.is_empty() {
        return Ok(String::new());
    }
    if is_data_encrypted(value) {
        decrypt(value).map_err(|_| FastApiError::unhandled())
    } else {
        Ok(value.to_owned())
    }
}

/// Python truthiness for the decrypted credential strings: only the empty
/// string is falsy.
fn python_truthy_str(value: &str) -> bool {
    !value.is_empty()
}

/// Python truthiness (`bool(value)`): `False`/`0`/empty string/empty
/// collection/`None` are falsy and everything else is truthy.
use brz_json::adapters::python_truthy;

/// `shared.utils.crypto`'s `GIT_TOKEN_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// AES block size, also the PKCS#7 block size.
const BLOCK_SIZE: usize = 16;

/// `shared.utils.crypto.CryptoConfigurationError` on the URL decryption path.
#[derive(Debug)]
enum CryptoError {
    /// `GIT_TOKEN_AES_IV` must be configured and 16 UTF-8 bytes long.
    InvalidIv,
}

/// The AES key/IV material `_get_encryption_key()` resolves.
struct EncryptionKey {
    key: Vec<u8>,
    iv: Vec<u8>,
}

/// `_get_encryption_key()`: `GIT_TOKEN_AES_KEY` defaults and
/// `GIT_TOKEN_AES_IV` is required and exactly one AES block.
fn encryption_key() -> Result<EncryptionKey, CryptoError> {
    let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_AES_KEY.to_string())
        .into_bytes();
    let iv = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV")
        .ok_or(CryptoError::InvalidIv)?
        .into_bytes();
    if iv.len() != BLOCK_SIZE {
        return Err(CryptoError::InvalidIv);
    }
    Ok(EncryptionKey { key, iv })
}

/// `decrypt_sensitive_data` after key resolution: `""` and `"***"` pass
/// through, and any decode/decrypt/UTF-8 failure returns the original text.
fn decrypt_sensitive_data(key: &[u8], iv: &[u8], text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    if text == "***" {
        return text.to_string();
    }
    let Some(encrypted) = STANDARD.decode(text.as_bytes()).ok() else {
        return text.to_string();
    };
    decrypt_cbc(key, iv, &encrypted)
        .ok()
        .and_then(|plain| String::from_utf8(plain).ok())
        .unwrap_or_else(|| text.to_string())
}

/// `is_data_encrypted`: a non-empty Base64 payload whose decoded length is a
/// whole number of AES blocks.
fn is_data_encrypted(data: &str) -> bool {
    if data.is_empty() {
        return false;
    }
    STANDARD
        .decode(data.as_bytes())
        .is_ok_and(|decoded| !decoded.is_empty() && decoded.len().is_multiple_of(BLOCK_SIZE))
}

/// `AES(key)` + `CBC(iv)`: the variant follows the configured key length.
fn decrypt_cbc(key: &[u8], iv: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, ()> {
    let iv: [u8; BLOCK_SIZE] = iv.try_into().map_err(|_| ())?;
    match key.len() {
        16 => cbc_decrypt::<Aes128>(key, iv, encrypted),
        24 => cbc_decrypt::<Aes192>(key, iv, encrypted),
        32 => cbc_decrypt::<Aes256>(key, iv, encrypted),
        _ => Err(()),
    }
}

/// CBC decryption and PKCS#7 unpadding (`decryptor.update` + `finalize`, then
/// `unpadder.update` + `finalize`).
fn cbc_decrypt<C>(key: &[u8], iv: [u8; BLOCK_SIZE], encrypted: &[u8]) -> Result<Vec<u8>, ()>
where
    C: BlockDecrypt + KeyInit,
{
    let cipher = C::new_from_slice(key).map_err(|_| ())?;
    if !encrypted.len().is_multiple_of(BLOCK_SIZE) {
        return Err(());
    }
    let mut previous = iv;
    let mut plain = Vec::with_capacity(encrypted.len());
    for chunk in encrypted.as_chunks::<BLOCK_SIZE>().0 {
        let mut block = Block::<C>::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        let mut decrypted = [0u8; BLOCK_SIZE];
        for (target, (byte, mask)) in decrypted.iter_mut().zip(block.iter().zip(previous.iter())) {
            *target = byte ^ mask;
        }
        plain.extend_from_slice(&decrypted);
        previous.copy_from_slice(chunk);
    }
    unpad_pkcs7(plain)
}

/// `padding.PKCS7(128).unpadder().finalize()`.
fn unpad_pkcs7(mut plain: Vec<u8>) -> Result<Vec<u8>, ()> {
    let padding = usize::from(*plain.last().ok_or(())?);
    if padding == 0 || padding > BLOCK_SIZE || padding > plain.len() {
        return Err(());
    }
    let content = plain.len() - padding;
    if plain[content..]
        .iter()
        .any(|byte| usize::from(*byte) != padding)
    {
        return Err(());
    }
    plain.truncate(content);
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &[u8] = DEFAULT_AES_KEY.as_bytes();
    const IV: &[u8] = b"1234567890123456";

    /// The production decryptor with the source's default key material, so the
    /// handler's behavior can be exercised without process environment.
    fn test_decrypt(url: &str) -> Result<String, CryptoError> {
        Ok(decrypt_sensitive_data(KEY, IV, url))
    }

    /// Ciphertexts produced by `openssl enc -aes-256-cbc -base64` with the
    /// source's default key and a 16-byte IV.
    #[test]
    fn decrypts_stored_urls_with_the_configured_key() {
        assert_eq!(
            decrypt_sensitive_data(KEY, IV, "N4DP229zmyi0e4Mwh5IlSg=="),
            "docs"
        );
        assert_eq!(
            decrypt_sensitive_data(
                KEY,
                IV,
                "jpx/RyzbRARmLYmxMCrZW88hairJjbe3XMbPYMBFi8/3+gvembkfRWVcGgA+nr+G"
            ),
            "https://mcp-gw.dingtalk.com/server/abc?key=def"
        );
    }

    #[test]
    fn undecryptable_or_empty_values_fall_back_to_the_ciphertext() {
        assert_eq!(decrypt_sensitive_data(KEY, IV, ""), "");
        assert_eq!(decrypt_sensitive_data(KEY, IV, "***"), "***");
        // Valid base64 but not a ciphertext block multiple; unpadding fails.
        assert_eq!(decrypt_sensitive_data(KEY, IV, "AAAA"), "AAAA");
        // Not base64 at all.
        assert_eq!(
            decrypt_sensitive_data(KEY, IV, "https://example.invalid/x"),
            "https://example.invalid/x"
        );
    }

    #[test]
    fn data_encrypted_requires_a_whole_block_count() {
        assert!(is_data_encrypted("N4DP229zmyi0e4Mwh5IlSg=="));
        assert!(!is_data_encrypted(""));
        assert!(!is_data_encrypted("https://example.invalid/x"));
        assert!(!is_data_encrypted("AAAA"));
    }

    #[test]
    fn service_config_decrypts_a_stored_url_and_reads_enabled() {
        let preferences = json!({
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": true,
                            "credentials": {"url": "N4DP229zmyi0e4Mwh5IlSg=="},
                        },
                        "table": {
                            "enabled": false,
                            "credentials": {"url": ""},
                        },
                    }
                }
            }
        })
        .to_string();
        assert_eq!(
            service_config_with(&preferences, "dingtalk", "docs", test_decrypt).unwrap(),
            ServiceUserConfig {
                enabled: true,
                url: "docs".to_string(),
                auth_mode: "url",
                oauth_connected: false,
                oauth_expires_at: None,
                oauth_account: None,
            }
        );
        assert_eq!(
            service_config_with(&preferences, "dingtalk", "table", test_decrypt).unwrap(),
            ServiceUserConfig {
                enabled: false,
                url: String::new(),
                auth_mode: "url",
                oauth_connected: false,
                oauth_expires_at: None,
                oauth_account: None,
            }
        );
        // A service absent from the user's preferences has default values.
        assert_eq!(
            service_config_with(&preferences, "dingtalk", "wikispace", test_decrypt).unwrap(),
            ServiceUserConfig {
                enabled: false,
                url: String::new(),
                auth_mode: "url",
                oauth_connected: false,
                oauth_expires_at: None,
                oauth_account: None,
            }
        );
    }

    #[test]
    fn service_config_reads_oauth_state_and_auth_mode() {
        let preferences = json!({
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": true,
                            "auth_mode": "oauth",
                            "credentials": {
                                "url": "N4DP229zmyi0e4Mwh5IlSg==",
                                "access_token": "jpx/RyzbRARmLYmxMCrZW88hairJjbe3XMbPYMBFi8/3+gvembkfRWVcGgA+nr+G",
                                "expires_at": 1792565276,
                                "account": "N4DP229zmyi0e4Mwh5IlSg==",
                            },
                        },
                        "table": {
                            "enabled": false,
                            "auth_mode": "invalid",
                            "credentials": {
                                "refresh_token": "plain-refresh-token",
                            },
                        },
                        "ai_table": {
                            "enabled": false,
                            "credentials": {
                                "access_token": "",
                                "refresh_token": 7,
                                "expires_at": "1792565276",
                                "account": "",
                            },
                        },
                    }
                }
            }
        })
        .to_string();
        // OAuth state is decrypted; `oauth_connected` is any present token.
        assert_eq!(
            service_config_with(&preferences, "dingtalk", "docs", test_decrypt).unwrap(),
            ServiceUserConfig {
                enabled: true,
                url: "docs".to_string(),
                auth_mode: "oauth",
                oauth_connected: true,
                oauth_expires_at: Some(1792565276),
                oauth_account: Some("docs".to_string()),
            }
        );
        // A plain (unencrypted) refresh token also marks the service
        // connected; an unknown auth_mode falls back to "url".
        assert_eq!(
            service_config_with(&preferences, "dingtalk", "table", test_decrypt).unwrap(),
            ServiceUserConfig {
                enabled: false,
                url: String::new(),
                auth_mode: "url",
                oauth_connected: true,
                oauth_expires_at: None,
                oauth_account: None,
            }
        );
        // Empty or non-string credentials read as disconnected and null;
        // a non-int expires_at renders null.
        assert_eq!(
            service_config_with(&preferences, "dingtalk", "ai_table", test_decrypt).unwrap(),
            ServiceUserConfig {
                enabled: false,
                url: String::new(),
                auth_mode: "url",
                oauth_connected: false,
                oauth_expires_at: None,
                oauth_account: None,
            }
        );
    }

    #[test]
    fn service_config_tolerates_missing_or_malformed_preferences() {
        for preferences in ["", "not json", "[]", "null", "{}"] {
            assert_eq!(
                service_config_with(preferences, "dingtalk", "docs", test_decrypt).unwrap(),
                ServiceUserConfig {
                    enabled: false,
                    url: String::new(),
                    auth_mode: "url",
                    oauth_connected: false,
                    oauth_expires_at: None,
                    oauth_account: None,
                },
                "{preferences:?}"
            );
        }
    }

    #[test]
    fn list_services_renders_registry_order_and_fields() {
        let preferences = json!({
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": true,
                            "credentials": {"url": "N4DP229zmyi0e4Mwh5IlSg=="},
                        }
                    }
                }
            }
        })
        .to_string();
        let configs = list_services_with("dingtalk", &preferences, test_decrypt).unwrap();
        let body = serde_json::to_string(&configs).unwrap();
        assert_eq!(
            body,
            "[{\"provider_id\":\"dingtalk\",\"service_id\":\"docs\",\
             \"server_name\":\"dingtalk_docs\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9629\",\
             \"enabled\":true,\"url\":\"docs\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null},\
             {\"provider_id\":\"dingtalk\",\"service_id\":\"table\",\
             \"server_name\":\"dingtalk_table\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9704\",\
             \"enabled\":false,\"url\":\"\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null},\
             {\"provider_id\":\"dingtalk\",\"service_id\":\"ai_table\",\
             \"server_name\":\"dingtalk_ai_table\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9555\",\
             \"enabled\":false,\"url\":\"\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null},\
             {\"provider_id\":\"dingtalk\",\"service_id\":\"wikispace\",\
             \"server_name\":\"dingtalk_wikispace\",\
             \"detail_url\":\"https://mcp.dingtalk.com/#/detail?mcpId=9730\",\
             \"enabled\":false,\"url\":\"\",\"auth_mode\":\"url\",\
             \"oauth_supported\":true,\"oauth_connected\":false,\
             \"oauth_expires_at\":null,\"oauth_account\":null}]"
        );
    }

    #[test]
    fn unknown_or_system_providers_are_not_found() {
        assert!(list_services_with("missing", "{}", test_decrypt).is_err());
        // The internal `ap` provider is system-mode, so it is not user-scoped.
        assert!(provider("ap").is_none());
        assert_eq!(
            unsupported_provider("missing").detail_message(),
            Some("Unsupported MCP provider: missing")
        );
    }

    #[test]
    fn python_truthiness_matches_bool() {
        for (value, expected) in [
            (json!(true), true),
            (json!(false), false),
            (json!(null), false),
            (json!(0), false),
            (json!(0.0), false),
            (json!(1), true),
            (json!(-1), true),
            (json!(""), false),
            (json!("false"), true),
            (json!([]), false),
            (json!([0]), true),
            (json!({}), false),
            (json!({"a": 1}), true),
        ] {
            assert_eq!(python_truthy(&value), expected, "{value}");
        }
    }
}
