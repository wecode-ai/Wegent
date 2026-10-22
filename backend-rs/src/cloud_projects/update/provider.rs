// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `provider_config` normalisation for the cloud-project update:
//! `app.schemas.cloud_project.normalize_provider_config` and
//! `app.core.provider_credentials.store_provider_config`.
//!
//! `store_provider_config` encrypts a supplied provider token with AES-256-GCM
//! under a key derived from the JWT key
//! (`sha256("wegent-cloud-project-provider:{SECRET_KEY}")`), keeping the
//! credential context (`{provider}:{domain}:{repository}`) as additional
//! authenticated data. The read path in `board_snapshot::external_provider`
//! decrypts the same envelope.
use base64::Engine as _;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// `settings.SECRET_KEY` default when the environment omits the key.
const DEFAULT_JWT_KEY: &str = "secret-key";
/// `provider_credentials.CREDENTIAL_VERSION`.
const CREDENTIAL_VERSION: i64 = 2;
/// `provider_credentials.CREDENTIAL_ALGORITHM`.
const CREDENTIAL_ALGORITHM: &str = "aes-256-gcm";
/// `provider_credentials.NONCE_BYTES`.
const NONCE_BYTES: usize = 12;

/// The provider kinds `normalize_provider_config` recognises.
const LOCAL: &str = "local";
const DINGTALK: &str = "dingtalk_aitable";

/// `normalize_provider_config(task_provider, provider_config)`: validate and
/// canonicalise a submitted provider config. `Err` is the source `ValueError`
/// message the service turns into `422`.
pub(super) fn normalize_provider_config(
    task_provider: &str,
    provider_config: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let mut config = provider_config.clone();
    if task_provider == LOCAL {
        return Ok(Map::new());
    }
    if task_provider == DINGTALK {
        if config.contains_key("credential") {
            return Err("encrypted provider credentials cannot be supplied".to_string());
        }
        for key in ["base_id", "table_id"] {
            let value = config.get(key).and_then(Value::as_str);
            match value.map(str::trim) {
                Some(text) if !text.is_empty() => {
                    config.insert(key.to_owned(), Value::String(text.to_owned()));
                }
                _ => return Err(format!("provider_config.{key} is required")),
            }
        }
        if config.contains_key("token") {
            return Err("DingTalk authentication is managed by the local Executor".to_string());
        }
        if let Some(mapping) = config.get("board_mapping")
            && !mapping.is_object()
        {
            return Err("provider_config.board_mapping must be an object".to_string());
        }
        return Ok(config);
    }
    let Some(repository) = config.get("repository").and_then(Value::as_str) else {
        return Err("provider_config.repository is required".to_string());
    };
    if repository.trim().is_empty() {
        return Err("provider_config.repository is required".to_string());
    }
    let normalized = normalize_repository(task_provider, repository);
    if normalized.is_empty() {
        return Err("provider_config.repository is required".to_string());
    }
    config.insert("repository".to_owned(), Value::String(normalized));
    if config.contains_key("credential") {
        return Err("encrypted provider credentials cannot be supplied".to_string());
    }
    if let Some(token) = config.get("token") {
        let Some(text) = token.as_str() else {
            return Err("provider token must be a string".to_string());
        };
        config.insert("token".to_owned(), Value::String(text.trim().to_owned()));
    }
    Ok(config)
}

/// `_normalize_repository(task_provider, repository)`.
fn normalize_repository(task_provider: &str, repository: &str) -> String {
    let mut normalized = repository.trim().trim_matches('/').to_owned();
    if task_provider == "gitlab" {
        normalized = normalized.split("/-/").next().unwrap_or("").to_owned();
    }
    if normalized.ends_with(".git") {
        normalized.truncate(normalized.len() - 4);
    }
    normalized
}

