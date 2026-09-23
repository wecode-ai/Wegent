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

#[cfg(test)]
mod tests {
    use brz_http_server::StatusCode;

    use super::*;

    #[test]
    fn authentication_failures_convert_with_the_source_challenge() {
        for (error, detail) in [
            (
                AuthError::CouldNotValidateCredentials,
                "\"Could not validate credentials\"",
            ),
            (AuthError::UserNotActivated, "\"User not activated\""),
            (AuthError::NotAuthenticated, "\"Not authenticated\""),
        ] {
            let converted = crate::http_compat::FastApiError::from(error);
            assert_eq!(converted.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(converted.validation_detail(), detail);
            assert!(
                converted.carries_challenge(),
                "the source 401 always carries WWW-Authenticate: Bearer"
            );
        }
    }

    #[test]
    fn dependency_failure_stays_a_plain_500() {
        let converted =
            crate::http_compat::FastApiError::from(AuthError::Dependency("down".to_string()));
        assert_eq!(converted.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!converted.carries_challenge());
    }
}
