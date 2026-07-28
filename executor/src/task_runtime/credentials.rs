// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Key, Nonce,
};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{TaskProviderKind, TaskRuntimeError};

const CREDENTIAL_VERSION: i64 = 1;
const CREDENTIAL_ALGORITHM: &str = "aes-256-gcm";
const MASTER_KEY_FILE: &str = "provider-master-key-v1";
const TOKEN_INPUT_KEY: &str = "token";
const CREDENTIAL_KEY: &str = "credential";

pub(crate) fn encrypt_provider_config(
    database_path: &Path,
    provider: TaskProviderKind,
    provider_config: Value,
) -> Result<Value, TaskRuntimeError> {
    let mut config = provider_config
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("provider_config must be an object"))?;
    if config.remove(CREDENTIAL_KEY).is_some() {
        return Err(invalid(
            "encrypted provider credentials cannot be supplied by project input",
        ));
    }
    let token = match config.remove(TOKEN_INPUT_KEY) {
        Some(Value::String(value)) => {
            let value = value.trim().to_owned();
            (!value.is_empty() && value != "***").then_some(value)
        }
        Some(Value::Null) | None => None,
        Some(_) => return Err(invalid("provider token must be a string")),
    };
    if let Some(token) = token {
        encrypt_token(database_path, provider, &mut config, &token)?;
    }
    Ok(Value::Object(config))
}

pub(crate) fn update_provider_config(
    database_path: &Path,
    provider: TaskProviderKind,
    current: &Value,
    replacement: Value,
) -> Result<Value, TaskRuntimeError> {
    let mut config = replacement
        .as_object()
        .cloned()
        .ok_or_else(|| invalid("provider_config must be an object"))?;
    if config.remove(CREDENTIAL_KEY).is_some() {
        return Err(invalid(
            "encrypted provider credentials cannot be supplied by project input",
        ));
    }
    config.remove("credential_configured");
    let token = match config.remove(TOKEN_INPUT_KEY) {
        Some(Value::String(value)) => {
            let value = value.trim().to_owned();
            (!value.is_empty() && value != "***").then_some(value)
        }
        Some(Value::Null) => return Ok(Value::Object(config)),
        Some(_) => return Err(invalid("provider token must be a string")),
        None => {
            preserve_credential(provider, current, &mut config)?;
            return Ok(Value::Object(config));
        }
    };
    if let Some(token) = token {
        encrypt_token(database_path, provider, &mut config, &token)?;
    }
    Ok(Value::Object(config))
}

pub(crate) fn decrypt_provider_credential(
    database_path: &Path,
    provider: TaskProviderKind,
    provider_config: &Map<String, Value>,
) -> Result<Option<String>, TaskRuntimeError> {
    let Some(credential) = provider_config
        .get(CREDENTIAL_KEY)
        .and_then(Value::as_object)
    else {
        return Ok(None);
    };
    require_credential_field(credential, "algorithm", CREDENTIAL_ALGORITHM)?;
    let version = credential
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| invalid("provider credential version is required"))?;
    if version != CREDENTIAL_VERSION {
        return Err(invalid("unsupported provider credential version"));
    }
    let key = load_master_key(database_path)?;
    require_credential_field(credential, "key_id", &key_id(&key))?;
    let nonce = decode_credential_bytes(credential, "nonce")?;
    if nonce.len() != 12 {
        return Err(invalid("provider credential nonce is invalid"));
    }
    let ciphertext = decode_credential_bytes(credential, "ciphertext")?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let context = credential_context(provider, provider_config)?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| invalid("provider credential decryption failed"))?;
    String::from_utf8(plaintext)
        .map(Some)
        .map_err(|_| invalid("provider credential is not UTF-8"))
}

pub(crate) fn mask_provider_config(provider_config: &mut Value) {
    let Some(config) = provider_config.as_object_mut() else {
        return;
    };
    let configured = config
        .get(CREDENTIAL_KEY)
        .and_then(Value::as_object)
        .is_some();
    config.remove(TOKEN_INPUT_KEY);
    config.remove(CREDENTIAL_KEY);
    config.insert("credential_configured".to_owned(), json!(configured));
}

fn encrypt_token(
    database_path: &Path,
    provider: TaskProviderKind,
    config: &mut Map<String, Value>,
    token: &str,
) -> Result<(), TaskRuntimeError> {
    let key = load_or_create_master_key(database_path)?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let context = credential_context(provider, config)?;
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: token.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| invalid("provider credential encryption failed"))?;
    config.insert(
        CREDENTIAL_KEY.to_owned(),
        json!({
            "version": CREDENTIAL_VERSION,
            "algorithm": CREDENTIAL_ALGORITHM,
            "key_id": key_id(&key),
            "nonce": general_purpose::STANDARD.encode(nonce),
            "ciphertext": general_purpose::STANDARD.encode(ciphertext),
        }),
    );
    Ok(())
}

