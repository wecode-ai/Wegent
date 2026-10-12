// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `shared/utils/crypto.py` Git-token decryption.
//!
//! `RepositoryProvider.decrypt_token` / `_is_token_encrypted` route every
//! stored `git_info[].git_token` through this pair before a provider uses it:
//! a value that looks like base64 AES ciphertext (`is_data_encrypted`) is
//! decrypted with `GIT_TOKEN_AES_KEY`/`GIT_TOKEN_AES_IV`; every other value
//! (including the `***` placeholder) passes through unchanged.
use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// `_get_encryption_key`'s `GIT_TOKEN_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// `cryptography`'s AES block size, also the PKCS#7 block size.
const BLOCK_SIZE: usize = 16;

/// `CryptoConfigurationError`: `GIT_TOKEN_AES_IV` is missing or not 16 bytes.
/// `decrypt_sensitive_data` re-raises it instead of returning the ciphertext.
#[derive(Debug)]
pub struct CryptoConfigurationError;

/// `is_data_encrypted`: base64-decodable to a non-empty whole 16-byte block.
fn is_token_encrypted(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    match STANDARD.decode(token.as_bytes()) {
        Ok(decoded) => !decoded.is_empty() && decoded.len() % BLOCK_SIZE == 0,
        Err(_) => false,
    }
}

/// `RepositoryProvider.decrypt_token`: a value that is not encrypted is
/// returned unchanged, so the common `ghp_...`/`***` values need no key. An
/// encrypted value resolves the key/IV, which the source requires.
pub(crate) fn decrypt_git_token(token: &str) -> Result<String, CryptoConfigurationError> {
    if !is_token_encrypted(token) {
        return Ok(token.to_string());
    }
    // `_get_encryption_key`: both checks precede the base64 decode and any
    // decryption failure, so a mis-configured deployment fails loudly.
    let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_AES_KEY.to_string());
    let iv = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV").ok_or(CryptoConfigurationError)?;
    if iv.len() != BLOCK_SIZE {
        return Err(CryptoConfigurationError);
    }
    Ok(decrypt_sensitive_data(key.as_bytes(), iv.as_bytes(), token))
}

/// `decrypt_sensitive_data` after key resolution: `""`/`"***"` pass through,
/// and any decode/decrypt/UTF-8 failure returns the original ciphertext.
fn decrypt_sensitive_data(key: &[u8], iv: &[u8], text: &str) -> String {
    if text.is_empty() || text == "***" {
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
    if !plain[plain.len() - padding..]
        .iter()
        .all(|byte| usize::from(*byte) == padding)
    {
        return Err(());
    }
    plain.truncate(plain.len() - padding);
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AES-256-CBC(`12345678901234567890123456789012`, `0123456789abcdef`) of
    /// `ghp_unit_token_test_value`, produced from the source's own key/IV pair.
    const CIPHERTEXT: &str = "JgMaeWWl3AwfpHkESUJhXNxmcHg5Kgv7lcXROYaZ1Zc=";

    #[test]
    fn plaintext_and_placeholder_tokens_pass_through() {
        assert_eq!(decrypt_git_token("ghp_short").unwrap(), "ghp_short");
        assert_eq!(decrypt_git_token("***").unwrap(), "***");
        assert_eq!(decrypt_git_token("").unwrap(), "");
    }

    #[test]
    fn encrypted_looking_values_are_detected_by_block_size() {
        assert!(is_token_encrypted(CIPHERTEXT));
        assert!(!is_token_encrypted("not base64!"));
        assert!(!is_token_encrypted("YQ=="));
    }

    #[test]
    fn decrypt_sensitive_data_matches_the_source_vector() {
        let key = DEFAULT_AES_KEY.as_bytes();
        let iv = b"0123456789abcdef";
        assert_eq!(
            decrypt_sensitive_data(key, iv, CIPHERTEXT),
            "ghp_unit_token_test_value"
        );
        // A short non-block value is returned unchanged.
        assert_eq!(decrypt_sensitive_data(key, iv, "YQ=="), "YQ==");
        // A block-sized value that is not valid ciphertext returns unchanged.
        assert_eq!(
            decrypt_sensitive_data(key, iv, "AAAAAAAAAAAAAAAAAAAAAA=="),
            "AAAAAAAAAAAAAAAAAAAAAA=="
        );
    }
}
