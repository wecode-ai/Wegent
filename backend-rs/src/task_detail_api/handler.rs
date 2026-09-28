// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Handler for `GET /api/tasks/{task_id}`
//! (`app.api.endpoints.adapter.tasks.get_task`).
use brz_http_server::{EphemeralBytesArena, IntoHttpError, Response, StatusCode};
use serde::Deserialize;
use tracing::warn;

use super::assembly::{TaskNotFound, build_task_detail};
use super::models::TaskDetailResponse;
use crate::state::AppState;

/// `ClientOriginQuery`: optional `client_origin` query parameter restricted
/// to the supported origins; absent means `frontend`.
#[derive(Debug, Deserialize)]
pub(crate) struct TaskDetailQuery {
    #[serde(default)]
    client_origin: Option<String>,
}

impl TaskDetailQuery {
    fn validated_origin(&self) -> Result<String, ApiError> {
        match self.client_origin.as_deref() {
            None | Some("frontend") => Ok("frontend".to_owned()),
            Some("wework") => Ok("wework".to_owned()),
            Some(_) => Err(ApiError {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                detail: "Invalid client_origin".to_owned(),
                www_authenticate: false,
            }),
        }
    }
}

/// Error response carrying the source `HTTPException` JSON body and, for
/// 401, the `WWW-Authenticate: Bearer` header.
pub(crate) struct ApiError {
    status: StatusCode,
    detail: String,
    www_authenticate: bool,
}

impl std::fmt::Debug for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.detail.as_str())
    }
}

impl IntoHttpError for ApiError {
    fn into_http_error(self, arena: &EphemeralBytesArena) -> Response {
        let mut response = crate::http_compat::FastApiError::detail(self.status, self.detail)
            .into_http_error(arena);
        if self.www_authenticate {
            let mut block = arena.alloc("www-authenticate: Bearer\r\n".len());
            block.extend_from_slice(b"www-authenticate: Bearer\r\n");
            if let Ok(header) = brz_http_server::HeaderBlock::new(block.freeze()) {
                response = response.headers(header);
            }
        }
        response
    }
}

/// Loads one task detail and maps the source's failures.
///
/// The success value is the typed `TaskDetail` document; the endpoint's JSON
/// framing belongs to the route, which returns it through the SDK's JSON
/// reply adaptor (`application/json`, like FastAPI's `JSONResponse`).
pub(crate) async fn task_detail(
    state: &AppState,
    task_id: i64,
    client_origin: Option<&str>,
    user: &crate::auth::SessionUser,
) -> Result<TaskDetailResponse, ApiError> {
    let query = TaskDetailQuery {
        client_origin: client_origin.map(str::to_owned),
    };
    let client_origin = query.validated_origin()?;

    let user_id = i64::from(user.id);

    // `task_kinds_service.get_task_detail`; a missing/inaccessible task
    // raises the source 404.
    let outcome = match build_task_detail(state, task_id, user_id, Some(&client_origin)).await {
        Ok(outcome) => outcome,
        Err(error) => {
            if error.downcast_ref::<TaskNotFound>().is_some() {
                return Err(ApiError {
                    status: StatusCode::NOT_FOUND,
                    detail: "Task not found".to_owned(),
                    www_authenticate: false,
                });
            }
            warn!(%error, %task_id, "[task_detail] internal error");
            return Err(ApiError {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                detail: "Internal server error".to_owned(),
                www_authenticate: false,
            });
        }
    };

    Ok(outcome.body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_origin_defaults_to_frontend() {
        let query = TaskDetailQuery {
            client_origin: None,
        };
        assert_eq!(query.validated_origin().unwrap(), "frontend");
        let wework = TaskDetailQuery {
            client_origin: Some("wework".to_owned()),
        };
        assert_eq!(wework.validated_origin().unwrap(), "wework");
        let bad = TaskDetailQuery {
            client_origin: Some("other".to_owned()),
        };
        assert!(bad.validated_origin().is_err());
    }
}
