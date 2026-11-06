// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `app.services.user_mcp_service.UserMCPService`: the user-scoped provider
//! MCP configuration stored inside `users.preferences`.
//!
//! The stored `mcps.<provider_id>.services.<service_id>` entry carries the
//! `enabled` flag and credentials; a stored URL is decrypted through
//! `shared.utils.crypto` (`GIT_TOKEN_AES_KEY` / `GIT_TOKEN_AES_IV`) only when
//! it is encrypted. Decryption failure keeps the original text, while a
//! missing or invalid IV raises `CryptoConfigurationError` like the source.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};
use brz_json::adapters::python_truthy;

use crate::http_compat::FastApiError;

/// `UserMCPService.get_provider_service_config`'s return value.
#[derive(Debug, PartialEq)]
pub(crate) struct ServiceUserConfig {
    pub enabled: bool,
    pub url: String,
    pub auth_mode: &'static str,
    pub oauth_connected: bool,
    pub oauth_expires_at: Option<i64>,
    pub oauth_account: Option<String>,
}

/// `get_provider_service_config`'s crypto boundary: resolve the configured key
/// material and decrypt only an encrypted stored value.
pub(crate) fn decrypt_with_env(url: &str) -> Result<String, CryptoError> {
    let material = encryption_key()?;
    Ok(decrypt_sensitive_data(&material.key, &material.iv, url))
}

/// `get_enabled_mcp_server`: the stored server URL when the service is
/// enabled and its decrypted URL is non-empty. The source's returned
/// `name`/`type` are unused by the only caller of this port, so only the URL
/// is returned.
pub(crate) fn enabled_provider_server(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
) -> Result<Option<String>, FastApiError> {
    enabled_provider_server_with(preferences, provider_id, service_id, decrypt_with_env)
}

/// [`enabled_provider_server`] with an explicit URL decryptor.
fn enabled_provider_server_with(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
    decrypt: impl Fn(&str) -> Result<String, CryptoError>,
) -> Result<Option<String>, FastApiError> {
    let config = service_config_with(preferences, provider_id, service_id, decrypt)?;
    let url = config.url.trim();
    if !config.enabled || url.is_empty() {
        return Ok(None);
    }
    Ok(Some(url.to_owned()))
}

