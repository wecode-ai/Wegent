// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! SSE framing policy and dispatch results.

use std::time::Duration;

/// `_SSE_CANCEL_POLL_INTERVAL_SECONDS`.
pub const CANCEL_POLL_INTERVAL: Duration = Duration::from_secs(1);
/// The chat-shell per-read timeout (`httpx`'s 300-second default).
///
/// This is an inactivity window, not a total request deadline. A streaming
/// response may legitimately run longer than this as long as chunks keep
/// arriving.
pub const STREAM_TIMEOUT: Duration = Duration::from_secs(300);
/// `_SSE_TERMINAL_DRAIN_TIMEOUT_SECONDS`: the bounded tail read after a
/// delivered terminal event.
pub const TERMINAL_DRAIN_TIMEOUT: Duration = Duration::from_secs(1);
/// The OpenAI SDK appends `/responses` to its `.../v1` base URL.
pub const RESPONSES_PATH: &str = "/v1/responses";

/// Events that end the read (`ResponsesAPIStreamEvents` terminal values).
pub const TERMINAL_EVENT_TYPES: [&str; 3] = ["response.completed", "error", "response.incomplete"];

/// The collected result of a synchronous chat-shell dispatch.
#[derive(Debug)]
pub struct Collected {
    /// `QueueBasedEmitter.collect`'s accumulated `chunk` content.
    pub content: String,
}

/// One failed dispatch the caller renders as
/// `500 {"detail": "LLM request failed: <message>"}`.
pub struct Failure {
    pub message: String,
    /// The terminal status was already persisted by the failure branch.
    pub persist: bool,
    pub error_code: Option<&'static str>,
}

impl Failure {
    /// The result payload persisted with a classified dispatch failure.
    pub fn result(&self) -> Option<Value> {
        self.error_code
            .map(|code| serde_json::json!({ "error_type": code }))
    }

    /// A failure the dispatcher's `except` branch persists as FAILED.
    pub fn persisted(message: String) -> Self {
        Self {
            message,
            persist: true,
            error_code: None,
        }
    }

    pub fn terminal_persistence(message: &str) -> Self {
        Self {
            message: message.into(),
            persist: false,
            error_code: None,
        }
    }

    /// A transport failure the dispatcher's `except` branch persists as
    /// FAILED with the Source's classified error code
    /// (`ExecutionDispatcher`'s `classify_error` returns `network_error` for
    /// a connection failure, which `collect_completed_result` writes into
    /// `result.error_type`).
    pub fn network(message: String) -> Self {
        Self {
            message,
            persist: true,
            error_code: Some("network_error"),
        }
    }
}

use serde_json::Value;

/// Incremental `data:` frame reader for the chat-shell event stream.
#[derive(Default)]
pub struct SseFrames {
    buffer: Vec<u8>,
}

impl SseFrames {
    /// Append a transport chunk and return every complete event JSON value.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Value> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some((end, delimiter)) = next_frame(&self.buffer) {
            let frame: Vec<u8> = self.buffer.drain(..end + delimiter).collect();
            if let Some(event) = parse_frame(&frame[..end]) {
                events.push(event);
            }
        }
        events
    }
}

/// Locate the end of the next frame and its delimiter length.
fn next_frame(buffer: &[u8]) -> Option<(usize, usize)> {
    let mut index = 0;
    while index < buffer.len() {
        if buffer[index] == b'\n' {
            if buffer.get(index + 1) == Some(&b'\n') {
                return Some((index, 2));
            }
            if buffer.get(index + 1) == Some(&b'\r') && buffer.get(index + 2) == Some(&b'\n') {
                return Some((index, 3));
            }
        }
        index += 1;
    }
    None
}

/// Join one frame's `data:` lines and decode them.
pub fn parse_frame(frame: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(frame).ok()?;
    let mut data = String::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
    }
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    serde_json::from_str(&data).ok()
}
