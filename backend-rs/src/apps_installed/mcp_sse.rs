// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Minimal HTTP+SSE MCP client for connector tool discovery.
//!
//! Mirrors the source `mcp.client.sse.sse_client` session that
//! `ConnectorRuntimeService._mcp_session` opens for an app whose
//! `transport` is `sse`: a `GET` request subscribing to the server's event
//! stream, the `endpoint` event naming the message URL, then one `POST` per
//! JSON-RPC message whose reply arrives on that stream. Connector apps built on
//! this legacy transport only implement `GET` for the session, so probing them
//! with the streamable-HTTP `POST initialize` would report a healthy upstream as
//! unavailable.
use std::time::Duration;

use brz_http::{Client as HttpClient, Endpoint, Response as HttpResponse};
use serde::Deserialize;
use serde_json::{Value, json};

use super::mcp::{
    InitializeResult, McpError, ToolsListResult, UpstreamTool, decode_body, initialize_body,
    initialized_notification_body, status_error, tools_list_body,
};

/// Source `sse_client` read window; the session is long-lived, so the bound
/// applies to each read rather than to the whole exchange.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// List every tool from the HTTP+SSE MCP server at `url`.
pub async fn list_tools_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> Result<Vec<UpstreamTool>, McpError> {
    let client = HttpClient::builder()
        .connect_timeout(REQUEST_TIMEOUT)
        .read_timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|error| McpError::Transport(error.to_string()))?;
    let mut stream = open_stream(&client, url, headers).await?;
    let message_url = wait_for_endpoint(&mut stream, url).await?;

    post_message(&client, &message_url, &initialize_body(), headers, None).await?;
    let initialize: InitializeResult = wait_for_result(&mut stream, &json!(0)).await?;
    let protocol_version = initialize.protocol_version;

    post_message(
        &client,
        &message_url,
        &initialized_notification_body(),
        headers,
        protocol_version.as_deref(),
    )
    .await?;

    let mut tools: Vec<UpstreamTool> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen_cursors: Vec<String> = Vec::new();
    let mut request_id: i64 = 1;
    loop {
        let body = tools_list_body(request_id, cursor.as_deref());
        let id = json!(request_id);
        request_id += 1;
        post_message(
            &client,
            &message_url,
            &body,
            headers,
            protocol_version.as_deref(),
        )
        .await?;
        let result: ToolsListResult = wait_for_result(&mut stream, &id).await?;
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

/// `GET` the app URL and subscribe to its event stream.
async fn open_stream(
    client: &HttpClient,
    url: &str,
    headers: &[(String, String)],
) -> Result<SseReader, McpError> {
    let endpoint: Endpoint = client
        .endpoint(url)
        .map_err(|error| McpError::Transport(error.to_string()))?;
    let mut request = endpoint
        .get()
        .header("accept", "text/event-stream")
        .header("cache-control", "no-store");
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| McpError::Transport(error.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(status.as_u16()));
    }
    Ok(SseReader {
        response,
        buffer: Vec::new(),
        eof: false,
    })
}

/// Read the `endpoint` event that names the message URL of the session.
async fn wait_for_endpoint(stream: &mut SseReader, base: &str) -> Result<String, McpError> {
    loop {
        let Some(event) = stream.next_event().await? else {
            return Err(McpError::Transport(
                "SSE stream ended before the endpoint event".to_string(),
            ));
        };
        if event.event != "endpoint" {
            continue;
        }
        return resolve_endpoint(base, event.data.trim());
    }
}

/// Resolve a possibly relative message URL against the session URL.
fn resolve_endpoint(base: &str, data: &str) -> Result<String, McpError> {
    if data.is_empty() {
        return Err(McpError::Transport(
            "SSE endpoint event carried no data".to_string(),
        ));
    }
    let base = url::Url::parse(base).map_err(|error| McpError::Transport(error.to_string()))?;
    base.join(data)
        .map(|url| url.to_string())
        .map_err(|error| McpError::Transport(error.to_string()))
}

