// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Bounded storage errors without signed URLs, secrets or response messages.
use super::UploadBackendError;

pub(super) async fn check_response(
    mut response: brz_http::Response,
    stage: &'static str,
) -> Result<brz_http::Response, UploadBackendError> {
    if response.status().is_success() {
        tracing::debug!(stage, "attachment S3 request succeeded");
        return Ok(response);
    }
    let status = response.status().as_u16();
    let mut body = Vec::new();
    while body.len() < 8192 {
        match response.chunk().await {
            Ok(Some(chunk)) => body.extend_from_slice(&chunk[..chunk.len().min(8192 - body.len())]),
            _ => break,
        }
    }
    let xml = String::from_utf8_lossy(&body);
    let code = super::xml_element(&xml, "Code")
        .filter(|value| {
            value.len() <= 128 && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .unwrap_or("unknown");
    tracing::error!(
        stage,
        status,
        s3_code = code,
        "attachment S3 request failed"
    );
    Err(UploadBackendError)
}

pub(super) fn transport_error(stage: &'static str, error: &brz_http::Error) -> UploadBackendError {
    tracing::error!(
        stage,
        timeout = error.is_timeout(),
        "attachment S3 transport failed"
    );
    UploadBackendError
}

pub(super) fn protocol_error(stage: &'static str, reason: &'static str) -> UploadBackendError {
    tracing::error!(stage, reason, "attachment S3 response invalid");
    UploadBackendError
}
