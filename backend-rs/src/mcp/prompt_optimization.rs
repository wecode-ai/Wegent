// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `GET /api/mcp/prompt-optimization/sse` — the prompt-optimization MCP
//! server's stateless streamable-HTTP transport
//! (`app/mcp_server/server.py`, `_PROMPT_OPTIMIZATION_MCP_SPEC`).
//!
//! The mounted Starlette app serves the MCP streamable-HTTP transport at
//! `/sse` with `stateless_http=True` and `json_response=True`. This batch
//! migrates the recorded method only: `GET` opens the server-to-client SSE
//! stream, which stays open with the source's periodic keep-alive comment and
//! has no recorded terminal event. The `POST` JSON-RPC surface (the
//! `prompt_optimization` tool bodies) is not selected for Rust, so those
//! requests continue to the Python implementation.

use brz_http_server::Response;

use super::protocol;
use super::transport;

/// `GET /api/mcp/prompt-optimization/sse`: open the server-to-client stream.
#[brz_http_server::get("/api/mcp/prompt-optimization/sse", access = public)]
async fn prompt_optimization_sse_get(
    #[header("accept")] accept: Option<&str>,
    #[header("mcp-protocol-version")] protocol_version: Option<&str>,
) -> Response {
    if !transport::accepts_sse(accept) {
        return transport::json_response(
            brz_http_server::StatusCode::NOT_ACCEPTABLE,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::protocol::LATEST_PROTOCOL_VERSION;
    use brz_http_server::StatusCode;

    #[test]
    fn deferred_route_keeps_python_ownership_and_handler_registration() {
        const PATH: &str = "/api/mcp/prompt-optimization/sse";
        // `method_bit`: DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT.
        const GET: u16 = 1 << 1;
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let config = crate::hybrid::load_routes_config(&path).expect("routes file loads");
        let table = crate::RouteTable::compile(config).expect("routes compile");
        assert!(!table.matches(&http::Method::GET, PATH));
        assert!(!table.matches(&http::Method::POST, PATH));
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| route.path == PATH && route.methods & GET != 0);
        assert!(registered, "GET {PATH} must be registered by the router");
    }

    #[tokio::test]
    async fn get_requires_the_event_stream_accept_header() {
        let rejected = prompt_optimization_sse_get(Some("application/json"), None).await;
        assert_eq!(rejected.status(), StatusCode::NOT_ACCEPTABLE);

        let opened = prompt_optimization_sse_get(Some("text/event-stream"), None).await;
        assert_eq!(opened.status(), StatusCode::OK);
        assert!(matches!(
            opened.body(),
            brz_http_server::ResponseBody::Stream(_)
        ));
    }

    #[tokio::test]
    async fn get_rejects_an_unsupported_protocol_version() {
        let response =
            prompt_optimization_sse_get(Some("text/event-stream"), Some("1999-01-01")).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn protocol_versions_match_the_sdk() {
        assert!(protocol::protocol_version_supported(Some(
            LATEST_PROTOCOL_VERSION
        )));
    }
}
