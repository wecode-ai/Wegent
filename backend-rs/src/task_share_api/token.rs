// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Share-token and share-URL generation for the task share endpoint.
//!
//! Secure share-token and share-URL generation for the task share endpoint.
//!
//! `SharedTaskService.generate_share_token` now issues 32 random bytes. The
//! caller persists the URL-safe token in `share_links` with its SHA-256 hash;
//! `GET /api/tasks/share/public` resolves only that hash.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;

use crate::config::env_or_dotenv;

/// `settings.TASK_SHARE_BASE_URL` default (`app/core/config.py`).
const DEFAULT_TASK_SHARE_BASE_URL: &str = "http://localhost:3000";
/// The generated raw token size: 32 random bytes (256 bits).
const SHARE_TOKEN_BYTES: usize = 32;

/// `generate_share_url(share_token)`: the public read-only share link.
///
/// The token is embedded verbatim; `generate_share_token` already URL-quoted
/// it, matching the source where `generate_share_url` interpolates the quoted
/// value unchanged.
pub(crate) fn generate_share_url(share_token: &str) -> String {
    build_share_url(&task_share_base_url(), share_token)
}

/// Generate a 256-bit opaque token. The caller persists it before returning it.
pub(crate) fn generate_share_token() -> Result<String, ()> {
    let mut bytes = [0u8; SHARE_TOKEN_BYTES];
    getrandom::getrandom(&mut bytes).map_err(|_| ())?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// SHA-256(token) as lowercase hex, the `share_links.token_hash` value.
pub(crate) fn token_hash(token: &str) -> String {
    crate::share_access::token_hash(token)
}

/// The `"{base_url}/shared/task?token={token}"` link.
fn build_share_url(base_url: &str, share_token: &str) -> String {
    format!("{base_url}/shared/task?token={share_token}")
}

/// `settings.TASK_SHARE_BASE_URL` through the source precedence.
fn task_share_base_url() -> String {
    env_or_dotenv("TASK_SHARE_BASE_URL").unwrap_or_else(|| DEFAULT_TASK_SHARE_BASE_URL.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A generated token is URL-safe and has 256 bits of entropy.
    #[test]
    fn generates_a_url_safe_256_bit_token() {
        let token = generate_share_token().expect("token");
        assert_eq!(token.len(), 43);
        assert!(
            token
                .bytes()
                .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') })
        );
    }

    /// Token lookup uses the SHA-256 digest of the raw token.
    #[test]
    fn hashes_the_raw_token_with_sha256() {
        assert_eq!(
            token_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
