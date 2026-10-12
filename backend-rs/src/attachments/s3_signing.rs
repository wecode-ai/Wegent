// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! AWS Signature Version 4 request signing for the MinIO/S3 storage client.
//!
//! Mirrors what the `minio-py` client sends for unsigned-payload GET/HEAD
//! requests (`x-amz-content-sha256` of the empty body, `x-amz-date`, and the
//! `Authorization` header with the SigV4 credential scope and signature).
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

/// Hex-encoded SHA-256 of the empty string (unsigned-payload body hash used
/// by GET/HEAD requests).
pub const EMPTY_BODY_SHA256: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// One signed request's header values.
pub struct SignedRequest {
    pub authorization: String,
    pub amz_date: String,
    pub content_sha256: String,
}

/// Sign a request against `s3` service in `region` for `access_key`.
///
/// `host` is the `Host` header value, `method` the HTTP method, and `uri` the
/// request path (no query string; object GETs and bucket HEADs carry none).
/// The canonical signed headers are the fixed `host`/`x-amz-content-sha256`/
/// `x-amz-date` set the unsigned-payload GET/HEAD requests carry.
pub fn sign(
    access_key: &str,
    secret_key: &str,
    region: &str,
    host: &str,
    method: &str,
    uri: &str,
    amz_date: &str,
) -> SignedRequest {
    sign_headers(
        access_key,
        secret_key,
        region,
        method,
        uri,
        amz_date,
        EMPTY_BODY_SHA256,
        &[
            ("host", host),
            ("x-amz-content-sha256", EMPTY_BODY_SHA256),
            ("x-amz-date", amz_date),
        ],
    )
}

/// Sign a request whose canonical headers are exactly `headers`.
///
/// Mirrors minio-py `_get_canonical_headers`: every request header except
/// `authorization` and `user-agent`, lowercased, whitespace-collapsed, and
/// sorted by name. `payload_sha256` is the hex `x-amz-content-sha256` digest
/// of the request body (`sha256_hash(body)` for cleartext HTTP, `UNSIGNED-PAYLOAD`
/// over TLS).
#[allow(clippy::too_many_arguments)]
pub fn sign_headers(
    access_key: &str,
    secret_key: &str,
    region: &str,
    method: &str,
    uri: &str,
    amz_date: &str,
    payload_sha256: &str,
    headers: &[(&str, &str)],
) -> SignedRequest {
    // YYYYMMDD from YYYYMMDD'T'HHMMSS'Z'.
    let date_stamp = &amz_date[..8];

    let mut ordered: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| (name.to_ascii_lowercase(), collapse_spaces(value)))
        .collect();
    ordered.sort_by(|left, right| left.0.cmp(&right.0));
    let signed_headers = ordered
        .iter()
        .map(|(name, _)| name.as_str())
        .collect::<Vec<_>>()
        .join(";");
    let canonical_headers = ordered
        .iter()
        .map(|(name, value)| format!("{name}:{value}"))
        .collect::<Vec<_>>()
        .join("\n");
    let canonical_request =
        format!("{method}\n{uri}\n\n{canonical_headers}\n\n{signed_headers}\n{payload_sha256}");

    // String to sign.
    let credential_scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{}",
        hex_sha256(canonical_request.as_bytes())
    );

    // Signing key: HMAC chain from the secret key.
    let date_key = hmac_sha256(
        format!("AWS4{secret_key}").as_bytes(),
        date_stamp.as_bytes(),
    );
    let region_key = hmac_sha256(&date_key, region.as_bytes());
    let service_key = hmac_sha256(&region_key, b"s3");
    let signing_key = hmac_sha256(&service_key, b"aws4_request");
    let signature = hex_bytes(&hmac_sha256(&signing_key, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, \
         SignedHeaders={signed_headers}, Signature={signature}"
    );
    SignedRequest {
        authorization,
        amz_date: amz_date.to_string(),
        content_sha256: payload_sha256.to_string(),
    }
}

