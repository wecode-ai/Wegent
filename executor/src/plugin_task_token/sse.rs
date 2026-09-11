//! Preserve the legacy SSE endpoint announcement through the loopback route.

use axum::body::{Body, Bytes};
use futures_util::StreamExt;
use std::{io, sync::Arc};
use tokio::sync::Mutex;

pub(super) fn body(
    response: reqwest::Response,
    upstream: reqwest::Url,
    local: String,
    endpoint: Arc<Mutex<Option<reqwest::Url>>>,
) -> Body {
    let stream = response.bytes_stream();
    let state = (
        Box::pin(stream),
        Vec::<u8>::new(),
        upstream,
        local,
        endpoint,
    );
    Body::from_stream(futures_util::stream::try_unfold(
        state,
        |(mut stream, mut pending, upstream, local, endpoint)| async move {
            loop {
                if let Some(end) = pending.windows(2).position(|bytes| bytes == b"\n\n") {
                    let frame: Vec<_> = pending.drain(..end + 2).collect();
                    let text = std::str::from_utf8(&frame)
                        .map_err(|_| io::Error::other("Invalid MCP SSE encoding"))?;
                    let frame = if text.lines().any(|line| line.trim() == "event: endpoint") {
                        let path = text
                            .lines()
                            .find_map(|line| line.strip_prefix("data:").map(str::trim))
                            .ok_or_else(|| io::Error::other("Missing MCP SSE endpoint"))?;
                        let url = upstream
                            .join(path)
                            .map_err(|_| io::Error::other("Invalid MCP SSE endpoint"))?;
                        if url.origin() != upstream.origin() {
                            return Err(io::Error::other("Cross-origin MCP SSE endpoint rejected"));
                        }
                        *endpoint.lock().await = Some(url);
                        format!("event: endpoint\ndata: {local}/messages\n\n").into_bytes()
                    } else {
                        frame
                    };
                    return Ok(Some((
                        Bytes::from(frame),
                        (stream, pending, upstream, local, endpoint),
                    )));
                }
                match stream.next().await {
                    Some(Ok(chunk)) => {
                        pending.extend_from_slice(&chunk);
                        // Normalize CRLF across chunk boundaries before framing.
                        pending = pending
                            .split(|byte| *byte == b'\r')
                            .flatten()
                            .copied()
                            .collect();
                        if pending.len() > 16 * 1024 * 1024 {
                            return Err(io::Error::other("MCP SSE event is too large"));
                        }
                    }
                    Some(Err(_)) => return Err(io::Error::other("MCP SSE stream interrupted")),
                    None => {
                        if pending.is_empty() {
                            return Ok(None);
                        }
                        return Err(io::Error::other("Incomplete MCP SSE event"));
                    }
                }
            }
        },
    ))
}
