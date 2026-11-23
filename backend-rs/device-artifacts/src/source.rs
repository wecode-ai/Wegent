// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::models::{ArtifactQuery, Source, valid_workspace_root};
use crate::DeviceArtifactState;
use brz_http_server::StatusCode;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use wegent_http_compat::FastApiError;

pub(super) fn validate_declared_root(
    authoritative: &str,
    declared: &str,
) -> Result<(), FastApiError> {
    if !valid_workspace_root(authoritative) || authoritative != declared {
        return Err(FastApiError::forbidden(
            "Artifact workspace does not match its Task execution",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Workspace {
    workspace_root: String,
}

pub(super) async fn workspace_root(
    state: &DeviceArtifactState,
    user_id: i64,
    source: &Source,
    task_id: i64,
    subtask_id: i64,
) -> Result<String, FastApiError> {
    let query = ArtifactQuery::new(source, task_id, subtask_id);
    let workspace: Workspace = if let Some(device) = source.executor_name.strip_prefix("device-") {
        let result = wegent_devices::device_command::task_artifact(
            state.command_services(),
            user_id,
            device,
            serde_json::to_value(&query).map_err(super::internal)?,
        )
        .await?;
        if !result.success {
            return Err(super::repository::source_unavailable());
        }
        serde_json::from_value(result.stdout).map_err(super::internal)?
    } else {
        let manager = manager_url();
        return workspace_root_via_manager(state, &manager, source, &query).await;
    };
    if !valid_workspace_root(&workspace.workspace_root) {
        return Err(super::repository::source_unavailable());
    }
    Ok(workspace.workspace_root)
}

pub(super) async fn workspace_root_via_manager(
    state: &AppState,
    manager: &str,
    source: &Source,
    query: &ArtifactQuery,
) -> Result<String, FastApiError> {
    let response =
        manager_artifact_request_at(state, manager, source, query, Duration::from_secs(15)).await?;
    if !response.status().is_success() {
        return Err(upstream_unavailable(response.status().as_u16()));
    }
    let workspace: Workspace = response
        .json()
        .await
        .map_err(|_| super::repository::source_unavailable())?;
    if !valid_workspace_root(&workspace.workspace_root) {
        return Err(super::repository::source_unavailable());
    }
    Ok(workspace.workspace_root)
}

/// Query sent to executor-manager's artifact proxy: the container query plus
/// the executor whose runtime owns the workspace.
#[derive(Serialize)]
pub(super) struct ManagerArtifactQuery<'a> {
    binding_id: &'a str,
    task_id: &'a str,
    subtask_id: &'a str,
    executor_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    executor_namespace: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    root_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    offset: Option<usize>,
}

impl<'a> ManagerArtifactQuery<'a> {
    pub(super) fn new(source: &'a Source, query: &'a ArtifactQuery) -> Self {
        Self {
            binding_id: &query.binding_id,
            task_id: &query.task_id,
            subtask_id: &query.subtask_id,
            executor_name: &source.executor_name,
            executor_namespace: (!source.executor_namespace.is_empty())
                .then_some(source.executor_namespace.as_str()),
            root_path: query.root_path.as_deref(),
            path: query.path.as_deref(),
            offset: query.offset,
        }
    }
}

fn manager_url() -> String {
    std::env::var("EXECUTOR_MANAGER_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| crate::executor_manager::DEFAULT_EXECUTOR_MANAGER_URL.to_owned())
}

/// Read an artifact through executor-manager instead of the container address.
pub(super) async fn manager_artifact_request(
    state: &AppState,
    source: &Source,
    query: &ArtifactQuery,
    timeout: Duration,
) -> Result<brz_http::Response, FastApiError> {
    let manager = manager_url();
    manager_artifact_request_at(state, &manager, source, query, timeout).await
}

pub(super) async fn manager_artifact_request_at(
    state: &AppState,
    manager: &str,
    source: &Source,
    query: &ArtifactQuery,
    timeout: Duration,
) -> Result<brz_http::Response, FastApiError> {
    state
        .attachment_http
        .get(format!(
            "{}/executor-manager/executor/workspace/artifact",
            manager.trim_end_matches('/'),
        ))
        .map_err(|_| super::repository::source_unavailable())?
        .query(&ManagerArtifactQuery::new(source, query))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| source_temporarily_unavailable())
}

fn upstream_unavailable(status: u16) -> FastApiError {
    match status {
        502..=504 => source_temporarily_unavailable(),
        _ => super::repository::source_unavailable(),
    }
}

fn source_temporarily_unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Artifact execution source is temporarily unavailable",
    )
}
