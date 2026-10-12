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

use base64::Engine;
use cbc::Encryptor;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockEncryptMut, KeyIvInit};

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
}
