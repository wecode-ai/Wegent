// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Authentication errors for
//! `app.core.security.get_current_user_flexible` (`get_auth_context`).
//!
//! All failures are source-compatible `401`/`400` responses with
//! `{"detail": ...}` bodies.
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

use super::http_error::HttpError;

/// Authentication failure mapped to the source HTTP response.
#[derive(Debug)]
pub enum AuthError {
    /// `401 "API key is required"` with `WWW-Authenticate: Bearer`.
    ApiKeyRequired,
    /// `401 "Invalid API key"`.
    InvalidApiKey,
    /// `401 "API key has expired"`.
    ApiKeyExpired,
    /// `401 "User not found or inactive"`.
    UserNotFoundOrInactive,
    /// `400 "Username is required for service key authentication..."`.
    UsernameRequired,
    /// `400 "Username can only contain letters, numbers, underscores, and
    /// hyphens"`.
    InvalidUsernameFormat,
    /// `401 "User '<name>' is inactive"`.
    UserInactive(String),
    /// `401 "Invalid authentication credentials"` (unknown key type).
    InvalidAuthenticationCredentials,
    /// `401 "Could not validate credentials"` (JWT fallback failure).
    #[allow(dead_code)]
    CouldNotValidateCredentials,
    /// Dependency failure mapped to `500`.
    Dependency(String),
}

impl AuthError {
    pub fn dependency(error: brz_mysql::MysqlError) -> Self {
        Self::Dependency(error.to_string())
    }

    fn into_mapped_error(self) -> HttpError {
        match self {
            Self::ApiKeyRequired => HttpError::new(StatusCode::UNAUTHORIZED, "API key is required"),
            Self::InvalidApiKey => HttpError::new(StatusCode::UNAUTHORIZED, "Invalid API key"),
            Self::ApiKeyExpired => HttpError::new(StatusCode::UNAUTHORIZED, "API key has expired"),
            Self::UserNotFoundOrInactive => {
                HttpError::new(StatusCode::UNAUTHORIZED, "User not found or inactive")
            }
            Self::UsernameRequired => HttpError::new(
                StatusCode::BAD_REQUEST,
                "Username is required for service key authentication \
                 (use wegent-username header)",
            ),
            Self::InvalidUsernameFormat => HttpError::new(
                StatusCode::BAD_REQUEST,
                "Username can only contain letters, numbers, underscores, \
                 and hyphens",
            ),
            Self::UserInactive(name) => HttpError::new(
                StatusCode::UNAUTHORIZED,
                format!("User '{name}' is inactive"),
            ),
            Self::InvalidAuthenticationCredentials => HttpError::new(
                StatusCode::UNAUTHORIZED,
                "Invalid authentication credentials",
            ),
            Self::CouldNotValidateCredentials => {
                HttpError::new(StatusCode::UNAUTHORIZED, "Could not validate credentials")
            }
            Self::Dependency(message) => HttpError::internal(message),
        }
    }
}

impl From<AuthError> for HttpError {
    fn from(error: AuthError) -> HttpError {
        error.into_mapped_error()
    }
}

impl IntoHttpError for AuthError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let is_api_key_required = matches!(self, AuthError::ApiKeyRequired);
        let is_unauthorized = !is_api_key_required
            && matches!(
                self,
                AuthError::InvalidApiKey
                    | AuthError::ApiKeyExpired
                    | AuthError::UserNotFoundOrInactive
                    | AuthError::UserInactive(_)
                    | AuthError::InvalidAuthenticationCredentials
                    | AuthError::CouldNotValidateCredentials
            );
        let mut response = HttpError::from(self).into_http_error(arena);
        if is_api_key_required || is_unauthorized {
            let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
            block.extend_from_slice(b"www-authenticate: Bearer\r\n");
            if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}
