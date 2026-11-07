// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Stateless MCP streamable-HTTP transport framing.
//!
//! Mirrors `mcp.server.streamable_http.StreamableHTTPServerTransport` for the
//! stateless mode used by the Wegent MCP servers (`stateless_http=True`): no
//! session identifier, `Accept`/`Content-Type` validation, a JSON-RPC reply per
//! request, `202 Accepted` for notifications, and an open server-to-client SSE
//! stream on `GET`.

use std::time::Duration;

use brz_http_server::{
    Bytes, EphemeralBytesArena, HeaderBlock, Response, ResponseStream, StatusCode,
};
use serde_json::{Value, json};

use super::protocol::{self, InboundMessage, MessageError};

/// `mcp.server.streamable_http.CONTENT_TYPE_JSON`.
pub(crate) const CONTENT_TYPE_JSON: &str = "application/json";
/// `mcp.server.streamable_http.CONTENT_TYPE_SSE`.
pub(crate) const CONTENT_TYPE_SSE: &str = "text/event-stream";
/// `sse_starlette.EventSourceResponse.DEFAULT_PING_INTERVAL`, in seconds: the
/// idle comment cadence the source uses to keep the SSE connection open.
const KEEP_ALIVE_INTERVAL: Duration = Duration::from_secs(15);
/// The SSE response headers the source emits beyond the media type
/// (`StreamableHTTPServerTransport._handle_get_request` plus sse_starlette).
const SSE_HEADERS: &[u8] = b"cache-control: no-cache, no-transform\r\nx-accel-buffering: no\r\n";

/// `StreamableHTTPServerTransport._check_accept_headers`: a media type whose
/// value starts with `application/json`.
pub(crate) fn accepts_json(accept: Option<&str>) -> bool {
    media_types(accept).any(|value| value.starts_with(CONTENT_TYPE_JSON))
}

/// `StreamableHTTPServerTransport._check_accept_headers`: a media type whose
/// value starts with `text/event-stream`.
pub(crate) fn accepts_sse(accept: Option<&str>) -> bool {
    media_types(accept).any(|value| value.starts_with(CONTENT_TYPE_SSE))
}

/// `StreamableHTTPServerTransport._check_content_type`: the first media type of
/// the `Content-Type` header is exactly `application/json`.
pub(crate) fn is_json_content_type(content_type: Option<&str>) -> bool {
    let Some(value) = content_type else {
        return false;
    };
    value
        .split(';')
        .next()
        .unwrap_or("")
        .split(',')
        .any(|part| part.trim() == CONTENT_TYPE_JSON)
}

fn media_types(accept: Option<&str>) -> impl Iterator<Item = &str> {
    accept
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A JSON response whose body is the transport's error or result object.
pub(crate) fn json_response(status: StatusCode, body: impl Into<Bytes>) -> Response {
    Response::owned_bytes(status, body).content_type(CONTENT_TYPE_JSON)
}

/// A JSON response with no body (`202 Accepted`).
pub(crate) fn empty_json_response(status: StatusCode) -> Response {
    Response::empty(status).content_type(CONTENT_TYPE_JSON)
}

/// Opens the server-to-client SSE stream
/// (`StreamableHTTPServerTransport._handle_get_request`).
///
/// The response head is written before the body is polled, so the client
/// observes the `200` and headers immediately. The stream then stays open,
/// emitting only the source's periodic keep-alive comment; it has no terminal
/// event and ends when the client disconnects.
pub(crate) fn sse_stream_response() -> Response {
    let pings = futures_util::stream::unfold((), |()| async {
        tokio::time::sleep(KEEP_ALIVE_INTERVAL).await;
        let comment = format!(": ping - {}\r\n\r\n", keep_alive_stamp());
        Some((Ok::<Bytes, std::io::Error>(Bytes::from(comment)), ()))
    });
    Response::stream(StatusCode::OK, ResponseStream::new(pings))
        .content_type(CONTENT_TYPE_SSE)
        .headers(sse_header_block())
}

/// `sse_starlette` ping comment timestamp: `datetime.now(timezone.utc)`
/// rendered with microseconds and an explicit UTC offset.
fn keep_alive_stamp() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%d %H:%M:%S%.6f+00:00")
        .to_string()
}

fn sse_header_block() -> HeaderBlock {
    let arena = EphemeralBytesArena::new(SSE_HEADERS.len());
    let mut bytes = arena.alloc(SSE_HEADERS.len());
    bytes.extend_from_slice(SSE_HEADERS);
    HeaderBlock::new(bytes.freeze()).expect("static SSE headers are valid")
}