/// `store_provider_config(task_provider, replacement, current)`.
pub(super) fn store_provider_config(
    task_provider: &str,
    replacement: &Map<String, Value>,
    current: Option<&Map<String, Value>>,
    jwt_key: &str,
) -> Result<Map<String, Value>, String> {
    let mut config = replacement.clone();
    if config.contains_key("credential") {
        return Err("encrypted provider credentials cannot be supplied".to_string());
    }
    config.remove("credential_configured");
    let token_supplied = config.contains_key("token");
    let token = config.remove("token");
    if let Some(token) = token.as_ref()
        && !token.is_null()
        && !token.is_string()
    {
        return Err("provider token must be a string".to_string());
    }

    if !token_supplied && let Some(current) = current.filter(|config| !config.is_empty()) {
        preserve_credential(task_provider, current, &mut config)?;
        return Ok(config);
    }

    let normalized_token = token
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !normalized_token.is_empty() && normalized_token != "***" {
        let context = credential_context(task_provider, &config);
        config.insert(
            "credential".to_owned(),
            encrypt_provider_token(normalized_token, &context, jwt_key),
        );
    }
    Ok(config)
}

/// `_preserve_credential(task_provider, current, replacement)`.
fn preserve_credential(
    task_provider: &str,
    current: &Map<String, Value>,
    replacement: &mut Map<String, Value>,
) -> Result<(), String> {
    let Some(credential) = current.get("credential") else {
        return Ok(());
    };
    if !credential.is_object() {
        return Ok(());
    }
    if credential_context(task_provider, current) != credential_context(task_provider, replacement)
    {
        return Err("provider token is required when repository or domain changes".to_string());
    }
    replacement.insert("credential".to_owned(), credential.clone());
    Ok(())
}

/// `_credential_context(task_provider, config)`.
fn credential_context(task_provider: &str, config: &Map<String, Value>) -> String {
    let repository = config
        .get("repository")
        .map(string_of)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let default_domain = if task_provider == "github" {
        "github.com"
    } else {
        "gitlab.com"
    };
    let domain = match config.get("domain") {
        Some(value) => {
            let text = string_of(value).trim().to_owned();
            if text.is_empty() {
                default_domain.to_owned()
            } else {
                text
            }
        }
        None => default_domain.to_owned(),
    };
    format!("{task_provider}:{domain}:{repository}")
}

