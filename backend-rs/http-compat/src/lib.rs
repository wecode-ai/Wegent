// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! FastAPI-compatible error responses for `http-server`.
//!
//! The source service is FastAPI: failures render as JSON `{"detail": ...}`
//! bodies (or the 422 validation array) with the source's status codes. The
//! platform `http-server` `ApiError` produces `{"error": ...}` instead, so
//! business methods return [`FastApiError`] and map it through
//! [`IntoHttpError`] to keep the recorded response bodies byte-compatible.
#![deny(unsafe_code)]

use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};

/// A mapped FastAPI-style HTTP failure: status, JSON body, and extra headers.
#[derive(Debug)]
pub struct FastApiError {
    status: StatusCode,
    body: ErrorBody,
    headers: Vec<(&'static str, String)>,
}

#[derive(Debug, serde::Serialize)]
#[serde(untagged)]
enum ErrorBody {
    Detail { detail: String },
    Validation { detail: brz_json::RawJson },
    Custom(brz_json::RawJson),
    Unhandled(UnhandledErrorBody),
}

/// The body of the application's `Exception` handler
/// (`app/core/exceptions.py:python_exception_handler`).
#[derive(Debug, serde::Serialize)]
struct UnhandledErrorBody {
    error_code: u16,
    detail: &'static str,
}

impl FastApiError {
    pub fn detail_message(&self) -> Option<&str> {
        match &self.body {
            ErrorBody::Detail { detail } => Some(detail),
            ErrorBody::Validation { .. } | ErrorBody::Custom(_) | ErrorBody::Unhandled(_) => None,
        }
    }

    /// `<status> {"detail": <message>}` — the default FastAPI error body.
    #[must_use]
    pub fn detail(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody::Detail {
                detail: message.into(),
            },
            headers: Vec::new(),
        }
    }

    /// `401 {"detail": <message>}` with the source's
    /// `WWW-Authenticate: Bearer` header (`HTTPException(401)` mapping in
    /// `app.core.security`).
    #[must_use]
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            body: ErrorBody::Detail {
                detail: message.into(),
            },
            headers: vec![("www-authenticate", "Bearer".to_string())],
        }
    }

    /// `403 {"detail": <message>}`.
    #[must_use]
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::detail(StatusCode::FORBIDDEN, message)
    }

    /// `404 {"detail": <message>}`.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::detail(StatusCode::NOT_FOUND, message)
    }

    /// Attaches one extra response header (for example `Allow`) to this
    /// error. Only the platform router's fallback path needs extra headers.
    #[must_use]
    pub fn with_header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    /// `422` with FastAPI's validation-error array body (`detail` is the
    /// array of `{type, loc, msg, input}` entries).
    #[must_use]
    pub fn validation(detail: impl serde::Serialize) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            body: ErrorBody::Validation {
                detail: brz_json::to_raw_value(&detail).expect("validation detail serializes"),
            },
            headers: Vec::new(),
        }
    }

    /// `422 {"error_code": 422, "detail": "Request parameter validation
    /// failed", "errors": [...]}` — the application's own
    /// `validation_exception_handler` (`app/core/exceptions.py`), which
    /// replaces FastAPI's default body for every request-validation failure.
    #[must_use]
    pub fn request_validation(errors: impl serde::Serialize) -> Self {
        Self::json_body(
            StatusCode::UNPROCESSABLE_ENTITY,
            serde_json::json!({
                "error_code": 422,
                "detail": "Request parameter validation failed",
                "errors": errors,
            }),
        )
    }

    /// `500 {"detail": "Internal Server Error"}`.
    #[must_use]
    pub fn internal() -> Self {
        Self::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
    }

    /// `500 {"error_code": 500, "detail": "Internal server error"}` — the
    /// application's `python_exception_handler` body (`app/core/exceptions.py`),
    /// installed as the app's `Exception` handler. Every failure a route does
    /// not convert into an `HTTPException` renders this shape instead of
    /// [`Self::internal`]. Starlette renders this outside its CORS middleware,
    /// so this response explicitly bypasses the public gateway's CORS policy.
    #[must_use]
    pub fn unhandled() -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            body: ErrorBody::Unhandled(UnhandledErrorBody {
                error_code: 500,
                detail: "Internal server error",
            }),
            headers: Vec::new(),
        }
    }

    /// A body that is already a JSON value (custom payload shapes).
    #[must_use]
    pub fn json_body(status: StatusCode, body: impl serde::Serialize) -> Self {
        Self {
            status,
            body: ErrorBody::Custom(brz_json::to_raw_value(&body).expect("error body serializes")),
            headers: Vec::new(),
        }
    }

    /// The mapped status code.
    #[must_use]
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// Whether this error carries a `WWW-Authenticate` challenge header.
    ///
    /// Endpoint error-mapping tests use this to assert the source's 401
    /// challenge without rendering a response.
    #[must_use]
    pub fn carries_challenge(&self) -> bool {
        self.headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("www-authenticate"))
    }

    /// The serialized validation-error `detail` array (422 responses).
    #[must_use]
    pub fn validation_detail(&self) -> String {
        match &self.body {
            ErrorBody::Detail { detail } => {
                serde_json::to_string(detail).expect("string serializes")
            }
            ErrorBody::Validation { detail } => detail.get().to_owned(),
            ErrorBody::Unhandled(body) => {
                serde_json::to_string(body.detail).expect("string serializes")
            }
            ErrorBody::Custom(body) => {
                #[derive(serde::Deserialize)]
                struct Detail<'a> {
                    #[serde(borrow)]
                    detail: Option<brz_json::RawJsonRef<'a>>,
                }
                serde_json::from_str::<Detail<'_>>(body.get())
                    .ok()
                    .and_then(|body| body.detail)
                    .map_or_else(|| "null".to_owned(), |detail| detail.get().to_owned())
            }
        }
    }

    /// The complete serialized error body, matching the bytes the error
    /// renders to a client. Endpoint error-mapping tests use it to pin the
    /// source's body shape without building a response.
    #[must_use]
    pub fn body_json(&self) -> serde_json::Value {
        serde_json::to_value(&self.body).expect("error body serializes")
    }
}

