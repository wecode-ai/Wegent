// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fmt::Display,
    fs,
    io::{self, Seek, SeekFrom},
    path::Path,
};

use axum::{
    extract::{
        multipart::{Field, MultipartError},
        Multipart, Query,
    },
    http::{header, HeaderMap, StatusCode},
    Json,
};
use tokio::{fs::File, io::AsyncWriteExt};

use super::{
    disk_usage_bytes, header_value, log_executor_event, resolve_envd_path, EntryInfo, HttpError,
    WorkspacePathQuery,
};

// The Backend accepts attachment files up to 100 MiB. Include multipart framing overhead.
pub(super) const MAX_ENVD_FILE_UPLOAD_BYTES: usize = 101 * 1024 * 1024;
const MIN_UPLOAD_FREE_SPACE_BYTES: u64 = 100 * 1024 * 1024;

fn multipart_http_error(error: MultipartError) -> HttpError {
    HttpError {
        status: error.status(),
        detail: error.body_text(),
    }
}

pub(super) async fn upload_envd_file(
    headers: HeaderMap,
    Query(query): Query<WorkspacePathQuery>,
    mut multipart: Multipart,
) -> Result<Json<Vec<EntryInfo>>, HttpError> {
    log_executor_event(
        "envd file upload request",
        &[
            ("path", query.path.clone().unwrap_or_default()),
            ("username", query.username.clone().unwrap_or_default()),
            ("content_type", header_value(&headers, header::CONTENT_TYPE)),
        ],
    );
    let path = resolve_envd_path(&query)?;
    let Some(parent) = path.parent() else {
        return Err(HttpError {
            status: StatusCode::BAD_REQUEST,
            detail: "Path is required".to_owned(),
        });
    };
    fs::create_dir_all(parent).map_err(|error| {
        log_executor_event(
            "envd file upload parent create failed",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("parent", parent.to_string_lossy().to_string()),
                ("error", error.to_string()),
            ],
        );
        HttpError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            detail: format!("failed to create parent directory: {error}"),
        }
    })?;
    if let Some(usage) = disk_usage_bytes(parent) {
        let free = usage.total.saturating_sub(usage.used);
        log_executor_event(
            "envd file upload disk check",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("parent", parent.to_string_lossy().to_string()),
                ("free_bytes", free.to_string()),
                ("required_bytes", MIN_UPLOAD_FREE_SPACE_BYTES.to_string()),
            ],
        );
        if free < MIN_UPLOAD_FREE_SPACE_BYTES {
            return Err(HttpError {
                status: StatusCode::INSUFFICIENT_STORAGE,
                detail: "Not enough disk space".to_owned(),
            });
        }
    }

    let mut staged = None;
    while let Some(mut field) = multipart.next_field().await.map_err(multipart_http_error)? {
        if staged.is_none() && field.name() == Some("file") {
            log_executor_event(
                "envd file upload multipart field",
                &[
                    ("path", path.to_string_lossy().into_owned()),
                    ("field_name", "file".to_owned()),
                    (
                        "file_name",
                        field.file_name().unwrap_or_default().to_owned(),
                    ),
                ],
            );
            staged = Some(stage_file(&path, parent, &mut field).await?);
        }
    }
    let staged = staged.ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "multipart field 'file' is required".to_owned(),
    })?;

    // Consume the entire multipart form before opening the destination. Copying into the
    // destination preserves its existing permissions and follows links as a normal write does.
    let destination = path.clone();
    let size = tokio::task::spawn_blocking(move || -> io::Result<u64> {
        let mut staged = staged;
        staged.seek(SeekFrom::Start(0))?;
        io::copy(&mut staged, &mut fs::File::create(destination)?)
    })
    .await
    .map_err(|error| upload_write_error(&path, error))?
    .map_err(|error| upload_write_error(&path, error))?;
    log_executor_event(
        "envd file upload succeeded",
        &[
            ("path", path.to_string_lossy().to_string()),
            ("size", size.to_string()),
        ],
    );
    Ok(Json(vec![EntryInfo {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default(),
        entry_type: "file".to_owned(),
    }]))
}

async fn stage_file(
    path: &Path,
    parent: &Path,
    field: &mut Field<'_>,
) -> Result<fs::File, HttpError> {
    let temporary =
        tempfile::tempfile_in(parent).map_err(|error| upload_write_error(path, error))?;
    let mut file = File::from_std(temporary);
    while let Some(chunk) = field.chunk().await.map_err(multipart_http_error)? {
        file.write_all(&chunk)
            .await
            .map_err(|error| upload_write_error(path, error))?;
    }
    file.flush()
        .await
        .map_err(|error| upload_write_error(path, error))?;
    Ok(file.into_std().await)
}

fn upload_write_error(path: &Path, error: impl Display) -> HttpError {
    log_executor_event(
        "envd file upload write failed",
        &[
            ("path", path.to_string_lossy().to_string()),
            ("error", error.to_string()),
        ],
    );
    HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("failed to write uploaded file: {error}"),
    }
}
