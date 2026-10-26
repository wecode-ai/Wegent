// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/mcp/knowledge-external/sse` — the external knowledge MCP
//! server's stateless streamable-HTTP transport
//! (`app/mcp_server/external_knowledge_app.py` and
//! `app/mcp_server/server.py::external_knowledge_mcp_server`).
//!
//! The mounted Starlette app applies two middlewares before the transport
//! (`add_middleware` puts the last-added one outermost, so
//! `EmptyPathToSlashMiddleware` → auth → limiter is the execution order):
//!
//! 1. `_ExternalKnowledgeAuthMiddleware` — the deployment auth handler
//!    ([`ExternalKnowledgeAuth`]) resolves the caller from the gateway employee
//!    header or the bearer credential; no identity answers `401
//!    {"error": "Authentication required", "code": "unauthorized"}` without
//!    consuming limiter budget;
//! 2. `_ExternalKnowledgeRateLimitMiddleware` — the Redis fixed-window
//!    `transport` budget keyed by the client-IP hash (and the credential hash
//!    when one is present).
//!
//! The transport then behaves like every other FastMCP streamable-HTTP mount
//! (`stateless_http=True`, `json_response=True`): `GET` opens the
//! server-to-client stream and `POST` exchanges JSON-RPC messages.
//!
//! Scope of this batch: the middleware chain, the transport framing, the
//! initialization handshake, and the server's declared tool listing. The
//! external tool bodies (knowledge-base listing, node listing, document
//! content/download, RAG search) are not migrated, so `tools/call` answers
//! with the protocol's `Unknown tool` error instead of inventing a result.
//! The internal deployment's replacement of the knowledge-base listing tool
//! is likewise not migrated
//! yet, so the listing below is the open-source tool surface.

use std::sync::Arc;

use brz_http_server::{IntoHttpError, Response, StatusCode};
use serde_json::json;

use super::super::knowledge_tools::python_json;
use super::super::protocol::{self, InboundMessage, RpcRequest};
use super::super::tools::{self, Literal, Param, ParamKind, Tool};
use super::super::transport;
use super::{client_ip, rate_limit};
use crate::state::AppState;

/// `EXTERNAL_KNOWLEDGE_MCP_TRANSPORT_PATH`'s FastMCP server name and service
/// name.
const SERVER_NAME: &str = "wegent-knowledge-external-mcp";

static LIST_KNOWLEDGE_BASE_PARAMS: &[Param] = &[
    Param {
        name: "scope",
        kind: ParamKind::Str,
        description: "",
        required: false,
        default: Some(Literal::Str("all")),
    },
    Param {
        name: "group_name",
        kind: ParamKind::Str,
        description: "",
        required: false,
        default: None,
    },
    Param {
        name: "query",
        kind: ParamKind::Str,
        description: "",
        required: false,
        default: None,
    },
    Param {
        name: "owner_user_ids",
        kind: ParamKind::ListOfInt,
        description: "",
        required: false,
        default: None,
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(50)),
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(0)),
    },
];

static LIST_NODES_PARAMS: &[Param] = &[
    Param {
        name: "knowledge_base_id",
        kind: ParamKind::Int,
        description: "",
        required: true,
        default: None,
    },
    Param {
        name: "folder_id",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(0)),
    },
    Param {
        name: "recursive",
        kind: ParamKind::Bool,
        description: "",
        required: false,
        default: Some(Literal::Bool(false)),
    },
    Param {
        name: "include_inactive",
        kind: ParamKind::Bool,
        description: "",
        required: false,
        default: Some(Literal::Bool(true)),
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(100)),
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(0)),
    },
];

static DOCUMENT_CONTENT_PARAMS: &[Param] = &[
    Param {
        name: "document_id",
        kind: ParamKind::Int,
        description: "",
        required: true,
        default: None,
    },
    Param {
        name: "offset",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(0)),
    },
    Param {
        name: "limit",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(100_000)),
    },
];

