// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! JSON-RPC 2.0 envelopes and MCP protocol constants.
//!
//! Mirrors the message layer shared by `mcp.shared.message.JSONRPCMessage` and
//! the transport's error builders (`mcp.server.streamable_http`). Only the
//! fields the stateless streamable-HTTP transport reads are modelled: the
//! `jsonrpc`/`id`/`method`/`params` request contract and the absence of a reply
//! for notifications and client responses.

use serde::Serialize;
use serde_json::Value;

/// `JSONRPCError` code for a body that is not valid JSON (`PARSE_ERROR`).
pub(crate) const PARSE_ERROR: i64 = -32700;
/// `INVALID_REQUEST`: a well-formed JSON body that is not a JSON-RPC message,
/// and the transport's default code for header-level rejections.
pub(crate) const INVALID_REQUEST: i64 = -32600;
/// `METHOD_NOT_FOUND`.
pub(crate) const METHOD_NOT_FOUND: i64 = -32601;
/// `INVALID_PARAMS`: a JSON-RPC message that fails envelope validation.
pub(crate) const INVALID_PARAMS: i64 = -32602;

/// `mcp.shared.version.SUPPORTED_PROTOCOL_VERSIONS` (SDK 1.27.2).
pub(crate) const SUPPORTED_PROTOCOL_VERSIONS: [&str; 4] =
    ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
/// `mcp.types.LATEST_PROTOCOL_VERSION`.
pub(crate) const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
/// `mcp.types.DEFAULT_NEGOTIATED_VERSION`, assumed when the header is absent.
pub(crate) const DEFAULT_NEGOTIATED_VERSION: &str = "2025-03-26";

/// A parsed inbound JSON-RPC request that expects a reply.
pub(crate) struct RpcRequest {
    /// The request identifier, echoed verbatim in the response.
    pub(crate) id: Value,
    pub(crate) method: String,
    pub(crate) params: Option<Value>,
}

/// A parsed inbound message.
pub(crate) enum InboundMessage {
    /// A request (has both `method` and `id`): the transport replies.
    Request(RpcRequest),
    /// A notification or client response: the transport answers `202 Accepted`.
    NoReply,
}

/// Why a request body could not be read as a JSON-RPC message.
#[derive(Debug)]
pub(crate) enum MessageError {
    /// `json.loads` failed (`Parse error`).
    Parse(String),
    /// Envelope validation failed (`Validation error`).
    Invalid(String),
}

/// Parses a request body like `JSONRPCMessage.model_validate(json.loads(body))`.
///
/// A JSON object with a string `method` is a request when a non-null `id` is
/// present and a notification otherwise; an object without `method` is a client
/// response. Every other shape is a validation failure.
pub(crate) fn parse(body: &[u8]) -> Result<InboundMessage, MessageError> {
    let value: Value =
        serde_json::from_slice(body).map_err(|error| MessageError::Parse(error.to_string()))?;
    let Some(object) = value.as_object() else {
        return Err(MessageError::Invalid(
            "message must be a JSON object".to_string(),
        ));
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(MessageError::Invalid(
            "jsonrpc must be the string \"2.0\"".to_string(),
        ));
    }
    match object.get("method") {
        Some(Value::String(method)) => match object.get("id") {
            Some(id) if !id.is_null() => Ok(InboundMessage::Request(RpcRequest {
                id: id.clone(),
                method: method.clone(),
                params: object.get("params").cloned(),
            })),
            _ => Ok(InboundMessage::NoReply),
        },
        Some(_) => Err(MessageError::Invalid("method must be a string".to_string())),
        None if object.contains_key("result") || object.contains_key("error") => {
            Ok(InboundMessage::NoReply)
        }
        None => Err(MessageError::Invalid("method is required".to_string())),
    }
}

/// Whether `protocol_version` is accepted by the SDK
/// (`StreamableHTTPServerTransport._validate_protocol_version`); a missing
/// header negotiates the SDK's default version.
pub(crate) fn protocol_version_supported(protocol_version: Option<&str>) -> bool {
    let version = protocol_version.unwrap_or(DEFAULT_NEGOTIATED_VERSION);
    SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
}

