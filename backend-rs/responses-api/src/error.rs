// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Shared HTTP error shapes for the responses API
//! (`app.api.endpoints.openapi_responses`).
//!
//! The source endpoints combine two failure families: the standard FastAPI
//! `HTTPException` body (`{"detail": ...}`, [`super::http_error::HttpError`])
//! and the slowapi `RateLimitExceeded` handler body
//! (`{"error": "Rate limit exceeded: <amount> per <multiples> <granularity>"}`).
use brz_http_server::StatusCode;

use super::rate_limit::RateLimit;

/// The 429 body slowapi's `RateLimitExceeded` handler emits
/// (`_rate_limit_exceeded_handler`), rendered from the route's decorator limit.
pub fn rate_limit_exceeded(limit: RateLimit) -> RateLimitError {
    RateLimitError {
        status: StatusCode::TOO_MANY_REQUESTS,
        error: format!(
            "Rate limit exceeded: {} per {} {}",
            limit.amount, limit.multiples, limit.granularity
        ),
    }
}

/// The 429 rate-limit failure with its source-specific `{"error": ...}` body
/// (not the FastAPI `{"detail": ...}` shape).
pub struct RateLimitError {
    pub status: StatusCode,
    pub error: String,
}

impl RateLimitError {
    /// The mapped status code.
    #[cfg(test)]
    pub fn status(&self) -> StatusCode {
        self.status
    }
}

impl brz_http_server::IntoHttpError for RateLimitError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        crate::http_compat::FastApiError::json_body(
            self.status,
            serde_json::json!({ "error": self.error }),
        )
        .into_http_error(arena)
    }
}

/// One of the endpoints' failure shapes: the rate-limit 429 body or the
/// standard FastAPI error.
pub enum ResponseError {
    RateLimit(RateLimitError),
    Http(super::http_error::HttpError),
}

impl From<RateLimitError> for ResponseError {
    fn from(error: RateLimitError) -> Self {
        Self::RateLimit(error)
    }
}

impl From<super::http_error::HttpError> for ResponseError {
    fn from(error: super::http_error::HttpError) -> Self {
        Self::Http(error)
    }
}

impl From<super::auth_error::AuthError> for ResponseError {
    fn from(error: super::auth_error::AuthError) -> Self {
        Self::Http(error.into())
    }
}

impl brz_http_server::IntoHttpError for ResponseError {
    fn into_http_error(
        self,
        arena: &brz_http_server::EphemeralBytesArena,
    ) -> brz_http_server::Response {
        match self {
            Self::RateLimit(error) => error.into_http_error(arena),
            Self::Http(error) => error.into_http_error(arena),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_body_matches_the_source_handler_format() {
        let limit = RateLimit::parse("10000/minute").expect("parseable limit");
        let error = rate_limit_exceeded(limit);
        assert_eq!(error.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error.error, "Rate limit exceeded: 10000 per 1 minute");
    }
}
