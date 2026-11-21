// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The Wegent system MCP server's streamable-HTTP transport and its
//! task-injection endpoint.
//!
//! `app/mcp_server/server.py` mounts the `wegent-system` FastMCP server
//! (`FastMCP("wegent-system-mcp", stateless_http=True, json_response=True,
//! streamable_http_path="/")`) at `/mcp/system` (`register_mcp_apps`). The
//! mounted app serves `GET`/`POST /api/mcp/system` with the same stateless
//! streamable-HTTP transport as the other feature servers, exposing the
//! `silent_exit` tool.
//!
//! Scope of this batch: the transport framing, the initialization handshake,
//! the prompt/resource listings, and `tools/list` for `silent_exit`. Its
//! `tools/call` body (subtask `silent_exit` result update) is not migrated, so
//! the transport keeps the protocol's `Unknown tool` error instead of
//! inventing a result.
//!
//! Separately, `get_mcp_system_config` advertises the task-injection URL as
//! `{BACKEND_INTERNAL_URL}{API_PREFIX}/mcp/system`. Because
//! `settings.BACKEND_INTERNAL_URL` already ends in `/api` and `API_PREFIX` is
//! `/api`, the advertised URL is `.../api/api/mcp/system` — a doubled-prefix
//! path that FastAPI answers with its default `404 {"detail":"Not Found"}`.
//! The faithful cutover registers `POST /api/api/mcp/system` so the request is
//! routed to Rust instead of proxying to Python (which yields the observed 502
//! "fallback upstream unavailable"), reproducing that not-found body.
//!
//! `config/routes.toml` selects the methods and paths for the Rust listener.

use brz_http_server::{Response, StatusCode};
use serde_json::json;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::tools::{self, Literal, Param, ParamKind, Tool};
use super::transport;

/// `_SYSTEM_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-system-mcp";

/// The source's `silent_exit` parameter definitions
/// (`app/mcp_server/server.py`, registered directly with `FastMCP.tool()`).
static SILENT_EXIT_PARAMS: &[Param] = &[Param {
    name: "reason",
    kind: ParamKind::Str,
    description: "",
    required: false,
    default: Some(Literal::Str("")),
}];

/// The system server's registered tool surface. `silent_exit` is registered
/// directly with `FastMCP.tool()`, so it publishes the function docstring
/// verbatim instead of a generated `@mcp_tool` docstring.
static SYSTEM_TOOLS: &[Tool] = &[Tool {
    name: "silent_exit",
    description: "Call this tool when execution result doesn't require user attention.\n\n    For example: regular status checks with no anomalies, routine data collection\n    with expected results, or monitoring tasks where everything is normal.\n    This will end the execution immediately and hide it from the timeline by default.\n\n    Args:\n        reason: Optional reason for silent exit (for logging only, not shown to user)\n\n    Returns:\n        JSON string with silent exit marker\n    ",
    params: SILENT_EXIT_PARAMS,
    defs: &[],
    generated_docstring: false,
}];

/// `GET /api/mcp/system`: open the server-to-client SSE stream.
#[brz_http_server::get("/api/mcp/system", access = public)]
async fn system_sse_get(
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

/// `POST /api/mcp/system`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/system", access = public)]
async fn system_sse_post(
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
        "tools/list" => protocol::success_body(&request.id, &tools::tool_listing(SYSTEM_TOOLS)),
        "tools/call" => protocol::error_body(
            &request.id,
            protocol::INVALID_PARAMS,
            &transport::unknown_tool_message(request.params.as_ref()),
        ),
        _ => protocol::error_body(&request.id, protocol::METHOD_NOT_FOUND, "Method not found"),
    }
}

