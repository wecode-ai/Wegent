// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `UserMCPService`'s OAuth credential store: the decrypted token read, the
//! refreshed-credential write, and the rejected-grant clear, all inside the
//! `users.preferences` document (`app/services/user_mcp_service.py`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value};

use aes_gcm::aes::{Aes128, Aes192, Aes256};
use cbc::Encryptor;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};

use crate::http_compat::FastApiError;
use crate::json_compat::python_json_value;
use crate::mcp_user_service::{
    BLOCK_SIZE, CryptoError, decrypt_stored, decrypt_with_env, encryption_key, is_data_encrypted,
};

/// `get_service_oauth_credentials`'s return value: the decrypted token material
/// the request builder needs to authorize a provider MCP request.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ServiceOAuthCredentials {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub scope: String,
}

/// `get_service_oauth_credentials`: the provider service's stored OAuth
/// credentials, decrypted. A missing service or credentials object reads as
/// empty values.
pub(crate) fn service_oauth_credentials(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
) -> Result<ServiceOAuthCredentials, FastApiError> {
    let parsed = parse_document(preferences);
    let credentials = parsed
        .get("mcps")
        .and_then(|mcps| mcps.get(provider_id))
        .and_then(|provider| provider.get("services"))
        .and_then(|services| services.get(service_id))
        .and_then(|service| service.get("credentials"));
    // `int(expires_at) if isinstance(expires_at, int) else 0`.
    let expires_at = credentials
        .and_then(|credentials| credentials.get("expires_at"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Ok(ServiceOAuthCredentials {
        access_token: decrypt_stored(credentials, "access_token", &decrypt_with_env)?,
        refresh_token: decrypt_stored(credentials, "refresh_token", &decrypt_with_env)?,
        expires_at,
        scope: decrypt_stored(credentials, "scope", &decrypt_with_env)?,
    })
}

/// `get_provider_oauth_client`'s return value: the cached OAuth client
/// registration of a provider.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct ProviderOAuthClient {
    pub token_endpoint: String,
    pub client_id: String,
}

/// `get_provider_oauth_client`: `mcps.<provider_id>.oauth`'s
/// `token_endpoint` and `client_id`.
pub(crate) fn provider_oauth_client(preferences: &str, provider_id: &str) -> ProviderOAuthClient {
    let parsed = parse_document(preferences);
    let client = parsed
        .get("mcps")
        .and_then(|mcps| mcps.get(provider_id))
        .and_then(|provider| provider.get("oauth"));
    ProviderOAuthClient {
        token_endpoint: string_field(client, "token_endpoint"),
        client_id: string_field(client, "client_id"),
    }
}

/// `save_service_oauth_credentials`: store freshly issued OAuth credentials on
/// a provider service and mark the service `oauth`. Returns the serialized
/// preferences document exactly as `json.dumps` renders it.
pub(crate) fn save_service_oauth_credentials(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
    access_token: &str,
    refresh_token: &str,
    expires_at: i64,
    scope: &str,
) -> Result<String, FastApiError> {
    save_service_oauth_credentials_with(
        preferences,
        provider_id,
        service_id,
        access_token,
        refresh_token,
        expires_at,
        scope,
        encrypt_with_env,
    )
}

/// [`save_service_oauth_credentials`] with an explicit credential encryptor, so
/// the stored document shape can be exercised without process environment.
#[allow(clippy::too_many_arguments)]
fn save_service_oauth_credentials_with(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
    access_token: &str,
    refresh_token: &str,
    expires_at: i64,
    scope: &str,
    encrypt: impl Fn(&str) -> Result<String, FastApiError>,
) -> Result<String, FastApiError> {
    let mut prefs = preferences_object(preferences);
    let mut service = service_object(&prefs, provider_id, service_id);
    let mut credentials = service
        .get("credentials")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    credentials.insert(
        "access_token".into(),
        Value::String(encrypt_stored(access_token, &encrypt)?),
    );
    if !refresh_token.is_empty() {
        credentials.insert(
            "refresh_token".into(),
            Value::String(encrypt_stored(refresh_token, &encrypt)?),
        );
    }
    credentials.insert("expires_at".into(), Value::from(expires_at));
    if !scope.is_empty() {
        credentials.insert(
            "scope".into(),
            Value::String(encrypt_stored(scope, &encrypt)?),
        );
    }
    service.insert("credentials".into(), Value::Object(credentials));
    service.insert("auth_mode".into(), Value::String("oauth".into()));
    set_service(&mut prefs, provider_id, service_id, service);
    Ok(python_json_value(&Value::Object(prefs)))
}

/// `clear_service_oauth_credentials`: drop the stored OAuth token entries while
/// keeping the service configured. Returns the serialized preferences document.
pub(crate) fn clear_service_oauth_credentials(
    preferences: &str,
    provider_id: &str,
    service_id: &str,
) -> Result<String, FastApiError> {
    let mut prefs = preferences_object(preferences);
    let mut service = service_object(&prefs, provider_id, service_id);
    // `_clear_oauth_credentials`: pop the token keys and keep the rest.
    let mut credentials = service
        .get("credentials")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for key in [
        "access_token",
        "refresh_token",
        "expires_at",
        "scope",
        "account",
    ] {
        credentials.shift_remove(key);
    }
    if credentials.is_empty() {
        service.shift_remove("credentials");
    } else {
        service.insert("credentials".into(), Value::Object(credentials));
    }
    set_service(&mut prefs, provider_id, service_id, service);
    Ok(python_json_value(&Value::Object(prefs)))
}

/// `load_preferences`: an unparsable or non-object payload is an empty map.
fn preferences_object(preferences: &str) -> Map<String, Value> {
    match parse_document(preferences) {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// `get_service_oauth_credentials`'s parse boundary: `json.loads`, with the
/// source's `{}` fallback for an empty or unparsable payload.
fn parse_document(preferences: &str) -> Value {
    if preferences.is_empty() {
        return Value::Object(Map::new());
    }
    serde_json::from_str(preferences).unwrap_or(Value::Null)
}

/// `_get_service`: a provider service object copy, or an empty map.
fn service_object(
    prefs: &Map<String, Value>,
    provider_id: &str,
    service_id: &str,
) -> Map<String, Value> {
    prefs
        .get("mcps")
        .and_then(|mcps| mcps.get(provider_id))
        .and_then(|provider| provider.get("services"))
        .and_then(|services| services.get(service_id))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

/// `_set_service`: write the service object back, creating the intermediate
/// maps. Every assignment keeps an existing key's position, as Python does.
fn set_service(
    prefs: &mut Map<String, Value>,
    provider_id: &str,
    service_id: &str,
    service: Map<String, Value>,
) {
    let mut mcps = prefs
        .get("mcps")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut provider = mcps
        .get(provider_id)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut services = provider
        .get("services")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    services.insert(service_id.to_owned(), Value::Object(service));
    provider.insert("services".into(), Value::Object(services));
    mcps.insert(provider_id.to_owned(), Value::Object(provider));
    prefs.insert("mcps".into(), Value::Object(mcps));
}

/// `_encrypt`: an already-encrypted value is kept, everything else is encrypted
/// with the configured key material.
fn encrypt_with_env(value: &str) -> Result<String, FastApiError> {
    let material = encryption_key().map_err(|_| FastApiError::unhandled())?;
    encrypt_sensitive_data(&material.key, &material.iv, value)
        .map_err(|_| FastApiError::unhandled())
}

/// [`encrypt_with_env`] with an explicit encryptor.
fn encrypt_stored(
    value: &str,
    encrypt: impl Fn(&str) -> Result<String, FastApiError>,
) -> Result<String, FastApiError> {
    if is_data_encrypted(value) {
        return Ok(value.to_owned());
    }
    encrypt(value)
}

/// A stored string field, or `""` when it is absent or not a string.
fn string_field(value: Option<&Value>, key: &str) -> String {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// `encrypt_sensitive_data` after key resolution: `""` and `"***"` pass
/// through, and the ciphertext is base64 encoded.
pub(crate) fn encrypt_sensitive_data(
    key: &[u8],
    iv: &[u8],
    text: &str,
) -> Result<String, CryptoError> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if text == "***" {
        return Ok(text.to_string());
    }
    encrypt_cbc(key, iv, text).map(|encrypted| STANDARD.encode(encrypted))
}

/// `AES(key)` + `CBC(iv)` + PKCS#7: the variant follows the configured key
/// length, exactly as `cryptography`'s `algorithms.AES`.
fn encrypt_cbc(key: &[u8], iv: &[u8], plain: &str) -> Result<Vec<u8>, CryptoError> {
    let iv: [u8; BLOCK_SIZE] = iv.try_into().map_err(|_| CryptoError::InvalidIv)?;
    match key.len() {
        16 => Ok(Encryptor::<Aes128>::new_from_slices(key, &iv)
            .map_err(|_| CryptoError::InvalidKey)?
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes())),
        24 => Ok(Encryptor::<Aes192>::new_from_slices(key, &iv)
            .map_err(|_| CryptoError::InvalidKey)?
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes())),
        32 => Ok(Encryptor::<Aes256>::new_from_slices(key, &iv)
            .map_err(|_| CryptoError::InvalidKey)?
            .encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes())),
        _ => Err(CryptoError::InvalidKey),
    }
}

#[cfg(test)]
#[path = "mcp_oauth_credentials_tests.rs"]
mod tests;