/// The `Unsupported protocol version` message
/// (`StreamableHTTPServerTransport._validate_protocol_version`).
pub(crate) fn unsupported_protocol_version_message(protocol_version: Option<&str>) -> String {
    let version = protocol_version.unwrap_or(DEFAULT_NEGOTIATED_VERSION);
    let supported = SUPPORTED_PROTOCOL_VERSIONS.join(", ");
    format!("Bad Request: Unsupported protocol version: {version}. Supported versions: {supported}")
}

/// The `protocolVersion` echoed by `ServerSession._received_request`: the
/// requested version when supported, otherwise the SDK's latest.
pub(crate) fn negotiated_protocol_version(requested: Option<&str>) -> &'static str {
    match requested {
        Some(version) if SUPPORTED_PROTOCOL_VERSIONS.contains(&version) => {
            // Return the matched static so the negotiated value stays borrowed.
            SUPPORTED_PROTOCOL_VERSIONS
                .into_iter()
                .find(|supported| *supported == version)
                .unwrap_or(LATEST_PROTOCOL_VERSION)
        }
        _ => LATEST_PROTOCOL_VERSION,
    }
}

#[derive(Serialize)]
struct Success<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    result: &'a Value,
}

#[derive(Serialize)]
struct Failure<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    error: ErrorObject<'a>,
}

#[derive(Serialize)]
struct ErrorObject<'a> {
    code: i64,
    message: &'a str,
}

/// Serializes `{"jsonrpc":"2.0","id":<id>,"result":<result>}`.
pub(crate) fn success_body(id: &Value, result: &Value) -> String {
    serde_json::to_string(&Success {
        jsonrpc: "2.0",
        id,
        result,
    })
    .expect("a JSON-RPC success serializes")
}

/// Serializes `{"jsonrpc":"2.0","id":<id>,"error":{"code":..,"message":..}}`,
/// dropping the optional `data` member like `exclude_none=True`.
pub(crate) fn error_body(id: &Value, code: i64, message: &str) -> String {
    serde_json::to_string(&Failure {
        jsonrpc: "2.0",
        id,
        error: ErrorObject { code, message },
    })
    .expect("a JSON-RPC error serializes")
}

/// The transport error body (`_create_error_response`) used before a request
/// identifier is available: the id is the literal `"server-error"`.
pub(crate) fn server_error_body(code: i64, message: &str) -> String {
    let id = Value::String("server-error".to_string());
    error_body(&id, code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_request_notification_and_response() {
        let request = parse(br#"{"method":"initialize","jsonrpc":"2.0","id":0}"#).unwrap();
        let InboundMessage::Request(request) = request else {
            panic!("expected a request");
        };
        assert_eq!(request.method, "initialize");
        assert_eq!(request.id, json!(0));

        assert!(matches!(
            parse(br#"{"method":"notifications/initialized","jsonrpc":"2.0"}"#).unwrap(),
            InboundMessage::NoReply
        ));
        assert!(matches!(
            parse(br#"{"jsonrpc":"2.0","id":1,"result":{}}"#).unwrap(),
            InboundMessage::NoReply
        ));
    }

    #[test]
    fn reject_non_json_and_malformed_envelopes() {
        assert!(matches!(
            parse(b"fallback upstream unavailable"),
            Err(MessageError::Parse(_))
        ));
        assert!(matches!(parse(b"[]"), Err(MessageError::Invalid(_))));
        assert!(matches!(
            parse(br#"{"method":"x"}"#),
            Err(MessageError::Invalid(_))
        ));
    }

    #[test]
    fn protocol_versions_match_the_sdk() {
        assert!(protocol_version_supported(None));
        assert!(protocol_version_supported(Some("2025-11-25")));
        assert!(!protocol_version_supported(Some("2024-01-01")));
        assert_eq!(
            negotiated_protocol_version(Some("2025-11-25")),
            "2025-11-25"
        );
        assert_eq!(
            negotiated_protocol_version(Some("1999-01-01")),
            LATEST_PROTOCOL_VERSION
        );
    }

    #[test]
    fn error_body_wraps_code_and_message() {
        assert_eq!(
            server_error_body(INVALID_REQUEST, "Method not found"),
            "{\"jsonrpc\":\"2.0\",\"id\":\"server-error\",\"error\":{\"code\":-32600,\"message\":\"Method not found\"}}"
        );
    }
}