/// Python `str(value)` for the provider-config scalars.
fn string_of(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

/// `_encrypt_provider_token(token, context)`: one AES-256-GCM envelope.
fn encrypt_provider_token(token: &str, context: &str, jwt_key: &str) -> Value {
    use aes_gcm::aead::{Aead, KeyInit, Payload};

    let mut nonce = [0u8; NONCE_BYTES];
    getrandom::getrandom(&mut nonce).expect("OS randomness is available");
    let material = format!("wegent-cloud-project-provider:{jwt_key}");
    let key = Sha256::digest(material.as_bytes());
    let cipher =
        aes_gcm::Aes256Gcm::new_from_slice(&key).expect("sha256 output is a valid AES-256 key");
    let ciphertext = cipher
        .encrypt(
            (&nonce).into(),
            Payload {
                msg: token.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .expect("AES-GCM encryption of a bounded token cannot fail");

    let mut credential = Map::new();
    credential.insert("version".to_owned(), Value::from(CREDENTIAL_VERSION));
    credential.insert(
        "algorithm".to_owned(),
        Value::String(CREDENTIAL_ALGORITHM.to_owned()),
    );
    credential.insert("context".to_owned(), Value::String(context.to_owned()));
    credential.insert(
        "nonce".to_owned(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(nonce)),
    );
    credential.insert(
        "ciphertext".to_owned(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(ciphertext)),
    );
    Value::Object(credential)
}

/// `settings.SECRET_KEY`, read from the process environment with the
/// source's default.
pub(super) fn jwt_key() -> String {
    crate::config::env_or_dotenv("SECRET_KEY")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_JWT_KEY.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn local_provider_config_normalises_to_empty() {
        let normalized =
            normalize_provider_config("local", &config(json!({"anything": 1}))).unwrap();
        assert!(normalized.is_empty());
    }

    #[test]
    fn git_provider_config_requires_a_repository() {
        let error = normalize_provider_config("github", &config(json!({}))).unwrap_err();
        assert_eq!(error, "provider_config.repository is required");
        let normalized =
            normalize_provider_config("github", &config(json!({"repository": "/owner/repo.git/"})))
                .unwrap();
        assert_eq!(normalized["repository"], json!("owner/repo"));
    }

    #[test]
    fn gitlab_repository_drops_the_merge_request_suffix() {
        let normalized = normalize_provider_config(
            "gitlab",
            &config(json!({"repository": "group/repo/-/merge_requests"})),
        )
        .unwrap();
        assert_eq!(normalized["repository"], json!("group/repo"));
    }

    #[test]
    fn dingtalk_requires_base_and_table_and_rejects_a_token() {
        let error =
            normalize_provider_config(DINGTALK, &config(json!({"base_id": "b"}))).unwrap_err();
        assert_eq!(error, "provider_config.table_id is required");
        let error = normalize_provider_config(
            DINGTALK,
            &config(json!({"base_id": "b", "table_id": "t", "token": "x"})),
        )
        .unwrap_err();
        assert_eq!(
            error,
            "DingTalk authentication is managed by the local Executor"
        );
    }

    #[test]
    fn a_stored_token_is_encrypted_and_round_trips_through_decryption() {
        let stored = store_provider_config(
            "github",
            &config(json!({"repository": "owner/repo", "token": " s3cret "})),
            None,
            "jwt-key",
        )
        .unwrap();
        let credential = stored["credential"].as_object().unwrap();
        assert_eq!(credential["version"], json!(2));
        assert_eq!(credential["algorithm"], json!("aes-256-gcm"));
        assert_eq!(credential["context"], json!("github:github.com:owner/repo"));
        assert!(!stored.contains_key("token"));

        let parsed: crate::board_snapshot::external_provider::ProviderCredential =
            serde_json::from_value(stored["credential"].clone()).unwrap();
        let token =
            crate::board_snapshot::external_provider::decrypt_provider_token("jwt-key", &parsed)
                .unwrap();
        assert_eq!(token, "s3cret");
    }

    #[test]
    fn an_omitted_token_preserves_the_stored_credential() {
        let credential = json!({"version": 2, "algorithm": "aes-256-gcm", "context": "github:github.com:owner/repo", "nonce": "a", "ciphertext": "b"});
        let current = config(json!({"repository": "owner/repo", "credential": credential}));
        let stored = store_provider_config(
            "github",
            &config(json!({"repository": "owner/repo", "api_base": "https://x"})),
            Some(&current),
            "jwt-key",
        )
        .unwrap();
        assert_eq!(stored["credential"], credential);
        assert_eq!(stored["api_base"], json!("https://x"));
    }

    #[test]
    fn changing_the_repository_without_a_token_is_rejected() {
        let credential = json!({"version": 2, "algorithm": "aes-256-gcm", "context": "github:github.com:owner/repo"});
        let current = config(json!({"repository": "owner/repo", "credential": credential}));
        let error = store_provider_config(
            "github",
            &config(json!({"repository": "owner/other"})),
            Some(&current),
            "jwt-key",
        )
        .unwrap_err();
        assert_eq!(
            error,
            "provider token is required when repository or domain changes"
        );
    }

    #[test]
    fn an_empty_string_token_clears_the_stored_credential() {
        let current =
            config(json!({"repository": "owner/repo", "credential": json!({"version": 2})}));
        let stored = store_provider_config(
            "github",
            &config(json!({"repository": "owner/repo", "token": ""})),
            Some(&current),
            "jwt-key",
        )
        .unwrap();
        assert!(!stored.contains_key("credential"));
    }
}
