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
    pub input_schema: Option<brz_json::OpaqueJson>,
    pub annotations: Option<brz_json::OpaqueJson>,
}

/// One JSON-RPC response envelope.
#[derive(Debug, Deserialize)]
pub(super) struct JsonRpcResponse<T> {
    result: Option<T>,
}

/// The `initialize` result payload.
#[derive(Debug, Deserialize)]
pub(super) struct InitializeResult {
    #[serde(default, rename = "protocolVersion")]
    pub(super) protocol_version: Option<String>,
}

/// One `tools/list` result payload.
#[derive(Debug, Deserialize)]
pub(super) struct ToolsListResult {
    #[serde(default)]
    pub(super) tools: Vec<ToolDefinition>,
    #[serde(default, rename = "nextCursor")]
    pub(super) next_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct ToolDefinition {
    pub(super) name: String,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    pub(super) input_schema: Option<brz_json::OpaqueJson>,
    #[serde(default)]
    pub(super) annotations: Option<brz_json::OpaqueJson>,
}

/// Errors while listing tools from one connector app.
#[derive(Debug)]
pub enum McpError {
    /// The upstream answered `401`/`403`: the stored grant is no longer
    /// accepted, which is a different outcome from a transport failure.
    Unauthorized(String),
    /// Transport, status, body, or decode failure.
    Transport(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized(message) => {
                write!(formatter, "MCP server rejected the credential: {message}")
            }
            Self::Transport(message) => write!(formatter, "MCP transport failure: {message}"),
        }
    }
}

/// Classify a non-success status: an authorization answer means the stored
/// credential was rejected, every other status is a transport failure.
pub(super) fn status_error(status: u16) -> McpError {
    if status == 401 || status == 403 {
        McpError::Unauthorized(format!("MCP server returned status {status}"))
    } else {
        McpError::Transport(format!("MCP server returned status {status}"))
    }
}

impl ToolDefinition {
    /// Project one `tools/list` entry into the connector view.
    pub(super) fn into_upstream_tool(self) -> UpstreamTool {
        UpstreamTool {
            name: self.name,
            title: self.title,
            description: self.description,
            input_schema: self.input_schema,
            annotations: self.annotations,
        }
    }
}

/// The `initialize` request the source's MCP client sends first.
pub(super) fn initialize_body() -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": 0,
        "method": "initialize",
        "params": {
            "protocolVersion": HANDSHAKE_PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "mcp", "version": "0.1.0"},
        },
    })
}

/// The `notifications/initialized` message sent after the handshake.
pub(super) fn initialized_notification_body() -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    })
}

/// List the tools of `app.transport`'s MCP server, dispatching to the protocol
/// the source's `_mcp_session` selects: `sse_client` for the legacy
/// HTTP+SSE transport and `streamablehttp_client` for everything else.
pub async fn list_tools_for_transport(
    transport: &str,
    url: &str,
    headers: &[(String, String)],
) -> Result<Vec<UpstreamTool>, McpError> {
    if transport == "sse" {
        return super::mcp_sse::list_tools_with_headers(url, headers).await;
    }
    list_tools_with_headers(url, headers).await
}

/// One open streamable-HTTP MCP session, from `initialize` through the last
/// request the caller needs.
///
/// A fresh Breeze client and endpoint are created per discovery pass,
/// mirroring the source's per-discovery
/// `async with streamablehttp_client(...)` session; the underlying reqwest
/// pool partitions connections by origin, so no connection churn policy
/// beyond the session scope is introduced.
///
/// The source `ConnectorRuntimeService._server_config` builds the session
/// headers (decrypted provider headers plus the caller's user context) once
/// per app and passes them to every request of the MCP client session.
pub struct StreamableSession {
    endpoint: Endpoint,
    headers: Vec<(String, String)>,
    protocol_version: Option<String>,
    /// `Mcp-Session-Id` from `initialize`; stateful servers reject every later
    /// request that omits it.
    session_id: Option<String>,
    next_id: i64,
}