/// The transport-level validation shared by every stateless server
/// (`_validate_accept_header` with `is_json_response_enabled=True`,
/// `_validate_content_type`, JSON-RPC parsing, and `_validate_protocol_version`
/// for every message except `initialize`).
#[allow(clippy::result_large_err)]
pub(crate) fn prepare_message(
    accept: Option<&str>,
    content_type: Option<&str>,
    protocol_version: Option<&str>,
    body: &[u8],
) -> Result<InboundMessage, Response> {
    if !accepts_json(accept) {
        return Err(json_response(
            StatusCode::NOT_ACCEPTABLE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Not Acceptable: Client must accept application/json",
            ),
        ));
    }
    if !is_json_content_type(content_type) {
        return Err(json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Unsupported Media Type: Content-Type must be application/json",
            ),
        ));
    }
    let message = match protocol::parse(body) {
        Ok(message) => message,
        Err(MessageError::Parse(error)) => {
            return Err(json_response(
                StatusCode::BAD_REQUEST,
                protocol::server_error_body(
                    protocol::PARSE_ERROR,
                    &format!("Parse error: {error}"),
                ),
            ));
        }
        Err(MessageError::Invalid(error)) => {
            return Err(json_response(
                StatusCode::BAD_REQUEST,
                protocol::server_error_body(
                    protocol::INVALID_PARAMS,
                    &format!("Validation error: {error}"),
                ),
            ));
        }
    };
    match &message {
        // `initialize` derives its protocol version from the request
        // parameters and skips the header validation; every other request
        // validates the header.
        InboundMessage::Request(request) => {
            if request.method != "initialize"
                && !protocol::protocol_version_supported(protocol_version)
            {
                return Err(unsupported_protocol_version(protocol_version));
            }
        }
        // Notifications and client responses are validated like any other
        // non-initialize message and acknowledged with `202`.
        InboundMessage::NoReply => {
            if !protocol::protocol_version_supported(protocol_version) {
                return Err(unsupported_protocol_version(protocol_version));
            }
        }
    }
    Ok(message)
}

/// `StreamableHTTPServerTransport._validate_protocol_version` rejection.
pub(crate) fn unsupported_protocol_version(protocol_version: Option<&str>) -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        protocol::server_error_body(
            protocol::INVALID_REQUEST,
            &protocol::unsupported_protocol_version_message(protocol_version),
        ),
    )
}

/// `ServerSession._received_request(InitializeRequest)`: the SDK's negotiated
/// protocol version, the server's declared capabilities, and its identity.
pub(crate) fn initialize_result(server_name: &str, params: Option<&Value>) -> Value {
    initialize_result_with(server_name, params, capabilities())
}

/// [`initialize_result`] with an explicit capability set, for a server whose
/// handler registration differs from the FastMCP servers.
pub(crate) fn initialize_result_with(
    server_name: &str,
    params: Option<&Value>,
    capabilities: Value,
) -> Value {
    let requested = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    json!({
        "protocolVersion": protocol::negotiated_protocol_version(requested),
        "capabilities": capabilities,
        "serverInfo": { "name": server_name, "version": protocol::SERVER_VERSION },
    })
}

/// `Server.get_capabilities` for the FastMCP servers: FastMCP registers its
/// prompt, resource, resource-template, and tool handlers for every server
/// (`FastMCP._setup_handlers`), so the SDK advertises `prompts`, `resources`,
/// and `tools` regardless of the registered tool surface; each is reported
/// without change notifications (and resources without subscriptions), and
/// `experimental` is always present.
pub(crate) fn capabilities() -> Value {
    json!({
        "experimental": {},
        "prompts": { "listChanged": false },
        "resources": { "subscribe": false, "listChanged": false },
        "tools": { "listChanged": false },
    })
}

/// `Server.call_tool`'s `Unknown tool: <name>` error for a tool body that is
/// not executed by the current batch.
pub(crate) fn unknown_tool_message(params: Option<&Value>) -> String {
    match params
        .and_then(Value::as_object)
        .and_then(|params| params.get("name"))
        .and_then(Value::as_str)
    {
        Some(name) => format!("Unknown tool: {name}"),
        None => "Invalid arguments".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_parsing_matches_startswith_semantics() {
        assert!(accepts_json(Some("application/json, text/event-stream")));
        assert!(accepts_json(Some(" application/json ")));
        assert!(!accepts_json(Some("text/event-stream")));
        assert!(!accepts_json(None));

        assert!(accepts_sse(Some("text/event-stream")));
        assert!(accepts_sse(Some("application/json, text/event-stream")));
        assert!(!accepts_sse(Some("application/json")));
        assert!(!accepts_sse(None));
    }

    #[test]
    fn content_type_uses_the_first_media_type() {
        assert!(is_json_content_type(Some("application/json")));
        assert!(is_json_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(!is_json_content_type(Some("text/event-stream")));
        assert!(!is_json_content_type(None));
    }

    #[tokio::test]
    async fn sse_response_streams_without_a_content_length() {
        let response = sse_stream_response();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(matches!(
            response.body(),
            brz_http_server::ResponseBody::Stream(_)
        ));
        // An unknown length makes the runtime frame the body as chunked, as the
        // recorded `GET` response does.
        assert_eq!(response.body().content_length(), None);
    }
}
