// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/users/me/runtime-configs/{runtime}` — the current user's runtime
//! configuration status.
//!
//! Mirrors `app.api.endpoints.users.get_user_runtime_config` ->
//! `UserRuntimeConfigService.get_config`
//! (`app/services/user_runtime_config.py`). The source pipeline authenticates
//! the bearer session (`security.get_current_user`, the labeled `users`
//! lookup), normalizes the runtime, reads the user's `UserRuntimeConfig` and
//! `UserProxyConfig` kind documents, and renders `UserRuntimeConfigResponse`.
use std::collections::BTreeMap;

use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use brz_http_server::StatusCode;
use brz_mysql::{FromMysqlRow, Json};
use serde::{Deserialize, Serialize};

use crate::auth::SessionUser;
use crate::http_compat::FastApiError;
use crate::json_compat::OpaqueJson;
use crate::state::AppState;

/// `USER_RUNTIME_CONFIG_KIND`.
const RUNTIME_CONFIG_KIND: &str = "UserRuntimeConfig";
/// `USER_PROXY_CONFIG_KIND`.
const PROXY_CONFIG_KIND: &str = "UserProxyConfig";
/// `USER_RUNTIME_CONFIG_NAMESPACE`.
const CONFIG_NAMESPACE: &str = "default";
/// `USER_PROXY_CONFIG_NAME`.
const PROXY_CONFIG_NAME: &str = "default";
/// `_get_encryption_key`'s `GIT_TOKEN_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// `cryptography`'s AES block size, also the PKCS#7 block size.
const AES_BLOCK_SIZE: usize = 16;

/// `kinds` columns as rendered by `db.query(Kind)` (labeled projection).
const KIND_COLUMNS: &str = "kinds.id AS kinds_id, kinds.user_id AS kinds_user_id, \
     kinds.kind AS kinds_kind, kinds.name AS kinds_name, \
     kinds.namespace AS kinds_namespace, kinds.json AS kinds_json, \
     kinds.is_active AS kinds_is_active, kinds.created_at AS kinds_created_at, \
     kinds.updated_at AS kinds_updated_at";

/// One `RUNTIME_AUTH_FILES` entry (`target_path`, `display_name`).
struct RuntimeAuthFile {
    target_path: &'static str,
    display_name: &'static str,
}

/// `RUNTIME_AUTH_FILES`: only `codex` is a supported runtime.
fn runtime_auth_file(runtime: &str) -> Option<RuntimeAuthFile> {
    match runtime {
        "codex" => Some(RuntimeAuthFile {
            target_path: "auth.json",
            display_name: "Codex",
        }),
        _ => None,
    }
}

/// GET /api/users/me/runtime-configs/{runtime}: the runtime-config free
/// function, injecting the process-lifetime application state.
#[brz_http_server::get("/api/users/me/runtime-configs/:runtime")]
async fn get_user_runtime_config(
    #[inject(state)] state: &AppState,
    #[auth] user: SessionUser,
    runtime: &str,
) -> Result<UserRuntimeConfigResponse, FastApiError> {
    user_runtime_config(state, &user.0, runtime).await
}

/// Handler body for `GET /api/users/me/runtime-configs/{runtime}`.
async fn user_runtime_config(
    state: &AppState,
    user: &crate::auth::UserRow,
    runtime: &str,
) -> Result<UserRuntimeConfigResponse, FastApiError> {
    let normalized = normalize_runtime(runtime)?;
    let config = fetch_kind(state, RUNTIME_CONFIG_KIND, &normalized, user.id).await?;
    let proxy = fetch_kind(state, PROXY_CONFIG_KIND, PROXY_CONFIG_NAME, user.id).await?;
    build_response(
        &normalized,
        config.as_ref(),
        &user.preferences,
        proxy.as_ref(),
    )
}

/// `_normalize_runtime`: strip and lowercase; an unsupported runtime is the
/// source `UserRuntimeConfigError`, rendered as its `400 {"detail": ...}`.
fn normalize_runtime(runtime: &str) -> Result<String, FastApiError> {
    let normalized = runtime.trim().to_lowercase();
    if runtime_auth_file(&normalized).is_none() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Unsupported runtime: {runtime}"),
        ));
    }
    Ok(normalized)
}

