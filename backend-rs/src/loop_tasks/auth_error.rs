// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible authentication error responses
//! (`app.core.security.get_current_user_jwt_apikey_tasktoken` /
//! FastAPI `HTTPException`).
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

use super::http_error::HttpError;

/// A mapped HTTP error carrying the source-compatible status and detail.
#[derive(Debug)]
pub struct AuthError {
    status: StatusCode,
    detail: String,
}

impl AuthError {
    /// `401 "Could not validate credentials"` with `WWW-Authenticate: Bearer`.
    pub fn invalid_credentials() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Could not validate credentials".to_string(),
        }
    }

    /// Missing credential: the source raises the same 401 detail.
    pub fn missing_credentials() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Missing authentication credentials".to_string(),
        }
    }

    /// `401 "Invalid or expired API key"`.
    pub fn invalid_api_key() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Invalid or expired API key".to_string(),
        }
    }

    /// Dependency failure: the source surfaces a 500 for an unusable DB.
    pub fn dependency(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "authentication database dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
        }
    }

    /// The mapped status code.
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The mapped detail message.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl IntoHttpError for AuthError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let mut response = crate::http_compat::FastApiError::detail(self.status, self.detail)
            .into_http_error(arena);
        let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
        block.extend_from_slice(b"www-authenticate: Bearer\r\n");
        if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
            response = response.headers(header);
        }
        response
    }
}

impl From<AuthError> for HttpError {
    fn from(error: AuthError) -> HttpError {
        HttpError::new(error.status(), error.detail().to_string())
    }
}
