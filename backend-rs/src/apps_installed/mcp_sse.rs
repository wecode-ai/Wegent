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
use tokio::time::{Instant, timeout_at};

use super::mcp::{
    InitializeResult, McpError, ToolCall, ToolsListResult, UpstreamTool, decode_body,
    initialize_body, initialized_notification_body, status_error,
};

/// Bound each handshake or JSON-RPC request, including keep-alive traffic.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Bound one event, including its terminator, before parsing its payload.
pub(super) const MAX_EVENT_BYTES: usize = 1024 * 1024;

/// One open HTTP+SSE MCP session: the subscribed stream plus the message
/// endpoint that carries every JSON-RPC request of the session.
struct SseSession {
    client: HttpClient,
    reader: SseReader,
    message_url: String,
    headers: Vec<(String, String)>,
    protocol_version: Option<String>,
    next_id: i64,
}

impl SseSession {
    async fn open(url: &str, headers: &[(String, String)]) -> Result<Self, McpError> {
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let client = HttpClient::builder()
            .connect_timeout(REQUEST_TIMEOUT)
            .read_timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| McpError::Transport(error.to_string()))?;
        let mut reader = timeout_at(deadline, open_stream(&client, url, headers))
            .await
            .map_err(|_| McpError::Transport("SSE connection timed out".to_string()))??;
        let message_url = wait_for_endpoint(&mut reader, url, deadline).await?;

        timeout_at(
            deadline,
            post_message(&client, &message_url, &initialize_body(), headers, None),
        )
        .await
        .map_err(|_| McpError::Transport("SSE initialize request timed out".to_string()))??;
        let initialize: InitializeResult =
            wait_for_result(&mut reader, &json!(0), deadline).await?;
        let protocol_version = initialize.protocol_version;
        timeout_at(
            deadline,
            post_message(
                &client,
                &message_url,
                &initialized_notification_body(),
                headers,
                protocol_version.as_deref(),
            ),
        )
        .await
        .map_err(|_| McpError::Transport("SSE initialized notification timed out".to_string()))??;

        Ok(Self {
            client,
            reader,
            message_url,
            headers: headers.to_vec(),
            protocol_version,
            next_id: 1,
        })
    }

    /// Send one request and read its reply from the event stream.
    async fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let mut body = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            body["params"] = params;
        }
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        timeout_at(
            deadline,
            post_message(
                &self.client,
                &self.message_url,
                &body,
                &self.headers,
                self.protocol_version.as_deref(),
            ),
        )
        .await
        .map_err(|_| McpError::Transport("SSE JSON-RPC request timed out".to_string()))??;
        wait_for_result::<Value>(&mut self.reader, &json!(id), deadline).await
    }
}

/// List every tool from the HTTP+SSE MCP server at `url`.
pub async fn list_tools_with_headers(
    url: &str,
    headers: &[(String, String)],
) -> Result<Vec<UpstreamTool>, McpError> {
    let mut session = SseSession::open(url, headers).await?;
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

/// Call one tool over the HTTP+SSE transport.
pub async fn call_tool_with_headers(
    url: &str,
    headers: &[(String, String)],
    name: &str,
    arguments: &Value,
) -> Result<ToolCall, McpError> {
    let mut session = SseSession::open(url, headers).await?;
    let result = session
        .request(
            "tools/call",
            Some(json!({"name": name, "arguments": arguments})),
        )
        .await?;
    Ok(ToolCall::from_result(&result))
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
        buffer: SseBuffer::default(),
        eof: false,
    })
}

