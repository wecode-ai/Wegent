// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! The pooled transport owned by the LLM proxy route.

use anyhow::Context as _;
use brz_http::Client;

use super::UPSTREAM_TIMEOUT;

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
        sync::oneshot,
        task::JoinHandle,
    };

    const FIRST_EVENT: &[u8] = b"data: first\n\n";
    const LAST_EVENT: &[u8] = b"data: last\n\n";

    struct DelayedResponse {
        url: String,
        ready: oneshot::Receiver<()>,
        release: oneshot::Sender<()>,
        server: JoinHandle<()>,
    }

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

    async fn delayed_response(before_headers: bool) -> DelayedResponse {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/upstream", listener.local_addr().unwrap());
        let (ready_tx, ready) = oneshot::channel();
        let (release, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                FIRST_EVENT.len() + LAST_EVENT.len(),
            );
            if !before_headers {
                stream.write_all(head.as_bytes()).await.unwrap();
                stream.write_all(FIRST_EVENT).await.unwrap();
            }
            ready_tx.send(()).unwrap();
            release_rx.await.unwrap();
            if before_headers {
                stream.write_all(head.as_bytes()).await.unwrap();
                stream.write_all(FIRST_EVENT).await.unwrap();
            }
            stream.write_all(LAST_EVENT).await.unwrap();
        });
        DelayedResponse {
            url,
            ready,
            release,
            server,
        }
    }

    async fn assert_upstream_delay(before_headers: bool, advance: Duration, timeout: bool) {
        let DelayedResponse {
            url,
            ready,
            release,
            server,
        } = delayed_response(before_headers).await;
        let http = build_http().unwrap();
        let (reading_tx, reading) = oneshot::channel();
        let request = async move {
            let mut response = http
                .post(url)
                .unwrap()
                .body(b"{}".to_vec())
                .timeout(UPSTREAM_TIMEOUT)
                .send()
                .await?;
            let mut bytes = Vec::new();
            let mut reading_tx = (!before_headers).then_some(reading_tx);
            while let Some(chunk) = response.chunk().await? {
                bytes.extend_from_slice(&chunk);
                if bytes.len() >= FIRST_EVENT.len()
                    && let Some(tx) = reading_tx.take()
                {
                    tx.send(()).unwrap();
                }
            }
            Ok::<_, brz_http::reqwest::Error>(bytes)
        };
        tokio::pin!(request);
        tokio::select! {
            _ = &mut request => panic!("request completed before the server was ready"),
            () = async {
                ready.await.unwrap();
                if !before_headers {
                    reading.await.unwrap();
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
            release.send(()).unwrap();
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
}
