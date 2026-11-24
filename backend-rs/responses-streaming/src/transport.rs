// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::time::Duration;

use brz_http::Client as HttpClient;
use serde_json::Value;

use crate::sse_protocol::TERMINAL_DRAIN_TIMEOUT;

pub fn stream_request(
    client: &HttpClient,
    url: &str,
    body: &Value,
    request_id: &str,
) -> brz_http::Result<brz_http::Request> {
    let request = client
        .post(url)?
        .header("content-type", "application/json")
        .header("accept", super::openai_client::OPENAI_ACCEPT)
        .header("X-Request-ID", request_id)
        .json(body);
    // The Source client identity (`AsyncOpenAI`) on the streaming path; the
    // executor-manager dispatch applies the same shared set.
    super::package_runtime::authorize(
        super::openai_client::apply_openai_client_headers(request),
        url,
    )
    .build()
}

/// `_drain_terminal_stream`: finish the HTTP response framing after a
/// delivered terminal event by reading the remaining body for up to one
/// second. Read errors are ignored because the terminal state is already
/// persisted and delivered.
pub async fn drain_terminal_stream(response: &mut brz_http::Response) {
    let drain = async { while let Ok(Some(_)) = response.chunk().await {} };
    let _ = tokio::time::timeout(TERMINAL_DRAIN_TIMEOUT, drain).await;
}

/// Render a stream transport failure without hiding an inactivity timeout
/// behind reqwest's generic body-decode message.
pub fn stream_transport_error(error: &brz_http::Error, read_timeout: Duration) -> String {
    if error.is_timeout() {
        format!(
            "Chat Shell SSE stream read timed out after {}s without data",
            read_timeout.as_secs()
        )
    } else {
        error.to_string()
    }
}