/// [`service_config`] with an explicit URL decryptor.
///
/// The stored URL and OAuth token credentials are decrypted only when they are
/// encrypted, and the configured key material is resolved lazily at that point
/// — matching the source, which never touches `_get_encryption_key` for a plain
/// or absent value. The explicit `decrypt` parameter carries that crypto
/// boundary so it can be exercised without process environment.
pub(crate) fn service_config_with(
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

/// `_decrypt(credentials.get(key, None))`: a missing or non-string value is an
/// empty string; an encrypted value is decrypted (failures fall back to the
/// original text), a plain string is passed through.
pub(crate) fn decrypt_stored(
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

/// `shared.utils.crypto`'s `GIT_TOKEN_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// AES block size, also the PKCS#7 block size.
pub(crate) const BLOCK_SIZE: usize = 16;

/// `shared.utils.crypto.CryptoConfigurationError` on the URL decryption path.
#[derive(Debug)]
pub(crate) enum CryptoError {
    /// `GIT_TOKEN_AES_IV` must be configured and 16 UTF-8 bytes long.
    InvalidIv,
    /// `algorithms.AES(key)` rejects a key that is not 16, 24, or 32 bytes.
    InvalidKey,
}

/// The AES key/IV material `_get_encryption_key()` resolves.
pub(crate) struct EncryptionKey {
    pub key: Vec<u8>,
    pub iv: Vec<u8>,
}

/// `_get_encryption_key()`: `GIT_TOKEN_AES_KEY` defaults and
/// `GIT_TOKEN_AES_IV` is required and exactly one AES block.
pub(crate) fn encryption_key() -> Result<EncryptionKey, CryptoError> {
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
pub(crate) fn decrypt_sensitive_data(key: &[u8], iv: &[u8], text: &str) -> String {
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
pub(crate) fn is_data_encrypted(data: &str) -> bool {
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

/// `_build_request_task_data` (`request_builder.py:1953`): the runtime task
/// data exposed to MCP placeholder substitution (`{"user_mcps": ...}`), or
/// `None` when the caller has no enabled user-configured MCP services.
pub(crate) fn build_request_task_data(
    preferences: Option<&str>,
) -> Result<Option<serde_json::Value>, FastApiError> {
    let Some(preferences) = preferences else {
        return Ok(None);
    };
    let Some(user_mcps) = enabled_decrypted_mcp_preferences(preferences)? else {
        return Ok(None);
    };
    let mut task_data = serde_json::Map::new();
    task_data.insert("user_mcps".into(), serde_json::Value::Object(user_mcps));
    Ok(Some(serde_json::Value::Object(task_data)))
}

/// `get_enabled_decrypted_mcp_preferences`: the stored provider MCP services
/// that are enabled, carry a non-empty (decrypted) URL, and belong to a
/// registry provider configured for `"user"` mode.
fn enabled_decrypted_mcp_preferences(
    preferences: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, FastApiError> {
    let parsed: serde_json::Value =
        serde_json::from_str(preferences).unwrap_or(serde_json::Value::Null);
    let Some(mcps) = parsed.get("mcps").and_then(serde_json::Value::as_object) else {
        return Ok(None);
    };
    let mut enabled_providers = serde_json::Map::new();
    for (provider_id, provider) in mcps {
        let Some(definition) = crate::mcp_provider_registry::get_mcp_provider(provider_id) else {
            continue;
        };
        if definition.configuration_mode != "user" {
            continue;
        }
        let Some(provider) = provider.as_object() else {
            continue;
        };
        let Some(services) = provider
            .get("services")
            .and_then(serde_json::Value::as_object)
        else {
            continue;
        };
        let mut enabled_services = serde_json::Map::new();
        for (service_id, service) in services {
            let Some(service) = service.as_object() else {
                continue;
            };
            if !service
                .get("enabled")
                .is_some_and(brz_json::adapters::python_truthy)
            {
                continue;
            }
            let url = decrypt_stored(service.get("credentials"), "url", &decrypt_with_env)?;
            if url.trim().is_empty() {
                continue;
            }
            let mut stored = service.clone();
            if let Some(mut credentials) = stored
                .get("credentials")
                .and_then(serde_json::Value::as_object)
                .cloned()
            {
                credentials.insert("url".into(), serde_json::Value::String(url));
                stored.insert("credentials".into(), serde_json::Value::Object(credentials));
            }
            enabled_services.insert(service_id.clone(), serde_json::Value::Object(stored));
        }
        if enabled_services.is_empty() {
            continue;
        }
        let mut stored_provider = provider.clone();
        stored_provider.insert(
            "services".into(),
            serde_json::Value::Object(enabled_services),
        );
        enabled_providers.insert(
            provider_id.clone(),
            serde_json::Value::Object(stored_provider),
        );
    }
    if enabled_providers.is_empty() {
        Ok(None)
    } else {
        Ok(Some(enabled_providers))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &[u8] = DEFAULT_AES_KEY.as_bytes();
    const IV: &[u8] = b"1234567890123456";

    /// The production decryptor with the source's default key material, so the
    /// behavior can be exercised without process environment.
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

    /// `get_enabled_mcp_server`: both `enabled` and a non-empty (stripped)
    /// decrypted URL are required.
    #[test]
    fn enabled_provider_server_requires_enabled_and_a_non_empty_url() {
        let preferences = json!({
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {
                            "enabled": true,
                            "credentials": {"url": "N4DP229zmyi0e4Mwh5IlSg=="},
                        },
                        "table": {
                            "enabled": true,
                            "credentials": {"url": "  https://example.invalid/mcp  "},
                        },
                        "ai_table": {"enabled": false, "credentials": {"url": "https://x.invalid"}},
                        "wikispace": {"enabled": true, "credentials": {"url": "   "}},
                    }
                }
            }
        })
        .to_string();
        let enabled = |service_id: &str| {
            enabled_provider_server_with(&preferences, "dingtalk", service_id, test_decrypt)
        };
        assert_eq!(enabled("docs").unwrap(), Some("docs".to_string()));
        assert_eq!(
            enabled("table").unwrap(),
            Some("https://example.invalid/mcp".to_string())
        );
        assert_eq!(enabled("ai_table").unwrap(), None);
        assert_eq!(enabled("wikispace").unwrap(), None);
        assert_eq!(enabled("missing").unwrap(), None);
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

#[cfg(test)]
mod task_data_tests {
    use super::*;
    use serde_json::json;

    /// `_build_request_task_data`: only registry `"user"` providers, only
    /// enabled services with a non-empty URL, and the stored provider shape is
    /// kept under `{"user_mcps": ...}`.
    #[test]
    fn build_request_task_data_keeps_enabled_user_services() {
        let preferences = json!({
            "mcps": {
                "dingtalk": {
                    "services": {
                        "docs": {"enabled": true, "credentials": {"url": "https://mcp/one"}},
                        "ai_table": {"enabled": true, "credentials": {"url": "https://mcp/two"}},
                        "disabled": {"enabled": false, "credentials": {"url": "https://mcp/off"}},
                        "no_url": {"enabled": true, "credentials": {}}
                    }
                },
                "not_a_registry_provider": {
                    "services": {"x": {"enabled": true, "credentials": {"url": "https://mcp/x"}}}
                }
            }
        })
        .to_string();

        let task_data = build_request_task_data(Some(&preferences))
            .unwrap()
            .expect("enabled user MCPs produce task data");
        assert_eq!(
            task_data,
            json!({
                "user_mcps": {
                    "dingtalk": {
                        "services": {
                            "docs": {"enabled": true, "credentials": {"url": "https://mcp/one"}},
                            "ai_table": {"enabled": true, "credentials": {"url": "https://mcp/two"}}
                        }
                    }
                }
            })
        );
    }

    /// A caller without enabled user MCP services dispatches a JSON `null`.
    #[test]
    fn build_request_task_data_is_none_without_enabled_services() {
        assert!(build_request_task_data(None).unwrap().is_none());
        assert!(build_request_task_data(Some("{}")).unwrap().is_none());
        assert!(build_request_task_data(Some("not json")).unwrap().is_none());
        let only_disabled = json!({
            "mcps": {"dingtalk": {"services": {"docs": {"enabled": false}}}}
        })
        .to_string();
        assert!(
            build_request_task_data(Some(&only_disabled))
                .unwrap()
                .is_none()
        );
    }
}
