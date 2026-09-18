// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP error mapping for the responses API.
//!
//! Mirrors the source FastAPI `HTTPException` responses: JSON body
//! `{"detail": <message>}` with the mapped status code.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

/// A mapped HTTP error carrying the source-compatible status and detail.
#[derive(Debug)]
pub struct HttpError {
    status: StatusCode,
    detail: String,
}

impl HttpError {
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }

    /// `400 "Invalid response_id format: '<id>'. Expected format:
    /// 'resp_{task_id}'"` (missing `resp_` prefix).
    pub fn invalid_response_id_prefix(response_id: &str) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            format!(
                "Invalid response_id format: '{response_id}'. \
                 Expected format: 'resp_{{task_id}}'"
            ),
        )
    }

    /// `400 "Invalid response_id format: '<id>'"` (non-numeric task id).
    pub fn invalid_response_id_numeric(response_id: &str) -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid response_id format: '{response_id}'"),
        )
    }

    /// `404 "Response '<id>' not found"` (task missing or not accessible).
    pub fn response_not_found(response_id: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            format!("Response '{response_id}' not found"),
        )
    }

    /// `500 "Internal server error"` (dependency failure; the source maps
    /// unhandled exceptions through the global exception handler).
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }
}

impl IntoHttpError for HttpError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        crate::http_compat::FastApiError::detail(self.status, self.detail).into_http_error(arena)
    }
}
