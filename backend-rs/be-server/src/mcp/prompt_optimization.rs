// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET`/`POST /api/mcp/prompt-optimization/sse` — the prompt-optimization MCP
//! server's stateless streamable-HTTP transport
//! (`app/mcp_server/server.py`, `_PROMPT_OPTIMIZATION_MCP_SPEC`).
//!
//! The mounted Starlette app serves the MCP streamable-HTTP transport at
//! `/sse` with `stateless_http=True` and `json_response=True`. `GET` opens the
//! server-to-client SSE stream (`StreamableHTTPServerTransport._handle_get_request`):
//! a `200` event stream that only carries keep-alive comments because the
//! source has no server-initiated messages. `POST` exchanges JSON-RPC messages:
//! the initialization handshake, the empty prompt/resource listings, and
//! `tools/list` for the source's two prompt-optimization tools
//! (`app/mcp_server/tools/prompt_optimization.py`).
//!
//! Scope of this batch: the transport framing and the surfaces the recording
//! exercises. The `tools/call` bodies (`get_team_prompt`'s team/bot/ghost
//! prompt assembly and `submit_prompt_changes`'s interactive block delivery)
//! are not migrated, so the transport answers them with the protocol's
//! `Unknown tool` error instead of inventing a result.

use brz_http_server::{Response, StatusCode};
use serde_json::json;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::tools::{self, Param, ParamKind, Tool};
use super::transport;

/// `_PROMPT_OPTIMIZATION_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-prompt-optimization-mcp";

/// `submit_prompt_changes`'s parameter definitions (the decorator's
/// `param_descriptions["changes"]`).
static SUBMIT_PROMPT_CHANGES_PARAMS: &[Param] = &[Param {
    name: "changes",
    kind: ParamKind::ListOfObject,
    description: "List of prompt changes. Each change must include: type ('ghost' or 'member'), id (resource ID from source mapping), name (display name), field (e.g. 'systemPrompt'), original (current prompt text), suggested (new prompt text). For member type, also include index (member index in team).",
    required: true,
    default: None,
}];