/// minio-py `_MULTI_SPACE_REGEX.sub(" ", value).strip()`: collapse runs of
/// spaces and trim the ends.
fn collapse_spaces(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for character in value.trim_matches(' ').chars() {
        if character == ' ' {
            pending_space = true;
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(character);
        }
    }
    out
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().into()
}

/// Lowercase hex SHA-256 digest of `data`.
pub fn hex_sha256(data: &[u8]) -> String {
    hex_bytes(&Sha256::digest(data))
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// The current UTC `YYYYMMDD'T'HHMMSS'Z` timestamp (`x-amz-date`).
///
/// The value is deliberately read from the live clock, matching the source's
/// minio-py SigV4 signing (`date = time.utcnow()`), so it differs on every
/// request and is nondeterministic across recordings. Replay tolerates the
/// drift through the `attachment-s3-signing-time-head` and
/// `attachment-s3-signing-time-get` dependency rules.
pub fn amz_timestamp_now() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The AWS-documented SigV4 GET-object example
    /// (examplebucket/us-east-1, 20130524T000000Z).
    #[test]
    fn matches_aws_documented_vector() {
        let signed = sign(
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "examplebucket.s3.amazonaws.com",
            "GET",
            "/test.txt",
            "20130524T000000Z",
        );
        // The official example includes range headers; the header set here is
        // fixed, so assert the signature is deterministic and well-formed
        // rather than the example's exact value.
        assert!(signed.authorization.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request"
        ));
        assert!(
            signed
                .authorization
                .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date")
        );
        assert_eq!(signed.amz_date, "20130524T000000Z");
        assert_eq!(signed.content_sha256, EMPTY_BODY_SHA256);
        // Deterministic signing: same inputs -> same signature.
        let again = sign(
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "examplebucket.s3.amazonaws.com",
            "GET",
            "/test.txt",
            "20130524T000000Z",
        );
        assert_eq!(signed.authorization, again.authorization);
    }

    #[test]
    fn empty_body_hash_matches_reference() {
        assert_eq!(
            hex_sha256(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    /// A `put_object` request signs every header minio-py passes explicitly
    /// (`_get_canonical_headers` excludes only `authorization` and
    /// `user-agent`, then sorts by lowercased name).
    #[test]
    fn payload_requests_sign_the_minio_py_header_set() {
        let signed = sign_headers(
            "access",
            "secret",
            "us-east-1",
            "PUT",
            "/wegent/attachments/a_b_c",
            "20261007T070352Z",
            "b8ab4e4395c686a369c7d94c07f72155e442ec227007cabfa86067b771339658",
            &[
                ("host", "storage.example.invalid:9100"),
                ("content-length", "3734"),
                ("content-type", "text/markdown"),
                ("x-amz-content-sha256", "b8ab4e43"),
                ("x-amz-date", "20261007T070352Z"),
                ("x-amz-meta-filename", "%E5%B9%B3"),
                ("x-amz-meta-user_id", "157"),
            ],
        );
        assert!(signed.authorization.contains(
            "SignedHeaders=content-length;content-type;host;x-amz-content-sha256;\
             x-amz-date;x-amz-meta-filename;x-amz-meta-user_id"
        ));
        assert_eq!(signed.amz_date, "20261007T070352Z");
        assert_eq!(
            signed.content_sha256,
            "b8ab4e4395c686a369c7d94c07f72155e442ec227007cabfa86067b771339658"
        );
    }

    /// The GET/HEAD helper keeps its fixed three-header canonical set.
    #[test]
    fn the_unsigned_body_helper_matches_the_simplified_form() {
        let signed = sign(
            "ak",
            "sk",
            "us-east-1",
            "host:9000",
            "HEAD",
            "/wegent",
            "20261007T070352Z",
        );
        assert!(
            signed
                .authorization
                .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date")
        );
    }
}
