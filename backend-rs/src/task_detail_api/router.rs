// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! API export for `GET /api/tasks/{task_id}`.

use std::sync::Arc;

use brz_http_server::Binary;
use brz_http_server::HttpResponse;

use super::handler::task_detail;
use crate::state::AppState;

/// GET /api/tasks/{task_id}: the success body is raw JSON with
/// `application/json` (FastAPI `JSONResponse` framing, no compression).
#[brz_http_server::get("/api/tasks/:task_id")]
async fn detail_response(
    #[inject(state)] state: &Arc<AppState>,
    task_id: i64,
    #[header] authorization: Option<&str>,
    client_origin: Option<String>,
) -> Result<HttpResponse<Binary>, super::handler::ApiError> {
    match task_detail(state, task_id, client_origin.as_deref(), authorization).await {
        Ok((status, body)) => Ok(HttpResponse::new(Binary::new(body)).status(status)),
        Err(error) => Err(error),
    }
}
