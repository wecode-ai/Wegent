// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Metadata-only video uploads (`ContextService.upload_video_metadata`).

use std::sync::Arc;

use brz_http_server::StatusCode;
use brz_mysql::MysqlTransaction;
use serde::{Deserialize, Serialize};

use super::{response::AttachmentResponse, store};
use crate::{auth::SessionUser, http_compat::FastApiError, state::AppState};

#[derive(Deserialize)]
struct VideoMetadataUpload {
    filename: String,
    #[serde(deserialize_with = "brz_json::adapters::integer")]
    file_size: i64,
    file_extension: String,
    #[serde(deserialize_with = "brz_json::adapters::integer")]
    fid: i64,
}

#[derive(Serialize)]
struct VideoMetadata<'a> {
    original_filename: &'a str,
    file_extension: String,
    file_size: i64,
    mime_type: &'static str,
    storage_backend: &'static str,
    fid: i64,
}

fn metadata<'a>(
    request: &'a VideoMetadataUpload,
    storage_backend: &'static str,
) -> Result<VideoMetadata<'a>, FastApiError> {
    let extension = request.file_extension.to_lowercase();
    let mime_type = match extension.as_str() {
        ".mp4" | ".avi" | ".mkv" | ".mov" | ".flv" | ".wmv" => {
            super::document::mime_type(&extension)
        }
        _ => {
            return Err(FastApiError::detail(
                StatusCode::BAD_REQUEST,
                format!(
                    "Unsupported video format: {extension}. Supported formats: \
                     .avi, .flv, .mkv, .mov, .mp4, .wmv"
                ),
            ));
        }
    };
    let max_mb = crate::config::env_or_dotenv("MAX_UPLOAD_VIDEO_FILE_SIZE_MB")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(1024);
    if request.file_size > max_mb.saturating_mul(1024 * 1024) {
        return Err(FastApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("Video file size exceeds maximum limit ({max_mb} MB)"),
        ));
    }
    Ok(VideoMetadata {
        original_filename: &request.filename,
        file_extension: extension,
        file_size: request.file_size,
        mime_type,
        storage_backend,
        fid: request.fid,
    })
}

fn upload_failed(error: impl std::fmt::Display) -> FastApiError {
    tracing::error!(%error, "video metadata upload failed");
    FastApiError::detail(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Failed to upload video metadata",
    )
}

#[brz_http_server::post("/api/attachments/upload-video-metadata")]
async fn upload_video_metadata(
    #[inject(state)] state: &Arc<AppState>,
    #[auth] user: SessionUser,
    request: VideoMetadataUpload,
) -> Result<AttachmentResponse, FastApiError> {
    let metadata = metadata(
        &request,
        state.attachment_upload.video_metadata_storage_backend(),
    )?;
    let type_data = crate::json_compat::python_json(&metadata).map_err(upload_failed)?;
    let id = state
        .mysql
        .with_transaction(async |transaction| {
            let result = transaction
                .execute(
                    "INSERT INTO subtask_contexts \
                     (subtask_id, user_id, context_type, name, status, error_message, \
                     binary_data, image_base64, extracted_text, text_length, type_data, \
                     created_at, updated_at) VALUES \
                     (0, ?, 'attachment', ?, 'ready', '', X'', '', '', 0, ?, now(), now())",
                    (user.id, request.filename.as_str(), type_data.as_str()),
                )
                .await?;
            Ok(result.last_insert_id as i64)
        })
        .await
        .map_err(upload_failed)?;
    let context = store::refresh_context(&state.mysql, id)
        .await
        .map_err(upload_failed)?
        .ok_or_else(|| upload_failed("new video attachment disappeared"))?;
    // The endpoint reads current_user.id in its success log after commit;
    // SQLAlchemy reloads the expired owner entity at that point.
    let owner: Option<super::OwnerEntityRow> = state
        .mysql
        .fetch_optional(crate::user_reader::USER_ENTITY_BY_ID_QUERY, (user.id,))
        .await
        .map_err(upload_failed)?;
    if owner.is_none() {
        return Err(upload_failed("video attachment owner disappeared"));
    }
    Ok(AttachmentResponse::from_context(&context, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_formats_are_normalized_and_size_is_checked() {
        let mut request = VideoMetadataUpload {
            filename: "video.MP4".to_owned(),
            file_size: 16,
            file_extension: ".MP4".to_owned(),
            fid: 17,
        };
        let value = metadata(&request, "external").unwrap();
        assert_eq!(value.file_extension, ".mp4");
        assert_eq!(value.mime_type, "video/mp4");
        assert_eq!(value.storage_backend, "external");
        assert_eq!(
            metadata(&request, "example-provider")
                .unwrap()
                .storage_backend,
            "example-provider"
        );
        request.file_extension = ".txt".to_owned();
        assert!(metadata(&request, "external").is_err());
        request.file_extension = ".mp4".to_owned();
        request.file_size = i64::MAX;
        assert!(metadata(&request, "external").is_err());
    }

    #[test]
    fn registered_route_keeps_python_ownership() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("config/routes.toml");
        let table = crate::RouteTable::compile(crate::load_routes_config(&path).unwrap()).unwrap();
        assert!(!table.matches(
            &http::Method::POST,
            "/api/attachments/upload-video-metadata"
        ));
        let registered =
            brz_http_server::__private::inventory::iter::<crate::__http_registry_http_apis::Entry>
                .into_iter()
                .flat_map(|entry| (entry.0.routes)())
                .any(|route| {
                    route.path == "/api/attachments/upload-video-metadata"
                        && route.methods & (1 << 5) != 0
                });
        assert!(registered);
    }

    #[test]
    fn metadata_uses_the_sqlalchemy_json_serializer() {
        let request = VideoMetadataUpload {
            filename: "视频.mp4".to_owned(),
            file_size: 16,
            file_extension: ".mp4".to_owned(),
            fid: 17,
        };
        let json =
            crate::json_compat::python_json(&metadata(&request, "external").unwrap()).unwrap();
        assert!(json.contains(r#""original_filename": "\u89c6\u9891.mp4""#));
        assert!(json.contains(r#", "fid": 17"#));
    }
}
