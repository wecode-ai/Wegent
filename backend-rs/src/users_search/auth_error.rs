// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible authentication error responses
//! (`app.core.security.get_current_user` / FastAPI `HTTPException`).
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

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

    /// Missing or malformed bearer credential (source OAuth2 scheme).
    pub fn missing_token() -> Self {
        Self::invalid_credentials()
    }

    /// `401 "User not activated"` for inactive users.
    pub fn user_not_activated() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "User not activated".to_string(),
        }
    }

    /// Dependency failure: source would surface a 500 for an unusable DB.
    pub fn dependency(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "users database dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
        }
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

impl From<AuthError> for crate::http_compat::FastApiError {
    fn from(error: AuthError) -> Self {
        crate::http_compat::FastApiError::detail(error.status, error.detail)
    }
}
