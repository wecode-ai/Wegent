// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `encrypt_sensitive_data` (`shared.utils.crypto`): AES-256-CBC with PKCS7
//! padding, a fixed IV from configuration, and Base64 output.
//!
//! The subscription update path encrypts each notification webhook's signing
//! `secret` before persisting it. Configuration is read from the same
//! environment variables the source uses (`GIT_TOKEN_AES_KEY`,
//! `GIT_TOKEN_AES_IV`); a missing or malformed IV is the source's
//! `CryptoConfigurationError`, surfaced as a 500.
//!
//! `decrypt_sensitive_data` is the matching reader (the outbound token issuer
//! decrypts a stored `privateKeyEncrypted`), so both directions share the key,
//! IV, and fallback rules here.

use base64::Engine;
use cbc::Encryptor;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};

/// `GIT_TOKEN_AES_KEY` default (`12345678901234567890123456789012`).
const DEFAULT_KEY: &str = "12345678901234567890123456789012";

/// `encrypt_sensitive_data` failures.
#[derive(Debug)]
pub(crate) enum CryptoError {
    /// `GIT_TOKEN_AES_IV must be configured`.
    MissingIv,
    /// `GIT_TOKEN_AES_IV must be 16 UTF-8 bytes`.
    InvalidIv,
    /// The key could not be parsed into an AES-256 key.
    InvalidKey,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingIv => formatter.write_str("GIT_TOKEN_AES_IV must be configured"),
            Self::InvalidIv => formatter.write_str("GIT_TOKEN_AES_IV must be 16 UTF-8 bytes"),
            Self::InvalidKey => formatter.write_str("GIT_TOKEN_AES_KEY must be a 32-byte key"),
        }
    }
}

/// `encrypt_sensitive_data`: `""` and `"***"` pass through unchanged.
pub(crate) fn encrypt_sensitive_data(plain: &str) -> Result<String, CryptoError> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if plain == "***" {
        return Ok("***".to_string());
    }

    let key = std::env::var("GIT_TOKEN_AES_KEY").unwrap_or_else(|_| DEFAULT_KEY.to_string());
    let iv = std::env::var("GIT_TOKEN_AES_IV").map_err(|_| CryptoError::MissingIv)?;
    let iv = iv.into_bytes();
    if iv.len() != 16 {
        return Err(CryptoError::InvalidIv);
    }
    let key = parse_aes_key(&key)?;
    encrypt_with(&key, &iv, plain)
}

/// AES-256-CBC/PKCS7 encryption of `plain` with an explicit key and IV.
fn encrypt_with(key: &[u8], iv: &[u8], plain: &str) -> Result<String, CryptoError> {
    let cipher =
        Encryptor::<aes::Aes256>::new_from_slices(key, iv).map_err(|_| CryptoError::InvalidKey)?;
    let ciphertext = cipher.encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes());
    Ok(base64::engine::general_purpose::STANDARD.encode(ciphertext))
}

/// `decrypt_sensitive_data` (`shared.utils.crypto:205`): the reader matching
/// [`encrypt_sensitive_data`].
///
/// `""` and `"***"` pass through unchanged. A missing or malformed
/// `GIT_TOKEN_AES_IV` raises the source's `CryptoConfigurationError` (the
/// endpoint surfaces it as a 500). Every other failure — invalid Base64, an
/// unsupported key length, bad padding, or non-UTF-8 plaintext — logs and
/// returns the input unchanged, which is the source's backward-compatibility
/// fallback.
pub(crate) fn decrypt_sensitive_data(encrypted: &str) -> Result<String, CryptoError> {
    if encrypted.is_empty() {
        return Ok(String::new());
    }
    if encrypted == "***" {
        return Ok("***".to_string());
    }

    // The sibling decryptors (`git_repositories::crypto`,
    // `admin_connector_apps::crypto`) resolve these settings through
    // `config::env_or_dotenv`, which falls back to the runtime dotenv file when
    // the process environment does not define them. A missing or malformed IV
    // is the source's `CryptoConfigurationError`.
    let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_KEY.to_string());
    let iv = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV").ok_or(CryptoError::MissingIv)?;
    let iv = iv.into_bytes();
    if iv.len() != 16 {
        return Err(CryptoError::InvalidIv);
    }
    // `_get_encryption_key` keeps the raw UTF-8 key bytes; `algorithms.AES`
    // accepts 16/24/32-byte keys and raises for anything else, which the
    // source's `except` turns into the passthrough.
    Ok(
        decrypt_with(key.as_bytes(), &iv, encrypted).unwrap_or_else(|| {
            tracing::warn!("failed to decrypt sensitive data; keeping the stored value");
            encrypted.to_string()
        }),
    )
}

