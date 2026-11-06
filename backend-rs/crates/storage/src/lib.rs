//! S3 signing primitives without configuration, transport, or authorization policy.

#![forbid(unsafe_code)]

pub mod s3_presign;
pub mod s3_signing;
mod signing;

/// Percent-encode an S3 object key while preserving unreserved bytes and `/`.
pub fn encode_object_path(key: &str) -> String {
    signing::uri_encode_bytes(key.as_bytes(), false)
}
