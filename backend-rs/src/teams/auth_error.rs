// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Error variants for the source `get_current_user` dependency.

use super::http_error::HttpError;

/// Authentication failure mapped to the source HTTP responses.
#[derive(Debug)]
pub enum AuthError {
    /// `401 "Could not validate credentials"`.
    CouldNotValidateCredentials,
    /// `401 "User not activated"`.
    UserNotActivated,
    /// `401 "Not authenticated"` (missing Authorization header).
    NotAuthenticated,
    /// Dependency failure mapped to `500`.
    Dependency(String),
}

impl AuthError {
    pub fn could_not_validate_credentials() -> Self {
        Self::CouldNotValidateCredentials
    }

    pub fn user_not_activated() -> Self {
        Self::UserNotActivated
    }

    pub fn not_authenticated() -> Self {
        Self::NotAuthenticated
    }

    pub fn dependency(error: brz_mysql::MysqlError) -> Self {
        Self::Dependency(error.to_string())
    }
}

impl From<AuthError> for HttpError {
    fn from(error: AuthError) -> HttpError {
        match error {
            AuthError::CouldNotValidateCredentials => HttpError::could_not_validate_credentials(),
            AuthError::UserNotActivated => HttpError::user_not_activated(),
            AuthError::NotAuthenticated => HttpError::not_authenticated(),
            AuthError::Dependency(message) => HttpError::internal(message),
        }
    }
}

impl From<AuthError> for crate::http_compat::FastApiError {
    fn from(error: AuthError) -> Self {
        crate::http_compat::FastApiError::from(HttpError::from(error))
    }
}
