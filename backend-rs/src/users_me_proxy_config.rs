// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/proxy-config` — the current user's stored proxy status.
//!
//! Mirrors `app.api.endpoints.users.get_user_proxy_config` and
//! `app.services.user_runtime_config.UserRuntimeConfigService.get_proxy_config`
//! (`_get_proxy_kind` -> `_build_proxy_response`): authenticate the bearer
//! token (`app.core.security.get_current_user`), read the user's active
//! `UserProxyConfig` kind, decrypt its stored proxy URL through
//! `shared.utils.crypto.decrypt_sensitive_data`, and render
//! `UserProxyConfigResponse` with the masked URL. The stored ciphertext and the
//! decrypted credential are never logged.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;

use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};

use brz_mysql::{FromMysqlRow, Json, Mysql, MysqlResult};

use crate::auth::{SessionUser, UserRow};
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

/// `app.services.user_runtime_config.USER_PROXY_CONFIG_KIND`.
const USER_PROXY_CONFIG_KIND: &str = "UserProxyConfig";
/// `app.services.user_runtime_config.USER_RUNTIME_CONFIG_NAMESPACE`.
const USER_RUNTIME_CONFIG_NAMESPACE: &str = "default";
/// `app.services.user_runtime_config.USER_PROXY_CONFIG_NAME`.
const USER_PROXY_CONFIG_NAME: &str = "default";

/// `shared.utils.crypto._get_encryption_key`'s `GIT_TOKEN_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// `cryptography`'s AES block size, also the PKCS#7 block size.
const BLOCK_SIZE: usize = 16;

/// `shared.utils.crypto.CryptoConfigurationError`: `GIT_TOKEN_AES_IV` is
/// missing or not exactly one AES block. `decrypt_sensitive_data` re-raises it
/// (it is not one of the swallowed decryption failures), so the route escapes
/// to `python_exception_handler`'s 500.
#[derive(Debug)]
struct CryptoConfigurationError;

/// `UserProxyConfigResponse` (`app.api.endpoints.users`), field order preserved
/// so the rendered body matches the source model.
#[derive(serde::Serialize)]
struct UserProxyConfigResponse {
    configured: bool,
    proxy_url_masked: String,
    proxy_updated_at: Option<String>,
    updated_at: Option<String>,
}

/// One `kinds` row for the proxy-config lookup, selected with the full labeled
/// source column list; only `kinds_json` is consumed.
#[derive(Debug, FromMysqlRow)]
struct ProxyKindRow {
    kinds_json: Json<OpaqueJson>,
}

/// The `kinds.json` document, reduced to the `spec` consumed by
/// `_build_proxy_response`. A non-object document fails the projection, which
/// the caller reads as the source's empty spec.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProxyDocument {
    spec: Option<ProxySpec>,
}

/// `kind.json["spec"]` (`_get_spec`): the stored proxy credential plus the
/// document-level `updatedAt`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProxySpec {
    proxy: Option<ProxyCredential>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

/// `spec["proxy"]`: the encrypted URL and its own `updatedAt`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProxyCredential {
    #[serde(rename = "encryptedUrl")]
    encrypted_url: Option<String>,
    #[serde(rename = "updatedAt")]
    updated_at: Option<String>,
}

/// GET /api/users/me/proxy-config: the proxy-status free function, injecting
/// the process-lifetime application state.
#[brz_http_server::get("/api/users/me/proxy-config")]
async fn get_user_proxy_config(
    #[inject(state)] state: &AppState,
    #[auth] current_user: SessionUser,
) -> Result<UserProxyConfigResponse, FastApiError> {
    user_proxy_config(state, current_user.0).await
}

/// Handler body for `GET /api/users/me/proxy-config`.
async fn user_proxy_config(
    state: &AppState,
    current_user: UserRow,
) -> Result<UserProxyConfigResponse, FastApiError> {
    let row = proxy_kind(&state.mysql, current_user.id)
        .await
        .map_err(|error| {
            tracing::error!(%error, "user proxy-config read failed");
            FastApiError::unhandled()
        })?;

    // `_get_spec` yields `{}` for an absent row or a non-object `spec`.
    let spec = row
        .and_then(|row| row.kinds_json.0.project::<ProxyDocument>())
        .and_then(|document| document.spec)
        .unwrap_or_default();
    let ProxySpec {
        proxy,
        updated_at: spec_updated_at,
    } = spec;
    let ProxyCredential {
        encrypted_url,
        updated_at: proxy_updated_at,
    } = proxy.unwrap_or_default();

    let proxy_url = decrypt_stored_proxy(encrypted_url.as_deref()).map_err(|error| {
        tracing::error!(?error, "user proxy-config crypto configuration failure");
        FastApiError::unhandled()
    })?;

    Ok(UserProxyConfigResponse {
        configured: !proxy_url.is_empty(),
        proxy_url_masked: mask_proxy_url(&proxy_url),
        proxy_updated_at,
        updated_at: spec_updated_at,
    })
}