static DOCUMENT_DOWNLOAD_PARAMS: &[Param] = &[
    Param {
        name: "document_id",
        kind: ParamKind::Int,
        description: "",
        required: true,
        default: None,
    },
    Param {
        name: "disposition",
        kind: ParamKind::Str,
        description: "",
        required: false,
        default: Some(Literal::Str("inline")),
    },
];

static SEARCH_PARAMS: &[Param] = &[
    Param {
        name: "query",
        kind: ParamKind::Str,
        description: "",
        required: true,
        default: None,
    },
    Param {
        name: "knowledge_base_ids",
        kind: ParamKind::ListOfInt,
        description: "",
        required: false,
        default: None,
    },
    Param {
        name: "max_results",
        kind: ParamKind::Int,
        description: "",
        required: false,
        default: Some(Literal::Int(10)),
    },
];

/// The external knowledge server's registered tools
/// (`app/mcp_server/tools/knowledge_external.py`). FastMCP publishes the
/// function docstring as the description, so these tools carry no generated
/// `Args:` block.
pub(crate) static EXTERNAL_TOOLS: &[Tool] = &[
    Tool {
        name: "wegent_kb_list_knowledge_bases",
        description: "List knowledge bases visible to the authenticated external user.",
        params: LIST_KNOWLEDGE_BASE_PARAMS,
        defs: &[],
        generated_docstring: false,
    },
    Tool {
        name: "wegent_kb_list_nodes",
        description: "List folder and document nodes in a knowledge base.",
        params: LIST_NODES_PARAMS,
        defs: &[],
        generated_docstring: false,
    },
    Tool {
        name: "wegent_kb_get_document_content",
        description: "Read parsed text content for an accessible knowledge document.",
        params: DOCUMENT_CONTENT_PARAMS,
        defs: &[],
        generated_docstring: false,
    },
    Tool {
        name: "wegent_kb_get_document_download",
        description: "Get a short-lived original file download credential for a document.",
        params: DOCUMENT_DOWNLOAD_PARAMS,
        defs: &[],
        generated_docstring: false,
    },
    Tool {
        name: "wegent_kb_search_content",
        description: "Search document content in accessible knowledge bases.",
        params: SEARCH_PARAMS,
        defs: &[],
        generated_docstring: false,
    },
];

