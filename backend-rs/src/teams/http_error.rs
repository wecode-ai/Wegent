// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP error mapping for the teams API.
//!
//! Mirrors the source FastAPI `HTTPException` responses: JSON body
//! `{"detail": ...}` with the mapped status code.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

/// A mapped HTTP error carrying the source-compatible status and detail.
#[derive(Debug)]
pub struct HttpError {
    status: StatusCode,
    detail: String,
}

impl HttpError {
    /// `401 "Could not validate credentials"` (`verify_token` /
    /// `get_current_user` failures), with `WWW-Authenticate: Bearer`.
    pub fn could_not_validate_credentials() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Could not validate credentials".to_string(),
        }
    }

    /// `401 "User not activated"` (inactive user), with
    /// `WWW-Authenticate: Bearer`.
    pub fn user_not_activated() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "User not activated".to_string(),
        }
    }

    /// `401 "Not authenticated"` (missing Authorization header).
    pub fn not_authenticated() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            detail: "Not authenticated".to_string(),
        }
    }

    /// `422 "none is not an allowed value"` (invalid query parameter).
    pub fn invalid_query_parameter() -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            detail: "Input should be a valid integer, unable to parse string as an integer"
                .to_string(),
        }
    }

    /// `422` for a query parameter outside its source `Literal` set.
    ///
    /// FastAPI renders the expected values as a single quoted list; the
    /// error body shape here stays the endpoint's `{"detail": <string>}`
    /// convention.
    pub fn invalid_literal_parameter(parameter: &str, allowed: &[&str]) -> Self {
        let expected = allowed
            .iter()
            .map(|value| format!("'{value}'"))
            .collect::<Vec<String>>()
            .join(", ");
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            detail: format!("Input should be {expected} ({parameter})"),
        }
    }

    /// `404 "Team not found"` / `403 "Access denied to this team"` mapped
    /// from the source `HTTPException(status_code, detail)` calls in
    /// `team_kinds_service.get_team_skills`.
    pub fn not_found(detail: &str) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: detail.to_string(),
        }
    }

    /// `403 "Access denied to this team"`.
    pub fn forbidden(detail: &str) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            detail: detail.to_string(),
        }
    }

    /// `500 Internal Server Error` (dependency or unexpected failure).
    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "teams database dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
        }
    }

    /// Status code of this error.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The mapped detail message.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl IntoHttpError for HttpError {
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

impl From<HttpError> for crate::http_compat::FastApiError {
    fn from(error: HttpError) -> Self {
        crate::http_compat::FastApiError::detail(error.status(), error.detail())
    }
}
