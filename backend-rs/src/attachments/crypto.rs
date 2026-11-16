// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Attachment payload crypto mirroring `shared/utils/crypto.py`'s
//! `decrypt_attachment` / `_get_attachment_encryption_key`, as the service
//! layer (`context_service.get_attachment_binary_data`) applies it.
//!
//! A row whose `type_data.is_encrypted` is set keeps AES-CBC ciphertext with
//! PKCS#7 padding in the configured backend; `decrypt_attachment` removes both
//! layers with `ATTACHMENT_AES_KEY` / `ATTACHMENT_AES_IV` and the documented
//! defaults. `cryptography`'s `algorithms.AES(key)` selects the variant from
//! the key length, so a 16-, 24-, or 32-byte configured key is AES-128,
//! AES-192, or AES-256 respectively.
//!
use std::borrow::Cow;

/// `_get_attachment_encryption_key`'s `ATTACHMENT_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// `_get_attachment_encryption_key`'s `ATTACHMENT_AES_IV` default.
const DEFAULT_AES_IV: &str = "1234567890123456";
/// The `cryptography` failure `decrypt_attachment` re-raises (an unsupported
/// key or IV length, a non-block-aligned payload, or invalid padding). The
/// endpoint renders it as its 500 `Failed to retrieve attachment data`.
#[derive(Debug)]
pub struct AttachmentDecryptionError;

impl std::fmt::Display for AttachmentDecryptionError {
    /// The source's log line (`Failed to decrypt attachment data`).
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Failed to decrypt attachment data")
    }
}

/// `decrypt_attachment(encrypted_data)`.
///
/// The key and IV come from the process environment or the source-compatible
/// dotenv file, like every other source `os.environ` read.
pub fn decrypt_attachment(encrypted: &[u8]) -> Result<Vec<u8>, AttachmentDecryptionError> {
    // `if not encrypted_data: return b""`.
    if encrypted.is_empty() {
        return Ok(Vec::new());
    }
    let key = configured("ATTACHMENT_AES_KEY", DEFAULT_AES_KEY);
    let iv = configured("ATTACHMENT_AES_IV", DEFAULT_AES_IV);
    decrypt_with_key(key.as_bytes(), iv.as_bytes(), encrypted)
}

/// `os.environ.get(name, default)`, with the deployment's dotenv file as the
/// process-environment source on startup.
fn configured(name: &str, default: &'static str) -> Cow<'static, str> {
    match crate::config::env_or_dotenv(name) {
        Some(value) => Cow::Owned(value),
        None => Cow::Borrowed(default),
    }
}

/// `AES(key)` + `CBC(iv)` + `decryptor.update(...)`.
///
/// Shared with the share-token decoder (`share_token.rs`), whose
/// `shared_task._aes_decrypt` applies the same AES-CBC + PKCS#7 primitive
/// with the `SHARE_TOKEN_AES_*` key material.
pub(crate) fn decrypt_with_key(
    key: &[u8],
    iv: &[u8],
    encrypted: &[u8],
) -> Result<Vec<u8>, AttachmentDecryptionError> {
    wegent_crypto::decrypt_cbc(key, iv, encrypted).map_err(|_| AttachmentDecryptionError)
}

/// The `cryptography` failure `encrypt_attachment` re-raises (an unsupported
/// key length); the endpoint renders it as its generic 500.
#[derive(Debug)]
pub struct AttachmentEncryptionError;

impl std::fmt::Display for AttachmentEncryptionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Failed to encrypt attachment data")
    }
}

/// `encrypt_attachment(binary_data)`: raw AES-CBC ciphertext with PKCS#7
/// padding (NOT base64 encoded). `if not binary_data: return b""`.
pub fn encrypt_attachment(plain: &[u8]) -> Result<Vec<u8>, AttachmentEncryptionError> {
    if plain.is_empty() {
        return Ok(Vec::new());
    }
    let key = configured("ATTACHMENT_AES_KEY", DEFAULT_AES_KEY);
    let iv = configured("ATTACHMENT_AES_IV", DEFAULT_AES_IV);
    encrypt_with_key(key.as_bytes(), iv.as_bytes(), plain)
}

