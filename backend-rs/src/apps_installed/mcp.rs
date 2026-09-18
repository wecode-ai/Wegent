// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Minimal streamable-HTTP MCP client for connector tool discovery.
//!
//! Mirrors the wire behavior of the source `mcp` Python client as used by
//! `ConnectorRuntimeService._mcp_session` + `_list_all_tools`: one JSON-RPC
//! `initialize` request, one `notifications/initialized` notification, then
//! paginated `tools/list` requests until no `nextCursor` is returned. The
//! source client negotiates `protocolVersion` from the `initialize` result
//! and echoes it as the `mcp-protocol-version` header on later requests.
use std::time::Duration;

use brz_http::{Client as HttpClient, Endpoint, Response as HttpResponse};
use serde::Deserialize;
use serde_json::json;

/// Source `streamablehttp_client(timeout=30)` connect/read window.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// The source MCP client's hardcoded handshake protocol version.
const HANDSHAKE_PROTOCOL_VERSION: &str = "2025-11-25";

/// One upstream MCP tool as returned by `tools/list`.
///
/// `input_schema` and `annotations` are the raw `inputSchema` and
/// `annotations` members. They stay opaque here because only the
/// connector-runtime projection inspects them; the apps-installed projection
/// uses `name`, `title`, and `description` alone.
#[derive(Debug, Clone)]
pub struct UpstreamTool {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Option<crate::json_compat::OpaqueJson>,
    pub annotations: Option<crate::json_compat::OpaqueJson>,
}

/// One JSON-RPC response envelope.
#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    result: Option<T>,
}

/// The `initialize` result payload.
#[derive(Debug, Deserialize)]
struct InitializeResult {
    #[serde(default, rename = "protocolVersion")]
    protocol_version: Option<String>,
}

/// One `tools/list` result payload.
#[derive(Debug, Deserialize)]
struct ToolsListResult {
    #[serde(default)]
    tools: Vec<ToolDefinition>,
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolDefinition {
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    input_schema: Option<crate::json_compat::OpaqueJson>,
    #[serde(default)]
    annotations: Option<crate::json_compat::OpaqueJson>,
}

/// Errors while listing tools from one connector app.
#[derive(Debug)]
pub enum McpError {
    /// Transport, status, body, or decode failure.
    Transport(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Transport(message) => write!(formatter, "MCP transport failure: {message}"),
        }
    }
}

/// List every tool from the streamable-HTTP MCP server at `url`.
///
/// A fresh Breeze client and endpoint are created per discovery pass,
/// mirroring the source's per-discovery
/// `async with streamablehttp_client(...)` session; the underlying reqwest
/// pool partitions connections by origin, so no connection churn policy
/// beyond the session scope is introduced.
pub async fn list_tools(url: &str) -> Result<Vec<UpstreamTool>, McpError> {
    list_tools_with_headers(url, &[]).await
}

/// List every tool from the streamable-HTTP MCP server at `url`, sending
/// `headers` on every JSON-RPC request of the session.
///
/// The source `ConnectorRuntimeService._server_config` builds the session
/// headers (decrypted provider headers plus the caller's user context) once
/// per app and passes them to every request of the MCP client session.
pub async fn list_tools_with_headers(
    url: &str,
    headers: &[(&str, String)],
) -> Result<Vec<UpstreamTool>, McpError> {
    let client = HttpClient::builder()
        .connect_timeout(REQUEST_TIMEOUT)
        .read_timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| McpError::Transport(error.to_string()))?;
    let endpoint: Endpoint = client
        .endpoint(url)
        .map_err(|error| McpError::Transport(error.to_string()))?;

    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": HANDSHAKE_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "mcp", "version": "0.1.0"},
        },
    });
    let initialize_request = session_request(&endpoint, &initialize, headers);
    let initialize_result: InitializeResult = decode_payload(
        initialize_request
            .send()
            .await
            .map_err(|error| McpError::Transport(error.to_string()))?,
    )
    .await?;
    let protocol_version = initialize_result.protocol_version;

    let notification = json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    });
    let mut notification_request = session_request(&endpoint, &notification, headers);
    if let Some(version) = protocol_version.as_deref() {
        notification_request = notification_request.header("mcp-protocol-version", version);
    }
    let notification_response = notification_request
        .send()
        .await
        .map_err(|error| McpError::Transport(error.to_string()))?;
    // A 202 with an empty body completes the notification; the body is
    // consumed to EOF for the HTTP profile contract.
    let _ = notification_response.bytes().await;

    let mut tools: Vec<UpstreamTool> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors: Vec<String> = Vec::new();
    let mut request_id: i64 = 1;
    loop {
        let mut request = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/list",
        });
        if let Some(cursor_value) = cursor.as_deref() {
            request["params"] = json!({ "cursor": cursor_value });
        }
        request_id += 1;
        let mut list_request = session_request(&endpoint, &request, headers);
        if let Some(version) = protocol_version.as_deref() {
            list_request = list_request.header("mcp-protocol-version", version);
        }
        let result: ToolsListResult = decode_payload(
            list_request
                .send()
                .await
                .map_err(|error| McpError::Transport(error.to_string()))?,
        )
        .await?;
        for tool in result.tools {
            tools.push(UpstreamTool {
                name: tool.name,
                title: tool.title,
                description: tool.description,
                input_schema: tool.input_schema,
                annotations: tool.annotations,
            });
        }
        cursor = result.next_cursor;
        match cursor.as_deref() {
            None => return Ok(tools),
            Some(next) => {
                if seen_cursors.iter().any(|seen| seen == next) {
                    return Err(McpError::Transport(
                        "MCP tools/list returned a repeated cursor".into(),
                    ));
                }
                seen_cursors.push(next.to_string());
            }
        }
    }
}