fn preserve_credential(
    provider: TaskProviderKind,
    current: &Value,
    replacement: &mut Map<String, Value>,
) -> Result<(), TaskRuntimeError> {
    let Some(current) = current.as_object() else {
        return Ok(());
    };
    let Some(credential) = current.get(CREDENTIAL_KEY) else {
        return Ok(());
    };
    if credential_context(provider, current)? != credential_context(provider, replacement)? {
        return Err(invalid(
            "provider token is required when repository or domain changes",
        ));
    }
    replacement.insert(CREDENTIAL_KEY.to_owned(), credential.clone());
    Ok(())
}

fn credential_context(
    provider: TaskProviderKind,
    provider_config: &Map<String, Value>,
) -> Result<String, TaskRuntimeError> {
    let repository = required_config_string(provider_config, "repository")?;
    let domain = provider_config
        .get("domain")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(match provider {
            TaskProviderKind::Github => "github.com",
            TaskProviderKind::Gitlab => "gitlab.com",
            _ => return Err(invalid("provider credentials require GitHub or GitLab")),
        });
    Ok(format!("{provider:?}:{domain}:{repository}"))
}

fn required_config_string<'a>(
    provider_config: &'a Map<String, Value>,
    key: &str,
) -> Result<&'a str, TaskRuntimeError> {
    provider_config
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(&format!("provider_config.{key} is required")))
}

fn master_key_path(database_path: &Path) -> Result<PathBuf, TaskRuntimeError> {
    let data_directory = database_path
        .parent()
        .ok_or_else(|| invalid("task database path is invalid"))?;
    let executor_home = data_directory
        .parent()
        .ok_or_else(|| invalid("Executor home path is invalid"))?;
    Ok(executor_home.join("credentials").join(MASTER_KEY_FILE))
}

fn load_or_create_master_key(database_path: &Path) -> Result<[u8; 32], TaskRuntimeError> {
    let path = master_key_path(database_path)?;
    if path.exists() {
        return read_master_key(&path);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(storage_error)?;
    }
    let key = Aes256Gcm::generate_key(&mut OsRng);
    if !write_new_master_key(&path, key.as_slice())? {
        return read_master_key(&path);
    }
    let mut value = [0_u8; 32];
    value.copy_from_slice(key.as_slice());
    Ok(value)
}

fn load_master_key(database_path: &Path) -> Result<[u8; 32], TaskRuntimeError> {
    let path = master_key_path(database_path)?;
    read_master_key(&path)
}

fn read_master_key(path: &Path) -> Result<[u8; 32], TaskRuntimeError> {
    let encoded = fs::read_to_string(path).map_err(storage_error)?;
    let bytes = general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| invalid("provider master key is invalid"))?;
    if bytes.len() != 32 {
        return Err(invalid("provider master key must contain 32 bytes"));
    }
    let mut key = [0_u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

fn write_new_master_key(path: &Path, key: &[u8]) -> Result<bool, TaskRuntimeError> {
    let temporary = path.with_extension(format!("tmp-{}", Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(storage_error)?;
    file.write_all(general_purpose::STANDARD.encode(key).as_bytes())
        .map_err(storage_error)?;
    file.sync_all().map_err(storage_error)?;
    drop(file);
    let linked = match fs::hard_link(&temporary, path) {
        Ok(()) => true,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            return Err(storage_error(error));
        }
    };
    fs::remove_file(&temporary).map_err(storage_error)?;
    Ok(linked)
}

fn key_id(key: &[u8]) -> String {
    let digest = format!("{:x}", Sha256::digest(key));
    format!("local-{}", &digest[..16])
}

fn require_credential_field(
    credential: &Map<String, Value>,
    key: &str,
    expected: &str,
) -> Result<(), TaskRuntimeError> {
    let value = credential
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&format!("provider credential {key} is required")))?;
    if value != expected {
        return Err(invalid(&format!(
            "provider credential {key} does not match"
        )));
    }
    Ok(())
}

fn decode_credential_bytes(
    credential: &Map<String, Value>,
    key: &str,
) -> Result<Vec<u8>, TaskRuntimeError> {
    let value = credential
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&format!("provider credential {key} is required")))?;
    general_purpose::STANDARD
        .decode(value)
        .map_err(|_| invalid(&format!("provider credential {key} is invalid")))
}

fn invalid(message: &str) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(message.to_owned())
}

