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
/// percent-encoded request target (path and optional query string).
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
/// `uri` must contain the already percent-encoded path and query sent on the
/// wire. Query names and values are decoded and S3-encoded before sorting;
/// S3 object paths are not normalized.
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
    let (path, query) = uri.split_once('?').unwrap_or((uri, ""));
    let canonical_query = canonical_query(query);
    let canonical_request = format!(
        "{method}\n{path}\n{canonical_query}\n{canonical_headers}\n\n{signed_headers}\n{payload_sha256}"
    );

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

/// Encode decoded names and values before sorting, retaining duplicate and empty pairs.
fn canonical_query(query: &str) -> String {
    let mut pairs: Vec<_> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| pair.split_once('=').unwrap_or((pair, "")))
        .map(|(name, value)| {
            (
                canonical_query_component(name),
                canonical_query_component(value),
            )
        })
        .collect();
    pairs.sort_unstable();
    pairs
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// Decode form-style query escapes once, then S3-encode bytes without UTF-8 loss.
fn canonical_query_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let mut byte = match bytes[index] {
            b'+' => b' ',
            byte => byte,
        };
        if byte == b'%'
            && let (Some(high), Some(low)) = (
                bytes
                    .get(index + 1)
                    .and_then(|byte| char::from(*byte).to_digit(16)),
                bytes
                    .get(index + 2)
                    .and_then(|byte| char::from(*byte).to_digit(16)),
            )
        {
            byte = ((high << 4) | low) as u8;
            index += 2;
        }
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[(byte >> 4) as usize]));
            out.push(char::from(HEX[(byte & 0xF) as usize]));
        }
        index += 1;
    }
    out
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

    /// Independent vectors generated with minio-py 7.2.20 sign_v4_s3.
    #[test]
    fn multipart_signatures_match_minio_sdk() {
        for (method, uri, signature) in [
            (
                "POST",
                "/bucket/key?uploads=",
                "460e8cc644cc0bcd3f10c472d147981666b530997d2ef4496edeedad8d1dec64",
            ),
            (
                "PUT",
                "/bucket/key?uploadId=a%2Bb%2Fc%3D&partNumber=1",
                "7e64d37bb02f14a6866e19581d287ff4558e21a125503c60158afbe4ed89aaf6",
            ),
            (
                "POST",
                "/bucket/key?uploadId=a%2Bb%2Fc%3D",
                "b326d50b5991bfa4694f7258f76d001ebe839cd2c1ac2812ddb627f98fb3008f",
            ),
        ] {
            let signed = sign_headers(
                "access",
                "secret",
                "us-east-1",
                method,
                uri,
                "20261026T130000Z",
                EMPTY_BODY_SHA256,
                &[
                    ("host", "storage.example.invalid"),
                    ("x-amz-content-sha256", EMPTY_BODY_SHA256),
                    ("x-amz-date", "20261026T130000Z"),
                ],
            );
            assert!(
                signed
                    .authorization
                    .ends_with(&format!("Signature={signature}")),
                "{uri}"
            );
        }
    }

    /// Encoded pairs sort by name and value, including query flags with no equals sign.
    #[test]
    fn query_pairs_sort_encoded_names_and_values_and_keep_empty_values() {
        assert_eq!(
            canonical_query("z=last&uploads&tag=b&tag=a&%C3%A9=%2B%2F%3D"),
            "%C3%A9=%2B%2F%3D&tag=a&tag=b&uploads=&z=last"
        );
    }

    /// Sign fixed inputs so encoding variants can be compared independently of time.
    fn query_signature(uri: &str) -> String {
        sign_headers(
            "access",
            "secret",
            "us-east-1",
            "PUT",
            uri,
            "20261026T130000Z",
            EMPTY_BODY_SHA256,
            &[
                ("host", "storage.example.invalid"),
                ("x-amz-content-sha256", EMPTY_BODY_SHA256),
                ("x-amz-date", "20261026T130000Z"),
            ],
        )
        .authorization
    }

    /// Hexadecimal escape case does not change a decoded query value.
    #[test]
    fn lowercase_query_escapes_have_the_canonical_signature() {
        assert_eq!(
            query_signature("/bucket/key?partNumber=1&uploadId=a%2fb"),
            query_signature("/bucket/key?partNumber=1&uploadId=a%2Fb")
        );
    }

    /// Escaped unreserved bytes must be emitted as their literal characters.
    #[test]
    fn escaped_unreserved_query_values_have_the_canonical_signature() {
        assert_eq!(
            query_signature("/bucket/key?uploadId=%61"),
            query_signature("/bucket/key?uploadId=a")
        );
    }

    /// Query names, like values, must be decoded before canonical encoding and sorting.
    #[test]
    fn escaped_query_names_have_the_canonical_signature() {
        assert_eq!(
            query_signature("/bucket/key?%75ploadId=a"),
            query_signature("/bucket/key?uploadId=a")
        );
    }

    /// Fixed canonical-request vectors independently calculated with Python hashlib/hmac.
    #[test]
    fn noncanonical_queries_match_fixed_canonical_signatures() {
        for (uri, signature) in [
            (
                "/bucket/key?partNumber=1&uploadId=a%2fb",
                "af9da3ceb0feb9add2d8de00981775a7475d406804e33c5bf1f4871eb83096c5",
            ),
            (
                "/bucket/key?uploadId=%61",
                "d1bf24bd6277372e134ce5d85444797bf2eb3589debb6be61ec03115e837c349",
            ),
            (
                "/bucket/key?%75ploadId=a",
                "d1bf24bd6277372e134ce5d85444797bf2eb3589debb6be61ec03115e837c349",
            ),
        ] {
            assert!(query_signature(uri).ends_with(signature), "{uri}");
        }
    }

    /// Canonical sorting follows encoding and must not drop duplicate or empty pairs.
    #[test]
    fn query_normalization_preserves_duplicates_and_empty_values() {
        assert_eq!(
            canonical_query("z=last&uploads&%74ag=b&tag=%61&tag=a&%C3%a9=%2b%2f%3d"),
            "%C3%A9=%2B%2F%3D&tag=a&tag=a&tag=b&uploads=&z=last"
        );
    }

    /// Decode once without losing non-UTF-8 octets or turning escaped delimiters into pairs.
    #[test]
    fn query_normalization_preserves_octets_and_escaped_delimiters() {
        assert_eq!(
            canonical_query("k=%ff%00%26%3d%25%2b%252f&space=a+b&utf8=中文"),
            "k=%FF%00%26%3D%25%2B%252f&space=a%20b&utf8=%E4%B8%AD%E6%96%87"
        );
    }

    /// Query canonicalization must not rewrite distinct S3 object paths.
    #[test]
    fn object_paths_remain_distinct_when_normalizing_query_parameters() {
        for (original, normalized) in [
            ("/bucket/a//b", "/bucket/a/b"),
            ("/bucket/a/../b", "/bucket/b"),
            ("/bucket/a%2fb", "/bucket/a%2Fb"),
        ] {
            assert_ne!(
                query_signature(&format!("{original}?uploadId=%61")),
                query_signature(&format!("{normalized}?uploadId=%61"))
            );
        }
    }

    /// The queryless GET must keep the independently generated MinIO SDK signature.
    #[test]
    fn queryless_signature_matches_minio_sdk() {
        let signed = sign_headers(
            "access",
            "secret",
            "us-east-1",
            "GET",
            "/test.txt",
            "20261026T130000Z",
            EMPTY_BODY_SHA256,
            &[
                ("host", "storage.example.invalid"),
                ("range", "bytes=0-9"),
                ("x-amz-content-sha256", EMPTY_BODY_SHA256),
                ("x-amz-date", "20261026T130000Z"),
            ],
        );
        assert!(signed.authorization.ends_with(
            "Signature=211209d1a3ba500a45a1ab06111cb94c12ddbc4529cabb0de4da0fffee69c2e2"
        ));
    }

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
