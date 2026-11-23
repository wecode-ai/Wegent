// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Source-compatible error responses for
//! `GET /api/attachments/task/{task_id}/all` (FastAPI `HTTPException`
//! bodies from `app.api.endpoints.adapter.attachments.get_all_task_attachments`
//! and its authentication dependency).
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

/// A mapped HTTP error carrying the source-compatible status and detail.
#[derive(Debug)]
pub struct HttpError {
    status: StatusCode,
    detail: &'static str,
    /// Whether the 401 carries `WWW-Authenticate: Bearer` (the source only
    /// sets it on the two invalid-credential HTTPExceptions).
    authenticate: bool,
}

impl HttpError {
    /// `404 "Task not found"` (`task_store.get_by_id` miss).
    pub fn task_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "Task not found",
            authenticate: false,
        }
    }

    /// `403 "Access denied"` (neither owner nor approved member).
    pub fn access_denied() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            detail: "Access denied",
            authenticate: false,
        }
    }

    /// `401 "Could not validate credentials"` with `WWW-Authenticate`.
    pub fn invalid_credentials() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Could not validate credentials",
            authenticate: true,
        }
    }

    /// `401 "Missing authentication credentials"`.
    pub fn missing_credentials() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Missing authentication credentials",
            authenticate: false,
        }
    }

    /// `401 "Invalid or expired API key"` with `WWW-Authenticate`.
    pub fn invalid_api_key() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Invalid or expired API key",
            authenticate: true,
        }
    }

    /// Dependency failure: the source surfaces a 500 for an unusable DB.
    pub fn dependency(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "attachments task/all dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal Server Error",
            authenticate: false,
        }
    }

    /// Status code of this error.
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The mapped detail message.
    pub fn detail(&self) -> &'static str {
        self.detail
    }

    /// Whether the response carries the `WWW-Authenticate: Bearer` header.
    #[cfg(test)]
    pub fn uses_challenge(&self) -> bool {
        self.authenticate
    }
}

impl IntoHttpError for HttpError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let mut response = crate::http_compat::FastApiError::detail(self.status, self.detail)
            .into_http_error(arena);
        if self.authenticate {
            let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
            block.extend_from_slice(b"www-authenticate: Bearer\r\n");
            if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}

impl From<HttpError> for crate::http_compat::FastApiError {
    fn from(error: HttpError) -> Self {
        crate::http_compat::FastApiError::detail(error.status(), error.detail())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_carry_source_statuses() {
        assert_eq!(HttpError::task_not_found().status(), StatusCode::NOT_FOUND);
        assert_eq!(HttpError::access_denied().status(), StatusCode::FORBIDDEN);
        assert_eq!(
            HttpError::missing_credentials().status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(!HttpError::missing_credentials().uses_challenge());
        assert!(HttpError::invalid_credentials().uses_challenge());
        assert!(HttpError::invalid_api_key().uses_challenge());
    }
}