impl StreamableSession {
    /// Run the `initialize` handshake and send `notifications/initialized`.
    pub async fn open(url: &str, headers: &[(String, String)]) -> Result<Self, McpError> {
        let client = HttpClient::builder()
            .connect_timeout(REQUEST_TIMEOUT)
            .read_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| McpError::Transport(error.to_string()))?;
        let endpoint: Endpoint = client
            .endpoint(url)
            .map_err(|error| McpError::Transport(error.to_string()))?;

        let initialize_request = session_request(&endpoint, &initialize_body(), headers, None);
        let (initialize_result, session_id): (InitializeResult, Option<String>) = decode_payload(
            initialize_request
                .send()
                .await
                .map_err(|error| McpError::Transport(error.to_string()))?,
            Some(&json!(0)),
        )
        .await?;
        let protocol_version = initialize_result.protocol_version;

        let mut notification_request = session_request(
            &endpoint,
            &initialized_notification_body(),
            headers,
            session_id.as_deref(),
        );
        if let Some(version) = protocol_version.as_deref() {
            notification_request = notification_request.header("mcp-protocol-version", version);
        }
        let notification_response = notification_request
            .send()
            .await
            .map_err(|error| McpError::Transport(error.to_string()))?;
        let notification_status = notification_response.status();
        // A 202 with an empty body completes the notification; the body is
        // consumed to EOF for the HTTP profile contract.
        let _ = notification_response.bytes().await;
        if !notification_status.is_success() {
            return Err(status_error(notification_status.as_u16()));
        }

        Ok(Self {
            endpoint,
            headers: headers.to_vec(),
            protocol_version,
            session_id,
            next_id: 1,
        })
    }

    /// Send one request and return its raw `result` payload.
    pub async fn request(
        &mut self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let mut body = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            body["params"] = params;
        }
        let mut request = session_request(
            &self.endpoint,
            &body,
            &self.headers,
            self.session_id.as_deref(),
        );
        if let Some(version) = self.protocol_version.as_deref() {
            request = request.header("mcp-protocol-version", version);
        }
        let (result, _) = decode_payload(
            request
                .send()
                .await
                .map_err(|error| McpError::Transport(error.to_string()))?,
            Some(&json!(id)),
        )
        .await?;
        Ok(result)
    }
}

/// One `tools/call` result (`CallToolResult`).
#[derive(Debug, Clone)]
pub struct ToolCall {
    /// `result.content`: the raw MCP content blocks.
    pub content: serde_json::Value,
    /// `result.structuredContent`, only when the upstream returned an object.
    pub structured_content: Option<serde_json::Value>,
    /// `result.isError`.
    pub is_error: bool,
}

impl ToolCall {
    /// Read one `tools/call` result payload.
    pub fn from_result(result: &serde_json::Value) -> Self {
        Self {
            content: result.get("content").cloned().unwrap_or_else(|| json!([])),
            structured_content: result
                .get("structuredContent")
                .filter(|value| value.is_object())
                .cloned(),
            is_error: result
                .get("isError")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        }
    }
}

/// Call one tool on the app's MCP server and return its result payload.
pub async fn call_tool_for_transport(
    transport: &str,
    url: &str,
    headers: &[(String, String)],
    name: &str,
    arguments: &serde_json::Value,
) -> Result<ToolCall, McpError> {
    if transport == "sse" {
        return super::mcp_sse::call_tool_with_headers(url, headers, name, arguments).await;
    }
    let mut session = StreamableSession::open(url, headers).await?;
    let result = session
        .request(
            "tools/call",
            Some(json!({"name": name, "arguments": arguments})),
        )
        .await?;
    Ok(ToolCall::from_result(&result))
}

