//! FastAPI-compatible error responses for `http-server`.
//!
//! Ported from the reference implementation's `src/http_compat.rs`. The source
//! service is FastAPI: failures render as JSON `{"detail": ...}` bodies (or the
//! 422 validation array) with the source's status codes. The platform
//! `http-server` `ApiError` produces `{"error": ...}` instead, so business
//! methods return [`FastApiError`] and map it through [`IntoHttpError`] to keep
//! the recorded response bodies byte-compatible.

use brz_http_server::{EphemeralBytesArena, HeaderBlock, IntoHttpError, Response, StatusCode};

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
    Detail {
        detail: String,
    },
    Validation {
        detail: Box<serde_json::value::RawValue>,
    },
    Custom(Box<serde_json::value::RawValue>),
}

/// The application's own error envelope for unhandled exceptions
/// (`app.core.exceptions.python_exception_handler`).
#[derive(Debug, serde::Serialize)]
struct AppErrorBody {
    error_code: u16,
    detail: &'static str,
}

impl FastApiError {
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

    /// Attaches one extra response header to this error.
    #[must_use]
    pub fn with_header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }

    /// `422` with FastAPI's validation-error array body (`detail` is the array
    /// of `{type, loc, msg, input}` entries).
    ///
    /// # Panics
    ///
    /// Panics when `detail` is not representable as JSON.
    #[must_use]
    pub fn validation(detail: impl serde::Serialize) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            body: ErrorBody::Validation {
                detail: serde_json::value::to_raw_value(&detail)
                    .expect("validation detail serializes"),
            },
            headers: Vec::new(),
        }
    }

    /// `500 {"error_code": 500, "detail": "Internal server error"}`.
    ///
    /// The application registers a catch-all handler for every unhandled
    /// exception (`app.core.exceptions.python_exception_handler`), so a
    /// failure escaping a dependency does **not** use FastAPI's default body.
    #[must_use]
    pub fn unhandled_exception() -> Self {
        Self::json_body(
            StatusCode::INTERNAL_SERVER_ERROR,
            AppErrorBody {
                error_code: 500,
                detail: "Internal server error",
            },
        )
    }

    /// A body that is already a JSON value (custom payload shapes).
    ///
    /// # Panics
    ///
    /// Panics when `body` is not representable as JSON.
    #[must_use]
    pub fn json_body(status: StatusCode, body: impl serde::Serialize) -> Self {
        Self {
            status,
            body: ErrorBody::Custom(
                serde_json::value::to_raw_value(&body).expect("error body serializes"),
            ),
            headers: Vec::new(),
        }
    }

    /// The mapped status code.
    #[must_use]
    pub fn status(&self) -> StatusCode {
        self.status
    }

    /// The serialized validation-error `detail` value (422 responses).
    ///
    /// # Panics
    ///
    /// Panics when a string body cannot be serialized, which cannot happen for
    /// a Rust `String`.
    #[must_use]
    pub fn validation_detail(&self) -> String {
        match &self.body {
            ErrorBody::Detail { detail } => {
                serde_json::to_string(detail).expect("string serializes")
            }
            ErrorBody::Validation { detail } => detail.get().to_owned(),
            ErrorBody::Custom(body) => {
                #[derive(serde::Deserialize)]
                struct Detail<'a> {
                    #[serde(borrow)]
                    detail: Option<&'a serde_json::value::RawValue>,
                }
                serde_json::from_str::<Detail<'_>>(body.get())
                    .ok()
                    .and_then(|body| body.detail)
                    .map_or_else(|| "null".to_owned(), |detail| detail.get().to_owned())
            }
        }
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
        for (name, value) in &self.headers {
            let mut block = arena.alloc(name.len() + value.len() + 4);
            block.extend_from_slice(name.as_bytes());
            block.extend_from_slice(b": ");
            block.extend_from_slice(value.as_bytes());
            block.extend_from_slice(b"\r\n");
            if let Ok(header) = HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use brz_http_server::{EphemeralBytesArena, ResponseBody};

    use super::*;

    /// Renders the error and returns the exact body bytes a client receives.
    fn rendered(error: FastApiError) -> String {
        let arena = EphemeralBytesArena::new(1024);
        let response = error.into_http_error(&arena);
        match response.body() {
            ResponseBody::Arena(bytes) => {
                String::from_utf8(bytes.as_ref().to_vec()).expect("error body is UTF-8")
            }
            other => panic!("expected an arena body, got {other:?}"),
        }
    }

    #[test]
    fn detail_body_serializes_like_fastapi() {
        let error = FastApiError::not_found("Skill not found");
        assert_eq!(error.status(), StatusCode::NOT_FOUND);
        assert_eq!(rendered(error), r#"{"detail":"Skill not found"}"#);
    }

    #[test]
    fn unauthorized_carries_bearer_challenge() {
        let error = FastApiError::unauthorized("Could not validate credentials");
        assert_eq!(error.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            error.headers,
            vec![("www-authenticate", "Bearer".to_string())]
        );
        assert_eq!(
            rendered(error),
            r#"{"detail":"Could not validate credentials"}"#
        );
    }

    #[test]
    fn unhandled_exception_uses_the_application_envelope() {
        let error = FastApiError::unhandled_exception();
        assert_eq!(error.status(), StatusCode::INTERNAL_SERVER_ERROR);
        // Field order matches `python_exception_handler`'s dict.
        assert_eq!(
            rendered(error),
            r#"{"error_code":500,"detail":"Internal server error"}"#
        );
    }

    #[test]
    fn validation_body_keeps_detail_array() {
        let error = FastApiError::validation(serde_json::json!([{
            "type": "missing", "loc": ["query", "state"],
            "msg": "Field required", "input": serde_json::Value::Null
        }]));
        assert_eq!(error.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body: serde_json::Value =
            serde_json::from_str(&rendered(error)).expect("error body is JSON");
        assert!(body["detail"].is_array());
    }
}