fn storage_error(error: std::io::Error) -> TaskRuntimeError {
    TaskRuntimeError::Invalid(format!("provider credential storage failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database_path(directory: &tempfile::TempDir) -> PathBuf {
        directory.path().join("data").join("tasks.sqlite")
    }

    #[test]
    fn encrypts_provider_tokens_and_masks_public_config() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = database_path(&directory);
        let encrypted = encrypt_provider_config(
            &database_path,
            TaskProviderKind::Github,
            json!({
                "repository": "acme/repo",
                "domain": "github.com",
                "token": "github-secret"
            }),
        )
        .unwrap();

        let serialized = encrypted.to_string();
        assert!(!serialized.contains("github-secret"));
        assert_eq!(
            decrypt_provider_credential(
                &database_path,
                TaskProviderKind::Github,
                encrypted.as_object().unwrap(),
            )
            .unwrap()
            .as_deref(),
            Some("github-secret")
        );
        let credential = &encrypted["credential"];
        assert_eq!(credential["algorithm"], CREDENTIAL_ALGORITHM);
        assert_eq!(credential["version"], CREDENTIAL_VERSION);
        assert!(credential["nonce"].as_str().unwrap().len() >= 16);
        assert!(credential["ciphertext"].as_str().unwrap().len() >= 16);

        let mut masked = encrypted;
        mask_provider_config(&mut masked);
        assert_eq!(masked["credential_configured"], true);
        assert!(masked.get("credential").is_none());
        assert!(masked.get("token").is_none());
    }

    #[test]
    fn binds_ciphertext_to_provider_domain_and_repository() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = database_path(&directory);
        let mut encrypted = encrypt_provider_config(
            &database_path,
            TaskProviderKind::Gitlab,
            json!({
                "repository": "group/project",
                "domain": "gitlab.example.com",
                "token": "gitlab-secret"
            }),
        )
        .unwrap();
        encrypted["repository"] = json!("other/project");

        let error = decrypt_provider_credential(
            &database_path,
            TaskProviderKind::Gitlab,
            encrypted.as_object().unwrap(),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("provider credential decryption failed"));
    }

    #[test]
    fn refuses_client_supplied_ciphertext() {
        let directory = tempfile::tempdir().unwrap();
        let error = encrypt_provider_config(
            &database_path(&directory),
            TaskProviderKind::Github,
            json!({
                "repository": "acme/repo",
                "credential": {
                    "version": 1,
                    "algorithm": "aes-256-gcm",
                    "ciphertext": "untrusted"
                }
            }),
        )
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("cannot be supplied by project input"));
    }

    #[test]
    fn rotates_preserves_and_clears_provider_tokens() {
        let directory = tempfile::tempdir().unwrap();
        let database_path = database_path(&directory);
        let encrypted = encrypt_provider_config(
            &database_path,
            TaskProviderKind::Github,
            json!({
                "repository": "acme/repo",
                "domain": "github.com",
                "token": "first-secret"
            }),
        )
        .unwrap();

        let preserved = update_provider_config(
            &database_path,
            TaskProviderKind::Github,
            &encrypted,
            json!({
                "repository": "acme/repo",
                "domain": "github.com",
                "credential_configured": true
            }),
        )
        .unwrap();
        assert_eq!(
            decrypt_provider_credential(
                &database_path,
                TaskProviderKind::Github,
                preserved.as_object().unwrap(),
            )
            .unwrap()
            .as_deref(),
            Some("first-secret")
        );

        let rotated = update_provider_config(
            &database_path,
            TaskProviderKind::Github,
            &preserved,
            json!({
                "repository": "acme/repo",
                "domain": "github.com",
                "token": "second-secret"
            }),
        )
        .unwrap();
        assert!(!rotated.to_string().contains("second-secret"));
        assert_eq!(
            decrypt_provider_credential(
                &database_path,
                TaskProviderKind::Github,
                rotated.as_object().unwrap(),
            )
            .unwrap()
            .as_deref(),
            Some("second-secret")
        );

        let cleared = update_provider_config(
            &database_path,
            TaskProviderKind::Github,
            &rotated,
            json!({
                "repository": "acme/repo",
                "domain": "github.com",
                "token": null
            }),
        )
        .unwrap();
        assert_eq!(
            decrypt_provider_credential(
                &database_path,
                TaskProviderKind::Github,
                cleared.as_object().unwrap(),
            )
            .unwrap(),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn creates_master_key_with_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let database_path = database_path(&directory);
        encrypt_provider_config(
            &database_path,
            TaskProviderKind::Github,
            json!({"repository": "acme/repo", "token": "secret"}),
        )
        .unwrap();

        let mode = fs::metadata(master_key_path(&database_path).unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
