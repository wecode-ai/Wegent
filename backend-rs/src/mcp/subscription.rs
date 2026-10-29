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
//! Scope of this batch: the transport framing, the initialization handshake,
//! the prompt/resource listings, and `tools/list` for the source's two
//! subscription tools. Their `tools/call` bodies (preview block rendering,
//! Redis preview storage, and subscription-task creation) are not migrated, so
//! the transport answers them with the protocol's `Unknown tool` error instead
//! of inventing a result. The recorded `initialize` handshake still advertises
//! the source's declared capabilities because FastMCP registers its prompt,
//! resource, and tool handlers for every server.

use brz_http_server::{Response, StatusCode};
use serde_json::json;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::tools::{self, Literal, Param, ParamKind, Tool};
use super::transport;

/// The source's `preview_subscription` parameter definitions
/// (`app/mcp_server/tools/subscription.py`).
static PREVIEW_PARAMS: &[Param] = &[
    Param {
        name: "display_name",
        kind: ParamKind::Str,
        description: "Display name for the subscription task",
        required: true,
        default: None,
    },
    Param {
        name: "trigger_type",
        kind: ParamKind::Str,
        description: "Trigger type: cron, interval, or one_time",
        required: true,
        default: None,
    },
    Param {
        name: "prompt_template",
        kind: ParamKind::Str,
        description: "Prompt template for execution with variable support",
        required: true,
        default: None,
    },
    Param {
        name: "description",
        kind: ParamKind::Str,
        description: "Optional description of the subscription task",
        required: false,
        default: None,
    },
    Param {
        name: "cron_expression",
        kind: ParamKind::Str,
        description: "Cron expression (e.g., '0 9 * * *' for daily at 9am)",
        required: false,
        default: None,
    },
    Param {
        name: "interval_value",
        kind: ParamKind::Int,
        description: "Interval value (for interval trigger)",
        required: false,
        default: None,
    },
    Param {
        name: "interval_unit",
        kind: ParamKind::Str,
        description: "Interval unit: minutes, hours, or days",
        required: false,
        default: None,
    },
    Param {
        name: "execute_at",
        kind: ParamKind::Str,
        description: "Execution time in ISO format (for one_time trigger)",
        required: false,
        default: None,
    },
    Param {
        name: "preserve_history",
        kind: ParamKind::Bool,
        description: "Whether to preserve conversation history",
        required: false,
        default: Some(Literal::Bool(false)),
    },
    Param {
        name: "history_message_count",
        kind: ParamKind::Int,
        description: "Number of history messages to preserve (0-50)",
        required: false,
        default: Some(Literal::Int(10)),
    },
    Param {
        name: "retry_count",
        kind: ParamKind::Int,
        description: "Retry count on failure (0-3)",
        required: false,
        default: Some(Literal::Int(1)),
    },
    Param {
        name: "timeout_seconds",
        kind: ParamKind::Int,
        description: "Execution timeout in seconds (60-86400)",
        required: false,
        default: Some(Literal::Int(600)),
    },
    Param {
        name: "expiration_type",
        kind: ParamKind::Str,
        description: "Expiration type: fixed_date or duration_days",
        required: false,
        default: None,
    },
    Param {
        name: "expiration_fixed_date",
        kind: ParamKind::Str,
        description: "Fixed expiration date in ISO format",
        required: false,
        default: None,
    },
    Param {
        name: "expiration_duration_days",
        kind: ParamKind::Int,
        description: "Days until expiration (1-3650)",
        required: false,
        default: None,
    },
];

/// The source's `create_subscription` parameter definitions.
static CREATE_PARAMS: &[Param] = &[
    Param {
        name: "display_name",
        kind: ParamKind::Str,
        description: "Display name for the subscription task",
        required: true,
        default: None,
    },
    Param {
        name: "trigger_type",
        kind: ParamKind::Str,
        description: "Trigger type: cron, interval, or one_time",
        required: true,
        default: None,
    },
    Param {
        name: "prompt_template",
        kind: ParamKind::Str,
        description: "Prompt template for execution",
        required: true,
        default: None,
    },
    Param {
        name: "preview_id",
        kind: ParamKind::Str,
        description: "Preview ID from preview_subscription tool (REQUIRED)",
        required: true,
        default: None,
    },
    Param {
        name: "description",
        kind: ParamKind::Str,
        description: "Optional description of the subscription task",
        required: false,
        default: None,
    },
    Param {
        name: "cron_expression",
        kind: ParamKind::Str,
        description: "Cron expression (for cron trigger)",
        required: false,
        default: None,
    },
    Param {
        name: "interval_value",
        kind: ParamKind::Int,
        description: "Interval value (for interval trigger)",
        required: false,
        default: None,
    },
    Param {
        name: "interval_unit",
        kind: ParamKind::Str,
        description: "Interval unit: minutes, hours, or days",
        required: false,
        default: None,
    },
    Param {
        name: "execute_at",
        kind: ParamKind::Str,
        description: "Execution time in ISO format (for one_time trigger)",
        required: false,
        default: None,
    },
    Param {
        name: "preserve_history",
        kind: ParamKind::Bool,
        description: "Whether to preserve conversation history",
        required: false,
        default: Some(Literal::Bool(false)),
    },
    Param {
        name: "history_message_count",
        kind: ParamKind::Int,
        description: "Number of history messages to preserve (0-50)",
        required: false,
        default: Some(Literal::Int(10)),
    },
    Param {
        name: "retry_count",
        kind: ParamKind::Int,
        description: "Retry count on failure (0-3)",
        required: false,
        default: Some(Literal::Int(1)),
    },
    Param {
        name: "timeout_seconds",
        kind: ParamKind::Int,
        description: "Execution timeout in seconds (60-86400)",
        required: false,
        default: Some(Literal::Int(600)),
    },
];

