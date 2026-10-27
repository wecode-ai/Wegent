// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET`/`POST /api/mcp/knowledge/sse` — the Wegent knowledge MCP server's
//! stateless streamable-HTTP transport.
//!
//! Mirrors `app/mcp_server/server.py` (`_KNOWLEDGE_MCP_SPEC` and
//! `_build_mcp_app`) layered over `mcp.server.streamable_http`. The mounted
//! Starlette app serves the transport at `/sse` with `stateless_http=True` and
//! `json_response=True`, so each request gets a fresh transport with no session
//! id: `GET` opens the server-to-client SSE stream and `POST` exchanges JSON-RPC
//! messages, replying `202 Accepted` to notifications and a JSON-RPC result or
//! error to every request.
//!
//! Scope of this batch: the transport framing, the initialization handshake,
//! the prompt and resource listings (both empty for this server), and the
//! knowledge tool surface (`tools/list` and the recorded `tools/call`
//! behavior over the shared knowledge read pipeline). The prompt/resource
//! read methods remain unimplemented and answer with the protocol's
//! `Method not found` error; the recorded `initialize` handshake still
//! advertises the source's `tools` capability because that is the server's
//! declared feature set.

use std::sync::Arc;

use brz_http_server::{Response, StatusCode};
use serde_json::json;

use crate::state::AppState;

use super::knowledge_tools::{self, KNOWLEDGE_TOOLS};
use super::protocol::{self, InboundMessage, RpcRequest};
use super::tools;
use super::transport;

/// `_KNOWLEDGE_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-knowledge-mcp";

/// `GET /api/mcp/knowledge/sse`: open the server-to-client SSE stream.
#[brz_http_server::get("/api/mcp/knowledge/sse", access = public)]
async fn knowledge_sse_get(
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
        return transport::unsupported_protocol_version(protocol_version);
    }
    transport::sse_stream_response()
}

/// `POST /api/mcp/knowledge/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/knowledge/sse", access = public)]
async fn knowledge_sse_post(
    #[inject(state)] state: &Arc<AppState>,
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("authorization")] authorization: Option<&str>,
    body: &[u8],
) -> Response {
    let message = match prepare(accept, content_type, protocol_version, body) {
        Ok(message) => message,
        Err(response) => return response,
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        InboundMessage::NoReply => {
            return transport::empty_json_response(StatusCode::ACCEPTED);
        }
    };
    // `tools/call` runs the tool body and may touch dependencies, so the
    // transport awaits it instead of building the reply synchronously.
    if request.method == "tools/call" {
        let reply = knowledge_tools::call(state, authorization, request.params.as_ref()).await;
        return match reply {
            knowledge_tools::CallReply::Error { code, message } => transport::json_response(
                StatusCode::OK,
                protocol::error_body(&request.id, code, &message),
            ),
            knowledge_tools::CallReply::Result(result) => transport::json_response(
                StatusCode::OK,
                protocol::success_body(&request.id, &result),
            ),
        };
    }
    transport::json_response(StatusCode::OK, dispatch(&request))
}

/// The transport-level validation shared by the stateless servers.
#[allow(clippy::result_large_err)]
fn prepare(
    accept: Option<&str>,
    content_type: Option<&str>,
    protocol_version: Option<&str>,
    body: &[u8],
) -> Result<InboundMessage, Response> {
    transport::prepare_message(accept, content_type, protocol_version, body)
}

