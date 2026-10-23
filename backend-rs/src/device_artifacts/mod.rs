// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Metadata-only Task artifacts, owned by Rust on both active API routes.
mod files;
mod models;
mod repository;
#[cfg(test)]
mod tests;

use brz_http_server::{Binary, HttpResponse, StatusCode};
use serde::Deserialize;
use serde_json::Value;

use crate::attachments_task_all::auth::{AuthenticatedUser, decode_with_keys};
use crate::auth::{SessionUser, extract_authorization_token};
use crate::http_compat::FastApiError;
use crate::state::AppState;
use models::{ArtifactResponse, DeclareRequest};

#[derive(Debug, Deserialize)]
struct TaskIdentity {
    #[serde(rename = "type")]
    token_type: String,
    task_id: i64,
    subtask_id: i64,
    user_id: i64,
    exp: i64,
    nbf: Option<i64>,
}

fn matching_task_token(
    config: &crate::config::AuthConfig,
    authorization: Option<&str>,
    task_id: i64,
    user_id: i64,
) -> Result<i64, FastApiError> {
    let token = extract_authorization_token(authorization);
    let identity = decode_with_keys::<TaskIdentity>(config, &token)
        .filter(|claims| {
            claims.token_type == "task_token"
                && claims.task_id == task_id
                && task_id > 0
                && claims.user_id == user_id
                && claims.subtask_id > 0
                && claims.exp > chrono::Utc::now().timestamp()
                && claims
                    .nbf
                    .is_none_or(|nbf| nbf <= chrono::Utc::now().timestamp())
        })
        .ok_or_else(|| FastApiError::forbidden("A matching Task Token is required"))?;
    Ok(identity.subtask_id)
}

#[brz_http_server::post("/api/tasks/:task_id/remote-workspace/artifacts")]
async fn declare_artifact(
    #[inject(state)] state: &AppState,
    task_id: i64,
    #[auth] user: AuthenticatedUser,
    #[header("authorization")] authorization: Option<&str>,
    body: Value,
) -> Result<ArtifactResponse, FastApiError> {
    let subtask_id = matching_task_token(&state.auth, authorization, task_id, user.id)?;
    let request = DeclareRequest::validated(body)?;
    let subtask = repository::owned_subtask(state, subtask_id, task_id, user.id)
        .await?
        .ok_or_else(|| FastApiError::forbidden("Artifact subtask is invalid"))?;
    if subtask.role != "ASSISTANT" {
        return Err(FastApiError::forbidden("Artifact subtask is invalid"));
    }
    repository::declare(&state.mysql, subtask_id, task_id, user.id, subtask, request).await
}

#[brz_http_server::get("/api/tasks/:task_id/remote-workspace/artifacts/:context_id/file")]
async fn download_artifact(
    #[inject(state)] state: &AppState,
    task_id: i64,
    context_id: i64,
    #[auth] user: SessionUser,
    disposition: Option<String>,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let disposition = disposition.as_deref().unwrap_or("attachment");
    if !matches!(disposition, "inline" | "attachment") {
        return Err(models::invalid("Invalid file disposition"));
    }
    let context = repository::context(&state.mysql, context_id, i64::from(user.id))
        .await?
        .ok_or_else(not_found)?;
    if repository::owned_subtask(state, context.subtask_id, task_id, i64::from(user.id))
        .await?
        .is_none()
    {
        return Err(not_found());
    }
    files::download(state, &context.type_data.0, i64::from(user.id), disposition).await
}

fn not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Artifact not found")
}

pub(super) fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "artifact metadata operation failed");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Artifact operation failed",
    )
}