/// `POST` one JSON-RPC message to the session's message URL.
async fn post_message(
    client: &HttpClient,
    url: &str,
    body: &Value,
    headers: &[(String, String)],
    protocol_version: Option<&str>,
) -> Result<(), McpError> {
    let endpoint: Endpoint = client
        .endpoint(url)
        .map_err(|error| McpError::Transport(error.to_string()))?;
    let mut request = endpoint
        .post()
        .header("accept", "application/json, text/event-stream")
        .json(body);
    if let Some(version) = protocol_version {
        request = request.header("mcp-protocol-version", version);
    }
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|error| McpError::Transport(error.to_string()))?;
    let status = response.status();
    // The transport answers `202 Accepted`; a body, when present, is drained so
    // the connection returns to the pool.
    let _ = response.bytes().await;
    if !status.is_success() {
        return Err(status_error(status.as_u16()));
    }
    Ok(())
}

/// Read the stream until the reply to the request `id` arrives.
async fn wait_for_result<T>(stream: &mut SseReader, id: &Value) -> Result<T, McpError>
where
    T: for<'de> Deserialize<'de>,
{
    loop {
        let Some(event) = stream.next_event().await? else {
            return Err(McpError::Transport(
                "SSE stream ended before the JSON-RPC reply".to_string(),
            ));
        };
        if event.event != "message" {
            continue;
        }
        let Ok(payload) = serde_json::from_str::<Value>(event.data.trim()) else {
            continue;
        };
        if payload.get("id") != Some(id) {
            continue;
        }
        if let Some(error) = payload.get("error").filter(|error| !error.is_null()) {
            return Err(McpError::Transport(format!(
                "MCP response carries an error: {error}"
            )));
        }
        return decode_body(payload.to_string().as_bytes());
    }
}

/// One parsed server-sent event.
struct SseEvent {
    event: String,
    data: String,
}

/// Incremental reader over the server's `text/event-stream` body.
struct SseReader {
    response: HttpResponse,
    buffer: Vec<u8>,
    eof: bool,
}

impl SseReader {
    async fn next_event(&mut self) -> Result<Option<SseEvent>, McpError> {
        loop {
            if let Some(event) = take_event(&mut self.buffer) {
                return Ok(Some(event));
            }
            if self.eof {
                return Ok(None);
            }
            match self
                .response
                .chunk()
                .await
                .map_err(|error| McpError::Transport(error.to_string()))?
            {
                Some(chunk) => self.buffer.extend_from_slice(&chunk),
                None => self.eof = true,
            }
        }
    }
}

/// Remove the first complete event from `buffer`.
fn take_event(buffer: &mut Vec<u8>) -> Option<SseEvent> {
    let (end, separator_len) = find_event_end(buffer)?;
    let raw = buffer[..end].to_vec();
    buffer.drain(..end + separator_len);
    Some(parse_event(&raw))
}

/// Byte index of the end of the first event and the length of its terminator.
fn find_event_end(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < buffer.len() {
        if buffer[index] == b'\n' && buffer.get(index + 1) == Some(&b'\n') {
            return Some((index, 2));
        }
        if buffer[index] == b'\r'
            && buffer.get(index + 1) == Some(&b'\n')
            && buffer.get(index + 2) == Some(&b'\r')
            && buffer.get(index + 3) == Some(&b'\n')
        {
            return Some((index, 4));
        }
        index += 1;
    }
    None
}

