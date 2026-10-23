// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use base64::Engine as _;
use brz_http_server::{Binary, HttpResponse, StatusCode};
use serde::Deserialize;
use std::time::Duration;

use super::models::{
    MAX_FILE_BYTES, Metadata, Source, normalize_relative_path, valid_workspace_root,
};
use crate::http_compat::FastApiError;
use crate::state::AppState;

pub(super) async fn download(
    state: &AppState,
    metadata: &Metadata,
    user_id: i64,
    disposition: &str,
) -> Result<HttpResponse<Binary>, FastApiError> {
    let source = metadata
        .source
        .as_ref()
        .filter(|source| {
            !source.executor_name.is_empty() && valid_workspace_root(&source.workspace_root)
        })
        .ok_or_else(super::repository::source_unavailable)?;
    let path = normalize_relative_path(&metadata.relative_path)?;
    let bytes = if let Some(device_id) = source.executor_name.strip_prefix("device-") {
        device_file(state, user_id, device_id, source, &path).await?
    } else {
        executor_file(state, source, &path).await?
    };
    let filename = path.rsplit('/').next().unwrap_or(&path);
    let disposition = crate::attachments::handler::build_content_disposition(disposition, filename);
    let mime = if metadata.mime_type.is_empty() {
        "application/octet-stream"
    } else {
        &metadata.mime_type
    };
    HttpResponse::new(Binary::new(bytes))
        .header(
            "content-type",
            &crate::attachments::content_type::content_type_value(mime),
        )
        .map_err(super::internal)?
        .header("content-disposition", &disposition)
        .map_err(super::internal)
}

#[derive(Deserialize)]
struct Chunk {
    content_base64: String,
    size: usize,
    offset: usize,
    eof: bool,
}

pub(super) fn decode_chunk(
    value: serde_json::Value,
    offset: usize,
) -> Result<(Vec<u8>, usize, bool), FastApiError> {
    let chunk: Chunk = serde_json::from_value(value).map_err(|_| invalid_chunk())?;
    if chunk.size > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let content = base64::engine::general_purpose::STANDARD
        .decode(&chunk.content_base64)
        .map_err(|_| invalid_chunk())?;
    let end = offset
        .checked_add(content.len())
        .ok_or_else(invalid_chunk)?;
    if chunk.offset != offset
        || end > chunk.size
        || chunk.eof != (end == chunk.size)
        || (content.is_empty() && !chunk.eof)
    {
        return Err(invalid_chunk());
    }
    Ok((content, chunk.size, chunk.eof))
}

async fn device_file(
    state: &AppState,
    user_id: i64,
    device_id: &str,
    source: &Source,
    path: &str,
) -> Result<Vec<u8>, FastApiError> {
    let mut content = Vec::new();
    let mut size = None;
    loop {
        let response = crate::device_command::read_artifact_chunk(
            state,
            user_id,
            device_id,
            &source.workspace_root,
            path,
            content.len(),
        )
        .await
        .map_err(|error| {
            tracing::warn!(user_id, device_id, ?error, "artifact source read rejected");
            super::repository::source_unavailable()
        })?;
        if !response.success {
            return Err(file_error("Artifact file read failed"));
        }
        let (chunk, chunk_size, eof) = decode_chunk(response.stdout, content.len())?;
        if size.is_some_and(|size| size != chunk_size) {
            return Err(invalid_chunk());
        }
        size = Some(chunk_size);
        content.extend(chunk);
        if eof {
            return Ok(content);
        }
    }
}

#[derive(Deserialize)]
struct Address {
    status: String,
    base_url: Option<String>,
}

async fn executor_file(
    state: &AppState,
    source: &Source,
    path: &str,
) -> Result<Vec<u8>, FastApiError> {
    let manager = std::env::var("EXECUTOR_MANAGER_URL")
        .unwrap_or_else(|_| crate::executor_manager::DEFAULT_EXECUTOR_MANAGER_URL.to_owned());
    let response = state
        .attachment_http
        .get(format!(
            "{}/executor-manager/executor/address",
            manager.trim_end_matches('/')
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
    let base = address
        .base_url
        .filter(|value| !value.is_empty())
        .filter(|_| address.status.eq_ignore_ascii_case("success"))
        .ok_or_else(super::repository::source_unavailable)?;
    let response = state
        .attachment_http
        .get(format!(
            "{}/filesystem/artifact",
            base.trim_end_matches('/')
        ))
        .map_err(|_| unavailable())?
        .query(&[
            ("root_path", source.workspace_root.as_str()),
            ("path", path),
        ])
        .timeout(Duration::from_secs(130))
        .send()
        .await
        .map_err(|_| unavailable())?;
    bounded_body(response, MAX_FILE_BYTES).await
}

pub(super) async fn bounded_body(
    mut response: brz_http::Response,
    limit: usize,
) -> Result<Vec<u8>, FastApiError> {
    let code = response.status();
    if matches!(code.as_u16(), 400 | 403 | 404 | 413) {
        return Err(FastApiError::detail(code, "Artifact file is unavailable"));
    }
    if !code.is_success() {
        return Err(file_error("Artifact file request failed"));
    }
    if let Some(length) = response.headers().get("content-length") {
        let length = length
            .to_str()
            .ok()
            .and_then(|length| length.parse::<usize>().ok())
            .ok_or_else(|| file_error("Invalid artifact file size"))?;
        if length > limit {
            return Err(too_large());
        }
    }
    let mut content = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if chunk.len() > limit.saturating_sub(content.len()) {
            return Err(too_large());
        }
        content.extend_from_slice(&chunk);
    }
    Ok(content)
}

fn invalid_chunk() -> FastApiError {
    file_error("Invalid artifact file response")
}
fn file_error(message: &str) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_GATEWAY, message)
}
fn too_large() -> FastApiError {
    FastApiError::detail(
        StatusCode::PAYLOAD_TOO_LARGE,
        "Artifact exceeds 50 MiB limit",
    )
}
fn unavailable() -> FastApiError {
    FastApiError::detail(
        StatusCode::SERVICE_UNAVAILABLE,
        "Artifact execution source is unavailable",
    )
}
