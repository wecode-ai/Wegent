// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET`/`POST /api/mcp/subscription/sse` — the Wegent subscription MCP
//! server's stateless streamable-HTTP transport.
//!
//! Mirrors `app/mcp_server/server.py` (`_SUBSCRIPTION_MCP_SPEC` and
//! `_build_mcp_app`) layered over `mcp.server.streamable_http`. The mounted
//! Starlette app serves the transport at `/sse` with `stateless_http=True` and
//! `json_response=True`, so each request gets a fresh transport with no session
//! id: `GET` opens the server-to-client SSE stream and `POST` exchanges JSON-RPC
//! messages, replying `202 Accepted` to notifications and a JSON-RPC result or
//! error to every request.
//!
//! Scope of this batch: the transport framing and the initialization handshake.
//! The subscription tool surface (`tools/list`, `tools/call`, and the prompt and
//! resource read methods) is a separate sub-migration; until it lands the
//! transport answers those methods with the protocol's `Method not found` error.
//! The recorded `initialize` handshake still advertises the source's declared
//! capabilities because FastMCP registers its prompt, resource, and tool
//! handlers for every server.

use brz_http_server::{Response, StatusCode};
use serde_json::{Value, json};

use super::protocol::{self, InboundMessage, MessageError, RpcRequest};
use super::transport;

/// `_SUBSCRIPTION_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-subscription-mcp";
/// `InitializationOptions.server_version`: the installed `mcp` package version.
const SERVER_VERSION: &str = "1.27.2";

/// `GET /api/mcp/subscription/sse`: open the server-to-client SSE stream.
#[brz_http_server::get("/api/mcp/subscription/sse", access = public)]
async fn subscription_sse_get(
    #[header("accept")] accept: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
) -> Response {
    if !transport::accepts_sse(accept) {
        return transport::json_response(
            StatusCode::NOT_ACCEPTABLE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Not Acceptable: Client must accept text/event-stream",
            ),
        );
    }
    if !protocol::protocol_version_supported(protocol_version) {
        return unsupported_protocol_version(protocol_version);
    }
    transport::sse_stream_response()
}

/// `POST /api/mcp/subscription/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/subscription/sse", access = public)]
async fn subscription_sse_post(
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    body: &[u8],
) -> Response {
    // `StreamableHTTPServerTransport._validate_accept_header` with
    // `is_json_response_enabled=True`: only `application/json` is required.
    if !transport::accepts_json(accept) {
        return transport::json_response(
            StatusCode::NOT_ACCEPTABLE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Not Acceptable: Client must accept application/json",
            ),
        );
    }
    if !transport::is_json_content_type(content_type) {
        return transport::json_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Unsupported Media Type: Content-Type must be application/json",
            ),
        );
    }
    let message = match protocol::parse(body) {
        Ok(message) => message,
        Err(MessageError::Parse(error)) => {
            return transport::json_response(
                StatusCode::BAD_REQUEST,
                protocol::server_error_body(
                    protocol::PARSE_ERROR,
                    &format!("Parse error: {error}"),
                ),
            );
        }
        Err(MessageError::Invalid(error)) => {
            return transport::json_response(
                StatusCode::BAD_REQUEST,
                protocol::server_error_body(
                    protocol::INVALID_PARAMS,
                    &format!("Validation error: {error}"),
                ),
            );
        }
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        InboundMessage::NoReply => {
            // Notifications and client responses are validated like any other
            // non-initialize message, acknowledged with `202`, and processed
            // without a persistent effect in stateless mode.
            if !protocol::protocol_version_supported(protocol_version) {
                return unsupported_protocol_version(protocol_version);
            }
            return transport::empty_json_response(StatusCode::ACCEPTED);
        }
    };
    // `initialize` derives its protocol version from the request parameters and
    // skips the header validation; every other request validates the header.
    if request.method != "initialize" && !protocol::protocol_version_supported(protocol_version) {
        return unsupported_protocol_version(protocol_version);
    }
    transport::json_response(StatusCode::OK, dispatch(&request))
}

/// `StreamableHTTPServerTransport._validate_protocol_version` rejection.
fn unsupported_protocol_version(protocol_version: Option<&str>) -> Response {
    transport::json_response(
        StatusCode::BAD_REQUEST,
        protocol::server_error_body(
            protocol::INVALID_REQUEST,
            &protocol::unsupported_protocol_version_message(protocol_version),
        ),
    )
}

/// Builds the JSON-RPC reply for one request.
fn dispatch(request: &RpcRequest) -> String {
    match request.method.as_str() {
        "initialize" => {
            protocol::success_body(&request.id, &initialize_result(request.params.as_ref()))
        }
        "ping" => protocol::success_body(&request.id, &json!({})),
        "prompts/list" => protocol::success_body(&request.id, &json!({ "prompts": [] })),
        "resources/list" => protocol::success_body(&request.id, &json!({ "resources": [] })),
        "resources/templates/list" => {
            protocol::success_body(&request.id, &json!({ "resourceTemplates": [] }))
        }
        _ => protocol::error_body(&request.id, protocol::METHOD_NOT_FOUND, "Method not found"),
    }
}

