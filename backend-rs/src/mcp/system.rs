// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `POST /api/api/mcp/system` — the Wegent system MCP server's task-injection
//! endpoint.
//!
//! `app/mcp_server/server.py` mounts the `wegent-system` FastMCP server at
//! `/mcp/system` with `transport_path="/"` (`register_mcp_apps` at
//! `app/main.py`), but `get_mcp_system_config` advertises its task-injection
//! URL as `{BACKEND_INTERNAL_URL}{API_PREFIX}/mcp/system`. Because
//! `settings.BACKEND_INTERNAL_URL` already ends in `/api` and `API_PREFIX` is
//! `/api`, the advertised URL is `.../api/api/mcp/system` — a doubled-prefix
//! path that FastAPI answers with its default `404 {"detail":"Not Found"}`.
//!
//! The faithful cutover registers `POST /api/api/mcp/system` so the request is
//! routed to Rust instead of proxying to Python (which yields the observed 502
//! "fallback upstream unavailable"): the handler returns exactly the source's
//! `404 {"detail":"Not Found"}` with an `application/json` content type.

use brz_http_server::{Response, StatusCode};

use super::transport;

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

    #[tokio::test]
    async fn returns_the_doubled_prefix_not_found_response() {
        let response = system_mcp_post().await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = match response.body() {
            brz_http_server::ResponseBody::Owned(bytes) => bytes,
            other => panic!("unexpected response body: {other:?}"),
        };
        assert_eq!(body, br#"{"detail":"Not Found"}"#.as_slice());
        let value: serde_json::Value = serde_json::from_slice(body).unwrap();
        assert_eq!(value["detail"], "Not Found");
    }
}
