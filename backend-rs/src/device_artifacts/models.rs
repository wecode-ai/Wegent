// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use brz_http_server::StatusCode;
use serde::{Deserialize, Serialize};

use crate::http_compat::FastApiError;

pub(super) const CONTEXT_TYPE: &str = "remote_workspace_artifact";
pub(super) const MAX_FILE_BYTES: usize = 50 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(super) struct Source {
    pub executor_name: String,
    #[serde(default)]
    pub executor_namespace: String,
    pub workspace_root: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct DeclareRequest {
    pub workspace_root: String,
    pub relative_path: String,
    pub name: String,
    pub file_size: u64,
    #[serde(default = "default_mime")]
    pub mime_type: String,
    pub modified_at: Option<i64>,
    pub sha256: String,
}

fn default_mime() -> String {
    "application/octet-stream".to_owned()
}

impl DeclareRequest {
    pub fn validated(body: serde_json::Value) -> Result<Self, FastApiError> {
        let mut value: Self = serde_json::from_value(body)
            .map_err(|_| invalid("Artifact metadata has missing or invalid fields"))?;
        if !valid_workspace_root(&value.workspace_root)
            || value.workspace_root.len() > 4096
            || value.relative_path.len() > 4096
            || value.name.is_empty()
            || value.name.chars().count() > 255
            || value.name.chars().any(char::is_control)
            || value.mime_type.len() > 255
            || value.mime_type.chars().any(char::is_control)
            || value.modified_at.is_some_and(|modified| modified < 0)
            || value.sha256.len() != 64
            || !value.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid("Invalid artifact metadata"));
        }
        value.relative_path = normalize_relative_path(&value.relative_path)?;
        value.sha256.make_ascii_lowercase();
        Ok(value)
    }
}

pub(super) fn invalid(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::UNPROCESSABLE_ENTITY, message)
}

pub(super) fn normalize_relative_path(value: &str) -> Result<String, FastApiError> {
    if value.chars().any(char::is_control) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Invalid artifact path",
        ));
    }
    let value = value.trim();
    if value.is_empty()
        || value.starts_with('/')
        || value.contains('\\')
        || (value.as_bytes().get(1) == Some(&b':') && value.as_bytes().get(2) == Some(&b'/'))
        || value.split('/').any(|part| part == "..")
    {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Invalid artifact path",
        ));
    }
    let normalized = value
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            "Invalid artifact path",
        ));
    }
    Ok(normalized)
}

pub(super) fn valid_workspace_root(value: &str) -> bool {
    let normalized = value.replace('\\', "/");
    if value.is_empty()
        || value.chars().any(char::is_control)
        || normalized.split('/').any(|part| part == "..")
    {
        return false;
    }
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .count();
    if value.starts_with("\\\\") {
        return parts > 2;
    }
    (value.starts_with('/') && parts > 0)
        || (value.as_bytes().get(1) == Some(&b':')
            && value.as_bytes()[0].is_ascii_alphabetic()
            && normalized.as_bytes().get(2) == Some(&b'/')
            && parts > 1)
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub(super) struct Metadata {
    pub task_id: i64,
    pub relative_path: String,
    pub file_extension: String,
    pub file_size: u64,
    pub mime_type: String,
    pub modified_at: Option<i64>,
    pub sha256: String,
    pub source: Option<Source>,
}

#[derive(Debug, Serialize)]
pub(super) struct ArtifactResponse {
    pub id: i64,
    pub task_id: i64,
    pub subtask_id: i64,
    pub relative_path: String,
    pub name: String,
    pub file_size: u64,
    pub mime_type: String,
    pub modified_at: Option<i64>,
    pub sha256: String,
    pub download_url: String,
}

pub(super) fn response(id: i64, subtask_id: i64, name: String, data: Metadata) -> ArtifactResponse {
    ArtifactResponse {
        id,
        task_id: data.task_id,
        subtask_id,
        name,
        relative_path: data.relative_path,
        file_size: data.file_size,
        mime_type: data.mime_type,
        modified_at: data.modified_at,
        sha256: data.sha256,
        download_url: format!(
            "/api/tasks/{}/remote-workspace/artifacts/{id}/file",
            data.task_id
        ),
    }
}