/// `ServerSession._received_request(InitializeRequest)`: the SDK's negotiated
/// protocol version, the server's declared capabilities, and its identity.
fn initialize_result(params: Option<&Value>) -> Value {
    let requested = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    json!({
        "protocolVersion": protocol::negotiated_protocol_version(requested),
        "capabilities": capabilities(),
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
    })
}

/// `Server.get_capabilities` for `wegent-subscription-mcp`. FastMCP registers
/// its prompt, resource, resource-template, and tool handlers for every server
/// (`FastMCP._setup_handlers`), so the SDK advertises `prompts`, `resources`,
/// and `tools` regardless of the registered tool surface; each is reported
/// without change notifications (and resources without subscriptions), and
/// `experimental` is always present.
fn capabilities() -> Value {
    json!({
        "experimental": {},
        "prompts": { "listChanged": false },
        "resources": { "subscribe": false, "listChanged": false },
        "tools": { "listChanged": false },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::protocol::LATEST_PROTOCOL_VERSION;

    fn request(method: &str, id: Value, params: Option<Value>) -> RpcRequest {
        RpcRequest {
            id,
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn initialize_result_matches_the_recorded_handshake() {
        let params = json!({ "protocolVersion": "2025-11-25" });
        let result = initialize_result(Some(&params));
        assert_eq!(
            result,
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "experimental": {},
                    "prompts": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false },
                    "tools": { "listChanged": false }
                },
                "serverInfo": { "name": "wegent-subscription-mcp", "version": "1.27.2" }
            })
        );
        // An unknown requested version negotiates the SDK's latest.
        let unknown = json!({ "protocolVersion": "1999-01-01" });
        assert_eq!(
            initialize_result(Some(&unknown))["protocolVersion"],
            LATEST_PROTOCOL_VERSION
        );
    }

    #[test]
    fn initialize_body_echoes_the_request_id() {
        let reply = dispatch(&request(
            "initialize",
            json!(0),
            Some(json!({ "protocolVersion": "2025-11-25" })),
        ));
        let value: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["id"], json!(0));
        assert_eq!(
            value["result"]["serverInfo"]["name"],
            "wegent-subscription-mcp"
        );
    }

    #[test]
    fn unknown_methods_report_method_not_found() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(7), None))).unwrap();
        assert_eq!(value["id"], json!(7));
        assert_eq!(value["error"]["code"], json!(-32601));
        assert_eq!(value["error"]["message"], "Method not found");
    }

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Empty => &[],
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    #[tokio::test]
    async fn get_requires_the_event_stream_accept_header() {
        let rejected = subscription_sse_get(Some("application/json"), Some("2025-11-25")).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);
        assert_eq!(
            serde_json::from_slice::<Value>(body_bytes(&rejected)).unwrap()["error"]["code"],
            json!(-32600)
        );

        let opened = subscription_sse_get(Some("text/event-stream"), Some("2025-11-25")).await;
        assert_eq!(opened.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_rejects_an_unsupported_protocol_version() {
        let response = subscription_sse_get(Some("text/event-stream"), Some("1999-01-01")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Unsupported protocol version: 1999-01-01")
        );
    }

    #[tokio::test]
    async fn post_validates_accept_and_content_type() {
        let initialize = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let rejected = subscription_sse_post(
            Some("text/event-stream"),
            Some("application/json"),
            None,
            initialize,
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);

        let unsupported = subscription_sse_post(
            Some("application/json"),
            Some("text/plain"),
            None,
            initialize,
        )
        .await;
        assert_eq!(unsupported.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn post_initialize_returns_the_handshake() {
        let body = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let response = subscription_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["id"], json!(0));
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(
            value["result"]["serverInfo"]["name"],
            "wegent-subscription-mcp"
        );
    }

    #[tokio::test]
    async fn post_rejects_an_unsupported_protocol_version() {
        // The recorded `server/discover` probe: the header version is
        // unsupported, so the transport rejects it before dispatch.
        let body =
            br#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover"}"#;
        let response = subscription_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2026-07-28"),
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["id"], json!("server-error"));
        assert_eq!(value["error"]["code"], json!(-32600));
        assert_eq!(
            value["error"]["message"],
            json!(
                "Bad Request: Unsupported protocol version: 2026-07-28. \
                 Supported versions: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25"
            )
        );
    }

    #[tokio::test]
    async fn post_notification_is_accepted_with_an_empty_body() {
        let body = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let response = subscription_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(body_bytes(&response).is_empty());
    }
}