impl IntoHttpError for FastApiError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let body = serde_json::to_vec(&self.body)
            .unwrap_or_else(|_| b"{\"detail\":\"Internal Server Error\"}".to_vec());
        let mut output = arena.alloc(body.len());
        output.extend_from_slice(&body);
        let mut response =
            Response::bytes(self.status, output.freeze()).content_type("application/json");
        if !self.headers.is_empty() {
            let length = self
                .headers
                .iter()
                .map(|(name, value)| name.len() + value.len() + 4)
                .sum();
            let mut headers = arena.alloc(length);
            for (name, value) in &self.headers {
                let parts = [name.as_bytes(), b": ", value.as_bytes(), b"\r\n"];
                let mut field = arena.alloc(name.len() + value.len() + 4);
                for part in parts {
                    field.extend_from_slice(part);
                }
                if brz_http_server::HeaderBlock::new(field.freeze()).is_ok() {
                    for part in parts {
                        headers.extend_from_slice(part);
                    }
                }
            }
            if !headers.is_empty()
                && let Ok(headers) = brz_http_server::HeaderBlock::new(headers.freeze())
            {
                response = response.headers(headers);
            }
        }
        if matches!(self.body, ErrorBody::Unhandled(_)) {
            response.without_cors()
        } else {
            response
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detail_body_serializes_like_fastapi() {
        let error = FastApiError::not_found("Skill not found");
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&serde_json::to_vec(&error.body).unwrap())
                .unwrap(),
            serde_json::json!({"detail": "Skill not found"})
        );
    }

    #[test]
    fn unhandled_body_matches_the_application_exception_handler() {
        let error = FastApiError::unhandled();
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&serde_json::to_vec(&error.body).unwrap())
                .unwrap(),
            serde_json::json!({"error_code": 500, "detail": "Internal server error"})
        );
    }

    #[test]
    fn unauthorized_carries_bearer_challenge() {
        let error = FastApiError::unauthorized("Could not validate credentials");
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            error.headers,
            vec![("www-authenticate", "Bearer".to_string())]
        );
    }

    #[test]
    fn validation_body_keeps_detail_array() {
        let error = FastApiError::validation(serde_json::json!([{
            "type": "missing", "loc": ["query", "state"],
            "msg": "Field required", "input": serde_json::Value::Null
        }]));
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            serde_json::from_slice::<serde_json::Value>(&serde_json::to_vec(&error.body).unwrap())
                .unwrap()["detail"]
                .is_array()
        );
    }
}

pub mod content_type;
pub mod fallback;

/// The source's FastAPI `CORSMiddleware` returns before installing its
/// response wrapper when the request carries no `Origin` header, so such a
/// response gets neither CORS permissions nor `Vary: Origin`
/// (`starlette/middleware/cors.py:80-93`). The gateway boundary varies by
/// origin unconditionally, so render a headerless response outside it to keep
/// the source's headers. Requests with an `Origin` retain the configured
/// policy.
pub fn source_cors(response: Response, origin: Option<&str>) -> Response {
    fallback::source_cors(response, origin.is_none())
}