/// The source `db.query(Kind).filter(Kind.user_id == user_id, Kind.kind ==
/// 'UserProxyConfig', Kind.namespace == 'default', Kind.name == 'default',
/// Kind.is_active.is_(True)).first()` statement: the full labeled `kinds`
/// projection with the user id as the literal SQLAlchemy renders.
async fn proxy_kind<M>(mysql: &M, user_id: i32) -> MysqlResult<Option<ProxyKindRow>>
where
    M: Mysql,
{
    mysql
        .fetch_optional(
            format!(
                "SELECT kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
                 kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
                 kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
                 kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
                 kinds.updated_at AS kinds_updated_at \nFROM kinds \n\
                 WHERE kinds.user_id = {user_id} AND kinds.kind = '{USER_PROXY_CONFIG_KIND}' \
                 AND kinds.namespace = '{USER_RUNTIME_CONFIG_NAMESPACE}' \
                 AND kinds.name = '{USER_PROXY_CONFIG_NAME}' \
                 AND kinds.is_active IS true \n LIMIT 1"
            )
            .as_str(),
            (),
        )
        .await
}

/// `_get_proxy_url` over `shared.utils.crypto.decrypt_sensitive_data`: decrypt
/// the stored ciphertext, treating an empty result or the source's
/// ciphertext-echo fallback as "not configured". A missing or mis-sized
/// `GIT_TOKEN_AES_IV` is the unswallowed `CryptoConfigurationError`.
fn decrypt_stored_proxy(encrypted_url: Option<&str>) -> Result<String, CryptoConfigurationError> {
    let Some(encrypted_url) = encrypted_url.filter(|value| !value.is_empty()) else {
        return Ok(String::new());
    };
    // `_get_encryption_key`: the key defaults, the IV is required and exactly
    // one block.
    let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_AES_KEY.to_string());
    let iv = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV").ok_or(CryptoConfigurationError)?;
    if iv.len() != BLOCK_SIZE {
        return Err(CryptoConfigurationError);
    }
    let decrypted = decrypt_sensitive_data(key.as_bytes(), iv.as_bytes(), encrypted_url);
    // A decrypt/UTF-8/base64 failure returns the ciphertext unchanged, which
    // `_get_proxy_url` reads as an unconfigured proxy.
    if decrypted.is_empty() || decrypted == encrypted_url {
        return Ok(String::new());
    }
    Ok(decrypted)
}

/// `decrypt_sensitive_data` after key resolution: `""` and `"***"` pass
/// through, any decode/decrypt/UTF-8 failure returns the original ciphertext.
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

/// `_mask_proxy_url` (`app.services.user_runtime_config`): replace any
/// `user:pass@` userinfo with `***:***@` and otherwise return the URL
/// unchanged.
fn mask_proxy_url(proxy_url: &str) -> String {
    if proxy_url.is_empty() {
        return String::new();
    }
    // No authority component means `urlsplit` yields an empty username and
    // password, so the source returns the URL unchanged.
    let Some(parsed) = parse_proxy_url(proxy_url) else {
        return proxy_url.to_string();
    };
    let (username, password) = split_userinfo(parsed.netloc);
    // `if not parsed.username and not parsed.password: return proxy_url`.
    if username.is_empty() && password.is_empty() {
        return proxy_url.to_string();
    }

    let (host, port) = split_host_port(host_after_userinfo(parsed.netloc));
    let host = if host.contains(':') {
        // Bare IPv6 host: re-wrap in brackets (`.hostname` strips them).
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let port = match port.and_then(|value| value.parse::<u16>().ok()) {
        Some(port) if port != 0 => format!(":{port}"),
        _ => String::new(),
    };

    // `_replace(netloc=...).geturl()`.
    let mut masked = String::with_capacity(proxy_url.len() + 8);
    if !parsed.scheme.is_empty() {
        masked.push_str(&parsed.scheme.to_ascii_lowercase());
        masked.push(':');
    }
    masked.push_str("//***:***@");
    masked.push_str(&host);
    masked.push_str(&port);
    if !parsed.tail.is_empty() && !parsed.tail.starts_with('/') {
        masked.push('/');
    }
    masked.push_str(parsed.tail);
    masked
}

/// The `urlsplit` components consumed by [`mask_proxy_url`].
struct ProxyUrl<'a> {
    /// Lowercased scheme; empty when the URL has no valid scheme.
    scheme: &'a str,
    /// Netloc authority substring (without the leading `//`).
    netloc: &'a str,
    /// The path plus query plus fragment (empty or starting with a delimiter).
    tail: &'a str,
}

