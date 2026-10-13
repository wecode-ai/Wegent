// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! AWS SigV4 query-string presigning for the workspace-archive bucket.
//!
//! Mirrors what the source `minio-py` client renders for
//! `presigned_get_object` / `presigned_put_object` (`_presign_v4`): the
//! `X-Amz-*` query parameters plus the `X-Amz-Signature` computed over the
//! request with the `UNSIGNED-PAYLOAD` body hash. The archive service hands
//! the resulting URL to the executor, which performs the object transfer.
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// The payload placeholder a presigned URL signs instead of a real body hash.
const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// Sign a `method` request for `host`/`uri` and return the full presigned URL.
///
/// `amz_date` is the UTC `YYYYMMDD'T'HHMMSS'Z'` timestamp; the credential
/// scope is `{date}/{region}/s3/aws4_request`, matching the header signer.
#[allow(clippy::too_many_arguments)]
pub fn presign(
    scheme: &str,
    host: &str,
    method: &str,
    uri: &str,
    access_key: &str,
    secret_key: &str,
    region: &str,
    amz_date: &str,
    expires_seconds: u64,
) -> String {
    let date_stamp = &amz_date[..8];
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let credential = format!("{access_key}/{credential_scope}");

    let mut params = [
        ("X-Amz-Algorithm", "AWS4-HMAC-SHA256".to_string()),
        ("X-Amz-Credential", credential),
        ("X-Amz-Date", amz_date.to_string()),
        ("X-Amz-Expires", expires_seconds.to_string()),
        ("X-Amz-SignedHeaders", "host".to_string()),
    ];
    params.sort_by(|left, right| left.0.cmp(right.0));
    let canonical_query = params
        .iter()
        .map(|(name, value)| format!("{}={}", uri_encode(name, true), uri_encode(value, true)))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_headers = format!("host:{host}\n");
    let canonical_request = format!(
        "{method}\n{uri}\n{canonical_query}\n{canonical_headers}\nhost\n{UNSIGNED_PAYLOAD}"
    );
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );
    let key = signing_key(secret_key, date_stamp, region);
    let signature = hex_bytes(&hmac_sha256(&key, string_to_sign.as_bytes()));

    format!("{scheme}://{host}{uri}?{canonical_query}&X-Amz-Signature={signature}")
}

/// The SigV4 signing key derived from the secret key and the date/region scope.
fn signing_key(secret_key: &str, date_stamp: &str, region: &str) -> [u8; 32] {
    let date_key = hmac_sha256(
        format!("AWS4{secret_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let region_key = hmac_sha256(&date_key, region.as_bytes());
    let service_key = hmac_sha256(&region_key, b"s3");
    hmac_sha256(&service_key, b"aws4_request")
}

/// RFC 3986 encoding, optionally preserving `/` (the object-path encoding the
/// storage client uses).
pub fn uri_encode(value: &str, encode_slash: bool) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'.' | b'_' | b'~')
            || (!encode_slash && byte == b'/');
        if unreserved {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0xF) as usize] as char);
        }
    }
    out
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

fn hex_sha256(data: &[u8]) -> String {
    hex_bytes(&Sha256::digest(data))
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_unreserved_and_slash_like_the_storage_client() {
        assert_eq!(uri_encode("a/b c", true), "a%2Fb%20c");
        assert_eq!(uri_encode("a/b c", false), "a/b%20c");
        assert_eq!(uri_encode("AKID/20261010", true), "AKID%2F20261010");
    }

    #[test]
    fn presigned_url_carries_the_sigv4_query_and_a_signature() {
        let url = presign(
            "http",
            "storage.example.invalid:9100",
            "GET",
            "/wegent-archives/workspace-archives/1/archive.tar.gz",
            "ak",
            "sk",
            "us-east-1",
            "20261010T062557Z",
            3600,
        );
        assert!(url.starts_with(
            "http://storage.example.invalid:9100/wegent-archives/workspace-archives/1/archive.tar.gz?"
        ));
        assert!(url.contains("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
        assert!(url.contains("X-Amz-Credential=ak%2F20261010%2Fus-east-1%2Fs3%2Faws4_request"));
        assert!(url.contains("X-Amz-Date=20261010T062557Z"));
        assert!(url.contains("X-Amz-Expires=3600"));
        assert!(url.contains("X-Amz-SignedHeaders=host"));
        assert!(url.contains("&X-Amz-Signature="));
    }

    #[test]
    fn presigning_is_deterministic_for_fixed_inputs() {
        let sign = || {
            presign(
                "https",
                "h",
                "GET",
                "/b/k",
                "ak",
                "sk",
                "us-east-1",
                "20261010T062557Z",
                60,
            )
        };
        assert_eq!(sign(), sign());
    }
}