/// `GET /api/mcp/knowledge-external/sse`: open the server-to-client stream.
#[brz_http_server::get("/api/mcp/knowledge-external/sse", access = public)]
async fn external_sse_get(
    #[inject(state)] state: &Arc<AppState>,
    #[header("accept")] accept: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("authorization")] authorization: Option<&str>,
    #[header("x-user-name")] user_name: Option<&str>,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
) -> Response {
    if let Err(response) = authorize(state, authorization, user_name, x_forwarded_for).await {
        return response;
    }
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

/// `POST /api/mcp/knowledge-external/sse`: exchange one JSON-RPC message.
#[brz_http_server::post("/api/mcp/knowledge-external/sse", access = public)]
// The function API binds each header as its own parameter.
#[allow(clippy::too_many_arguments)]
async fn external_sse_post(
    #[inject(state)] state: &Arc<AppState>,
    #[header("accept")] accept: Option<&str>,
    #[header("content-type")] content_type: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
    #[header("authorization")] authorization: Option<&str>,
    #[header("x-user-name")] user_name: Option<&str>,
    #[header("x-forwarded-for")] x_forwarded_for: Option<&str>,
    body: &[u8],
) -> Response {
    if let Err(response) = authorize(state, authorization, user_name, x_forwarded_for).await {
        return response;
    }
    let message = match transport::prepare_message(accept, content_type, protocol_version, body) {
        Ok(message) => message,
        Err(response) => return response,
    };
    let request = match message {
        InboundMessage::Request(request) => request,
        InboundMessage::NoReply => return transport::empty_json_response(StatusCode::ACCEPTED),
    };
    transport::json_response(StatusCode::OK, dispatch(&request))
}

/// The two middlewares' shared rejection path: the rate limit first, then the
/// deployment auth handler. A resolved user is not needed by the current
/// transport methods beyond authentication, so only rejection is surfaced.
#[allow(clippy::result_large_err)]
async fn authorize(
    state: &AppState,
    authorization: Option<&str>,
    user_name: Option<&str>,
    x_forwarded_for: Option<&str>,
) -> Result<(), Response> {
    let token = authorization.and_then(extract_bearer_token);
    // Starlette wraps the last-added middleware outermost, so the mounted
    // app runs `EmptyPathToSlashMiddleware` → `_ExternalKnowledgeAuthMiddleware`
    // → `_ExternalKnowledgeRateLimitMiddleware`. Authentication therefore
    // resolves (and rejects) before the limiter consumes any budget, which is
    // also the dependency order: deployment identity lookups precede the
    // limiter transaction.
    let employee_id = user_name.map(str::trim).filter(|value| !value.is_empty());
    if state
        .external_knowledge_auth
        .resolve(state, employee_id, token)
        .await
        .is_none()
    {
        return Err(transport::json_response(
            StatusCode::UNAUTHORIZED,
            unauthorized_body("Authentication required"),
        ));
    }

    rate_limit::check_transport(
        &rate_limit::TransportRateLimits::from_env(),
        state.redis.as_ref(),
        &client_ip(x_forwarded_for),
        token,
    )
    .await
    .map_err(|error| error.into_http_error(&brz_http_server::EphemeralBytesArena::new(256)))
}

/// `extract_token_from_header`: the credential of a two-token
/// `Bearer <token>` header.
fn extract_bearer_token(authorization: &str) -> Option<&str> {
    crate::task_token::extract_token_from_header(authorization)
}

/// `_send_json_error(error=..., code="unauthorized")`.
fn unauthorized_body(error: &str) -> String {
    python_json(&json!({ "error": error, "code": "unauthorized" }))
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
        "tools/list" => protocol::success_body(&request.id, &tools::tool_listing(EXTERNAL_TOOLS)),
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

    #[test]
    fn initialize_result_matches_the_recorded_handshake() {
        let params = json!({ "protocolVersion": "2025-11-25" });
        assert_eq!(
            transport::initialize_result(SERVER_NAME, Some(&params)),
            json!({
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "experimental": {},
                    "prompts": { "listChanged": false },
                    "resources": { "subscribe": false, "listChanged": false },
                    "tools": { "listChanged": false }
                },
                "serverInfo": { "name": "wegent-knowledge-external-mcp", "version": "1.27.2" }
            })
        );
        let unknown = json!({ "protocolVersion": "1999-01-01" });
        assert_eq!(
            transport::initialize_result(SERVER_NAME, Some(&unknown))["protocolVersion"],
            LATEST_PROTOCOL_VERSION
        );
    }

    #[test]
    fn initialize_reply_is_a_compact_json_rpc_result() {
        let reply = protocol::success_body(
            &json!(0),
            &transport::initialize_result(
                SERVER_NAME,
                Some(&json!({ "protocolVersion": "2025-11-25" })),
            ),
        );
        assert!(
            reply
                .starts_with(r#"{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25""#)
        );
    }

    #[test]
    fn tools_list_publishes_the_external_tool_surface() {
        let value: Value =
            serde_json::from_str(&dispatch(&request("tools/list", json!(1), None))).unwrap();
        let tools = value["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 5);
        assert_eq!(tools[0]["name"], "wegent_kb_list_knowledge_bases");
        assert_eq!(tools[3]["name"], "wegent_kb_get_document_download");
    }

    #[test]
    fn transport_validation_rejects_missing_headers() {
        let body = br#"{"method":"initialize","params":{},"jsonrpc":"2.0","id":0}"#;
        assert_eq!(
            transport::prepare_message(
                Some("text/event-stream"),
                Some("application/json"),
                None,
                body
            )
            .err()
            .unwrap()
            .status(),
            StatusCode::NOT_ACCEPTABLE
        );
        assert_eq!(
            transport::prepare_message(Some("application/json"), Some("text/plain"), None, body)
                .err()
                .unwrap()
                .status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[test]
    fn unauthorized_body_matches_the_source() {
        assert_eq!(
            unauthorized_body("Authentication required"),
            r#"{"error": "Authentication required", "code": "unauthorized"}"#
        );
    }
}
