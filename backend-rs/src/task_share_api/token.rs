// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Share-token and share-URL generation for the task share endpoint.
//!
//! Mirrors `SharedTaskService.generate_share_token` / `generate_share_url`
//! (`app/services/shared_task.py`): AES-CBC (PKCS#7) over
//! `"{user_id}#{task_id}"`, base64, then `urllib.parse.quote` with its default
//! `safe="/"`, and `"{TASK_SHARE_BASE_URL}/shared/task?token={token}"`.
//!
//! The settings resolve through the source precedence: the process
//! environment, then the active dotenv file (`config::init_env` exports it),
//! then the pydantic field default.

use aes::Aes128;
use aes::Aes192;
use aes::Aes256;
use aes::cipher::{BlockEncryptMut, KeyIvInit, block_padding::Pkcs7};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::config::env_or_dotenv;

/// `settings.SHARE_TOKEN_AES_KEY` default (`app/core/config.py`).
const DEFAULT_SHARE_TOKEN_AES_KEY: &str = "12345678901234567890123456789012";
/// `settings.SHARE_TOKEN_AES_IV` default (`app/core/config.py`).
const DEFAULT_SHARE_TOKEN_AES_IV: &str = "1234567890123456";
/// `settings.TASK_SHARE_BASE_URL` default (`app/core/config.py`).
const DEFAULT_TASK_SHARE_BASE_URL: &str = "http://localhost:3000";

/// The AES block size the source's CBC mode and PKCS#7 padding use.
const BLOCK_SIZE: usize = 16;

/// `generate_share_url(share_token)`: the public read-only share link.
///
/// The token is embedded verbatim; `generate_share_token` already URL-quoted
/// it, matching the source where `generate_share_url` interpolates the quoted
/// value unchanged.
pub(crate) fn generate_share_url(share_token: &str) -> String {
    build_share_url(&task_share_base_url(), share_token)
}

/// `generate_share_token(user_id, task_id)`:
/// `quote(AES-CBC-base64(f"{user_id}#{task_id}"))`.
///
/// Returns `Err(())` when the configured key/IV length is one the source's
/// `cryptography` `Cipher` construction rejects; the route maps that to the
/// application's unhandled error body, exactly as a source `ValueError` would.
pub(crate) fn generate_share_token(user_id: i64, task_id: i64) -> Result<String, ()> {
    let key = env_or_dotenv("SHARE_TOKEN_AES_KEY")
        .unwrap_or_else(|| DEFAULT_SHARE_TOKEN_AES_KEY.to_string());
    let iv = env_or_dotenv("SHARE_TOKEN_AES_IV")
        .unwrap_or_else(|| DEFAULT_SHARE_TOKEN_AES_IV.to_string());
    encode_share_token(key.as_bytes(), iv.as_bytes(), user_id, task_id)
}

/// The `"{base_url}/shared/task?token={token}"` link.
fn build_share_url(base_url: &str, share_token: &str) -> String {
    format!("{base_url}/shared/task?token={share_token}")
}

/// `settings.TASK_SHARE_BASE_URL` through the source precedence.
fn task_share_base_url() -> String {
    env_or_dotenv("TASK_SHARE_BASE_URL").unwrap_or_else(|| DEFAULT_TASK_SHARE_BASE_URL.to_string())
}

/// The crypto half of `generate_share_token`, independent of configuration.
fn encode_share_token(key: &[u8], iv: &[u8], user_id: i64, task_id: i64) -> Result<String, ()> {
    let plaintext = format!("{user_id}#{task_id}");
    let encrypted = encrypt_cbc(key, iv, plaintext.as_bytes()).ok_or(())?;
    Ok(python_quote(&STANDARD.encode(encrypted)))
}

/// `AES(key)` + `CBC(iv)` + PKCS#7: the variant follows the configured key
/// length (16/24/32 bytes -> AES-128/192/256), like the source's
/// `algorithms.AES(key)`.
fn encrypt_cbc(key: &[u8], iv: &[u8], plaintext: &[u8]) -> Option<Vec<u8>> {
    let iv: [u8; BLOCK_SIZE] = iv.try_into().ok()?;
    match key.len() {
        16 => {
            let key: [u8; 16] = key.try_into().ok()?;
            Some(
                cbc::Encryptor::<Aes128>::new(&key.into(), &iv.into())
                    .encrypt_padded_vec_mut::<Pkcs7>(plaintext),
            )
        }
        24 => {
            let key: [u8; 24] = key.try_into().ok()?;
            Some(
                cbc::Encryptor::<Aes192>::new(&key.into(), &iv.into())
                    .encrypt_padded_vec_mut::<Pkcs7>(plaintext),
            )
        }
        32 => {
            let key: [u8; 32] = key.try_into().ok()?;
            Some(
                cbc::Encryptor::<Aes256>::new(&key.into(), &iv.into())
                    .encrypt_padded_vec_mut::<Pkcs7>(plaintext),
            )
        }
        _ => None,
    }
}

/// `urllib.parse.quote(text, safe="/")`: keep the RFC 3986 unreserved set plus
/// `/`, percent-encode every other byte with uppercase hex. The source's
/// default `safe` keeps `/` literal, unlike a plain path-segment encoder.
fn python_quote(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-' | b'~' | b'/') {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Known-answer vector: `{user_id}#{task_id}` under the default key/IV
    /// produces this token, and the base URL produces the share link shape.
    #[test]
    fn reproduces_the_recorded_token_and_url() {
        let token = encode_share_token(
            DEFAULT_SHARE_TOKEN_AES_KEY.as_bytes(),
            DEFAULT_SHARE_TOKEN_AES_IV.as_bytes(),
            157,
            21577915845323,
        )
        .expect("token");
        assert_eq!(token, "TzpvmMe3/jzEwJ1kKuLLOQC80qp9TFzueEXxlnm%2Bj7k%3D");
        assert_eq!(
            build_share_url("https://share.example.test", &token),
            "https://share.example.test/shared/task?token=TzpvmMe3/jzEwJ1kKuLLOQC80qp9TFzueEXxlnm%2Bj7k%3D"
        );
    }

    /// `urllib.parse.quote(safe="/")` keeps `/`, encodes `+`/`=`, and leaves
    /// the unreserved set intact.
    #[test]
    fn quotes_like_python_quote() {
        assert_eq!(python_quote("a/b+c="), "a/b%2Bc%3D");
        assert_eq!(python_quote("A-Z_a.z~9"), "A-Z_a.z~9");
        assert_eq!(python_quote("\u{4e2d}"), "%E4%B8%AD");
    }

    /// A wrong-length key or IV is rejected, mirroring the source `Cipher`
    /// construction error.
    #[test]
    fn rejects_a_malformed_key_or_iv() {
        assert!(encrypt_cbc(&[0u8; 32], &[0u8; 8], b"x").is_none());
        assert!(encrypt_cbc(&[0u8; 20], &[0u8; 16], b"x").is_none());
    }
}
