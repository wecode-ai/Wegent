// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/mcp/media-understanding/sse` — the media-understanding MCP
//! server's stateless streamable-HTTP transport
//! (`app/mcp_server/server.py`, `_MEDIA_UNDERSTANDING_MCP_SPEC` and
//! `app/mcp_server/tools/media_understanding.py`).
//!
//! The mounted Starlette app serves the MCP streamable-HTTP transport at
//! `/sse` with `stateless_http=True` and `json_response=True`. This batch
//! migrates the recorded surface: the initialization handshake, the prompt and
//! resource listings (empty for this server), the `understand_media` tool
//! listing, and `202 Accepted` for notifications. The `understand_media` tool
//! body (the multimodal model call and its attachment/URL preparation) is not
//! migrated yet, so `tools/call` answers with the protocol's `Unknown tool`
//! error instead of inventing a result.

use brz_http_server::{Response, StatusCode};
use serde_json::json;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::tools::{self, Literal, Param, ParamKind, Tool};
use super::transport;

/// `_MEDIA_UNDERSTANDING_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-media-understanding-mcp";

static UNDERSTAND_MEDIA_PARAMS: &[Param] = &[
    Param {
        name: "context_id",
        kind: ParamKind::Int,
        description: "Alias of attachment_id. It is the metadata header ID parsed as SubtaskContext.id, not fid.",
        required: false,
        default: None,
    },
    Param {
        name: "attachment_id",
        kind: ParamKind::Int,
        description: "Preferred for image or video attachments. Use the ID shown in the attachment metadata header; do not pass fid.",
        required: false,
        default: None,
    },
    Param {
        name: "media_url",
        kind: ParamKind::Str,
        description: "HTTP(S) image or video URL when no attachment context is available.",
        required: false,
        default: None,
    },
    Param {
        name: "media_type",
        kind: ParamKind::Str,
        description: "Media type. Supported values are 'image' and 'video'.",
        required: false,
        default: Some(Literal::Str("video")),
    },
    Param {
        name: "question",
        kind: ParamKind::Str,
        description: "The user's original question about the media.",
        required: false,
        default: None,
    },
    Param {
        name: "instruction",
        kind: ParamKind::Str,
        description: "Optional analysis instruction for the media understanding model.",
        required: false,
        default: None,
    },
    Param {
        name: "context",
        kind: ParamKind::Object,
        description: "Optional background context such as title, description, transcript, metadata, and related texts.",
        required: false,
        default: None,
    },
];

/// `media_understanding_mcp_server`'s registered tools
/// (`app/mcp_server/tools/media_understanding.py`).
pub(crate) static MEDIA_TOOLS: &[Tool] = &[Tool {
    name: "understand_media",
    description: "Understand image or video media using a fixed multimodal model.",
    params: UNDERSTAND_MEDIA_PARAMS,
    defs: &[],
    generated_docstring: true,
}];

/// `POST /api/mcp/media-understanding/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/media-understanding/sse", access = public)]
async fn media_understanding_sse_post(
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    body: &[u8],
) -> Response {
    let message = match transport::prepare_message(accept, content_type, protocol_version, body) {
        Ok(message) => message,
        Err(response) => return response,
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        // Notifications and client responses are acknowledged with `202` and
        // have no persistent effect in stateless mode.
        InboundMessage::NoReply => return transport::empty_json_response(StatusCode::ACCEPTED),
    };
    transport::json_response(StatusCode::OK, dispatch(&request))
}

/// Builds the JSON-RPC reply for one request.
fn dispatch(request: &RpcRequest) -> String {
    match request.method.as_str() {
        "initialize" => protocol::success_body(
            &request.id,
            &transport::initialize_result(SERVER_NAME, request.params.as_ref()),
        ),
        "ping" => protocol::success_body(&request.id, &json!({})),
        "prompts/list" => protocol::success_body(&request.id, &json!({ "prompts": [] })),
        "resources/list" => protocol::success_body(&request.id, &json!({ "resources": [] })),
        "resources/templates/list" => {
            protocol::success_body(&request.id, &json!({ "resourceTemplates": [] }))
        }
        "tools/list" => protocol::success_body(&request.id, &tools::tool_listing(MEDIA_TOOLS)),
        "tools/call" => protocol::error_body(
            &request.id,
            protocol::INVALID_PARAMS,
            &transport::unknown_tool_message(request.params.as_ref()),
        ),
        _ => protocol::error_body(&request.id, protocol::METHOD_NOT_FOUND, "Method not found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn request(method: &str, id: Value, params: Option<Value>) -> RpcRequest {
        RpcRequest {
            id,
            method: method.to_string(),
            params,
        }
    }

    #[test]
    fn tools_list_publishes_the_recorded_media_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(1), None))).unwrap();
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "understand_media");
        assert_eq!(
            tools[0]["description"],
            MEDIA_TOOLS[0].docstring(),
            "the generated docstring is the listing description"
        );
        let media_type = &tools[0]["inputSchema"]["properties"]["media_type"];
        assert_eq!(media_type["default"], json!("video"));
        assert_eq!(media_type["title"], json!("Media Type"));
        let context = &tools[0]["inputSchema"]["properties"]["context"];
        assert_eq!(
            context["anyOf"],
            json!([{ "additionalProperties": true, "type": "object" }, { "type": "null" }])
        );
        assert_eq!(context["default"], Value::Null);
        assert_eq!(
            tools[0]["inputSchema"]["title"],
            "understand_mediaArguments"
        );
    }

    #[test]
    fn initialize_result_matches_the_recorded_handshake() {
        let params = json!({ "protocolVersion": "2025-11-25" });
        let result = transport::initialize_result(SERVER_NAME, Some(&params));
        assert_eq!(result["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(result["serverInfo"]["version"], "1.27.2");
        assert_eq!(result["protocolVersion"], "2025-11-25");
    }

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/mcp/media-understanding/sse";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(&http::Method::POST, PATH));
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }

    #[tokio::test]
    async fn post_initialize_returns_the_handshake() {
        let body = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let response = media_understanding_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn post_notification_is_accepted_without_a_reply() {
        let body = br#"{"method":"notifications/initialized","jsonrpc":"2.0"}"#;
        let response = media_understanding_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }
}