/// Build one JSON-RPC POST request of an MCP session: the source's `httpx`
/// client sends `application/json` with the streamable-HTTP accept pair, plus
/// the session headers supplied by `_server_config`.
fn session_request(
    endpoint: &Endpoint,
    body: &impl serde::Serialize,
    headers: &[(&str, String)],
) -> brz_http::RequestBuilder {
    let mut request = endpoint
        .post()
        .header("accept", "application/json, text/event-stream")
        .json(body);
    for (name, value) in headers {
        request = request.header(*name, value);
    }
    request
}

/// Read one JSON-RPC response body and decode its `result` payload.
async fn decode_payload<T>(response: HttpResponse) -> Result<T, McpError>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|error| McpError::Transport(error.to_string()))?;
    if !status.is_success() {
        return Err(McpError::Transport(format!(
            "MCP server returned status {status}"
        )));
    }
    if body.is_empty() {
        return Err(McpError::Transport(
            "MCP response body is empty".to_string(),
        ));
    }
    let payload: JsonRpcResponse<T> =
        serde_json::from_slice(&body).map_err(|error| McpError::Transport(error.to_string()))?;
    let result = payload
        .result
        .ok_or_else(|| McpError::Transport("MCP response carries no result".to_string()))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handshake_uses_source_protocol_version() {
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": HANDSHAKE_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "mcp", "version": "0.1.0"},
            },
        });
        assert_eq!(initialize["params"]["protocolVersion"], "2025-11-25");
        assert_eq!(initialize["params"]["clientInfo"]["name"], "mcp");
        assert_eq!(initialize["params"]["clientInfo"]["version"], "0.1.0");
    }

    #[test]
    fn tool_definition_keeps_input_schema_and_annotations() {
        let tool: ToolDefinition = serde_json::from_value(json!({
            "name": "get_capabilities",
            "title": "Get Capabilities",
            "description": "Return the capabilities.",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false,
            },
            "annotations": {
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            },
        }))
        .expect("recorded tools/list entry decodes");
        assert_eq!(tool.name, "get_capabilities");
        assert_eq!(tool.title.as_deref(), Some("Get Capabilities"));
        assert_eq!(
            tool.input_schema
                .as_ref()
                .map(crate::json_compat::OpaqueJson::to_value),
            Some(json!({
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false,
            }))
        );
        assert_eq!(
            tool.annotations
                .as_ref()
                .map(crate::json_compat::OpaqueJson::to_value),
            Some(json!({
                "readOnlyHint": true,
                "destructiveHint": false,
                "idempotentHint": false,
                "openWorldHint": false,
            }))
        );
    }

    #[test]
    fn tool_definition_tolerates_missing_optional_members() {
        let tool: ToolDefinition = serde_json::from_value(json!({"name": "bare"}))
            .expect("a tool without hints still decodes");
        assert_eq!(tool.name, "bare");
        assert_eq!(tool.title, None);
        assert_eq!(tool.description, None);
        assert!(tool.input_schema.is_none());
        assert!(tool.annotations.is_none());
    }
}