/// One `kinds` row of a runtime-config lookup; only `kinds_json` is consumed.
#[derive(Debug, FromMysqlRow)]
struct KindDocumentRow {
    #[mysql(rename = "kinds_json")]
    kinds_json: Json<OpaqueJson>,
}

/// `UserRuntimeConfigService._get_kind` / `_get_proxy_kind`: the first active
/// kind with the exact `user_id`/`kind`/`namespace`/`name`.
async fn fetch_kind(
    state: &AppState,
    kind: &str,
    name: &str,
    user_id: i32,
) -> Result<Option<KindDocumentRow>, FastApiError> {
    let sql = format!(
        "SELECT {KIND_COLUMNS} \nFROM kinds \nWHERE kinds.user_id = {user_id} \
         AND kinds.kind = {} AND kinds.namespace = {} AND kinds.name = {} \
         AND kinds.is_active IS true \n LIMIT 1",
        quote_literal(kind),
        quote_literal(CONFIG_NAMESPACE),
        quote_literal(name),
    );
    state.mysql.fetch_optional(&sql, ()).await.map_err(|error| {
        tracing::error!(%error, "runtime-config kind lookup failed");
        FastApiError::unhandled()
    })
}

/// SQL string literal, escaping like SQLAlchemy's rendering.
fn quote_literal(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for byte in value.bytes() {
        match byte {
            b'\'' => out.push_str("\\'"),
            b'\\' => out.push_str("\\\\"),
            b'\0' => out.push_str("\\0"),
            b'\n' => out.push_str("\\n"),
            b'\r' => out.push_str("\\r"),
            b'\x1a' => out.push_str("\\Z"),
            other => out.push(other as char),
        }
    }
    out.push('\'');
    out
}

/// The stored kind CRD document (`kind.json`), of which only `spec` is read.
#[derive(Debug, Default, Deserialize)]
struct StoredKindDocument {
    #[serde(default)]
    spec: Option<StoredSpec>,
}

/// `kind.json["spec"]`; a non-object spec is an absent projection.
#[derive(Debug, Default, Deserialize)]
struct StoredSpec {
    #[serde(default)]
    auth: Option<StoredAuth>,
    #[serde(default)]
    proxy: Option<StoredProxy>,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
}

/// `spec["auth"]` for a `UserRuntimeConfig` document.
#[derive(Debug, Default, Deserialize)]
struct StoredAuth {
    #[serde(default, rename = "encryptedValue")]
    encrypted_value: Option<LooseJson>,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
}

/// `spec["proxy"]` for a `UserProxyConfig` document.
#[derive(Debug, Default, Deserialize)]
struct StoredProxy {
    #[serde(default, rename = "encryptedUrl")]
    encrypted_url: Option<LooseJson>,
    #[serde(default, rename = "updatedAt")]
    updated_at: Option<String>,
}

/// `_get_spec(kind)`: `kind.json.get("spec")` when it decodes as an object.
fn spec_of(row: Option<&KindDocumentRow>) -> Option<StoredSpec> {
    row?.kinds_json.0.project::<StoredKindDocument>()?.spec
}

/// The public preference document, projected far enough to reproduce
/// `load_runtime_preferences` and the source's dict checks.
#[derive(Debug, Default, Deserialize)]
struct StoredPreferences {
    #[serde(default)]
    runtime_configs: Option<LooseJson>,
}

/// `is_runtime_user_config_enabled`: `preferences.runtime_configs[runtime]`
/// must be an object whose `use_user_config` is truthy.
fn is_runtime_user_config_enabled(preferences: &str, runtime: &str) -> bool {
    let Some(preferences) = OpaqueJson::from_json_text(preferences)
        .and_then(|document| document.project::<StoredPreferences>())
    else {
        return false;
    };
    let Some(LooseJson::Object(runtime_configs)) = preferences.runtime_configs else {
        return false;
    };
    let Some(LooseJson::Object(config)) = runtime_configs.get(runtime) else {
        return false;
    };
    config.get("use_user_config").is_some_and(truthy)
}

/// An arbitrary JSON value projected far enough to reproduce Python
/// truthiness and the source's strict dict checks.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LooseJson {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<LooseJson>),
    Object(BTreeMap<String, LooseJson>),
}

