// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Per-user encryption keys for native Wework transcript segments.
//!
//! Mirrors `app.core.wework_transcript_encryption`: one stable AES-256-GCM key
//! per user, derived from the configured master secret without persisting
//! plaintext key material.
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// `KEY_ALGORITHM` (`app.core.wework_transcript_encryption`).
pub(crate) const KEY_ALGORITHM: &str = "aes-256-gcm";

/// `transcript_encryption_key(user_id)`.
///
/// The source computes
/// `base64(HMAC-SHA256(SHA-256("wegent-wework-transcript-master:<configured>"),
/// "wegent-wework-transcript:user:<user_id>"))`, so the same user always
/// decrypts its own transcript segments and different users never share a key.
pub(crate) fn transcript_encryption_key(configured_key: &str, user_id: i32) -> String {
    let master: [u8; 32] =
        Sha256::digest(format!("wegent-wework-transcript-master:{configured_key}").as_bytes())
            .into();

    let mut mac = HmacSha256::new_from_slice(&master).expect("HMAC accepts any key length");
    mac.update(format!("wegent-wework-transcript:user:{user_id}").as_bytes());
    STANDARD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_a_stable_standard_base64_key_per_user() {
        let key = transcript_encryption_key("compat-master-value", 2095);
        assert_eq!(key.len(), 44);
        assert_eq!(key, transcript_encryption_key("compat-master-value", 2095));
        assert_ne!(key, transcript_encryption_key("compat-master-value", 2096));
        assert_ne!(key, transcript_encryption_key("other-master-value", 2095));
    }

    #[test]
    fn key_length_matches_a_full_hmac_sha256_digest() {
        let decoded = STANDARD
            .decode(transcript_encryption_key("master", 1))
            .unwrap();
        assert_eq!(decoded.len(), 32);
    }

    #[test]
    fn matches_the_source_derivation_for_known_inputs() {
        // Vectors produced by `app.core.wework_transcript_encryption` for the
        // literal value `wegent-transcript-compat-master`, so a change to the
        // digest, HMAC, base64 alphabet, or context string fails here.
        assert_eq!(
            transcript_encryption_key("wegent-transcript-compat-master", 2095),
            "AQfkyI0Zs36mcBkdjimM2cjMGTiQJ49/m3Dj5oj3VEo="
        );
        assert_eq!(
            transcript_encryption_key("wegent-transcript-compat-master", 1),
            "OttZ8YTE7xFuh6AsJT0Q6/KzZHXuFDd1nNOL67a/Kfw="
        );
    }
}
