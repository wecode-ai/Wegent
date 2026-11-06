//! Common protocol error response for local model services.
use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use wegent_protocol::ProtocolError;
use wegent_runtime_logging::log_executor_event;

#[derive(Debug)]
pub struct HttpError {
    pub status: StatusCode,
    pub detail: String,
}

impl From<ProtocolError> for HttpError {
    fn from(error: ProtocolError) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            detail: error.to_string(),
        }
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        log_executor_event(
            "http error response",
            &[
                ("status", self.status.as_u16().to_string()),
                ("detail", self.detail.clone()),
            ],
        );
        (self.status, Json(json!({ "detail": self.detail }))).into_response()
    }
}
