// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `AttachmentResponse` (`app/schemas/subtask_context.py`) — the JSON body
//! `POST /api/attachments/upload` returns.
//!
//! Pydantic serializes fields in declaration order with `None` as `null`, so
//! the rendered object keeps the exact source key order and null shape.
//! `created_at` is serialized by Pydantic v2 as an ISO-8601 datetime string
//! without microseconds when they are zero. `AttachmentResponse` (unlike
//! `AttachmentDetailResponse`) carries no `subtask_id`.
use chrono::Timelike;

use super::store::SubtaskContextRefreshRow;

/// `build_context_display_fields` returns no display fields for an upload
/// (`type_data.source` is never `external_web_content`), so every display
/// field stays `None`.
const NO_DISPLAY_FIELD: Option<serde_json::Value> = None;

#[derive(Debug, serde::Serialize)]
pub struct AttachmentResponse {
    pub id: i64,
    pub filename: String,
    pub file_size: i64,
    pub mime_type: String,
    pub status: String,
    pub file_extension: String,
    pub text_length: Option<i64>,
    pub error_message: Option<String>,
    pub error_code: Option<serde_json::Value>,
    pub truncation_info: Option<serde_json::Value>,
    pub created_at: Option<String>,
    pub external_media_type: Option<serde_json::Value>,
    pub text_count: Option<i64>,
    pub video_count: Option<i64>,
    pub image_count: Option<serde_json::Value>,
    pub comment_count: Option<serde_json::Value>,
    pub fetched_comment_count: Option<serde_json::Value>,
    pub site: Option<serde_json::Value>,
    pub source_url: Option<serde_json::Value>,
    pub cover_url: Option<serde_json::Value>,
}

impl AttachmentResponse {
    /// `AttachmentResponse.from_context(context, truncation_info)`.
    pub fn from_context(
        context: &SubtaskContextRefreshRow,
        truncation_info: Option<serde_json::Value>,
    ) -> Self {
        let filename = context.original_filename();
        Self {
            id: context.id,
            filename,
            file_size: context.file_size(),
            mime_type: context.mime_type(),
            status: context.status.clone(),
            file_extension: context.file_extension(),
            text_length: Some(i64::from(context.text_length)),
            error_message: context.error_message.clone(),
            // `from_context` never sets `error_code` (declaration default).
            error_code: None,
            truncation_info,
            created_at: context.created_at.map(format_datetime),
            external_media_type: NO_DISPLAY_FIELD,
            text_count: None,
            video_count: None,
            image_count: NO_DISPLAY_FIELD,
            comment_count: NO_DISPLAY_FIELD,
            fetched_comment_count: NO_DISPLAY_FIELD,
            site: NO_DISPLAY_FIELD,
            source_url: NO_DISPLAY_FIELD,
            cover_url: NO_DISPLAY_FIELD,
        }
    }
}

/// Pydantic v2 ISO-8601 rendering: seconds precision when the subsecond part
/// is zero, otherwise microseconds.
fn format_datetime(value: chrono::NaiveDateTime) -> String {
    if value.nanosecond() == 0 {
        value.format("%Y-%m-%dT%H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%dT%H:%M:%S%.6f").to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attachments::context_store::AttachmentMetadata;
    use brz_json::JsonProjection;
    use brz_mysql::Json;
    use serde_json::Value;
    use serde_json::json;

    fn row(type_data: Value, text_length: i32) -> SubtaskContextRefreshRow {
        SubtaskContextRefreshRow {
            id: 1364828,
            subtask_id: 0,
            user_id: 157,
            context_type: "attachment".to_string(),
            name: "平台架构周报2026-04-17.md".to_string(),
            status: "ready".to_string(),
            error_message: Some(String::new()),
            binary_data: Vec::new(),
            image_base64: Some(String::new()),
            extracted_text: None,
            text_length,
            type_data: Some(Json(JsonProjection::<AttachmentMetadata>::from_json(
                &type_data,
            ))),
            created_at: chrono::NaiveDateTime::parse_from_str(
                "2026-10-07 15:03:52",
                "%Y-%m-%d %H:%M:%S",
            )
            .ok(),
            updated_at: None,
        }
    }

    /// The recorded 200 body for the text case (438 bytes).
    #[test]
    fn renders_the_recorded_upload_body() {
        let response = AttachmentResponse::from_context(
            &row(
                json!({
                    "original_filename": "平台架构周报2026-04-17.md",
                    "file_extension": ".md",
                    "file_size": 3734,
                    "mime_type": "text/markdown",
                    "storage_backend": "minio",
                    "storage_key": "attachments/a6c59ec13de9_20261007070352_157_1364828",
                }),
                1852,
            ),
            None,
        );
        let rendered = serde_json::to_string(&response).expect("serializes");
        let expected = r#"{"id":1364828,"filename":"平台架构周报2026-04-17.md","file_size":3734,"mime_type":"text/markdown","status":"ready","file_extension":".md","text_length":1852,"error_message":"","error_code":null,"truncation_info":null,"created_at":"2026-10-07T15:03:52","external_media_type":null,"text_count":null,"video_count":null,"image_count":null,"comment_count":null,"fetched_comment_count":null,"site":null,"source_url":null,"cover_url":null}"#;
        assert_eq!(rendered, expected);
    }
}
