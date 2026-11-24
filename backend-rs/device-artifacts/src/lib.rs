// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Metadata-only Task artifacts, owned by Rust on both active API routes.
#![forbid(unsafe_code)]

mod files;
mod models;
mod repository;
mod source;
#[cfg(test)]
mod tests;

use brz_http_server::{Binary, HttpResponse, StatusCode};
use serde::Deserialize;
use serde_json::Value;

use models::{ArtifactResponse, DeclareRequest};
use wegent_attachments::attachments_task_all::auth::{AuthenticatedUser, decode_with_keys};
use wegent_http_compat::FastApiError;
use wegent_identity::auth::{SessionUser, extract_authorization_token};

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
    config: &wegent_backend_config::AuthConfig,
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
    #[inject(state)] state: &DeviceArtifactState,
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
    use sha2::{Digest, Sha256};
    let token = extract_authorization_token(authorization);
    let mut source = subtask.source(format!("{:x}", Sha256::digest(token.as_bytes())))?;
    source.workspace_root =
        source::workspace_root(state, user.id, &source, task_id, subtask_id).await?;
    source::validate_declared_root(&source.workspace_root, &request.workspace_root)?;
    repository::declare(&state.mysql, subtask_id, task_id, user.id, source, request).await
}

#[brz_http_server::get("/api/tasks/:task_id/remote-workspace/artifacts/:context_id/file")]
async fn download_artifact(
    #[inject(state)] state: &DeviceArtifactState,
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
    files::download(
        state,
        &context.type_data.0,
        context.subtask_id,
        i64::from(user.id),
        disposition,
    )
    .await
}

fn not_found() -> FastApiError {
    FastApiError::detail(StatusCode::NOT_FOUND, "Artifact not found")
}

fn internal(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "artifact metadata operation failed");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Artifact operation failed",
    )
}

use std::sync::Arc;

use wegent_devices::device_command::DeviceCommandServices;
use wegent_identity::auth::AppAuthenticator;

pub struct DeviceArtifactState {
    pub mysql: brz_mysql::MysqlService,
    pub redis: Option<brz_redis::RedisService>,
    pub socketio_rpc: Option<Arc<wegent_socket_events::socketio_rpc::SocketIoRpc>>,
    pub auth: wegent_backend_config::AuthConfig,
    pub attachment_http: brz_http::Client,
    pub task_store: Arc<dyn wegent_task_store::task_store::TaskStore>,
}

impl DeviceArtifactState {
    fn command_services(&self) -> DeviceCommandServices<'_> {
        DeviceCommandServices {
            mysql: &self.mysql,
            redis: self.redis.as_ref(),
            socketio_rpc: self.socketio_rpc.as_deref(),
        }
    }
}

brz_http_server::registry!(
    dependencies(state: Arc<DeviceArtifactState>),
    auth = AppAuthenticator
);

pub fn routes(
    state: Arc<DeviceArtifactState>,
) -> Result<brz_http_server::Router<AppAuthenticator>, brz_http_server::RegistryError> {
    brz_http_server::handlers!(state = state)
}

pub fn registered_routes() -> Vec<(&'static str, u16)> {
    brz_http_server::__private::inventory::iter::<__http_registry_http_apis::Entry>
        .into_iter()
        .flat_map(|entry| {
            (entry.0.routes)()
                .iter()
                .map(|route| (route.path, route.methods))
        })
        .collect()
}