/// A minimal `urlsplit`: split the optional scheme and the `//`-introduced
/// authority from the remainder. Returns `None` when the URL has no authority
/// component (no `//` after the scheme), which the source treats as no
/// userinfo.
fn parse_proxy_url(url: &str) -> Option<ProxyUrl<'_>> {
    let (scheme, after_scheme) = split_scheme(url);
    let rest = after_scheme.strip_prefix("//")?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    Some(ProxyUrl {
        scheme,
        netloc: &rest[..end],
        tail: &rest[end..],
    })
}

/// `urlsplit`'s scheme split: a leading `[A-Za-z][A-Za-z0-9+.-]*` before the
/// first `:` is the scheme; otherwise the URL has none.
fn split_scheme(url: &str) -> (&str, &str) {
    if let Some(colon) = url.find(':') {
        let candidate = &url[..colon];
        let mut chars = candidate.chars();
        if chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        {
            return (&url[..colon], &url[colon + 1..]);
        }
    }
    ("", url)
}

/// `SplitResult`'s `username` and `password`: the netloc userinfo split on
/// the first `:`; both empty when there is no userinfo.
fn split_userinfo(netloc: &str) -> (&str, &str) {
    let Some(at) = netloc.rfind('@') else {
        return ("", "");
    };
    let userinfo = &netloc[..at];
    if userinfo.is_empty() {
        return ("", "");
    }
    match userinfo.find(':') {
        Some(colon) => (&userinfo[..colon], &userinfo[colon + 1..]),
        None => (userinfo, ""),
    }
}

/// `_hostinfo`: the netloc after the last `@`.
fn host_after_userinfo(netloc: &str) -> &str {
    match netloc.rfind('@') {
        Some(at) => &netloc[at + 1..],
        None => netloc,
    }
}

