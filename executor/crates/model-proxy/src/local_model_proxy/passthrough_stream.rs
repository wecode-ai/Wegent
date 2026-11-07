// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use std::pin::Pin;

use super::{
    append_stream_utf8, is_responses_terminal_event, responses_failed_event, take_sse_block,
};

struct State<S> {
    stream: Pin<Box<S>>,
    pending: String,
    utf8: Vec<u8>,
    terminal_seen: bool,
    finished: bool,
}

impl<S> State<S> {
    fn inspect(&mut self, bytes: &Bytes) {
        if append_stream_utf8(&mut self.pending, &mut self.utf8, bytes).is_err() {
            self.pending.clear();
            self.utf8.clear();
        }
        while let Some(event) = take_sse_block(&mut self.pending) {
            self.terminal_seen |= is_responses_terminal_event(&event);
        }
    }

    fn finish(&mut self, message: &str) -> Option<Bytes> {
        self.finished = true;
        self.terminal_seen |= is_responses_terminal_event(&self.pending);
        if self.terminal_seen {
            return None;
        }
        let mut failure = b"\n\n".to_vec();
        failure.extend_from_slice(&responses_failed_event(message));
        Some(Bytes::from(failure))
    }
}

/// Forward original chunks; synthesize a failure only when no terminal arrived.
pub(super) fn guard<S, E>(stream: S) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: Send + 'static,
{
    let state = State {
        stream: Box::pin(stream),
        pending: String::new(),
        utf8: Vec::new(),
        terminal_seen: false,
        finished: false,
    };
    futures_util::stream::unfold(state, |mut state| async move {
        if state.finished {
            return None;
        }
        let bytes = match state.stream.next().await {
            Some(Ok(bytes)) => {
                state.inspect(&bytes);
                bytes
            }
            Some(Err(_)) => state.finish("Upstream Responses stream read failed")?,
            None => state.finish("Upstream Responses stream ended before a terminal event")?,
        };
        Some((Ok(bytes), state))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn collect(chunks: Vec<Result<Bytes, std::io::Error>>) -> Vec<u8> {
        guard(futures_util::stream::iter(chunks))
            .collect::<Vec<_>>()
            .await
            .into_iter()
            .flat_map(|chunk| chunk.expect("guard reports failures as SSE events"))
            .collect()
    }

    #[tokio::test]
    async fn terminal_events_preserve_original_bytes() {
        for terminal in [
            "response.completed",
            "response.failed",
            "response.incomplete",
        ] {
            let payload = format!("event: {terminal}\r\ndata: {{\"type\":\"{terminal}\",\"response\":{{\"id\":\"id/slash\",\"extension\":\"思考\"}}}}\r\n\r\n");
            let chunks = payload
                .bytes()
                .map(|byte| Ok(Bytes::from(vec![byte])))
                .collect();

            assert_eq!(collect(chunks).await, payload.as_bytes());
        }
    }

    #[tokio::test]
    async fn premature_eof_appends_one_failure_after_unchanged_payload() {
        let payload = b"data: {\"type\":\"provider.extension\",\"opaque\":true}\n\n";
        let output = collect(vec![Ok(Bytes::from_static(payload))]).await;

        assert!(output.starts_with(payload));
        let suffix = std::str::from_utf8(&output[payload.len()..]).unwrap();
        assert!(suffix.contains("response.failed"));
        assert!(suffix.contains("ended before a terminal event"));
    }

    #[tokio::test]
    async fn done_marker_without_a_responses_terminal_event_is_still_incomplete() {
        let payload = b"data: [DONE]\n\n";
        let output = collect(vec![Ok(Bytes::from_static(payload))]).await;

        assert!(output.starts_with(payload));
        assert!(std::str::from_utf8(&output[payload.len()..])
            .unwrap()
            .contains("response.failed"));
    }

    #[tokio::test]
    async fn read_error_emits_a_failure_without_transport_diagnostics() {
        let output = collect(vec![Err(std::io::Error::other(
            "private transport diagnostic",
        ))])
        .await;
        let text = std::str::from_utf8(&output).unwrap();

        assert!(text.contains("response.failed"));
        assert!(!text.contains("private transport diagnostic"));
    }

    #[tokio::test]
    async fn late_error_after_terminal_does_not_emit_another_failure() {
        let payload = b"data: {\"type\":\"response.completed\"}\n\n";
        let output = collect(vec![
            Ok(Bytes::from_static(payload)),
            Err(std::io::Error::other("late reset")),
        ])
        .await;

        assert_eq!(output, payload);
    }

    #[tokio::test]
    async fn terminal_without_a_blank_tail_preserves_original_bytes() {
        let payload = b"data: {\"type\":\"response.completed\",\"response\":{}}";

        assert_eq!(
            collect(vec![Ok(Bytes::from_static(payload))]).await,
            payload
        );
    }
}
