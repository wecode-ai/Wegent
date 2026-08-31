// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::Write;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::{write::GzEncoder, Compression};
use serde_json::{json, Value};

use crate::logging::{format_executor_log, write_executor_error_line, write_executor_log_line};

const RUNTIME_RPC_COMPRESSION_THRESHOLD_BYTES: usize = 512 * 1024;
const APP_IPC_COMPRESSION_THRESHOLD_BYTES: usize = 1024 * 1024;
const RUNTIME_RPC_MAX_ENCODED_BYTES: usize = 980_000;
const APP_IPC_MAX_ENCODED_BYTES: usize = 15 * 1024 * 1024;
const RUNTIME_RPC_COMPRESSED_ENCODING: &str = "gzip+base64+json";

pub(super) fn encode_runtime_rpc_response(method: &str, response: Value) -> Value {
    encode_json_response(
        "runtime:rpc",
        method,
        response,
        RUNTIME_RPC_COMPRESSION_THRESHOLD_BYTES,
        RUNTIME_RPC_MAX_ENCODED_BYTES,
        "runtime_rpc",
    )
}

pub(crate) fn encode_app_ipc_response(method: &str, response: Value) -> Value {
    encode_json_response(
        "app IPC",
        method,
        response,
        APP_IPC_COMPRESSION_THRESHOLD_BYTES,
        APP_IPC_MAX_ENCODED_BYTES,
        "app_ipc",
    )
}

fn encode_json_response(
    log_prefix: &str,
    method: &str,
    response: Value,
    compression_threshold_bytes: usize,
    max_encoded_bytes: usize,
    error_prefix: &str,
) -> Value {
    let raw = match serde_json::to_vec(&response) {
        Ok(raw) => raw,
        Err(error) => {
            write_executor_error_line(&format_executor_log(
                &format!("{log_prefix} response serialization failed"),
                &[("method", method.to_owned()), ("error", error.to_string())],
            ));
            return encoding_error_response(
                &format!("{error_prefix}_response_encoding_failed"),
                "Response could not be encoded",
            );
        }
    };
    if raw.len() <= compression_threshold_bytes {
        return response;
    }

    let compressed = match gzip(&raw) {
        Ok(compressed) => compressed,
        Err(error) => {
            write_executor_error_line(&format_executor_log(
                &format!("{log_prefix} response compression failed"),
                &[
                    ("method", method.to_owned()),
                    ("raw_bytes", raw.len().to_string()),
                    ("error", error.to_string()),
                ],
            ));
            return encoding_error_response(
                &format!("{error_prefix}_response_encoding_failed"),
                "Response could not be encoded",
            );
        }
    };
    let encoded = BASE64_STANDARD.encode(&compressed);
    let envelope = json!({
        "__runtimeRpcEncoding": RUNTIME_RPC_COMPRESSED_ENCODING,
        "payload": encoded,
        "rawBytes": raw.len(),
        "compressedBytes": compressed.len(),
    });
    let envelope_bytes = serde_json::to_vec(&envelope)
        .map(|value| value.len())
        .unwrap_or(usize::MAX);

    if envelope_bytes > max_encoded_bytes {
        write_executor_error_line(&format_executor_log(
            &format!("{log_prefix} compressed response exceeds transport limit"),
            &[
                ("method", method.to_owned()),
                ("raw_bytes", raw.len().to_string()),
                ("compressed_bytes", compressed.len().to_string()),
                ("encoded_bytes", envelope_bytes.to_string()),
            ],
        ));
        return encoding_error_response(
            &format!("{error_prefix}_response_too_large"),
            "Response exceeded the transport payload limit",
        );
    }

    write_executor_log_line(&format_executor_log(
        &format!("{log_prefix} response compressed"),
        &[
            ("method", method.to_owned()),
            ("raw_bytes", raw.len().to_string()),
            ("compressed_bytes", compressed.len().to_string()),
            ("encoded_bytes", envelope_bytes.to_string()),
        ],
    ));
    envelope
}