/// Split the lowercased host and its port from `hostinfo`. A bracketed IPv6
/// literal keeps its brackets in the host and drops them before returning.
fn split_host_port(hostinfo: &str) -> (String, Option<&str>) {
    if let Some(rest) = hostinfo.strip_prefix('[')
        && let Some(close) = rest.find(']')
    {
        let host = rest[..close].to_ascii_lowercase();
        let after = &rest[close + 1..];
        let port = after.strip_prefix(':').filter(|value| !value.is_empty());
        return (host, port);
    }
    let (host, port) = match hostinfo.rfind(':') {
        Some(colon) => (
            &hostinfo[..colon],
            Some(&hostinfo[colon + 1..]).filter(|value| !value.is_empty()),
        ),
        None => (hostinfo, None),
    };
    (host.to_ascii_lowercase(), port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_document(raw: &str) -> Option<ProxyDocument> {
        OpaqueJson::from(serde_json::from_str::<serde_json::Value>(raw).unwrap()).project()
    }

    #[test]
    fn constants_match_source() {
        assert_eq!(USER_PROXY_CONFIG_KIND, "UserProxyConfig");
        assert_eq!(USER_RUNTIME_CONFIG_NAMESPACE, "default");
        assert_eq!(USER_PROXY_CONFIG_NAME, "default");
        assert_eq!(DEFAULT_AES_KEY, "12345678901234567890123456789012");
    }

    #[test]
    fn decrypts_a_stored_proxy_url() {
        // `openssl enc -aes-256-cbc -base64` over "http://127.0.0.1:7897" with
        // the default key and the 16-byte IV.
        let key = DEFAULT_AES_KEY.as_bytes();
        let iv = b"1234567890123456";
        assert_eq!(
            decrypt_sensitive_data(key, iv, "1AGq7v94AJ47aC9qKcsOdhwLg3Ej4DRIMJzqjnfAGB0="),
            "http://127.0.0.1:7897"
        );
        // A ciphertext with userinfo decrypts to the full URL before masking.
        assert_eq!(
            decrypt_sensitive_data(
                key,
                iv,
                "9k7/+Yc54n/AZo6h6tPTny9S47lGUTq2nwipe91+e1n7hO/hXX9z7ktKzPv6JzVu"
            ),
            "http://user:pass@proxy.example.com:8080"
        );
    }

    #[test]
    fn undecryptable_payloads_echo_the_ciphertext() {
        // Not base64, valid base64 that is not block aligned, and the source
        // pass-through markers.
        assert_eq!(
            decrypt_sensitive_data(
                DEFAULT_AES_KEY.as_bytes(),
                b"1234567890123456",
                "not base64!"
            ),
            "not base64!"
        );
        assert_eq!(
            decrypt_sensitive_data(DEFAULT_AES_KEY.as_bytes(), b"1234567890123456", "AAAA"),
            "AAAA"
        );
        assert_eq!(
            decrypt_sensitive_data(DEFAULT_AES_KEY.as_bytes(), b"1234567890123456", "***"),
            "***"
        );
        assert_eq!(
            decrypt_sensitive_data(DEFAULT_AES_KEY.as_bytes(), b"1234567890123456", ""),
            ""
        );
    }

    #[test]
    fn mask_returns_credential_free_urls_unchanged() {
        assert_eq!(mask_proxy_url(""), "");
        assert_eq!(
            mask_proxy_url("http://127.0.0.1:7897"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            mask_proxy_url("socks5://proxy.example.com:1080"),
            "socks5://proxy.example.com:1080"
        );
    }

    #[test]
    fn mask_replaces_userinfo() {
        assert_eq!(
            mask_proxy_url("http://user:pass@proxy.example.com:8080"),
            "http://***:***@proxy.example.com:8080"
        );
        // A username-only userinfo still triggers masking.
        assert_eq!(
            mask_proxy_url("http://user@127.0.0.1:7897"),
            "http://***:***@127.0.0.1:7897"
        );
        // Empty userinfo does not.
        assert_eq!(
            mask_proxy_url("http://:@127.0.0.1:7897"),
            "http://:@127.0.0.1:7897"
        );
    }

    #[test]
    fn mask_keeps_ipv6_brackets_and_trailing_path() {
        assert_eq!(
            mask_proxy_url("http://user:pass@[::1]:7897"),
            "http://***:***@[::1]:7897"
        );
        assert_eq!(
            mask_proxy_url("http://user:pass@proxy.example.com:8080/path?q=1"),
            "http://***:***@proxy.example.com:8080/path?q=1"
        );
    }

    #[test]
    fn document_projection_reads_spec() {
        let document = parse_document(
            r#"{"kind":"UserProxyConfig","spec":{"proxy":{"encryptedUrl":"abc","updatedAt":"t1"},"updatedAt":"t2"}}"#,
        )
        .unwrap();
        let spec = document.spec.unwrap();
        assert_eq!(spec.updated_at.as_deref(), Some("t2"));
        let proxy = spec.proxy.unwrap();
        assert_eq!(proxy.encrypted_url.as_deref(), Some("abc"));
        assert_eq!(proxy.updated_at.as_deref(), Some("t1"));
    }

    #[test]
    fn absent_or_malformed_spec_yields_defaults() {
        for raw in [
            "{}",
            "null",
            r#"{"spec": "not-an-object"}"#,
            r#"{"spec": 3}"#,
        ] {
            let spec = parse_document(raw).and_then(|document| document.spec);
            assert!(spec.is_none(), "expected no spec for {raw}");
        }
    }

    #[test]
    fn response_field_order_matches_model() {
        let body = UserProxyConfigResponse {
            configured: true,
            proxy_url_masked: "http://127.0.0.1:7897".to_string(),
            proxy_updated_at: Some("2026-06-11T11:30:03.236235+00:00".to_string()),
            updated_at: None,
        };
        let value = crate::json_contract_tests::serialized(body).unwrap();
        let keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "configured",
                "proxy_url_masked",
                "proxy_updated_at",
                "updated_at"
            ]
        );
        assert_eq!(value["updated_at"], json!(null));
    }
}