/// Read the `endpoint` event that names the message URL of the session.
async fn wait_for_endpoint(
    stream: &mut SseReader,
    base: &str,
    deadline: Instant,
) -> Result<String, McpError> {
    loop {
        let Some(event) = next_event_before(stream, deadline, "endpoint event").await? else {
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

/// Wait for one event without letting keep-alive comments renew the deadline.
async fn next_event_before(
    stream: &mut SseReader,
    deadline: Instant,
    phase: &str,
) -> Result<Option<SseEvent>, McpError> {
    timeout_at(deadline, stream.next_event())
        .await
        .map_err(|_| McpError::Transport(format!("SSE {phase} timed out")))?
}

/// Resolve a possibly relative message URL against the session URL.
fn resolve_endpoint(base: &str, data: &str) -> Result<String, McpError> {
    if data.is_empty() {
        return Err(McpError::Transport(
            "SSE endpoint event carried no data".to_string(),
        ));
    }
    let base = url::Url::parse(base).map_err(|error| McpError::Transport(error.to_string()))?;
    let endpoint = base
        .join(data)
        .map_err(|error| McpError::Transport(error.to_string()))?;
    // Session credentials belong only to the configured origin. An upstream
    // endpoint event must not redirect authenticated JSON-RPC to another host.
    if endpoint.origin() != base.origin()
        || !endpoint.username().is_empty()
        || endpoint
            .as_str()
            .split('/')
            .nth(2)
            .is_some_and(|authority| authority.contains('@'))
    {
        return Err(McpError::Transport(
            "SSE endpoint origin does not match connection origin".to_string(),
        ));
    }
    Ok(endpoint.to_string())
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
async fn wait_for_result<T>(
    stream: &mut SseReader,
    id: &Value,
    deadline: Instant,
) -> Result<T, McpError>
where
    T: for<'de> Deserialize<'de>,
{
    loop {
        let Some(event) = next_event_before(stream, deadline, "JSON-RPC reply").await? else {
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
#[derive(Debug)]
pub(super) struct SseEvent {
    pub(super) event: String,
    pub(super) data: String,
}

/// Incremental reader over the server's `text/event-stream` body.
struct SseReader {
    response: HttpResponse,
    buffer: SseBuffer,
    eof: bool,
}

impl SseReader {
    async fn next_event(&mut self) -> Result<Option<SseEvent>, McpError> {
        loop {
            if let Some(event) = self.buffer.next_event()? {
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
                Some(chunk) => self.buffer.push(&chunk),
                None => self.eof = true,
            }
        }
    }
}

/// Shared bounded parser for legacy SSE and streamable-HTTP event bodies.
#[derive(Default)]
pub(super) struct SseBuffer {
    bytes: Vec<u8>,
    event_start: usize,
    scan_start: usize,
}

impl SseBuffer {
    pub(super) fn push(&mut self, chunk: &[u8]) {
        // Compact once per chunk, not once per queued event.
        if self.event_start > 0 {
            self.bytes.drain(..self.event_start);
            self.scan_start -= self.event_start;
            self.event_start = 0;
        }
        self.bytes.extend_from_slice(chunk);
    }

    pub(super) fn next_event(&mut self) -> Result<Option<SseEvent>, McpError> {
        let limit = self.event_start.saturating_add(MAX_EVENT_BYTES);
        let bounded = &self.bytes[..self.bytes.len().min(limit)];
        if let Some((end, separator_len)) = find_event_end_from(bounded, self.scan_start) {
            let event = parse_event(&self.bytes[self.event_start..end]);
            self.event_start = end + separator_len;
            self.scan_start = self.event_start;
            return Ok(Some(event));
        }
        if self.bytes.len() > limit {
            return Err(McpError::Transport(format!(
                "SSE event exceeded {MAX_EVENT_BYTES} bytes"
            )));
        }
        // Revisit only the suffix where a CRLF terminator could be split.
        self.scan_start = self.bytes.len().saturating_sub(3).max(self.event_start);
        Ok(None)
    }
}

/// Byte index of the end of the first event and the length of its terminator.
fn find_event_end_from(buffer: &[u8], start: usize) -> Option<(usize, usize)> {
    let mut index = start;
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
        let mut buffer = SseBuffer::default();
        buffer.push(b"event: endpoint\ndata: /a\n\ndata: {}\n\n");
        assert_eq!(
            buffer.next_event().unwrap().map(|e| e.data),
            Some("/a".into())
        );
        assert_eq!(
            buffer.next_event().unwrap().map(|e| e.data),
            Some("{}".into())
        );
        assert!(buffer.next_event().unwrap().is_none());

        buffer.push(b"event: endpoint\r\ndata: /b\r\n\r\n");
        assert_eq!(
            buffer.next_event().unwrap().map(|e| e.data),
            Some("/b".into())
        );
        assert!(buffer.next_event().unwrap().is_none());
    }

    #[test]
    fn event_terminators_split_across_chunks_are_detected_incrementally() {
        let mut buffer = SseBuffer::default();
        buffer.push(b"event: message\ndata: {}\r\n\r");
        assert!(buffer.next_event().unwrap().is_none());
        buffer.push(b"\n");
        assert_eq!(buffer.next_event().unwrap().unwrap().data, "{}");
        assert!(buffer.next_event().unwrap().is_none());
    }

    #[tokio::test]
    async fn next_event_rejects_an_oversized_incomplete_event() {
        let url = serve(Mode::ClosedStream).await;
        let client = HttpClient::builder().build().unwrap();
        let response = client.endpoint(&url).unwrap().get().send().await.unwrap();
        let mut stream = SseReader {
            response,
            buffer: SseBuffer {
                bytes: vec![b'x'; MAX_EVENT_BYTES + 1],
                ..Default::default()
            },
            eof: false,
        };

        let error = stream.next_event().await.unwrap_err();
        assert!(matches!(error, McpError::Transport(_)));
        assert!(error.to_string().contains("exceeded"));
    }

    #[tokio::test]
    async fn next_event_rejects_an_oversized_complete_event() {
        let url = serve(Mode::ClosedStream).await;
        let client = HttpClient::builder().build().unwrap();
        let response = client.endpoint(&url).unwrap().get().send().await.unwrap();
        let mut buffer = vec![b'x'; MAX_EVENT_BYTES + 1];
        buffer.extend_from_slice(b"\n\n");
        let mut stream = SseReader {
            response,
            buffer: SseBuffer {
                bytes: buffer,
                ..Default::default()
            },
            eof: false,
        };

        let error = stream.next_event().await.unwrap_err();
        assert!(error.to_string().contains("exceeded"));
    }

    #[tokio::test]
    async fn incomplete_events_advance_the_scan_cursor() {
        let url = serve(Mode::ClosedStream).await;
        let client = HttpClient::builder().build().unwrap();
        let response = client.endpoint(&url).unwrap().get().send().await.unwrap();
        let mut stream = SseReader {
            response,
            buffer: SseBuffer::default(),
            eof: false,
        };

        stream.buffer.push(&vec![b'x'; 4096]);
        assert!(stream.buffer.next_event().unwrap().is_none());
        assert_eq!(stream.buffer.scan_start, 4093);
        stream.buffer.push(b"\r\n\r");
        assert!(stream.buffer.next_event().unwrap().is_none());
        assert_eq!(stream.buffer.scan_start, 4096);
        stream.buffer.push(b"\n");
        assert!(stream.buffer.next_event().unwrap().is_some());
    }

    #[test]
    fn event_cap_is_per_event_not_per_chunk() {
        let mut buffer = SseBuffer::default();
        let mut event = b"data: ".to_vec();
        event.resize(MAX_EVENT_BYTES - 2, b'x');
        event.extend_from_slice(b"\n\n");
        let mut chunk = event.clone();
        chunk.extend_from_slice(&event);
        chunk.extend_from_slice(b"data: tail\r\n\r");
        buffer.push(&chunk);

        assert!(buffer.next_event().unwrap().is_some());
        assert!(buffer.next_event().unwrap().is_some());
        assert!(buffer.next_event().unwrap().is_none());
        buffer.push(b"\n");
        assert_eq!(buffer.bytes, b"data: tail\r\n\r\n");
        assert_eq!(buffer.next_event().unwrap().unwrap().data, "tail");
    }

    #[tokio::test]
    async fn reply_wait_has_a_deadline_after_unmatched_ids_and_keep_alives() {
        let url = serve(Mode::EndpointKeepAlive).await;
        let client = HttpClient::builder().build().unwrap();
        let mut stream = open_stream(&client, &url, &[]).await.unwrap();
        stream.buffer.push(b"data: {\"id\":7,\"result\":{}}\n\n");

        let result = wait_for_result::<Value>(
            &mut stream,
            &json!(8),
            Instant::now() + Duration::from_millis(50),
        )
        .await;
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("JSON-RPC reply timed out")
        );
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
    fn endpoint_events_cannot_change_origin_or_embed_credentials() {
        for endpoint in [
            "https://other.example.test/messages",
            "//other.example.test/messages",
            "http://mcp.example.test/messages",
            "https://mcp.example.test:8443/messages",
            "https://user:password@mcp.example.test/messages",
        ] {
            let error = resolve_endpoint("https://mcp.example.test/sse", endpoint).unwrap_err();
            assert!(
                error.to_string().contains("origin does not match"),
                "{endpoint}"
            );
        }
        assert_eq!(
            resolve_endpoint(
                "https://mcp.example.test/sse",
                "https://mcp.example.test:443/messages"
            )
            .unwrap(),
            "https://mcp.example.test/messages"
        );
    }

    #[tokio::test]
    async fn cross_origin_endpoint_receives_no_session_requests() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let source = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/sse", source.local_addr().unwrap());
        let endpoint = format!("http://{}/messages", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = source.accept().await.unwrap();
            read_request(&mut stream).await.unwrap();
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n\
                         event: endpoint\r\ndata: {endpoint}\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        });
        let error = list_tools_with_headers(
            &url,
            &[("Authorization".to_string(), "Bearer synthetic".to_string())],
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("origin does not match"));
        assert!(
            tokio::time::timeout(Duration::from_millis(100), target.accept())
                .await
                .is_err(),
            "The untrusted endpoint must receive neither requests nor credentials"
        );
        server.await.unwrap();
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
        /// Serve only keep-alive comments instead of the endpoint event.
        EndpointKeepAlive,
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
                Mode::EndpointKeepAlive => {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n")
                        .await
                        .ok();
                    loop {
                        if stream.write_all(b": keep-alive\n\n").await.is_err() {
                            return;
                        }
                        let _ = stream.flush().await;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
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

    #[tokio::test]
    async fn endpoint_wait_has_an_overall_deadline_across_keep_alives() {
        let url = serve(Mode::EndpointKeepAlive).await;
        let client = HttpClient::builder().build().unwrap();
        let mut stream = open_stream(&client, &url, &[]).await.unwrap();
        let error = wait_for_endpoint(
            &mut stream,
            &url,
            Instant::now() + Duration::from_millis(50),
        )
        .await
        .unwrap_err();

        assert!(matches!(error, McpError::Transport(_)));
        assert!(error.to_string().contains("timed out"));
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
