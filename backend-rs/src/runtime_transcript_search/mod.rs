// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Search one owned or durably project-bound runtime transcript.

mod access;
mod request;
mod rpc;

use brz_http_server::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};
use request::SearchRequest;

#[brz_http_server::post("/api/runtime-work/transcript/search")]
async fn search_transcript(
    #[inject(state)] state: &AppState,
    body: Value,
    #[auth] user: SessionUser,
) -> Result<SearchResponse, FastApiError> {
    let request = SearchRequest::validated(&body)?;
    let target = access::resolve(state, user.0.id, &request).await?;
    let payload = request.payload(&target.task_id, target.project_bound);
    let result = rpc::search(state, &target, &request.device_id, payload).await?;
    response(result)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchResponse {
    matches: Vec<SearchMatch>,
    #[serde(alias = "total_matches")]
    total_matches: u64,
    #[serde(alias = "is_capped")]
    is_capped: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchMatch {
    #[serde(default, alias = "message_id", skip_serializing_if = "Option::is_none")]
    message_id: Option<String>,
    #[serde(default, alias = "item_id", skip_serializing_if = "Option::is_none")]
    item_id: Option<String>,
    #[serde(default, alias = "turn_id", skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reply_questions: Option<Vec<String>>,
    occurrence: u64,
    cursor: String,
}

fn response(result: Value) -> Result<SearchResponse, FastApiError> {
    if result.get("success") == Some(&Value::Bool(false)) {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            result
                .get("error")
                .filter(|v| !v.is_null() && v.as_str() != Some(""))
                .map(crate::device_commands::python_str)
                .unwrap_or_else(|| "Runtime RPC failed".to_owned()),
        ));
    }
    serde_json::from_value::<SearchResponse>(result)
        .ok()
        .filter(|response| response.matches.iter().all(|item| !item.cursor.is_empty()))
        .ok_or_else(|| {
            error(
                StatusCode::BAD_GATEWAY,
                "Runtime returned an invalid conversation search response",
            )
        })
}

fn error(status: StatusCode, detail: impl Into<String>) -> FastApiError {
    FastApiError::json_body(
        status,
        serde_json::json!({
            "error_code": status.as_u16(), "detail": detail.into(),
        }),
    )
}

fn database_error(error: brz_mysql::MysqlError) -> FastApiError {
    tracing::error!(%error, "transcript search database read failed");
    FastApiError::unhandled()
}

#[cfg(test)]
mod tests;