/// The prompt-optimization server's registered tool surface, in decorator
/// registration order.
pub(crate) static PROMPT_OPTIMIZATION_TOOLS: &[Tool] = &[
    Tool {
        name: "get_team_prompt",
        description: "Get the assembled system prompt for the current task's team with source mapping. Returns each prompt source (Ghost systemPrompt or TeamMember prompt) with its name and content.",
        params: &[],
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "submit_prompt_changes",
        description: "Submit optimized prompt changes to the frontend for user review. Displays interactive cards showing original vs modified prompt for each change. The user can then apply or cancel each change independently. Call get_team_prompt() first to get the current prompts and source mapping, then rewrite the prompts yourself, and call this tool with the changes.",
        params: SUBMIT_PROMPT_CHANGES_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
];

/// `GET /api/mcp/prompt-optimization/sse`: open the server-to-client SSE
/// stream (`StreamableHTTPServerTransport._handle_get_request`).
#[brz_http_server::get("/api/mcp/prompt-optimization/sse", access = public)]
async fn prompt_optimization_sse_get(
    #[header("accept")] accept: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("origin")] origin: Option<&str>,
) -> Response {
    let response = if !transport::accepts_sse(accept) {
        transport::json_response(
            StatusCode::NOT_ACCEPTABLE,
            protocol::server_error_body(
                protocol::INVALID_REQUEST,
                "Not Acceptable: Client must accept text/event-stream",
            ),
        )
    } else if !protocol::protocol_version_supported(protocol_version) {
        transport::unsupported_protocol_version(protocol_version)
    } else {
        transport::sse_stream_response()
    };
    transport::source_cors(response, origin)
}

/// `POST /api/mcp/prompt-optimization/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/prompt-optimization/sse", access = public)]
async fn prompt_optimization_sse_post(
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("origin")] origin: Option<&str>,
    body: &[u8],
) -> Response {
    let response = match transport::prepare_message(accept, content_type, protocol_version, body) {
        Ok(InboundMessage::Request(request)) => {
            transport::json_response(StatusCode::OK, dispatch(&request))
        }
        // Notifications and client responses are acknowledged with `202` and
        // have no persistent effect in stateless mode.
        Ok(InboundMessage::NoReply) => transport::empty_json_response(StatusCode::ACCEPTED),
        Err(response) => response,
    };
    transport::source_cors(response, origin)
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
        "tools/list" => {
            protocol::success_body(&request.id, &tools::tool_listing(PROMPT_OPTIMIZATION_TOOLS))
        }
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
    use crate::mcp::protocol::LATEST_PROTOCOL_VERSION;
    use serde_json::Value;

    fn request(method: &str, id: Value, params: Option<Value>) -> RpcRequest {
        RpcRequest {
            id,
            method: method.to_string(),
            params,
        }
    }

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Empty => &[],
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    #[test]
    fn post_cutover_selects_the_recorded_transport_method() {
        const PATH: &str = "/api/mcp/prompt-optimization/sse";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        const POST: u16 = 1 << 5;
        let table = crate::app_test_support::cutover_route_table(&[(PATH, &["POST"])]);
        // Only the recorded `POST` method is cut over; `GET` stays Python-owned
        // even though the handler is registered.
        assert!(table.matches(&http::Method::POST, PATH));
        assert!(!table.matches(&http::Method::GET, PATH));
        let mut registered = 0u16;
        for entry in
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
        {
            for route in (entry.0.routes)() {
                if route.path == PATH {
                    registered |= route.methods;
                }
            }
        }
        assert_eq!(registered & GET, GET, "GET {PATH} must be registered");
        assert_eq!(registered & POST, POST, "POST {PATH} must be registered");
    }

    #[tokio::test]
    async fn post_initialize_returns_the_recorded_handshake() {
        let body = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":0}"#;
        let response = prompt_optimization_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            None,
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["id"], json!(0));
        assert_eq!(
            value["result"],
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "experimental": {},
                    "prompts": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false },
                    "tools": { "listChanged": false }
                },
                "serverInfo": { "name": "wegent-prompt-optimization-mcp", "version": "1.27.2" }
            })
        );
    }

    #[tokio::test]
    async fn post_rejects_an_unsupported_protocol_version_like_the_sdk() {
        // The recording's `server/discover` probe: the client announced the
        // newer `2026-07-28` version in both the body meta and the header.
        let body = br#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#;
        let response = prompt_optimization_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2026-07-28"),
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            String::from_utf8_lossy(body_bytes(&response)),
            "{\"jsonrpc\":\"2.0\",\"id\":\"server-error\",\"error\":{\"code\":-32600,\
             \"message\":\"Bad Request: Unsupported protocol version: 2026-07-28. \
             Supported versions: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25\"}}"
        );
    }

    #[test]
    fn tools_list_publishes_the_source_tool_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(2), None))).unwrap();
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "get_team_prompt");
        assert_eq!(tools[1]["name"], "submit_prompt_changes");
        assert_eq!(
            tools[0]["description"],
            PROMPT_OPTIMIZATION_TOOLS[0].docstring()
        );
        assert_eq!(
            tools[0]["inputSchema"],
            json!({
                "properties": {},
                "title": "get_team_promptArguments",
                "type": "object",
            })
        );
        assert_eq!(
            tools[1]["inputSchema"],
            json!({
                "properties": {
                    "changes": {
                        "items": { "additionalProperties": true, "type": "object" },
                        "title": "Changes",
                        "type": "array",
                    }
                },
                "required": ["changes"],
                "title": "submit_prompt_changesArguments",
                "type": "object",
            })
        );
    }

    #[test]
    fn unmigrated_tool_calls_report_unknown_tool() {
        let params = Some(json!({ "name": "get_team_prompt" }));
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/call", json!(3), params))).unwrap();
        assert_eq!(value["error"]["code"], json!(-32602));
        assert_eq!(value["error"]["message"], "Unknown tool: get_team_prompt");
    }

    #[test]
    fn unknown_methods_report_method_not_found() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("prompts/get", json!(7), None))).unwrap();
        assert_eq!(value["error"]["code"], json!(-32601));
        assert_eq!(value["error"]["message"], "Method not found");
    }

    #[tokio::test]
    async fn post_notification_is_accepted_without_a_reply() {
        let body = br#"{"method":"notifications/initialized","jsonrpc":"2.0"}"#;
        let response = prompt_optimization_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
    }

    #[tokio::test]
    async fn get_requires_the_event_stream_accept_header() {
        let rejected = prompt_optimization_sse_get(Some("application/json"), None, None).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);

        let opened = prompt_optimization_sse_get(Some("text/event-stream"), None, None).await;
        assert_eq!(opened.status(), StatusCode::OK);
        assert!(matches!(
            opened.body(),
            brz_http_server::ResponseBody::Stream(_)
        ));
    }

    #[test]
    fn protocol_versions_match_the_sdk() {
        assert!(protocol::protocol_version_supported(Some(
            LATEST_PROTOCOL_VERSION
        )));
    }
}
