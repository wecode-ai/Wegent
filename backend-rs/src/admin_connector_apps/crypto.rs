// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Provider-header decryption for the administrator connector-app listing.
//!
//! Ports `app/services/connector_apps.py::_decrypt_json` and the
//! `shared/utils/crypto.py` `encrypt_sensitive_data` / `decrypt_sensitive_data`
//! pair it calls: AES-CBC with PKCS#7 padding over the base64 payload, using
//! `GIT_TOKEN_AES_KEY` / `GIT_TOKEN_AES_IV` and the source's default key. A
//! missing or mis-sized IV raises `CryptoConfigurationError`, which the source
//! does not swallow; every other failure returns the original ciphertext so
//! JSON parsing then yields no headers.
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use std::collections::BTreeMap;

use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};

use crate::json_compat::{JsonField, OpaqueJson};

/// `_get_encryption_key`'s `GIT_TOKEN_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// `cryptography`'s AES block size, also the PKCS#7 block size.
const BLOCK_SIZE: usize = 16;

/// `shared.utils.crypto.CryptoConfigurationError`.
#[derive(Debug)]
pub enum CryptoError {
    /// `GIT_TOKEN_AES_IV` must be configured and 16 UTF-8 bytes long.
    MissingIv,
}

/// `_decrypt_json(value)`: the sorted names of the decrypted header entries
/// whose value is a string, `[]` for every other shape.
pub fn provider_header_names(encrypted: Option<&str>) -> Result<Vec<String>, CryptoError> {
    // `if not value: return {}`.
    let Some(value) = encrypted.filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    // `_get_encryption_key`: the key defaults, the IV is required and exactly
    // one block; both checks precede decoding.
    let key = crate::config::env_or_dotenv("GIT_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_AES_KEY.to_string());
    let iv = crate::config::env_or_dotenv("GIT_TOKEN_AES_IV").ok_or(CryptoError::MissingIv)?;
    if iv.len() != BLOCK_SIZE {
        return Err(CryptoError::MissingIv);
    }
    Ok(parse_provider_header_names(&decrypt_sensitive_data(
        key.as_bytes(),
        iv.as_bytes(),
        value,
    )))
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
    // `base64.b64decode` failure is one of the swallowed exceptions.
    let Some(encrypted) = STANDARD.decode(text.as_bytes()).ok() else {
        return text.to_string();
    };
    decrypt_cbc(key, iv, &encrypted)
        .ok()
        .and_then(|plain| String::from_utf8(plain).ok())
        .unwrap_or_else(|| text.to_string())
}

/// `_decrypt_json`'s tail: parse the decrypted text as JSON (`"{}"` when
/// empty), keep only an object, and return the sorted names of its
/// string-valued entries.
fn parse_provider_header_names(decrypted: &str) -> Vec<String> {
    let body = if decrypted.is_empty() {
        "{}"
    } else {
        decrypted
    };
    // A `BTreeMap` keeps the keys sorted, matching `sorted(provider_headers)`;
    // `JsonField<String>` keeps only entries whose value is a JSON string.
    let Some(entries) = OpaqueJson::from_json_text(body)
        .and_then(|document| document.project::<BTreeMap<String, JsonField<String>>>())
    else {
        return Vec::new();
    };
    entries
        .into_iter()
        .filter(|(_, value)| value.value.is_some())
        .map(|(name, _)| name)
        .collect()
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

    const KEY: &[u8] = DEFAULT_AES_KEY.as_bytes();
    const IV: &[u8] = b"1234567890123456";

    // Ciphertexts produced by `openssl enc -aes-256-cbc -base64` with the
    // default key and the 16-byte IV, so a change to the chaining or the
    // unpadding fails here rather than in Replay.
    fn headers(ciphertext: &str) -> Vec<String> {
        parse_provider_header_names(&decrypt_sensitive_data(KEY, IV, ciphertext))
    }

    #[test]
    fn decrypts_and_sorts_the_string_valued_header_names() {
        assert_eq!(
            headers("UCIx42FRean7TlkZIfVjaBMFaYEcaR7ltnKmDJkAuGDmJzBovw6SRe4otFGBNDsi"),
            vec!["Authorization".to_string(), "X-Api-Key".to_string()]
        );
        assert_eq!(
            headers("qcjflZGCWJovQnU3Z3KtnvODwSw5zrPRyXC5zqhxmLw="),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn drops_non_string_values() {
        assert_eq!(
            headers("5Ztu2WnSC/yaB0rSKSKZvN/bHPNTmYueITwIVhNHR3k="),
            vec!["ok".to_string()]
        );
    }

    #[test]
    fn non_object_or_undecryptable_payloads_yield_no_headers() {
        // Valid ciphertext whose plaintext is not JSON.
        assert_eq!(headers("TuZF39n9Z2SD8i0DzY86iQ=="), Vec::<String>::new());
        // The base64 fallback keeps the ciphertext, which is not JSON.
        assert_eq!(headers("not base64!"), Vec::<String>::new());
        // Every other shape is `{}` or a non-object.
        assert_eq!(headers("***"), Vec::<String>::new());
        assert!(parse_provider_header_names("[]").is_empty());
        assert!(parse_provider_header_names("").is_empty());
    }

    #[test]
    fn a_missing_or_wrong_iv_is_a_configuration_error() {
        // The IV must be exactly one AES block; `decrypt_cbc` rejects others.
        assert!(decrypt_cbc(KEY, b"short", b"0123456789abcdef").is_err());
    }

    #[test]
    fn empty_input_needs_no_crypto() {
        assert!(provider_header_names(None).unwrap().is_empty());
        assert!(provider_header_names(Some("")).unwrap().is_empty());
    }
}