/// `AES(key)` + `CBC(iv)` + `encryptor.update(...)`.
fn encrypt_with_key(
    key: &[u8],
    iv: &[u8],
    plain: &[u8],
) -> Result<Vec<u8>, AttachmentEncryptionError> {
    wegent_crypto::encrypt_cbc(key, iv, plain).map_err(|_| AttachmentEncryptionError)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(value: &str) -> Vec<u8> {
        (0..value.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
            .collect()
    }

    const DEFAULT_KEY: &[u8] = b"12345678901234567890123456789012";
    const DEFAULT_IV: &[u8] = b"1234567890123456";

    // Ciphertexts produced by `openssl enc -aes-<bits>-cbc` with PKCS#7
    // padding, so a change to the block order, the chaining, or the unpadding
    // fails here rather than in Replay.
    #[test]
    fn decrypts_aes_256_cbc_with_the_default_key() {
        assert_eq!(
            decrypt_with_key(
                DEFAULT_KEY,
                DEFAULT_IV,
                &hex("71a51a155db0824633d5222b7a9bfb3d")
            )
            .unwrap(),
            b"wegent"
        );
        assert_eq!(
            decrypt_with_key(
                DEFAULT_KEY,
                DEFAULT_IV,
                &hex("de3f54a5ea18703da9b88da50076e1cb")
            )
            .unwrap(),
            b"decrypt-me"
        );
    }

    #[test]
    fn removes_padding_that_fills_the_last_block() {
        // A 16-byte plaintext pads to a whole extra block.
        assert_eq!(
            decrypt_with_key(
                DEFAULT_KEY,
                DEFAULT_IV,
                &hex("ee493e309404018af85b3ad0a656a77140e28cecafdf30ff26369636aaed72ac")
            )
            .unwrap(),
            b"xxxxxxxxxxxxxxxx"
        );
        // A full padding block decrypts to the empty payload.
        assert_eq!(
            decrypt_with_key(
                DEFAULT_KEY,
                DEFAULT_IV,
                &hex("b5522cd53f3d5a728c5c531474efc150")
            )
            .unwrap(),
            b""
        );
    }

    #[test]
    fn selects_the_variant_from_the_key_length() {
        assert_eq!(
            decrypt_with_key(
                b"0123456789abcdef",
                DEFAULT_IV,
                &hex("3f43c004815ceaa734d8909c29afd69a")
            )
            .unwrap(),
            b"wegent"
        );
        assert_eq!(
            decrypt_with_key(
                b"0123456789abcdef01234567",
                DEFAULT_IV,
                &hex("a60d58b426bbdb778d40741a1f90448e")
            )
            .unwrap(),
            b"wegent"
        );
    }

    #[test]
    fn rejects_invalid_input_like_the_source() {
        // `algorithms.AES` accepts only 128/192/256-bit keys and `modes.CBC`
        // only a 16-byte IV.
        assert!(decrypt_with_key(b"too-short", DEFAULT_IV, &hex("71a51a15")).is_err());
        assert!(decrypt_with_key(DEFAULT_KEY, b"short-iv", &hex("71a51a15")).is_err());
        // `finalize()` rejects a payload that is not block-aligned.
        assert!(decrypt_with_key(DEFAULT_KEY, DEFAULT_IV, &hex("71a51a15")).is_err());
        // A wrong key produces invalid padding.
        assert!(
            decrypt_with_key(
                b"01234567890123456789012345678901",
                DEFAULT_IV,
                &hex("71a51a155db0824633d5222b7a9bfb3d")
            )
            .is_err()
        );
    }

    #[test]
    fn empty_payloads_stay_empty() {
        // `if not encrypted_data: return b""` runs before any key lookup.
        assert_eq!(decrypt_attachment(b"").unwrap(), Vec::<u8>::new());
        assert_eq!(encrypt_attachment(b"").unwrap(), Vec::<u8>::new());
    }

    /// `encrypt_attachment` is the exact inverse of `decrypt_attachment`.
    #[test]
    fn encryption_round_trips_through_decryption() {
        for plain in [b"wegent".as_slice(), b"xxxxxxxxxxxxxxxx", b"decrypt-me"] {
            let encrypted = encrypt_with_key(DEFAULT_KEY, DEFAULT_IV, plain).unwrap();
            assert_eq!(
                decrypt_with_key(DEFAULT_KEY, DEFAULT_IV, &encrypted).unwrap(),
                plain
            );
        }
    }
}
