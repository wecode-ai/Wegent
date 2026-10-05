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
//! The block cipher comes from the `aes` crate this repository already links
//! through `aes-gcm` (the provider-credential payloads), so the CBC path adds
//! no dependency to the migrated surface.
use std::borrow::Cow;

use aes_gcm::aes::cipher::{Block, BlockDecrypt, KeyInit};
use aes_gcm::aes::{Aes128, Aes192, Aes256};

/// `_get_attachment_encryption_key`'s `ATTACHMENT_AES_KEY` default.
const DEFAULT_AES_KEY: &str = "12345678901234567890123456789012";
/// `_get_attachment_encryption_key`'s `ATTACHMENT_AES_IV` default.
const DEFAULT_AES_IV: &str = "1234567890123456";
/// `algorithms.AES.block_size`: the CBC block size and the PKCS#7 block size.
const BLOCK_SIZE: usize = 16;

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
fn decrypt_with_key(
    key: &[u8],
    iv: &[u8],
    encrypted: &[u8],
) -> Result<Vec<u8>, AttachmentDecryptionError> {
    // `modes.CBC(aes_iv)` requires exactly one block of IV.
    let iv: [u8; BLOCK_SIZE] = iv.try_into().map_err(|_| AttachmentDecryptionError)?;
    match key.len() {
        16 => decrypt_cbc::<Aes128>(key, iv, encrypted),
        24 => decrypt_cbc::<Aes192>(key, iv, encrypted),
        32 => decrypt_cbc::<Aes256>(key, iv, encrypted),
        // Every other key length is rejected by `algorithms.AES`.
        _ => Err(AttachmentDecryptionError),
    }
}

/// CBC decryption: `finalize()` rejects a payload that is not a whole number
/// of blocks, and each plaintext block is the decrypted block XORed with the
/// preceding ciphertext block (`decryptor.update` + `finalize`).
fn decrypt_cbc<C>(
    key: &[u8],
    iv: [u8; BLOCK_SIZE],
    encrypted: &[u8],
) -> Result<Vec<u8>, AttachmentDecryptionError>
where
    C: BlockDecrypt + KeyInit,
{
    let cipher = C::new_from_slice(key).map_err(|_| AttachmentDecryptionError)?;
    if !encrypted.len().is_multiple_of(BLOCK_SIZE) {
        return Err(AttachmentDecryptionError);
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

/// `padding.PKCS7(128).unpadder()`: the trailing byte is the pad length and
/// every padded byte repeats it.
fn unpad_pkcs7(mut plain: Vec<u8>) -> Result<Vec<u8>, AttachmentDecryptionError> {
    let padding = usize::from(*plain.last().ok_or(AttachmentDecryptionError)?);
    if padding == 0 || padding > BLOCK_SIZE || padding > plain.len() {
        return Err(AttachmentDecryptionError);
    }
    let content = plain.len() - padding;
    if plain[content..]
        .iter()
        .any(|byte| usize::from(*byte) != padding)
    {
        return Err(AttachmentDecryptionError);
    }
    plain.truncate(content);
    Ok(plain)
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
    }
}