/// AES-CBC/PKCS7 decryption of `text` with an explicit key and IV; `None` is
/// the source's generic `except` fallback.
fn decrypt_with(key: &[u8], iv: &[u8], text: &str) -> Option<String> {
    let ciphertext = base64::engine::general_purpose::STANDARD
        .decode(text)
        .ok()?;
    let plaintext = match key.len() {
        16 => cbc::Decryptor::<aes::Aes128>::new_from_slices(key, iv)
            .ok()?
            .decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
            .ok()?,
        24 => cbc::Decryptor::<aes::Aes192>::new_from_slices(key, iv)
            .ok()?
            .decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
            .ok()?,
        32 => cbc::Decryptor::<aes::Aes256>::new_from_slices(key, iv)
            .ok()?
            .decrypt_padded_vec_mut::<Pkcs7>(&ciphertext)
            .ok()?,
        _ => return None,
    };
    String::from_utf8(plaintext).ok()
}

/// `_parse_aes_key`: a `base64:` prefix decodes the remainder; anything else is
/// used as raw UTF-8 bytes.
fn parse_aes_key(key: &str) -> Result<Vec<u8>, CryptoError> {
    let bytes = match key.strip_prefix("base64:") {
        Some(encoded) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| CryptoError::InvalidKey)?,
        None => key.as_bytes().to_vec(),
    };
    if bytes.len() != 32 {
        return Err(CryptoError::InvalidKey);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_and_masked_values_pass_through() {
        assert_eq!(encrypt_sensitive_data("").unwrap(), "");
        assert_eq!(encrypt_sensitive_data("***").unwrap(), "***");
    }

    #[test]
    fn encryption_is_deterministic_with_the_fixed_iv() {
        // The fixed-IV CBC output is stable for a fixed key/IV, which is what
        // lets equal plaintexts render equal ciphertexts.
        let first = encrypt_with(DEFAULT_KEY.as_bytes(), b"1234567890123456", "hello").unwrap();
        let second = encrypt_with(DEFAULT_KEY.as_bytes(), b"1234567890123456", "hello").unwrap();
        assert_eq!(first, second);
        // A different IV changes the ciphertext for the same plaintext.
        assert_ne!(
            first,
            encrypt_with(DEFAULT_KEY.as_bytes(), b"6543210987654321", "hello").unwrap()
        );
    }

    #[test]
    fn key_parsing_accepts_raw_and_prefixed_forms() {
        assert_eq!(parse_aes_key(DEFAULT_KEY).unwrap().len(), 32);
        let prefixed = format!(
            "base64:{}",
            base64::engine::general_purpose::STANDARD.encode(DEFAULT_KEY.as_bytes())
        );
        assert_eq!(parse_aes_key(&prefixed).unwrap(), DEFAULT_KEY.as_bytes());
        assert!(parse_aes_key("short").is_err());
    }

    #[test]
    fn decryption_inverts_encryption_for_the_source_scheme() {
        let iv = b"1234567890123456";
        let plain = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n";
        let encrypted = encrypt_with(DEFAULT_KEY.as_bytes(), iv, plain).unwrap();
        assert_eq!(
            decrypt_with(DEFAULT_KEY.as_bytes(), iv, &encrypted).as_deref(),
            Some(plain)
        );
        // A non-Base64 or wrongly-padded value falls back to the input.
        assert_eq!(decrypt_with(DEFAULT_KEY.as_bytes(), iv, "AAAA"), None);
        // An unsupported key length is the source's caught `ValueError`.
        assert_eq!(decrypt_with(b"short", iv, &encrypted), None);
        // The 16- and 24-byte AES variants the source accepts also decrypt.
        let encrypted = encrypt_aes128(b"0123456789abcdef", iv, plain);
        assert_eq!(
            decrypt_with(b"0123456789abcdef", iv, &encrypted).as_deref(),
            Some(plain)
        );
        let encrypted = encrypt_aes192(b"0123456789abcdefghijklmn", iv, plain);
        assert_eq!(
            decrypt_with(b"0123456789abcdefghijklmn", iv, &encrypted).as_deref(),
            Some(plain)
        );
    }

    /// AES-128-CBC/PKCS7 (test-only): the source's `algorithms.AES` accepts a
    /// 16-byte key, so a round-trip needs a matching encryptor.
    fn encrypt_aes128(key: &[u8], iv: &[u8], plain: &str) -> String {
        let cipher = Encryptor::<aes::Aes128>::new_from_slices(key, iv).unwrap();
        base64::engine::general_purpose::STANDARD
            .encode(cipher.encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes()))
    }

    /// AES-192-CBC/PKCS7 (test-only), matching the source's 24-byte key case.
    fn encrypt_aes192(key: &[u8], iv: &[u8], plain: &str) -> String {
        let cipher = Encryptor::<aes::Aes192>::new_from_slices(key, iv).unwrap();
        base64::engine::general_purpose::STANDARD
            .encode(cipher.encrypt_padded_vec_mut::<Pkcs7>(plain.as_bytes()))
    }
}
