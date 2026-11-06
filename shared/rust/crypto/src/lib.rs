// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! AES-CBC with PKCS#7 padding. Configuration and failure policy belong to callers.

#![forbid(unsafe_code)]

use aes::{Aes128, Aes192, Aes256};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};

/// Invalid key, IV, ciphertext length, or PKCS#7 padding. Contains no key material.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CryptoError;

impl std::fmt::Display for CryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("invalid AES-CBC input")
    }
}

impl std::error::Error for CryptoError {}

/// Encrypt bytes with a 16/24/32-byte AES key and a 16-byte IV.
/// Empty plaintext produces one full padding block.
pub fn encrypt_cbc(key: &[u8], iv: &[u8], plain: &[u8]) -> Result<Vec<u8>, CryptoError> {
    macro_rules! encrypt {
        ($cipher:ty) => {
            cbc::Encryptor::<$cipher>::new_from_slices(key, iv)
                .map(|cipher| cipher.encrypt_padded_vec_mut::<Pkcs7>(plain))
                .map_err(|_| CryptoError)
        };
    }
    match key.len() {
        16 => encrypt!(Aes128),
        24 => encrypt!(Aes192),
        32 => encrypt!(Aes256),
        _ => Err(CryptoError),
    }
}

/// Decrypt whole ciphertext blocks and strictly validate PKCS#7 padding.
pub fn decrypt_cbc(key: &[u8], iv: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, CryptoError> {
    decrypt_with_padding::<Pkcs7>(key, iv, encrypted)
}

/// Decrypt whole CBC blocks without validating or removing padding.
/// Callers must validate padding according to their own wire protocol.
pub fn decrypt_cbc_blocks(key: &[u8], iv: &[u8], encrypted: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if encrypted.is_empty() {
        return Err(CryptoError);
    }
    decrypt_with_padding::<cbc::cipher::block_padding::NoPadding>(key, iv, encrypted)
}

fn decrypt_with_padding<P: cbc::cipher::block_padding::Padding<cbc::cipher::consts::U16>>(
    key: &[u8],
    iv: &[u8],
    encrypted: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    macro_rules! decrypt {
        ($cipher:ty) => {
            cbc::Decryptor::<$cipher>::new_from_slices(key, iv)
                .map_err(|_| CryptoError)?
                .decrypt_padded_vec_mut::<P>(encrypted)
                .map_err(|_| CryptoError)
        };
    }
    match key.len() {
        16 => decrypt!(Aes128),
        24 => decrypt!(Aes192),
        32 => decrypt!(Aes256),
        _ => Err(CryptoError),
    }
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

    #[test]
    fn matches_openssl_pkcs7_vectors_for_all_key_sizes() {
        let iv = b"1234567890123456";
        for (key, ciphertext) in [
            (
                b"0123456789abcdef".as_slice(),
                "3f43c004815ceaa734d8909c29afd69a",
            ),
            (
                b"0123456789abcdef01234567".as_slice(),
                "a60d58b426bbdb778d40741a1f90448e",
            ),
            (
                b"12345678901234567890123456789012".as_slice(),
                "71a51a155db0824633d5222b7a9bfb3d",
            ),
        ] {
            let encrypted = hex(ciphertext);
            assert_eq!(encrypt_cbc(key, iv, b"wegent").unwrap(), encrypted);
            assert_eq!(decrypt_cbc(key, iv, &encrypted).unwrap(), b"wegent");
        }
    }

    #[test]
    fn empty_plaintext_has_one_padding_block_but_empty_ciphertext_is_invalid() {
        let key = b"12345678901234567890123456789012";
        let iv = b"1234567890123456";
        let encrypted = hex("b5522cd53f3d5a728c5c531474efc150");
        assert_eq!(encrypt_cbc(key, iv, b"").unwrap(), encrypted);
        assert_eq!(decrypt_cbc(key, iv, &encrypted).unwrap(), b"");
        assert_eq!(decrypt_cbc(key, iv, b""), Err(CryptoError));
    }

    #[test]
    fn rejects_invalid_material_and_padding() {
        let key = b"12345678901234567890123456789012";
        let iv = b"1234567890123456";
        assert_eq!(encrypt_cbc(b"short", iv, b"secret"), Err(CryptoError));
        assert_eq!(encrypt_cbc(key, b"short", b"secret"), Err(CryptoError));
        assert_eq!(decrypt_cbc(key, iv, b"partial"), Err(CryptoError));
        // Flip the last plaintext byte's padding via the IV for one CBC block.
        let mut bad_iv = *iv;
        bad_iv[15] ^= 10;
        assert_eq!(
            decrypt_cbc(key, &bad_iv, &hex("71a51a155db0824633d5222b7a9bfb3d")),
            Err(CryptoError)
        );
    }
}