/// The subscription server's registered tool surface, in decorator
/// registration order.
pub(crate) static SUBSCRIPTION_TOOLS: &[Tool] = &[
    Tool {
        name: "preview_subscription",
        description: "Preview a subscription plan WITHOUT creating it. Use this tool FIRST when user wants to schedule recurring/periodic tasks. The frontend will display an interactive preview card with Confirm/Cancel buttons.\n\nWorkflow:\n1. User: 'remind me every morning' / '每天早上9点提醒我喝水'\n2. AI: Call preview_subscription tool to generate preview\n3. System: Displays interactive preview card with Confirm/Cancel buttons\n4. User confirmation (either one):\n   - Clicks 'Confirm' button: Frontend creates automatically, AI does NOTHING more\n   - Sends '确认' message: AI must call create_subscription to create the subscription\n\nCRITICAL: After calling preview_subscription, wait for user confirmation. NEVER auto-create.",
        params: PREVIEW_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "create_subscription",
        description: "Create a subscription task AFTER user has confirmed via message. This tool should ONLY be called when user sends a confirmation message (e.g., '确认', '创建') after preview.\n\nWorkflow:\n1. User: 'remind me every morning'\n2. AI: Call preview_subscription tool to generate preview\n3. System: Displays interactive preview card with Confirm/Cancel buttons\n4. User confirmation (either one):\n   - Clicks 'Confirm' button in UI: Frontend creates automatically, AI does NOTHING\n   - Sends '确认' message: AI must call create_subscription to create the subscription\n\nCRITICAL: NEVER auto-call create_subscription after preview. Wait for explicit user confirmation message.",
        params: CREATE_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
];

/// `_SUBSCRIPTION_MCP_SPEC.service_name` and the FastMCP server name.
const SERVER_NAME: &str = "wegent-subscription-mcp";

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
        return transport::unsupported_protocol_version(protocol_version);
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
    let message = match transport::prepare_message(accept, content_type, protocol_version, body) {
        Ok(message) => message,
        Err(response) => return response,
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        // Notifications and client responses are acknowledged with `202` and
        // processed without a persistent effect in stateless mode.
        InboundMessage::NoReply => {
            return transport::empty_json_response(StatusCode::ACCEPTED);
        }
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
        "tools/list" => {
            protocol::success_body(&request.id, &tools::tool_listing(SUBSCRIPTION_TOOLS))
        }
        "tools/call" => protocol::error_body(
            &request.id,
            protocol::INVALID_PARAMS,
            &transport::unknown_tool_message(request.params.as_ref()),
        ),
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
                "serverInfo": { "name": "wegent-subscription-mcp", "version": "1.27.2" }
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
            "wegent-subscription-mcp"
        );
    }

    #[test]
    fn tools_list_publishes_the_subscription_tool_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(1), None))).unwrap();
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0]["name"], "preview_subscription");
        assert_eq!(tools[1]["name"], "create_subscription");
        assert_eq!(
            tools[0]["inputSchema"]["required"],
            json!(["display_name", "trigger_type", "prompt_template"])
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

    #[test]
    fn unmigrated_tool_calls_report_unknown_tool() {
        let params = Some(json!({ "name": "preview_subscription" }));
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/call", json!(3), params))).unwrap();
        assert_eq!(value["error"]["code"], json!(-32602));
        assert_eq!(
            value["error"]["message"],
            "Unknown tool: preview_subscription"
        );
    }

    fn body_bytes(response: &Response) -> &[u8] {
        match response.body() {
            brz_http_server::ResponseBody::Empty => &[],
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        }
    }

    #[test]
    fn route_table_keeps_unmigrated_subscription_tools_on_python() {
        const PATH: &str = "/api/mcp/subscription/sse";
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        for method in [http::Method::GET, http::Method::POST] {
            assert!(
                !table.matches(&method, PATH),
                "{method} {PATH} must reach the Python subscription tools"
            );
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