/// Python truthiness of a decoded JSON value.
fn truthy(value: &LooseJson) -> bool {
    match value {
        LooseJson::Null => false,
        LooseJson::Bool(value) => *value,
        LooseJson::Number(value) => *value != 0.0,
        LooseJson::String(value) => !value.is_empty(),
        LooseJson::Array(value) => !value.is_empty(),
        LooseJson::Object(value) => !value.is_empty(),
    }
}

/// `UserRuntimeConfigResponse` (`app.api.endpoints.users`) in the model's
/// declaration order.
#[derive(Debug, Serialize)]
struct UserRuntimeConfigResponse {
    runtime: String,
    display_name: String,
    use_user_config: bool,
    use_proxy: bool,
    configured: bool,
    target_path: String,
    auth_json_sha256: Option<String>,
    auth_json_updated_at: Option<String>,
    proxy_configured: bool,
    proxy_url_masked: String,
    proxy_updated_at: Option<String>,
    updated_at: Option<String>,
}

/// `_build_response`: read the stored runtime and proxy documents, decrypt the
/// stored proxy URL, and render the public status.
fn build_response(
    runtime: &str,
    config: Option<&KindDocumentRow>,
    preferences: &str,
    proxy: Option<&KindDocumentRow>,
) -> Result<UserRuntimeConfigResponse, FastApiError> {
    let Some(auth_file) = runtime_auth_file(runtime) else {
        // `normalize_runtime` rejects every other runtime first.
        return Err(FastApiError::unhandled());
    };
    let spec = spec_of(config);
    let auth = spec.as_ref().and_then(|spec| spec.auth.as_ref());
    let proxy_spec = spec_of(proxy);
    let proxy_url = proxy_url(proxy)?;
    let has_proxy_url = !proxy_url.is_empty();
    Ok(UserRuntimeConfigResponse {
        runtime: runtime.to_string(),
        display_name: auth_file.display_name.to_string(),
        use_user_config: is_runtime_user_config_enabled(preferences, runtime),
        use_proxy: has_proxy_url,
        configured: auth
            .and_then(|auth| auth.encrypted_value.as_ref())
            .is_some_and(truthy),
        target_path: auth_file.target_path.to_string(),
        auth_json_sha256: auth.and_then(|auth| auth.sha256.clone()),
        auth_json_updated_at: auth.and_then(|auth| auth.updated_at.clone()),
        proxy_configured: has_proxy_url,
        proxy_url_masked: mask_proxy_url(&proxy_url),
        proxy_updated_at: proxy_spec
            .as_ref()
            .and_then(|spec| spec.proxy.as_ref())
            .and_then(|proxy| proxy.updated_at.clone()),
        updated_at: spec.and_then(|spec| spec.updated_at),
    })
}

/// `_get_proxy_url`: the decrypted stored proxy URL, or `""` when it is absent
/// or cannot be recovered (the source treats an unchanged ciphertext as empty).
fn proxy_url(proxy: Option<&KindDocumentRow>) -> Result<String, FastApiError> {
    let encrypted = spec_of(proxy)
        .and_then(|spec| spec.proxy)
        .and_then(|proxy| proxy.encrypted_url);
    let Some(LooseJson::String(encrypted)) = encrypted.filter(truthy) else {
        // `if not encrypted_url: return ""` — a non-string truthy value fails
        // the source decryption and is treated as absent as well.
        return Ok(String::new());
    };
    let decrypted = decrypt_sensitive_data(&encrypted)?;
    if decrypted.is_empty() || decrypted == encrypted {
        return Ok(String::new());
    }
    Ok(decrypted)
}

/// `decrypt_sensitive_data` (`shared/utils/crypto.py`): AES-256-CBC with the
/// fixed `GIT_TOKEN_AES_IV`. A missing or mis-sized IV is the source
/// `CryptoConfigurationError`, which propagates as the app's 500; every other
/// failure returns the original ciphertext.
fn decrypt_sensitive_data(text: &str) -> Result<String, FastApiError> {
    if text.is_empty() {
        return Ok(String::new());
    }
    if text == "***" {
        return Ok("***".to_string());
    }
    let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_AES_KEY.to_string());
    // `_get_encryption_key` validates the IV before decrypting.
    let Some(iv) = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV") else {
        return Err(FastApiError::unhandled());
    };
    if iv.len() != AES_BLOCK_SIZE {
        return Err(FastApiError::unhandled());
    }
    Ok(decrypt_cbc(key.as_bytes(), iv.as_bytes(), text).unwrap_or_else(|| text.to_string()))
}

