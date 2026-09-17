// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Internal service token verification
//! (`app/services/auth/internal_service_token.py`).
//!
//! Endpoints fail closed when the token is not configured.

/// Verify the `Authorization: Bearer <token>` header against the configured
/// internal service token (`verify_internal_service_token`).
#[allow(clippy::result_large_err)]
pub fn verify_internal_service_token(
    expected_token: &Option<String>,
    authorization: Option<&str>,
) -> Result<(), http_error::HttpError> {
    let Some(expected) = expected_token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
    else {
        return Err(http_error::HttpError::unauthorized(
            "Internal service token is not configured",
        ));
    };
    let Some(header) = authorization else {
        return Err(http_error::HttpError::unauthorized(
            "Missing authentication token",
        ));
    };
    let Some(provided) = header.strip_prefix("Bearer ").map(str::trim) else {
        return Err(http_error::HttpError::unauthorized(
            "Missing authentication token",
        ));
    };
    if !constant_time_eq(provided.as_bytes(), expected.as_bytes()) {
        return Err(http_error::HttpError::unauthorized(
            "Invalid authentication token",
        ));
    }
    Ok(())
}

/// Constant-time byte-string comparison (`hmac.compare_digest`).
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(value: &'static str) -> Option<&'static str> {
        Some(value)
    }

    #[test]
    fn fails_closed_without_configured_token() {
        let error = verify_internal_service_token(&None, header("Bearer anything")).unwrap_err();
        assert_eq!(error.status(), brz_http_server::StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn accepts_matching_bearer_token() {
        let token = Some("test-internal-token".to_string());
        assert!(
            verify_internal_service_token(&token, header("Bearer test-internal-token")).is_ok()
        );
    }

    #[test]
    fn rejects_wrong_token_and_missing_header() {
        let token = Some("test-internal-token".to_string());
        assert!(verify_internal_service_token(&token, header("Bearer wrong")).is_err());
        assert!(verify_internal_service_token(&token, None).is_err());
        assert!(verify_internal_service_token(&token, header("Basic abc")).is_err());
    }
}

pub mod http_error {
    //! HTTP error mapping for the internal chat API.
    //!
    //! Mirrors the source FastAPI `HTTPException` responses: JSON body
    //! `{"detail": ...}` with the mapped status code.

    use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

    /// A mapped HTTP error carrying the source-compatible status and detail.
    #[derive(Debug)]
    pub struct HttpError {
        status: StatusCode,
        detail: String,
        challenge: bool,
    }

    impl HttpError {
        fn new(status: StatusCode, detail: impl Into<String>) -> Self {
            Self {
                status,
                detail: detail.into(),
                challenge: false,
            }
        }

        /// 400 Bad Request.
        pub fn bad_request(detail: &str) -> Self {
            Self::new(StatusCode::BAD_REQUEST, detail)
        }

        /// 404 Not Found.
        pub fn not_found(detail: &str) -> Self {
            Self::new(StatusCode::NOT_FOUND, detail)
        }

        /// 500 Internal Server Error (dependency or unexpected failure).
        pub fn internal(error: brz_mysql::MysqlError) -> Self {
            tracing::error!(%error, "internal chat storage dependency failure");
            Self::new(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }

        /// 401 Unauthorized with the source-compatible WWW-Authenticate header.
        pub fn unauthorized(detail: &str) -> Self {
            Self {
                status: StatusCode::UNAUTHORIZED,
                detail: detail.to_string(),
                challenge: true,
            }
        }

        /// 422 with FastAPI's validation-error array body (`detail` is the
        /// array of `{type, loc, msg, input}` entries).
        pub fn validation(error: crate::http_compat::FastApiError) -> Self {
            Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                detail: error.validation_detail(),
                challenge: false,
            }
        }

        /// Status code of this error.
        #[cfg(test)]
        pub fn status(&self) -> StatusCode {
            self.status
        }
    }

    impl From<HttpError> for crate::http_compat::FastApiError {
        fn from(error: HttpError) -> Self {
            crate::http_compat::FastApiError::detail(error.status, error.detail)
        }
    }

    impl IntoHttpError for HttpError {
        fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
            let mut response = crate::http_compat::FastApiError::detail(self.status, self.detail)
                .into_http_error(arena);
            if self.challenge {
                let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
                block.extend_from_slice(b"www-authenticate: Bearer\r\n");
                if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                    response = response.headers(header);
                }
            }
            response
        }
    }
}
