// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The pooled transport owned by the LLM proxy route.

use anyhow::Context as _;
use brz_http::Client;

use super::UPSTREAM_TIMEOUT;

/// Builds the route's pooled client with LLM phase budgets and the shared TLS trust anchor.
pub(super) fn build_http() -> anyhow::Result<Client> {
    // A per-request total timeout does not override the client's phase timers.
    Client::builder()
        .connect_timeout(UPSTREAM_TIMEOUT)
        .read_timeout(UPSTREAM_TIMEOUT)
        .configure(|builder| match crate::http_trust::trust_anchor() {
            Some(anchor) => builder.add_root_certificate(anchor),
            None => builder,
        })
        .build()
        .context("failed to build the LLM proxy HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm_proxy::UPSTREAM_TIMEOUT;
    use std::{future::poll_fn, task::Poll, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        sync::{mpsc, oneshot},
        task::JoinHandle,
    };

    const FIRST_EVENT: &[u8] = b"data: first\n\n";
    const MIDDLE_EVENT: &[u8] = b"data: middle\n\n";
    const LAST_EVENT: &[u8] = b"data: last\n\n";

    struct DelayedResponse {
        url: String,
        ready: oneshot::Receiver<()>,
        release: mpsc::UnboundedSender<()>,
        server: JoinHandle<()>,
    }

    /// Consumes the full request before the server announces that a timed wait can begin.
    async fn read_request(stream: &mut TcpStream) {
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 1024];
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(count > 0, "request ended before its body");
            bytes.extend_from_slice(&buffer[..count]);
            let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let head = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
            let length: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            if bytes.len() >= end + 4 + length {
                return;
            }
        }
    }

    /// Gates response events individually, optionally holding the headers and first event too.
    async fn delayed_response(
        before_headers: bool,
        events: &'static [&'static [u8]],
    ) -> DelayedResponse {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/upstream", listener.local_addr().unwrap());
        let (ready_tx, ready) = oneshot::channel();
        let (release, mut release_rx) = mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                events.iter().map(|event| event.len()).sum::<usize>(),
            );
            if !before_headers {
                stream.write_all(head.as_bytes()).await.unwrap();
                stream.write_all(events[0]).await.unwrap();
            }
            ready_tx.send(()).unwrap();
            for (index, event) in events.iter().enumerate().skip(usize::from(!before_headers)) {
                release_rx.recv().await.unwrap();
                if index == 0 {
                    stream.write_all(head.as_bytes()).await.unwrap();
                }
                stream.write_all(event).await.unwrap();
            }
        });
        DelayedResponse {
            url,
            ready,
            release,
            server,
        }
    }

    /// Uses the production client policy and reports consumed bytes independently of TCP framing.
    async fn read_upstream_response(
        url: String,
        reading: mpsc::UnboundedSender<usize>,
    ) -> Result<Vec<u8>, brz_http::reqwest::Error> {
        let mut response = build_http()
            .unwrap()
            .post(url)
            .unwrap()
            .body(b"{}".to_vec())
            .timeout(UPSTREAM_TIMEOUT)
            .send()
            .await?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            bytes.extend_from_slice(&chunk);
            reading.send(bytes.len()).unwrap();
        }
        Ok(bytes)
    }

    /// Waits until an entire event has been consumed before advancing virtual time.
    async fn wait_for_bytes(reading: &mut mpsc::UnboundedReceiver<usize>, expected: usize) {
        while reading.recv().await.unwrap() < expected {}
    }

    /// Advances a confirmed header/body wait, then resumes real time before releasing socket I/O.
    async fn assert_upstream_delay(before_headers: bool, advance: Duration, timeout: bool) {
        const EVENTS: &[&[u8]] = &[FIRST_EVENT, LAST_EVENT];
        let DelayedResponse {
            url,
            ready,
            release,
            server,
        } = delayed_response(before_headers, EVENTS).await;
        let (reading_tx, mut reading) = mpsc::unbounded_channel();
        let request = read_upstream_response(url, reading_tx);
        tokio::pin!(request);
        tokio::select! {
            _ = &mut request => panic!("request completed before the server was ready"),
            () = async {
                ready.await.unwrap();
                if !before_headers {
                    wait_for_bytes(&mut reading, FIRST_EVENT.len()).await;
                }
            } => (),
        }
        tokio::time::pause();
        tokio::time::advance(advance).await;
        let result = poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx))).await;
        tokio::time::resume();
        if timeout {
            let Poll::Ready(result) = result else {
                panic!("LLM request exceeded its deadline");
            };
            assert!(result.unwrap_err().is_timeout());
            server.abort();
            assert!(server.await.unwrap_err().is_cancelled());
        } else {
            assert!(
                result.is_pending(),
                "LLM request inherited the attachment timeout"
            );
            for _ in &EVENTS[usize::from(!before_headers)..] {
                release.send(()).unwrap();
            }
            let body = request.await.unwrap();
            assert_eq!(body, [FIRST_EVENT, LAST_EVENT].concat());
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn response_headers_can_arrive_after_the_attachment_read_timeout() {
        assert_upstream_delay(true, Duration::from_secs(121), false).await;
    }

    #[tokio::test]
    async fn stream_chunks_can_arrive_after_the_attachment_read_timeout() {
        assert_upstream_delay(false, Duration::from_secs(121), false).await;
    }

    #[tokio::test]
    async fn upstream_request_deadline_remains_bounded() {
        assert_upstream_delay(true, UPSTREAM_TIMEOUT + Duration::from_secs(1), true).await;
    }

    #[tokio::test]
    async fn upstream_body_deadline_remains_bounded() {
        assert_upstream_delay(false, UPSTREAM_TIMEOUT + Duration::from_secs(1), true).await;
    }

    #[tokio::test]
    /// Resets the read timer midway while retaining the deadline measured from request start.
    async fn active_stream_does_not_reset_the_total_deadline() {
        let DelayedResponse {
            url,
            ready,
            release,
            server,
        } = delayed_response(false, &[FIRST_EVENT, MIDDLE_EVENT, LAST_EVENT]).await;
        let (reading_tx, mut reading) = mpsc::unbounded_channel();
        let request = read_upstream_response(url, reading_tx);
        tokio::pin!(request);
        tokio::select! {
            _ = &mut request => panic!("request completed before its first event"),
            () = async {
                ready.await.unwrap();
                wait_for_bytes(&mut reading, FIRST_EVENT.len()).await;
            } => (),
        }

        tokio::time::pause();
        tokio::time::advance(UPSTREAM_TIMEOUT / 2).await;
        tokio::time::resume();
        release.send(()).unwrap();
        tokio::select! {
            _ = &mut request => panic!("request completed before its middle event"),
            () = wait_for_bytes(&mut reading, FIRST_EVENT.len() + MIDDLE_EVENT.len()) => (),
        }

        // The middle event resets the read timer at 300s, while the request's
        // original deadline must still expire at 600s. Resume real time while
        // exchanging socket data so paused-time auto-advance cannot race I/O.
        tokio::time::pause();
        tokio::time::advance(UPSTREAM_TIMEOUT / 2 + Duration::from_secs(1)).await;
        let result = poll_fn(|cx| Poll::Ready(request.as_mut().poll(cx))).await;
        tokio::time::resume();
        server.abort();
        assert!(server.await.unwrap_err().is_cancelled());
        let Poll::Ready(result) = result else {
            panic!("active LLM stream exceeded its total deadline");
        };
        assert!(result.unwrap_err().is_timeout());
    }
}
