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
//! the prompt/resource listings, `tools/list` for the source's four
//! subscription tools (preview, create, list, and get), and the
//! `get_subscription` tool body ([`super::subscription_read`]): the owned
//! active `Subscription` row read and its serialized current state. The
//! remaining tool bodies (preview block rendering, Redis preview storage, and
//! task creation) are not migrated, so the transport answers them with the
//! protocol's `Unknown tool` error instead of inventing a result. The
//! recorded `initialize` handshake still advertises the source's declared
//! capabilities because FastMCP registers its prompt, resource, and tool
//! handlers for every server.

use std::sync::Arc;

use brz_http_server::{Response, StatusCode};
use serde_json::json;

use crate::state::AppState;

use super::protocol::{self, InboundMessage, RpcRequest};
use super::subscription_read;
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

/// The source's `list_subscriptions` parameter definitions
/// (`app/mcp_server/tools/subscription_read.py`).
static LIST_PARAMS: &[Param] = &[
    Param {
        name: "enabled",
        kind: ParamKind::Bool,
        description: "Optional filter for enabled or disabled subscriptions",
        required: false,
        default: None,
    },
    Param {
        name: "trigger_type",
        kind: ParamKind::Str,
        description: "Optional trigger type filter: cron, interval, one_time, or event",
        required: false,
        default: None,
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "Pagination offset (default: 0)",
        required: false,
        default: Some(Literal::Int(0)),
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "Maximum number of subscriptions to return (1-100, default: 20)",
        required: false,
        default: Some(Literal::Int(20)),
    },
];

