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
    disk_usage_bytes, header_value, log_executor_event, resolve_envd_path, ByteUsage, EntryInfo,
    HttpError, WorkspacePathQuery,
};

// The Backend accepts attachment files up to 100 MiB. Include multipart framing overhead.
pub(super) const MAX_ENVD_FILE_UPLOAD_BYTES: usize = 101 * 1024 * 1024;

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
            staged = Some(stage_file(&path, &mut field).await?);
        }
    }
    let staged = staged.ok_or_else(|| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: "multipart field 'file' is required".to_owned(),
    })?;

    // Consume the entire multipart form before opening the destination. Copying into the
    // destination preserves its existing permissions and follows links as a normal write does.
    let destination = path.clone();
    let destination_dir = parent.to_path_buf();
    let size = tokio::task::spawn_blocking(move || {
        let destination_dir = fs::canonicalize(&destination)
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
            .unwrap_or(destination_dir);
        publish_staged_file(
            staged,
            &destination,
            &destination_dir,
            disk_usage_bytes(&destination_dir),
        )
    })
    .await
    .map_err(|error| upload_write_error(&path, error))??;
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

async fn stage_file(path: &Path, field: &mut Field<'_>) -> Result<fs::File, HttpError> {
    let temporary = tempfile::tempfile().map_err(|error| upload_io_error(path, error))?;
    let mut file = File::from_std(temporary);
    while let Some(chunk) = field.chunk().await.map_err(multipart_http_error)? {
        file.write_all(&chunk)
            .await
            .map_err(|error| upload_io_error(path, error))?;
    }
    file.flush()
        .await
        .map_err(|error| upload_io_error(path, error))?;
    Ok(file.into_std().await)
}

fn publish_staged_file(
    mut staged: fs::File,
    path: &Path,
    directory: &Path,
    usage: Option<ByteUsage>,
) -> Result<u64, HttpError> {
    let size = staged
        .metadata()
        .map_err(|error| upload_io_error(path, error))?
        .len();
    // A single directory link and allocated blocks do not establish how much space
    // truncating will release. Shared extents and snapshots can retain those blocks.
    check_upload_space(path, directory, usage, size)?;
    staged
        .seek(SeekFrom::Start(0))
        .map_err(|error| upload_io_error(path, error))?;
    let mut destination = fs::File::create(path).map_err(|error| upload_io_error(path, error))?;
    io::copy(&mut staged, &mut destination).map_err(|error| upload_io_error(path, error))
}

fn check_upload_space(
    path: &Path,
    directory: &Path,
    usage: Option<ByteUsage>,
    required: u64,
) -> Result<(), HttpError> {
    if let Some(usage) = usage {
        let free = usage.total.saturating_sub(usage.used);
        log_executor_event(
            "envd file upload disk check",
            &[
                ("path", path.to_string_lossy().to_string()),
                ("directory", directory.to_string_lossy().to_string()),
                ("free_bytes", free.to_string()),
                ("required_bytes", required.to_string()),
            ],
        );
        if free < required {
            return Err(insufficient_storage());
        }
    }
    Ok(())
}

fn insufficient_storage() -> HttpError {
    HttpError {
        status: StatusCode::INSUFFICIENT_STORAGE,
        detail: "Not enough disk space".to_owned(),
    }
}

fn upload_io_error(path: &Path, error: io::Error) -> HttpError {
    let response = upload_write_error(path, &error);
    if is_capacity_error(&error) {
        insufficient_storage()
    } else {
        response
    }
}

#[cfg(unix)]
fn is_capacity_error(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(libc::ENOSPC | libc::EDQUOT))
}

#[cfg(windows)]
fn is_capacity_error(error: &io::Error) -> bool {
    use windows_sys::Win32::Foundation::{
        ERROR_DISK_FULL, ERROR_DISK_QUOTA_EXCEEDED, ERROR_HANDLE_DISK_FULL,
    };

    error.raw_os_error().is_some_and(|code| {
        matches!(
            code as u32,
            ERROR_DISK_FULL | ERROR_DISK_QUOTA_EXCEEDED | ERROR_HANDLE_DISK_FULL
        )
    })
}

#[cfg(not(any(unix, windows)))]
fn is_capacity_error(_error: &io::Error) -> bool {
    false
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn insufficient_publish_space_keeps_the_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("upload.bin");
        fs::write(&target, b"original").unwrap();
        let mut staged = tempfile::tempfile().unwrap();
        staged.write_all(b"replacement").unwrap();

        let error = publish_staged_file(
            staged,
            &target,
            directory.path(),
            Some(ByteUsage {
                total: 20,
                used: 17,
            }),
        )
        .unwrap_err();

        assert_eq!(error.status, StatusCode::INSUFFICIENT_STORAGE);
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    fn actual_storage_errors_return_insufficient_storage() {
        let path = Path::new("upload.bin");
        let error = upload_io_error(path, io::Error::from_raw_os_error(libc::ENOSPC));

        assert_eq!(error.status, StatusCode::INSUFFICIENT_STORAGE);
    }
}