/// `POST /api/api/mcp/system`: return FastAPI's default not-found body for the
/// doubled-prefix system MCP path.
#[brz_http_server::post("/api/api/mcp/system", access = public)]
async fn system_mcp_post() -> Response {
    // FastAPI's default HTTPException(404) renders `{"detail":"Not Found"}`
    // as `application/json`; reproduce it exactly.
    transport::json_response(StatusCode::NOT_FOUND, r#"{"detail":"Not Found"}"#)
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

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Empty => &[],
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    #[test]
    fn tools_list_publishes_the_silent_exit_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(1), None))).unwrap();
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "silent_exit");
        assert_eq!(
            tools[0]["inputSchema"],
            json!({
                "properties": {
                    "reason": { "default": "", "title": "Reason", "type": "string" }
                },
                "title": "silent_exitArguments",
                "type": "object",
            })
        );
        assert_eq!(
            tools[0]["outputSchema"]["title"],
            json!("silent_exitOutput")
        );
    }

    #[test]
    fn initialize_reports_the_system_server_identity() {
        let value: Value = serde_json::from_str(&dispatch(&request(
            "initialize",
            json!(0),
            Some(json!({ "protocolVersion": "2025-11-25" })),
        )))
        .unwrap();
        assert_eq!(value["id"], json!(0));
        assert_eq!(value["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(value["result"]["serverInfo"]["name"], SERVER_NAME);
        assert_eq!(value["result"]["serverInfo"]["version"], "1.27.2");
        assert_eq!(
            value["result"]["capabilities"]["tools"]["listChanged"],
            false
        );
        assert_eq!(
            value["result"]["capabilities"]["resources"]["subscribe"],
            false
        );
    }

    #[test]
    fn unmigrated_tool_calls_report_unknown_tool() {
        let params = Some(json!({ "name": "silent_exit" }));
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/call", json!(3), params))).unwrap();
        assert_eq!(value["error"]["code"], json!(-32602));
        assert_eq!(value["error"]["message"], "Unknown tool: silent_exit");
    }

    #[tokio::test]
    async fn get_requires_the_event_stream_accept_header() {
        let rejected = system_sse_get(Some("application/json"), Some("2025-11-25"), None).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);
        assert_eq!(
            serde_json::from_slice::<Value>(body_bytes(&rejected)).unwrap()["error"]["code"],
            json!(-32600)
        );

        let opened = system_sse_get(Some("text/event-stream"), Some("2025-11-25"), None).await;
        assert_eq!(opened.status(), StatusCode::OK);
        assert!(matches!(
            opened.body(),
            brz_http_server::ResponseBody::Stream(_)
        ));
    }

    #[tokio::test]
    async fn headerless_requests_do_not_vary_by_origin() {
        let headerless = system_sse_get(Some("text/event-stream"), Some("2025-11-25"), None).await;
        assert_eq!(
            headerless.cors_policy(),
            brz_http_server::ResponseCors::Skip
        );

        let cross_origin = system_sse_get(
            Some("text/event-stream"),
            Some("2025-11-25"),
            Some("https://a.example"),
        )
        .await;
        assert_eq!(
            cross_origin.cors_policy(),
            brz_http_server::ResponseCors::Apply
        );

        let body = br#"{"method":"tools/list","jsonrpc":"2.0","id":1}"#;
        let post = system_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
            body,
        )
        .await;
        assert_eq!(post.cors_policy(), brz_http_server::ResponseCors::Skip);

        let post_cross = system_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            Some("https://a.example"),
            body,
        )
        .await;
        assert_eq!(
            post_cross.cors_policy(),
            brz_http_server::ResponseCors::Apply
        );
    }

    #[tokio::test]
    async fn post_initialize_returns_the_handshake_without_a_protocol_header() {
        let body = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":0}"#;
        let response = system_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            None,
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["result"]["serverInfo"]["name"], SERVER_NAME);
    }

    #[tokio::test]
    async fn post_notifications_are_accepted_without_a_body() {
        let response = system_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
            br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(body_bytes(&response).is_empty());
    }

    #[tokio::test]
    async fn post_rejects_an_unsupported_protocol_version() {
        // The recorded `server/discover` probe: the header version is
        // unsupported, so the transport rejects it before dispatch.
        let body =
            br#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover"}"#;
        let response = system_sse_post(
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2026-07-28"),
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["error"]["code"], json!(-32600));
        assert!(
            value["error"]["message"]
                .as_str()
                .unwrap()
                .contains("Unsupported protocol version: 2026-07-28")
        );
    }

    #[tokio::test]
    async fn returns_the_doubled_prefix_not_found_response() {
        let response = system_mcp_post().await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = body_bytes(&response);
        assert_eq!(body, br#"{"detail":"Not Found"}"#.as_slice());
        let value: Value = serde_json::from_slice(body).unwrap();
        assert_eq!(value["detail"], "Not Found");
    }

    /// The cutover and the handler registration must agree. The hybrid gateway
    /// sends `GET`/`POST /api/mcp/system` to the Rust listener only when
    /// `config/routes.toml` selects them; the router must register the same
    /// methods and path.
    #[test]
    fn route_table_selects_both_registered_system_mcp_transport_methods() {
        const PATH: &str = "/api/mcp/system";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        const POST: u16 = 1 << 5;

        let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET", "POST"])]);
        assert!(table.matches(&http::Method::GET, PATH));
        assert!(table.matches(&http::Method::POST, PATH));
        for method in [http::Method::PUT, http::Method::DELETE] {
            assert!(!table.matches(&method, PATH));
        }

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

    /// The doubled-prefix not-found cutover stays registered and selected.
    #[test]
    fn route_table_selects_the_registered_doubled_prefix_post_handler() {
        const PATH: &str = "/api/api/mcp/system";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const POST: u16 = 1 << 5;

        let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../config/routes.toml");
        let config = crate::hybrid::load_routes_config(&file).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(table.matches(&http::Method::POST, PATH));
        for method in [http::Method::GET, http::Method::PUT, http::Method::DELETE] {
            assert!(!table.matches(&method, PATH));
        }

        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & POST != 0);
        assert!(registered, "POST {PATH} must be registered by the router");
    }
}