/// The source's `get_subscription` parameter definitions
/// (`app/mcp_server/tools/subscription_read.py`).
static GET_PARAMS: &[Param] = &[Param {
    name: "subscription_id",
    kind: ParamKind::Int,
    description: "Subscription ID to retrieve",
    required: true,
    default: None,
}];

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
        description: "Create a subscription task AFTER user has confirmed via message. This tool should ONLY be called when user sends a confirmation message (e.g., '确认', '创建') after preview.\n\nWorkflow:\n1. User: 'remind me every morning'\n2. AI: Call preview_subscription tool to generate preview\n3. System: Displays interactive preview card with Confirm/Cancel buttons\n4. User confirmation (either one):\n   - Clicks 'Confirm' button in UI: Frontend creates automatically, AI does NOTHING\n   - Sends '确认' message: AI must call create_subscription to create the subscription\n\nCRITICAL: NEVER auto-call create_subscription after preview. Wait for explicit user confirmation message. The create result is a point-in-time record; use get_subscription to verify current state before reporting it.",
        params: CREATE_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "list_subscriptions",
        description: "List the current user's active subscriptions with their real-time state. Use this whenever the user asks what subscriptions exist, whether a subscription still exists or is enabled, or before advising about an existing subscription. Results exclude rental subscriptions. Never infer current subscription state from an earlier create_subscription response.",
        params: LIST_PARAMS,
        defs: &[],
        generated_docstring: true,
    },
    Tool {
        name: "get_subscription",
        description: "Get one subscription by ID with its current real-time state, including enabled, next execution time, last execution result, and execution counts. Use this to verify a subscription after creation or before answering whether it will run. Deleted or inaccessible subscriptions are not found. This tool cannot enable, disable, or delete a subscription.",
        params: GET_PARAMS,
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

/// `POST /api/mcp/subscription/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/subscription/sse", access = public)]
async fn subscription_sse_post(
    #[inject(state)] state: &Arc<AppState>,
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("authorization")] authorization: Option<&str>,
    #[header("origin")] origin: Option<&str>,
    body: &[u8],
) -> Response {
    let response = match transport::prepare_message(accept, content_type, protocol_version, body) {
        // `tools/call` may touch dependencies, so the transport awaits the
        // tool body before building the reply.
        Ok(InboundMessage::Request(request)) if request.method == "tools/call" => {
            let reply =
                subscription_read::call(state, authorization, &request.id, request.params.as_ref())
                    .await;
            transport::json_response(StatusCode::OK, reply)
        }
        Ok(InboundMessage::Request(request)) => {
            transport::json_response(StatusCode::OK, dispatch(&request))
        }
        // Notifications and client responses are acknowledged with `202` and
        // processed without a persistent effect in stateless mode.
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

    /// An application state over a stub MySQL server: the transport-level
    /// tests never reach the database.
    async fn test_state() -> Arc<AppState> {
        let fixture = crate::sql_test_support::mysql_rows::MysqlRows::start(|_| Vec::new()).await;
        crate::app_test_support::app(fixture.mysql.clone())
    }

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
        assert_eq!(tools.len(), 4);
        assert_eq!(tools[0]["name"], "preview_subscription");
        assert_eq!(tools[1]["name"], "create_subscription");
        assert_eq!(tools[2]["name"], "list_subscriptions");
        assert_eq!(tools[3]["name"], "get_subscription");
        assert_eq!(
            tools[0]["inputSchema"]["required"],
            json!(["display_name", "trigger_type", "prompt_template"])
        );
        assert_eq!(
            tools[2]["inputSchema"]["required"],
            Value::Null,
            "every list_subscriptions parameter is optional"
        );
        assert_eq!(
            tools[3]["inputSchema"]["required"],
            json!(["subscription_id"])
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
    fn route_table_selects_both_registered_transport_methods() {
        const PATH: &str = "/api/mcp/subscription/sse";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        const POST: u16 = 1 << 5;
        let table = crate::app_test_support::cutover_route_table(&[(PATH, &["GET", "POST"])]);
        assert!(table.matches(&http::Method::GET, PATH));
        assert!(table.matches(&http::Method::POST, PATH));
        let mut selected = 0u16;
        for entry in
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
        {
            for route in (entry.0.routes)() {
                if route.path == PATH {
                    selected |= route.methods;
                }
            }
        }
        assert_eq!(selected & GET, GET, "GET {PATH} must be registered");
        assert_eq!(selected & POST, POST, "POST {PATH} must be registered");
    }

    #[tokio::test]
    async fn get_requires_the_event_stream_accept_header() {
        let rejected =
            subscription_sse_get(Some("application/json"), Some("2025-11-25"), None).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);
        assert_eq!(
            serde_json::from_slice::<Value>(body_bytes(&rejected)).unwrap()["error"]["code"],
            json!(-32600)
        );

        let opened =
            subscription_sse_get(Some("text/event-stream"), Some("2025-11-25"), None).await;
        assert_eq!(opened.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn get_rejects_an_unsupported_protocol_version() {
        let response =
            subscription_sse_get(Some("text/event-stream"), Some("1999-01-01"), None).await;
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
    async fn headerless_requests_do_not_vary_by_origin() {
        let state = test_state().await;
        let headerless =
            subscription_sse_get(Some("text/event-stream"), Some("2025-11-25"), None).await;
        assert_eq!(
            headerless.cors_policy(),
            brz_http_server::ResponseCors::Skip
        );

        let cross_origin = subscription_sse_get(
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
        let post = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
            None,
            body,
        )
        .await;
        assert_eq!(post.cors_policy(), brz_http_server::ResponseCors::Skip);

        let post_cross = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
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
    async fn post_validates_accept_and_content_type() {
        let state = test_state().await;
        let initialize = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let rejected = subscription_sse_post(
            &state,
            Some("text/event-stream"),
            Some("application/json"),
            None,
            None,
            None,
            initialize,
        )
        .await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);

        let unsupported = subscription_sse_post(
            &state,
            Some("application/json"),
            Some("text/plain"),
            None,
            None,
            None,
            initialize,
        )
        .await;
        assert_eq!(unsupported.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    }

    #[tokio::test]
    async fn post_initialize_returns_the_handshake() {
        let state = test_state().await;
        let body = br#"{"method":"initialize","params":{"protocolVersion":"2025-11-25"},"jsonrpc":"2.0","id":0}"#;
        let response = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            None,
            None,
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
        let state = test_state().await;
        // The recorded `server/discover` probe: the header version is
        // unsupported, so the transport rejects it before dispatch.
        let body =
            br#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover"}"#;
        let response = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2026-07-28"),
            None,
            None,
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
        let state = test_state().await;
        let body = br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let response = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(body_bytes(&response).is_empty());
    }

    #[tokio::test]
    async fn tools_call_without_a_token_returns_the_auth_required_payload() {
        let state = test_state().await;
        // `tool_wrapper` renders the missing identity as an ordinary result.
        let body = br#"{"method":"tools/call","params":{"name":"get_subscription","arguments":{"subscription_id":1}},"jsonrpc":"2.0","id":1}"#;
        let response = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            None,
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["id"], json!(1));
        assert_eq!(
            value["result"]["content"][0]["text"],
            json!("{\"error\": \"Authentication required\"}")
        );
    }

    #[tokio::test]
    async fn tools_call_loads_the_owned_active_subscription_row() {
        use crate::sql_test_support::mysql_rows::{MysqlRows, Row, Value as SqlValue};

        let document = json!({
            "kind": "Subscription",
            "spec": {
                "displayName": "短剧需求搜索词天级判定与钉钉推送（uv分档版）",
                "taskType": "collection",
                "visibility": "private",
                "promptTemplate": "模板",
                "retryCount": 1,
                "timeoutSeconds": 7200,
                "trigger": {
                    "type": "cron",
                    "cron": {"expression": "0 10 * * *", "timezone": "Asia/Shanghai"}
                }
            },
            "_internal": {
                "enabled": true,
                "team_id": 110467,
                "trigger_type": "cron",
                "workspace_id": 0,
                "bound_task_id": 0,
                "next_execution_time": "2026-11-12T02:00:00",
                "last_execution_status": ""
            }
        });
        let fixture = MysqlRows::start_results(move |sql| {
            assert!(sql.contains("FROM kinds"), "{sql}");
            let row: Row = vec![
                ("kinds_id", SqlValue::I32(2643427)),
                ("kinds_user_id", SqlValue::I32(4097)),
                ("kinds_kind", SqlValue::Text("Subscription".into())),
                ("kinds_name", SqlValue::Text("sub-uv-51891ddf".into())),
                ("kinds_namespace", SqlValue::Text("default".into())),
                ("kinds_json", SqlValue::Text(document.to_string())),
                ("kinds_is_active", SqlValue::I8(1)),
                ("kinds_created_at", SqlValue::DateTime),
                ("kinds_updated_at", SqlValue::DateTime),
            ];
            (row.clone(), vec![row])
        })
        .await;
        let state = crate::app_test_support::app(fixture.mysql.clone());
        let token = task_token_for(&state);

        let body = br#"{"method":"tools/call","params":{"name":"get_subscription","arguments":{"subscription_id":2643427}},"jsonrpc":"2.0","id":1}"#;
        let response = subscription_sse_post(
            &state,
            Some("application/json, text/event-stream"),
            Some("application/json"),
            Some("2025-11-25"),
            Some(&token),
            None,
            body,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: Value = serde_json::from_slice(body_bytes(&response)).unwrap();
        assert_eq!(value["id"], json!(1));
        let text = value["result"]["content"][0]["text"]
            .as_str()
            .expect("text content");
        let payload: Value = serde_json::from_str(text).unwrap();
        assert_eq!(payload["success"], json!(true));
        assert_eq!(payload["subscription"]["id"], json!(2643427));
        assert_eq!(
            payload["subscription"]["trigger_summary"],
            json!("Cron表达式: `0 10 * * *` (时区: Asia/Shanghai)")
        );
        assert_eq!(
            payload["subscription"]["management_url"],
            json!("/subscriptions/2643427")
        );
        // The single owned-active Subscription read the source performs.
        let queries = fixture.queries();
        assert_eq!(queries.len(), 1, "queries: {queries:?}");
        assert!(
            queries[0].contains("kinds.kind = 'Subscription'"),
            "{queries:?}"
        );
        assert!(queries[0].contains("kinds.is_active = true"), "{queries:?}");
    }

    /// `Authorization: Bearer <task token>` for `state`'s auth config, signed
    /// exactly like the source's `create_task_token`.
    fn task_token_for(state: &AppState) -> String {
        use jsonwebtoken::{Algorithm, EncodingKey, Header};
        let claims = json!({
            "task_id": 11,
            "subtask_id": 22,
            "user_id": 4097,
            "user_name": "tester",
            "exp": 4_102_444_800_i64,
            "type": "task_token",
        });
        let token = jsonwebtoken::encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(state.auth.jwt_key.as_bytes()),
        )
        .expect("a signed test task token");
        format!("Bearer {token}")
    }
}
