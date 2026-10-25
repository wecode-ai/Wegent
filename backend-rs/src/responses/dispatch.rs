// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Process-owned background dispatch for the responses create flow
//! (`openapi_responses.py:_create_non_streaming_response_unified` /
//! `_create_streaming_response_unified` + `execution/dispatcher.py`).
//!
//! The source fires the executor-manager and chat-shell dispatches with
//! `asyncio.create_task(...)`, returning the create response immediately. That
//! background work is process-owned, so it runs on one startup-owned worker with
//! a bounded queue: the create handler only enqueues a job, and the worker
//! (spawned once when [`ResponsesDispatch::spawn`] runs at startup) owns the
//! retained HTTP client and every outbound request. The queue bounds the number
//! of in-flight jobs; a full queue drops the job with a warning rather than
//! blocking the request path.
use std::time::Duration;

use brz_http::Client as HttpClient;
use serde_json::Value;
use tokio::sync::mpsc;

/// `httpx`'s 300-second executor/chat-shell timeout.
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(300);
/// The bounded dispatch queue depth.
const QUEUE_DEPTH: usize = 256;

/// One background dispatch the create flow hands to the worker.
pub enum DispatchJob {
    /// `_dispatch_http_callback`: `POST {target}/v1/responses` with
    /// `stream=false, background=true`; the acknowledgement is logged only.
    Executor { url: String, body: Value },
    /// `_dispatch_sse`: `POST {chat_shell}/v1/responses` with `stream=true` and
    /// the `X-Request-ID` propagation header; the stream is drained.
    ChatShell {
        url: String,
        request_id: String,
        body: Value,
    },
}

/// The startup-owned responses dispatch worker.
pub struct ResponsesDispatch {
    sender: mpsc::Sender<DispatchJob>,
}

impl ResponsesDispatch {
    /// Spawn the single process-owned worker. Called once at startup.
    #[must_use]
    pub fn spawn() -> Self {
        let (sender, mut receiver) = mpsc::channel::<DispatchJob>(QUEUE_DEPTH);
        tokio::spawn(async move {
            // The source's OpenAI/httpx client keeps a 300-second per-read
            // timeout for both dispatch kinds. `brz-http`'s 400 ms default
            // per-read timeout would abort the chat-shell SSE drain at its
            // first recorded inter-chunk gap.
            let http = match HttpClient::builder().read_timeout(DISPATCH_TIMEOUT).build() {
                Ok(http) => http,
                Err(error) => {
                    tracing::error!(%error, "failed to build the responses dispatch client");
                    return;
                }
            };
            while let Some(job) = receiver.recv().await {
                run(&http, job).await;
            }
        });
        Self { sender }
    }

    /// Enqueue one dispatch. A full queue drops the job with a warning so the
    /// request path never blocks on the worker.
    pub async fn submit(&self, job: DispatchJob) {
        if let Err(error) = self.sender.send(job).await {
            tracing::warn!(%error, "responses dispatch queue is closed; dropping the job");
        }
    }
}

/// Perform one dispatch against the retained client.
async fn run(http: &HttpClient, job: DispatchJob) {
    match job {
        DispatchJob::Executor { url, body } => {
            let Ok(request) = http.post(&url) else {
                tracing::warn!(%url, "failed to build the executor dispatch request");
                return;
            };
            let request = request
                .header("content-type", "application/json")
                .header("accept", crate::responses::create::dispatch::OPENAI_ACCEPT)
                .header(
                    "authorization",
                    crate::responses::create::dispatch::OPENAI_DUMMY_AUTHORIZATION,
                )
                .json(&body);
            match request.timeout(DISPATCH_TIMEOUT).send().await {
                Ok(response) => {
                    tracing::info!(%url, status = %response.status(), "executor dispatch acknowledged")
                }
                Err(error) => {
                    tracing::warn!(%url, %error, "executor dispatch failed (fire-and-forget)")
                }
            }
        }
        DispatchJob::ChatShell {
            url,
            request_id,
            body,
        } => {
            let Ok(request) = http.post(&url) else {
                tracing::warn!(%url, "failed to build the chat-shell dispatch request");
                return;
            };
            let request = request
                .header("content-type", "application/json")
                .header("accept", crate::responses::create::dispatch::OPENAI_ACCEPT)
                .header(
                    "authorization",
                    crate::responses::create::dispatch::OPENAI_DUMMY_AUTHORIZATION,
                )
                .header("X-Request-ID", request_id.as_str())
                .json(&body);
            match request.timeout(DISPATCH_TIMEOUT).send().await {
                Ok(mut response) => {
                    // Drain the stream to drive the upstream to completion.
                    while matches!(response.chunk().await, Ok(Some(chunk)) if !chunk.is_empty()) {}
                }
                Err(error) => {
                    tracing::warn!(%url, %error, "chat-shell dispatch failed (streaming)")
                }
            }
        }
    }
}