/// Parse one event's fields: comments are dropped, `data` lines join with
/// newlines, and an event without an `event` field defaults to `message`.
fn parse_event(raw: &[u8]) -> SseEvent {
    let text = String::from_utf8_lossy(raw);
    let mut event = String::new();
    let mut data: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => event = value.to_string(),
            "data" => data.push(value),
            _ => {}
        }
    }
    SseEvent {
        event: if event.is_empty() {
            "message".to_string()
        } else {
            event
        },
        data: data.join("\n"),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::Notify;

    use super::*;

    fn parse(raw: &str) -> SseEvent {
        parse_event(raw.as_bytes())
    }

    #[test]
    fn endpoint_events_are_parsed() {
        let event = parse("event: endpoint\ndata: /messages/?session_id=abc");
        assert_eq!(event.event, "endpoint");
        assert_eq!(event.data, "/messages/?session_id=abc");
    }

    #[test]
    fn message_events_are_the_default_event_type() {
        let event = parse("data: {\"id\":1}");
        assert_eq!(event.event, "message");
        assert_eq!(event.data, "{\"id\":1}");
    }

    #[test]
    fn comments_and_keep_alives_are_ignored() {
        let event = parse(": ping - 2026-10-28 10:00:00\r\ndata: {}\r");
        assert_eq!(event.data, "{}");
    }

    #[test]
    fn multi_line_data_is_joined_with_newlines() {
        let event = parse("event: message\ndata: {\ndata: \"id\":1}");
        assert_eq!(event.data, "{\n\"id\":1}");
    }

    #[test]
    fn events_split_on_both_terminator_styles() {
        let mut buffer = b"event: endpoint\ndata: /a\n\ndata: {}\n\n".to_vec();
        assert_eq!(take_event(&mut buffer).map(|e| e.data), Some("/a".into()));
        assert_eq!(take_event(&mut buffer).map(|e| e.data), Some("{}".into()));
        assert!(take_event(&mut buffer).is_none());

        let mut crlf = b"event: endpoint\r\ndata: /b\r\n\r\n".to_vec();
        assert_eq!(take_event(&mut crlf).map(|e| e.data), Some("/b".into()));
        assert!(crlf.is_empty());
    }

    #[test]
    fn relative_message_urls_resolve_against_the_session_url() {
        assert_eq!(
            resolve_endpoint("https://mcp.example.test/sse?x=1", "/messages/?id=1").unwrap(),
            "https://mcp.example.test/messages/?id=1"
        );
        assert_eq!(
            resolve_endpoint("https://mcp.example.test/sse", "messages/1").unwrap(),
            "https://mcp.example.test/messages/1"
        );
    }

    #[test]
    fn an_empty_endpoint_event_is_a_transport_failure() {
        let error = resolve_endpoint("https://mcp.example.test/sse", "").unwrap_err();
        assert!(matches!(error, McpError::Transport(_)));
    }

    #[test]
    fn authorization_answers_are_not_transport_failures() {
        assert!(matches!(status_error(401), McpError::Unauthorized(_)));
        assert!(matches!(status_error(403), McpError::Unauthorized(_)));
        assert!(matches!(status_error(500), McpError::Transport(_)));
    }

    /// How the fixture answers the session `GET`.
    #[derive(Clone, Copy)]
    enum Mode {
        /// Serve the `endpoint` event and reply to each posted message.
        Handshake,
        /// Answer the `GET` with this status and no stream.
        Deny(u16),
        /// Serve an empty stream that closes immediately.
        ClosedStream,
    }

    #[derive(Default)]
    struct Feed {
        pending: Mutex<VecDeque<String>>,
        notify: Notify,
    }

    impl Feed {
        fn push(&self, payload: String) {
            self.pending.lock().unwrap().push_back(payload);
            self.notify.notify_waiters();
        }

        fn take(&self) -> Option<String> {
            self.pending.lock().unwrap().pop_front()
        }
    }

    /// Start a fixture MCP server and return its session URL.
    async fn serve(mode: Mode) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let feed = Arc::new(Feed::default());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let feed = Arc::clone(&feed);
                tokio::spawn(async move {
                    handle(stream, feed, mode).await;
                });
            }
        });
        format!("http://{address}/sse")
    }

    async fn handle(mut stream: TcpStream, feed: Arc<Feed>, mode: Mode) {
        let Some((head, body)) = read_request(&mut stream).await else {
            return;
        };
        let method = head
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        if method == "GET" {
            match mode {
                Mode::Deny(status) => {
                    let reply = format!("HTTP/1.1 {status} Denied\r\ncontent-length: 0\r\n\r\n");
                    let _ = stream.write_all(reply.as_bytes()).await;
                }
                Mode::ClosedStream => {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n")
                        .await
                        .ok();
                }
                Mode::Handshake => {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
                              event: endpoint\r\ndata: /messages\r\n\r\n",
                        )
                        .await
                        .ok();
                    let _ = stream.flush().await;
                    while let Some(payload) = next_payload(&feed).await {
                        let frame = format!("event: message\ndata: {payload}\n\n");
                        if stream.write_all(frame.as_bytes()).await.is_err() {
                            return;
                        }
                        let _ = stream.flush().await;
                    }
                }
            }
            return;
        }
        stream
            .write_all(b"HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\n\r\n")
            .await
            .ok();
        if let Some(reply) = response_for(&body) {
            feed.push(reply);
        }
    }

    async fn next_payload(feed: &Feed) -> Option<String> {
        loop {
            if let Some(payload) = feed.take() {
                return Some(payload);
            }
            feed.notify.notified().await;
        }
    }

    /// The JSON-RPC reply the fixture sends for one posted message.
    fn response_for(body: &[u8]) -> Option<String> {
        let message: Value = serde_json::from_slice(body).ok()?;
        let method = message.get("method")?.as_str()?;
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        match method {
            "initialize" => Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"protocolVersion": "2024-11-05"},
                })
                .to_string(),
            ),
            "tools/list" => Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {"tools": [{"name": "read_doc", "title": "Read"}]},
                })
                .to_string(),
            ),
            _ => None,
        }
    }

    async fn read_request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
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
                    let read = stream.read(&mut chunk).await.ok()?;
                    if read == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                }
                let body = buffer[start..(start + length).min(buffer.len())].to_vec();
                return Some((head, body));
            }
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return None;
            }
            buffer.extend_from_slice(&chunk[..read]);
        }
    }

    /// The `sse` transport only serves `GET`; the session completes over the
    /// message endpoint named by the `endpoint` event.
    #[tokio::test]
    async fn lists_tools_over_the_sse_transport() {
        let url = serve(Mode::Handshake).await;
        let tools = list_tools_with_headers(&url, &[]).await.unwrap();

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "read_doc");
        assert_eq!(tools[0].title.as_deref(), Some("Read"));
    }

    /// The transport dispatch keeps streamable-HTTP apps on their own protocol.
    #[tokio::test]
    async fn the_app_transport_selects_the_protocol() {
        let url = serve(Mode::Handshake).await;
        assert!(
            crate::apps_installed::mcp::list_tools_for_transport("sse", &url, &[])
                .await
                .is_ok()
        );
        // The same server answers `GET`, so a streamable-HTTP probe fails.
        assert!(
            crate::apps_installed::mcp::list_tools_for_transport("streamable-http", &url, &[])
                .await
                .is_err()
        );
    }

    /// A rejected credential is reported as such, not as a transport failure.
    #[tokio::test]
    async fn an_authorization_status_is_unauthorized() {
        let url = serve(Mode::Deny(401)).await;
        assert!(matches!(
            list_tools_with_headers(&url, &[]).await.unwrap_err(),
            McpError::Unauthorized(_)
        ));

        let url = serve(Mode::Deny(403)).await;
        assert!(matches!(
            list_tools_with_headers(&url, &[]).await.unwrap_err(),
            McpError::Unauthorized(_)
        ));
    }

    /// Any other status is a transport failure that keeps the grant.
    #[tokio::test]
    async fn a_server_error_stays_a_transport_failure() {
        let url = serve(Mode::Deny(500)).await;
        assert!(matches!(
            list_tools_with_headers(&url, &[]).await.unwrap_err(),
            McpError::Transport(_)
        ));
    }

    /// A stream that closes before naming the message endpoint cannot be used.
    #[tokio::test]
    async fn a_stream_without_an_endpoint_event_fails() {
        let url = serve(Mode::ClosedStream).await;
        let error = list_tools_with_headers(&url, &[]).await.unwrap_err();
        assert!(matches!(error, McpError::Transport(_)));
        assert!(error.to_string().contains("endpoint event"));
    }
}