/// `AES(key)` + `CBC(iv)` + PKCS#7 unpadding; the variant follows the
/// configured key length. Every decode/decrypt/unpad/UTF-8 failure is `None`.
fn decrypt_cbc(key: &[u8], iv: &[u8], text: &str) -> Option<String> {
    let iv: [u8; AES_BLOCK_SIZE] = iv.try_into().ok()?;
    let encrypted = STANDARD.decode(text.as_bytes()).ok()?;
    let plain = match key.len() {
        16 => cbc_decrypt::<Aes128>(key, iv, &encrypted),
        24 => cbc_decrypt::<Aes192>(key, iv, &encrypted),
        32 => cbc_decrypt::<Aes256>(key, iv, &encrypted),
        _ => None,
    }?;
    String::from_utf8(plain).ok()
}

/// CBC decryption of whole blocks, chaining each plaintext block with the
/// preceding ciphertext block.
fn cbc_decrypt<C>(key: &[u8], iv: [u8; AES_BLOCK_SIZE], encrypted: &[u8]) -> Option<Vec<u8>>
where
    C: BlockDecrypt + KeyInit,
{
    let cipher = C::new_from_slice(key).ok()?;
    if encrypted.is_empty() || !encrypted.len().is_multiple_of(AES_BLOCK_SIZE) {
        return None;
    }
    let mut previous = iv;
    let mut plain = Vec::with_capacity(encrypted.len());
    for chunk in encrypted.as_chunks::<AES_BLOCK_SIZE>().0 {
        let mut block = Block::<C>::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        let mut decrypted = [0u8; AES_BLOCK_SIZE];
        for (target, (byte, mask)) in decrypted.iter_mut().zip(block.iter().zip(previous.iter())) {
            *target = byte ^ mask;
        }
        plain.extend_from_slice(&decrypted);
        previous.copy_from_slice(chunk);
    }
    unpad_pkcs7(plain)
}

/// `padding.PKCS7(128).unpadder()`: the trailing byte is the pad length and
/// every padded byte repeats it.
fn unpad_pkcs7(mut plain: Vec<u8>) -> Option<Vec<u8>> {
    let padding = usize::from(*plain.last()?);
    if padding == 0 || padding > AES_BLOCK_SIZE || padding > plain.len() {
        return None;
    }
    let content = plain.len() - padding;
    if plain[content..]
        .iter()
        .any(|byte| usize::from(*byte) != padding)
    {
        return None;
    }
    plain.truncate(content);
    Some(plain)
}