/// Builds the JSON-RPC reply for one request.
fn dispatch(request: &RpcRequest) -> String {
    match request.method.as_str() {
        "initialize" => protocol::success_body(
            &request.id,
            &transport::initialize_result(SERVER_NAME, request.params.as_ref()),
        ),
        "ping" => protocol::success_body(&request.id, &json!({})),
        "tools/list" => protocol::success_body(&request.id, &tools::tool_listing(KNOWLEDGE_TOOLS)),
        "prompts/list" => protocol::success_body(&request.id, &json!({ "prompts": [] })),
        "resources/list" => protocol::success_body(&request.id, &json!({ "resources": [] })),
        "resources/templates/list" => {
            protocol::success_body(&request.id, &json!({ "resourceTemplates": [] }))
        }
        _ => protocol::error_body(&request.id, protocol::METHOD_NOT_FOUND, "Method not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::protocol::LATEST_PROTOCOL_VERSION;
    use serde_json::Value;

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
        let result = transport::initialize_result(SERVER_NAME, Some(&params));
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
                "serverInfo": { "name": "wegent-knowledge-mcp", "version": "1.27.2" }
            })
        );
        // An unknown requested version negotiates the SDK's latest.
        let unknown = json!({ "protocolVersion": "1999-01-01" });
        assert_eq!(
            transport::initialize_result(SERVER_NAME, Some(&unknown))["protocolVersion"],
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
            "wegent-knowledge-mcp"
        );
    }

    #[test]
    fn empty_listings_and_ping() {
        assert_eq!(
            serde_json::from_str::<Value>(&dispatch(&request("prompts/list", json!(1), None)))
                .unwrap()["result"],
            json!({ "prompts": [] })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&dispatch(&request("resources/list", json!(1), None)))
                .unwrap()["result"],
            json!({ "resources": [] })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&dispatch(&request(
                "resources/templates/list",
                json!(1),
                None
            )))
            .unwrap()["result"],
            json!({ "resourceTemplates": [] })
        );
        assert_eq!(
            serde_json::from_str::<Value>(&dispatch(&request("ping", json!(1), None))).unwrap()["result"],
            json!({})
        );
    }

    #[test]
    fn tools_list_publishes_the_knowledge_tool_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(2), None))).unwrap();
        assert_eq!(value["id"], json!(2));
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), KNOWLEDGE_TOOLS.len());
        assert_eq!(tools[0]["name"], "wegent_kb_search_knowledge_base");
        assert_eq!(tools[0]["description"], KNOWLEDGE_TOOLS[0].docstring());
        assert_eq!(
            tools[0]["inputSchema"]["title"],
            "wegent_kb_search_knowledge_baseArguments"
        );
    }

    #[test]
    fn unknown_methods_report_method_not_found() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("prompts/get", json!(7), None))).unwrap();
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
        let rejected = knowledge_sse_get(Some("application/json"), Some("2025-11-25")).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);
        assert_eq!(
            serde_json::from_slice::<Value>(body_bytes(&rejected)).unwrap()["error"]["code"],
            json!(-32600)
        );

        let opened = knowledge_sse_get(Some("text/event-stream"), Some("2025-11-25")).await;
        assert_eq!(opened.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_rejects_an_unsupported_protocol_version() {
        let response = knowledge_sse_get(Some("text/event-stream"), Some("1999-01-01")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Unsupported protocol version: 1999-01-01")
        );
    }

    #[test]
    fn post_validates_accept_and_content_type() {
        let initialize = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let rejected = prepare(
            Some("text/event-stream"),
            Some("application/json"),
            None,
            initialize,
        )
        .err()
        .expect("rejected");
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);

        let unsupported = prepare(
            Some("application/json"),
            Some("text/plain"),
            None,
            initialize,
        )
        .err()
        .expect("rejected");
        assert_eq!(unsupported.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[test]
    fn post_initialize_returns_the_handshake() {
        let body = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let message = prepare(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            None,
            body,
        )
        .expect("accepted");
        let InboundMessage::Request(request) = message else {
            panic!("initialize is a request");
        };
        let value: Value = serde_json::from_str(&dispatch(&request)).unwrap();
        assert_eq!(value["id"], json!(0));
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn post_notification_is_accepted_without_a_reply() {
        let body = br#"{"method":"notifications/initialized","jsonrpc":"2.0"}"#;
        let message = prepare(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            body,
        )
        .expect("accepted");
        assert!(matches!(message, InboundMessage::NoReply));
    }

    #[test]
    fn post_rejects_an_unsupported_protocol_version() {
        let body = br#"{"method":"tools/list","jsonrpc":"2.0","id":1}"#;
        let response = prepare(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2026-07-28"),
            body,
        )
        .err()
        .expect("rejected");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
