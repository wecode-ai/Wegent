// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP error mapping shared by the remote-workspace endpoint.
//!
//! Mirrors the source `fastapi.HTTPException` responses: JSON body
//! `{"detail": <message>}` with the mapped status code, and the
//! `WWW-Authenticate: Bearer` header on 401.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    detail: String,
}

impl ApiError {
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }

    pub(crate) fn detail(&self) -> &str {
        &self.detail
    }

    pub(crate) fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }

    pub(crate) fn bad_request(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, detail)
    }

    pub(crate) fn unauthorized(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, detail)
    }

    pub(crate) fn not_found(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, detail)
    }

    pub(crate) fn conflict(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, detail)
    }

    pub(crate) fn service_unavailable(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, detail)
    }

    pub(crate) fn bad_gateway(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, detail)
    }

    pub(crate) fn internal(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, detail)
    }
}

/// The chain's MySQL failure mapping: the driver error is logged and the
/// response is the source's `HTTPException(500, "database query failed")`.
pub(crate) fn database_query_failed(error: brz_mysql::MysqlError) -> ApiError {
    tracing::warn!(%error, "[remote_workspace] mysql query failed");
    ApiError::internal("database query failed")
}

impl IntoHttpError for ApiError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let mut response = crate::http_compat::FastApiError::detail(self.status, self.detail)
            .into_http_error(arena);
        if self.status == StatusCode::UNAUTHORIZED {
            let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
            block.extend_from_slice(b"www-authenticate: Bearer\r\n");
            if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}

/// The error's `detail` payload parsed as JSON (test-only projection for
/// asserting FastAPI 422 validation bodies, whose detail is a JSON array).
#[cfg(test)]
pub(crate) fn detail_of(error: &ApiError) -> serde_json::Value {
    serde_json::from_str(&error.detail).unwrap_or(serde_json::Value::Null)
}