/// `_mask_proxy_url`: redact embedded credentials, leaving the host and port.
fn mask_proxy_url(proxy_url: &str) -> String {
    if proxy_url.is_empty() {
        return String::new();
    }
    let Ok(mut parsed) = url::Url::parse(proxy_url) else {
        return proxy_url.to_string();
    };
    if parsed.username().is_empty() && parsed.password().is_none() {
        return proxy_url.to_string();
    }
    let _ = parsed.set_username("***");
    let _ = parsed.set_password(Some("***"));
    parsed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a `kinds_json` column from a JSON document text.
    fn document(json: &str) -> KindDocumentRow {
        KindDocumentRow {
            kinds_json: Json(OpaqueJson::from_json_text(json).expect("valid JSON")),
        }
    }

    #[test]
    fn normalizes_and_rejects_unsupported_runtimes() {
        assert_eq!(normalize_runtime("  CODEX ").unwrap(), "codex");
        let error = normalize_runtime("  claude  ").unwrap_err();
        assert_eq!(error.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error.detail_message(),
            Some("Unsupported runtime:   claude  ")
        );
    }

    #[test]
    fn decrypts_registered_cbc_vectors() {
        // Vectors produced with `openssl enc -aes-256-cbc` and the source's
        // default key/IV; a change to chaining or unpadding fails here.
        assert_eq!(
            decrypt_cbc(
                DEFAULT_AES_KEY.as_bytes(),
                b"1234567890123456",
                "caUaFV2wgkYz1SIrepv7PQ=="
            )
            .unwrap(),
            "wegent"
        );
        assert_eq!(
            decrypt_cbc(
                DEFAULT_AES_KEY.as_bytes(),
                b"1234567890123456",
                "2pAdJlwroOUFjVkE7K4006Gy9PEXsHP9UD4+Zn8HF4go+w1u5sOcNnzL2QaEYHvt"
            )
            .unwrap(),
            "http://proxy.example.invalid:8080"
        );
        assert!(
            decrypt_cbc(
                DEFAULT_AES_KEY.as_bytes(),
                b"1234567890123456",
                "not-base64!"
            )
            .is_none()
        );
    }

    #[test]
    fn masks_only_urls_with_credentials() {
        assert_eq!(mask_proxy_url(""), "");
        assert_eq!(
            mask_proxy_url("http://127.0.0.1:7897"),
            "http://127.0.0.1:7897"
        );
        assert_eq!(
            mask_proxy_url("socks5://alice:secret@127.0.0.1:1080"),
            "socks5://***:***@127.0.0.1:1080"
        );
    }

    #[test]
    fn enabled_flag_follows_nested_truthiness() {
        assert!(is_runtime_user_config_enabled(
            r#"{"runtime_configs":{"codex":{"use_user_config":true}}}"#,
            "codex"
        ));
        assert!(!is_runtime_user_config_enabled(
            r#"{"runtime_configs":{"codex":{"use_user_config":false}}}"#,
            "codex"
        ));
        assert!(!is_runtime_user_config_enabled(
            r#"{"runtime_configs":{"claude":{"use_user_config":true}}}"#,
            "codex"
        ));
        assert!(!is_runtime_user_config_enabled(
            r#"{"runtime_configs":[]}"#,
            "codex"
        ));
        assert!(!is_runtime_user_config_enabled(
            r#"{"runtime_configs":{}}"#,
            "codex"
        ));
        assert!(!is_runtime_user_config_enabled("{}", "codex"));
        assert!(!is_runtime_user_config_enabled("", "codex"));
        assert!(!is_runtime_user_config_enabled("null", "codex"));
        assert!(is_runtime_user_config_enabled(
            r#"{"runtime_configs":{"codex":{"use_user_config":{"non_empty":1}}}}"#,
            "codex"
        ));
    }

    #[test]
    fn response_matches_the_source_field_order() {
        let config = document(
            r#"{"kind":"UserRuntimeConfig","spec":{"auth":{"format":"json",
               "sha256":"abc123","updatedAt":"2026-06-10T08:57:19.147352+00:00",
               "targetPath":"~/.codex/auth.json","encryptedValue":"cipher"},
               "runtime":"codex","updatedAt":"2026-06-10T08:57:19.147352+00:00"}}"#,
        );
        let body = build_response(
            "codex",
            Some(&config),
            r#"{"runtime_configs":{"codex":{"use_user_config":true}}}"#,
            None,
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"runtime\":\"codex\",\"display_name\":\"Codex\",\"use_user_config\":true,\
             \"use_proxy\":false,\"configured\":true,\"target_path\":\"auth.json\",\
             \"auth_json_sha256\":\"abc123\",\
             \"auth_json_updated_at\":\"2026-06-10T08:57:19.147352+00:00\",\
             \"proxy_configured\":false,\"proxy_url_masked\":\"\",\
             \"proxy_updated_at\":null,\
             \"updated_at\":\"2026-06-10T08:57:19.147352+00:00\"}"
        );
    }

    #[test]
    fn absent_documents_render_defaults() {
        let body = build_response("codex", None, "{}", None).unwrap();
        assert_eq!(
            serde_json::to_string(&body).unwrap(),
            "{\"runtime\":\"codex\",\"display_name\":\"Codex\",\"use_user_config\":false,\
             \"use_proxy\":false,\"configured\":false,\"target_path\":\"auth.json\",\
             \"auth_json_sha256\":null,\"auth_json_updated_at\":null,\
             \"proxy_configured\":false,\"proxy_url_masked\":\"\",\
             \"proxy_updated_at\":null,\"updated_at\":null}"
        );
    }
}
