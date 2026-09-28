// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! HTTP error mapping for the loop-item tasks API.
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
    /// A mapped error with an explicit status and detail.
    pub fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }

    /// `404 "Cloud context not found"` (`find_cloud_context`).
    pub fn cloud_context_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "Cloud context not found".to_string(),
        }
    }

    /// `404 "TODO not found"` (loop item and shadow paths).
    pub fn todo_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "TODO not found".to_string(),
        }
    }

    /// `404 "Cloud project not found"` (`require_cloud_project_role`).
    pub fn cloud_project_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "Cloud project not found".to_string(),
        }
    }

    /// `403 "Invalid cloud project role"` (unknown membership role).
    pub fn invalid_cloud_project_role() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            detail: "Invalid cloud project role".to_string(),
        }
    }

    /// `403 "Insufficient permission"` (`has_permission` failure).
    pub fn insufficient_permission() -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            detail: "Insufficient permission".to_string(),
        }
    }

    /// `404 "Linked TODO not found"` (`find_for_runtime_task`).
    pub fn linked_todo_not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            detail: "Linked TODO not found".to_string(),
        }
    }

    /// `500 Internal Server Error` (dependency or unexpected failure).
    pub fn internal(error: brz_mysql::MysqlError) -> Self {
        tracing::error!(%error, "loop-items database dependency failure");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
        }
    }

    /// `500 Internal Server Error` for an unsupported loop-item branch.
    ///
    /// The recorded cloud-context case never reaches the loop-item branch;
    /// a partial `LoopItemResponse` projection would diverge from the source
    /// schema, so this surfaces the unsupported path instead of emitting a
    /// malformed body.
    pub fn internal_unsupported_loop_item() -> Self {
        tracing::error!("cloud-context loop-item branch reached without a recorded projection");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: "Internal server error".to_string(),
        }
    }
}

impl IntoHttpError for HttpError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        crate::http_compat::FastApiError::detail(self.status, self.detail).into_http_error(arena)
    }
}
