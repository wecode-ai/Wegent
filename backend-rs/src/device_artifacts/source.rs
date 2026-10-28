// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::models::{ArtifactQuery, Source, valid_workspace_root};
use crate::{http_compat::FastApiError, state::AppState};
use serde::Deserialize;
use std::time::Duration;

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
    state: &AppState,
    user_id: i64,
    source: &Source,
    task_id: i64,
    subtask_id: i64,
) -> Result<String, FastApiError> {
    let query = ArtifactQuery::new(source, task_id, subtask_id);
    let workspace: Workspace = if let Some(device) = source.executor_name.strip_prefix("device-") {
        let result = crate::device_command::task_artifact(
            state,
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
        let base = executor_base(state, source).await?;
        let response = state
            .attachment_http
            .get(format!("{base}/filesystem/artifact"))
            .map_err(|_| super::repository::source_unavailable())?
            .query(&query)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|_| super::repository::source_unavailable())?;
        if !response.status().is_success() {
            return Err(super::repository::source_unavailable());
        }
        response
            .json()
            .await
            .map_err(|_| super::repository::source_unavailable())?
    };
    if !valid_workspace_root(&workspace.workspace_root) {
        return Err(super::repository::source_unavailable());
    }
    Ok(workspace.workspace_root)
}

#[derive(Deserialize)]
struct Address {
    status: String,
    base_url: Option<String>,
}

pub(super) async fn executor_base(
    state: &AppState,
    source: &Source,
) -> Result<String, FastApiError> {
    let manager = std::env::var("EXECUTOR_MANAGER_URL")
        .unwrap_or_else(|_| crate::executor_manager::DEFAULT_EXECUTOR_MANAGER_URL.to_owned());
    let response = state
        .attachment_http
        .get(format!(
            "{}/executor-manager/executor/address",
            manager.trim_end_matches('/'),
        ))
        .map_err(|_| super::repository::source_unavailable())?
        .query(&[
            ("executor_name", &source.executor_name),
            ("executor_namespace", &source.executor_namespace),
        ])
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|_| super::repository::source_unavailable())?;
    if !response.status().is_success() {
        return Err(super::repository::source_unavailable());
    }
    let address: Address = response
        .json()
        .await
        .map_err(|_| super::repository::source_unavailable())?;
    address
        .base_url
        .filter(|value| !value.is_empty())
        .filter(|_| address.status.eq_ignore_ascii_case("success"))
        .map(|value| value.trim_end_matches('/').to_owned())
        .ok_or_else(super::repository::source_unavailable)
}