/// List every tool from the streamable-HTTP MCP server at `url`, sending
/// `headers` on every JSON-RPC request of the session.
pub async fn list_tools_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> Result<Vec<UpstreamTool>, McpError> {
    let mut session = StreamableSession::open(url, headers).await?;
    let mut tools: Vec<UpstreamTool> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors: Vec<String> = Vec::new();
    loop {
        let params = cursor.as_deref().map(|cursor| json!({ "cursor": cursor }));
        let result: ToolsListResult =
            serde_json::from_value(session.request("tools/list", params).await?)
                .map_err(|error| McpError::Transport(error.to_string()))?;
        for tool in result.tools {
            tools.push(tool.into_upstream_tool());
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
    headers: &[(String, String)],
    session_id: Option<&str>,
) -> brz_http::RequestBuilder {
    let mut request = endpoint
        .post()
        .header("accept", "application/json, text/event-stream")
        .json(body);
    if let Some(session_id) = session_id {
        request = request.header("mcp-session-id", session_id);
    }
    for (name, value) in headers {
        request = request.header(name, value);
    }
    request
}

/// Read one JSON-RPC response and decode its `result`, returning the
/// `Mcp-Session-Id` the server assigned, if any.
///
/// The request declares `Accept: application/json, text/event-stream`, so the
/// server may answer either way. An event stream is consumed incrementally and
/// stops at the reply for `expected_id`; buffering it to EOF would hang on a
/// connection the server keeps open.
async fn decode_payload<T>(
    mut response: HttpResponse,
    expected_id: Option<&serde_json::Value>,
) -> Result<(T, Option<String>), McpError>
where
    T: for<'de> Deserialize<'de>,
{
    let status = response.status();
    let session_id = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if !status.is_success() {
        return Err(status_error(status.as_u16()));
    }
    let is_event_stream = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().starts_with("text/event-stream"));
    let result = if is_event_stream {
        decode_sse_stream(&mut response, expected_id).await?
    } else {
        let body = response
            .bytes()
            .await
            .map_err(|error| McpError::Transport(error.to_string()))?;
        decode_body(&body)?
    };
    Ok((result, session_id))
}

/// Read the reply for `expected_id` from an incremental event stream.
async fn decode_sse_stream<T>(
    response: &mut HttpResponse,
    expected_id: Option<&serde_json::Value>,
) -> Result<T, McpError>
where
    T: for<'de> Deserialize<'de>,
{
    let mut buffer = Vec::new();
    loop {
        while let Some(event) = super::mcp_sse::take_event(&mut buffer) {
            if event.event != "message" {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.data.trim()) else {
                continue;
            };
            if expected_id.is_some_and(|expected| payload.get("id") != Some(expected)) {
                continue;
            }
            if let Some(error) = payload.get("error").filter(|error| !error.is_null()) {
                return Err(McpError::Transport(format!(
                    "MCP response carries an error: {error}"
                )));
            }
            return decode_body(payload.to_string().as_bytes());
        }
        match response
            .chunk()
            .await
            .map_err(|error| McpError::Transport(error.to_string()))?
        {
            Some(chunk) => buffer.extend_from_slice(&chunk),
            None => {
                return Err(McpError::Transport(
                    "MCP event stream ended before the JSON-RPC reply".to_string(),
                ));
            }
        }
    }
}

/// Decode one buffered JSON-RPC response body into its `result` payload.
pub(super) fn decode_body<T>(body: &[u8]) -> Result<T, McpError>
where
    T: for<'de> Deserialize<'de>,
{
    if body.is_empty() {
        return Err(McpError::Transport(
            "MCP response body is empty".to_string(),
        ));
    }
    let payload: JsonRpcResponse<T> =
        serde_json::from_slice(body).map_err(|error| McpError::Transport(error.to_string()))?;
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
                .map(brz_json::OpaqueJson::to_value),
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
                .map(brz_json::OpaqueJson::to_value),
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

    /// One scripted answer the fixture returns for the next request.
    struct Scripted {
        status: u16,
        content_type: &'static str,
        headers: Vec<(&'static str, &'static str)>,
        body: String,
        /// Keep the socket open after writing, like a server holding an SSE tail.
        hold_open: bool,
    }

    type RecordedHeaders = std::sync::Arc<std::sync::Mutex<Vec<Vec<(String, String)>>>>;

    /// Serve one connection per scripted answer, recording every request head.
    async fn serve_script(script: Vec<Scripted>) -> (String, RecordedHeaders) {
        use tokio::io::AsyncWriteExt as _;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let recorded: RecordedHeaders = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = std::sync::Arc::clone(&recorded);
        tokio::spawn(async move {
            let mut remaining = script.into_iter();
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let Some(answer) = remaining.next() else {
                    return;
                };
                let head = read_request_head(&mut stream).await;
                recorder.lock().unwrap().push(head);
                let mut raw = format!(
                    "HTTP/1.1 {} X\r\ncontent-type: {}\r\n",
                    answer.status, answer.content_type
                );
                for (name, value) in &answer.headers {
                    raw.push_str(&format!("{name}: {value}\r\n"));
                }
                raw.push_str(&format!("content-length: {}\r\n", answer.body.len()));
                raw.push_str("connection: close\r\n\r\n");
                raw.push_str(&answer.body);
                let _ = stream.write_all(raw.as_bytes()).await;
                if answer.hold_open {
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        });
        (format!("http://{address}/mcp"), recorded)
    }

    /// Read one request's header block and body, returning the lowercased head.
    async fn read_request_head(stream: &mut tokio::net::TcpStream) -> Vec<(String, String)> {
        use tokio::io::AsyncReadExt as _;
        let mut buffer = Vec::new();
        let mut chunk = [0_u8; 2048];
        loop {
            if let Some(position) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buffer[..position]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                let start = position + 4;
                while buffer.len() < start + length {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
                return head
                    .lines()
                    .skip(1)
                    .filter_map(|line| line.split_once(':'))
                    .map(|(name, value)| {
                        (name.trim().to_ascii_lowercase(), value.trim().to_string())
                    })
                    .collect();
            }
            let read = stream.read(&mut chunk).await.unwrap_or(0);
            if read == 0 {
                return Vec::new();
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
    }

    fn header_value(head: &[(String, String)], name: &str) -> Option<String> {
        head.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    }

    /// A stateful server hands out `Mcp-Session-Id` on `initialize`; every later
    /// request of the session must echo it.
    #[tokio::test]
    async fn stateful_servers_receive_the_session_id_on_later_requests() {
        let (url, recorded) = serve_script(vec![
            Scripted {
                status: 200,
                content_type: "application/json",
                headers: vec![("mcp-session-id", "sess-42")],
                body: json!({
                    "jsonrpc": "2.0",
                    "id": 0,
                    "result": {"protocolVersion": "2025-06-18"},
                })
                .to_string(),
                hold_open: false,
            },
            Scripted {
                status: 202,
                content_type: "application/json",
                headers: vec![],
                body: String::new(),
                hold_open: false,
            },
            Scripted {
                status: 200,
                content_type: "application/json",
                headers: vec![],
                body: json!({"jsonrpc": "2.0", "id": 1, "result": {"tools": []}}).to_string(),
                hold_open: false,
            },
        ])
        .await;

        let tools = list_tools_with_headers(&url, &[]).await.unwrap();
        assert!(tools.is_empty());

        let heads = recorded.lock().unwrap().clone();
        assert_eq!(heads.len(), 3);
        assert_eq!(header_value(&heads[0], "mcp-session-id"), None);
        assert_eq!(
            header_value(&heads[1], "mcp-session-id").as_deref(),
            Some("sess-42")
        );
        assert_eq!(
            header_value(&heads[2], "mcp-session-id").as_deref(),
            Some("sess-42")
        );
    }

    /// An event-stream answer is decoded when its reply arrives, without waiting
    /// for the server to close the connection.
    #[tokio::test]
    async fn event_stream_replies_are_decoded_without_waiting_for_eof() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"echo\"}]}}\n\n";
        let (url, _) = serve_script(vec![
            Scripted {
                status: 200,
                content_type: "application/json",
                headers: vec![],
                body: json!({
                    "jsonrpc": "2.0",
                    "id": 0,
                    "result": {"protocolVersion": "2025-06-18"},
                })
                .to_string(),
                hold_open: false,
            },
            Scripted {
                status: 202,
                content_type: "application/json",
                headers: vec![],
                body: String::new(),
                hold_open: false,
            },
            Scripted {
                status: 200,
                content_type: "text/event-stream",
                headers: vec![],
                body: sse.to_string(),
                hold_open: true,
            },
        ])
        .await;

        let tools = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            list_tools_with_headers(&url, &[]),
        )
        .await
        .expect("the SSE reply must resolve before the connection closes")
        .unwrap();

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
    }

    /// `tools/call` may also answer with an event stream.
    #[tokio::test]
    async fn tool_calls_decode_event_stream_results() {
        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}],\"isError\":false}}\n\n";
        let (url, _) = serve_script(vec![
            Scripted {
                status: 200,
                content_type: "application/json",
                headers: vec![],
                body: json!({
                    "jsonrpc": "2.0",
                    "id": 0,
                    "result": {"protocolVersion": "2025-06-18"},
                })
                .to_string(),
                hold_open: false,
            },
            Scripted {
                status: 202,
                content_type: "application/json",
                headers: vec![],
                body: String::new(),
                hold_open: false,
            },
            Scripted {
                status: 200,
                content_type: "text/event-stream",
                headers: vec![],
                body: sse.to_string(),
                hold_open: true,
            },
        ])
        .await;

        let call = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            call_tool_for_transport("streamable-http", &url, &[], "echo", &json!({})),
        )
        .await
        .expect("the SSE reply must resolve before the connection closes")
        .unwrap();

        assert!(!call.is_error);
        assert_eq!(call.content[0]["text"], json!("ok"));
    }

    /// One event split across two writes still decodes.
    #[tokio::test]
    async fn event_stream_events_split_across_chunks_are_reassembled() {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let sse_head = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,";
        let sse_tail = "\"result\":{\"tools\":[{\"name\":\"split\"}]}}\n\n";
        tokio::spawn(async move {
            let answers = [
                (
                    "application/json",
                    json!({
                        "jsonrpc": "2.0",
                        "id": 0,
                        "result": {"protocolVersion": "2025-06-18"},
                    })
                    .to_string(),
                ),
                ("application/json", String::new()),
                ("text/event-stream", String::new()),
            ];
            for (content_type, body) in answers {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = Vec::new();
                let mut chunk = [0_u8; 1024];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    if String::from_utf8_lossy(&buffer).contains("\r\n\r\n") {
                        break;
                    }
                }
                // The event stream has no declared length: it is delimited by
                // the connection close, like a server streaming a session.
                let head = if content_type == "text/event-stream" {
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\nconnection: close\r\n\r\n"
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                        body.len()
                    )
                };
                let _ = stream.write_all(head.as_bytes()).await;
                if content_type == "text/event-stream" {
                    let _ = stream.write_all(sse_head.as_bytes()).await;
                    let _ = stream.flush().await;
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    let _ = stream.write_all(sse_tail.as_bytes()).await;
                } else if !body.is_empty() {
                    let _ = stream.write_all(body.as_bytes()).await;
                }
            }
        });

        let tools = list_tools_with_headers(&format!("http://{address}/mcp"), &[])
            .await
            .unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "split");
    }

    /// Streamable-HTTP answers keep the same classification as the SSE
    /// transport: 401/403 mean the credential was rejected, 5xx is a transport
    /// failure that keeps the grant.
    #[tokio::test]
    async fn streamable_http_status_classes_match_the_grant_contract() {
        let (url, _) = serve_script(vec![Scripted {
            status: 401,
            content_type: "application/json",
            headers: vec![],
            body: String::new(),
            hold_open: false,
        }])
        .await;
        assert!(matches!(
            list_tools_with_headers(&url, &[]).await.unwrap_err(),
            McpError::Unauthorized(_)
        ));

        let (url, _) = serve_script(vec![Scripted {
            status: 500,
            content_type: "application/json",
            headers: vec![],
            body: String::new(),
            hold_open: false,
        }])
        .await;
        assert!(matches!(
            list_tools_with_headers(&url, &[]).await.unwrap_err(),
            McpError::Transport(_)
        ));
    }
}