fn gzip(raw: &[u8]) -> Result<Vec<u8>, std::io::Error> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(raw)?;
    encoder.finish()
}

fn encoding_error_response(code: &str, message: &str) -> Value {
    json!({
        "success": false,
        "code": code,
        "error": message,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;

    use super::*;

    #[test]
    fn leaves_small_responses_inline() {
        let response = json!({"success": true, "message": "ok"});

        assert_eq!(
            encode_runtime_rpc_response("runtime.tasks.list", response.clone()),
            response
        );
    }

    #[test]
    fn compresses_large_unicode_responses_losslessly() {
        let response = json!({
            "success": true,
            "messages": [{
                "id": "message-1",
                "content": "长历史🙂".repeat(100_000),
            }],
        });

        let encoded = encode_runtime_rpc_response("runtime.tasks.transcript", response.clone());
        let compressed = BASE64_STANDARD
            .decode(encoded["payload"].as_str().expect("compressed payload"))
            .expect("valid base64");
        let mut decoder = GzDecoder::new(compressed.as_slice());
        let mut raw = Vec::new();
        decoder.read_to_end(&mut raw).expect("valid gzip");

        assert_eq!(
            serde_json::from_slice::<Value>(&raw).expect("valid JSON"),
            response
        );
        assert_eq!(
            encoded["__runtimeRpcEncoding"],
            RUNTIME_RPC_COMPRESSED_ENCODING
        );
        assert_eq!(
            encoded["rawBytes"].as_u64(),
            Some(serde_json::to_vec(&response).unwrap().len() as u64)
        );
        assert!(serde_json::to_vec(&encoded).unwrap().len() < RUNTIME_RPC_MAX_ENCODED_BYTES);
    }

    #[test]
    fn accepts_compressed_envelopes_near_the_socket_budget() {
        let response = json!({
            "success": true,
            "payload": BASE64_STANDARD.encode(deterministic_bytes(715_000)),
        });

        let encoded = encode_runtime_rpc_response("runtime.tasks.transcript", response);
        let encoded_bytes = serde_json::to_vec(&encoded).unwrap().len();

        assert_eq!(
            encoded["__runtimeRpcEncoding"],
            RUNTIME_RPC_COMPRESSED_ENCODING
        );
        assert!(encoded_bytes > 900_000);
        assert!(encoded_bytes < RUNTIME_RPC_MAX_ENCODED_BYTES);
    }

    #[test]
    fn app_ipc_accepts_compressed_responses_larger_than_socket_io_budget() {
        let response = json!({"items": vec!["plugin metadata"; 200_000]});
        let encoded = encode_app_ipc_response("plugin/list", response);

        assert_eq!(
            encoded["__runtimeRpcEncoding"],
            RUNTIME_RPC_COMPRESSED_ENCODING
        );
        assert!(encoded["rawBytes"].as_u64().unwrap() > 980_000);
        assert!(encoded["payload"].as_str().unwrap().len() < APP_IPC_MAX_ENCODED_BYTES);
    }

    #[test]
    fn rejects_compressed_envelopes_that_still_exceed_socket_budget() {
        let response = json!({
            "success": true,
            "payload": BASE64_STANDARD.encode(deterministic_bytes(
                RUNTIME_RPC_MAX_ENCODED_BYTES
            )),
        });

        let encoded = encode_runtime_rpc_response("runtime.tasks.transcript", response);

        assert_eq!(encoded["success"], false);
        assert_eq!(encoded["code"], "runtime_rpc_response_too_large");
        assert!(serde_json::to_vec(&encoded).unwrap().len() < 1_000_000);
    }

    fn deterministic_bytes(length: usize) -> Vec<u8> {
        let mut state = 0x9e3779b97f4a7c15_u64;
        (0..length)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect()
    }
}
