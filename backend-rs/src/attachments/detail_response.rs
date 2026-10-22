// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `AttachmentDetailResponse` (`app/schemas/subtask_context.py`) — the JSON
//! detail body for `GET /api/attachments/{attachment_id}`.
//!
//! Pydantic serializes fields in declaration order with `None` as `null`, so
//! the rendered object keeps the exact source key order and null shape.
//! `created_at` is serialized by Pydantic v2 as an ISO-8601 datetime string
//! without microseconds when they are zero.
use brz_json::RawJson;
use chrono::Timelike;

use super::context_store::SubtaskContextRow;

/// `build_context_display_fields` (`app/schemas/context_display.py`) for
/// attachment contexts. Non-attachment types never reach this response.
fn display_fields(context: &SubtaskContextRow) -> DisplayFields {
    let data = context.metadata();
    if let Some(data) = data.filter(|data| data.source.as_deref() == Some("external_web_content")) {
        let media_type = data.external_media_type.as_deref().unwrap_or("video");
        let opaque = |field: &Option<brz_json::OpaqueJson>| {
            field
                .as_ref()
                .map(|value| brz_json::to_raw_value(value).expect("metadata serializes"))
        };
        let site = opaque(&data.site);
        let source_url = opaque(&data.external_source_url);
        let cover_url = opaque(&data.cover_url);
        return match media_type {
            "text" => DisplayFields {
                external_media_type: Some("text"),
                text_count: Some(1),
                comment_count: None,
                fetched_comment_count: None,
                video_count: None,
                site,
                source_url,
                cover_url,
            },
            "comments" => DisplayFields {
                external_media_type: Some("comments"),
                text_count: None,
                comment_count: opaque(&data.comment_count),
                fetched_comment_count: opaque(&data.fetched_comment_count),
                video_count: None,
                site,
                source_url,
                cover_url,
            },
            _ => DisplayFields {
                external_media_type: Some("video"),
                text_count: None,
                comment_count: None,
                fetched_comment_count: None,
                video_count: Some(1),
                site,
                source_url,
                cover_url,
            },
        };
    }
    DisplayFields::default()
}

#[derive(Default)]
struct DisplayFields {
    external_media_type: Option<&'static str>,
    text_count: Option<i64>,
    video_count: Option<i64>,
    comment_count: Option<RawJson>,
    fetched_comment_count: Option<RawJson>,
    site: Option<RawJson>,
    source_url: Option<RawJson>,
    cover_url: Option<RawJson>,
}

/// `AttachmentDetailResponse`.
#[derive(serde::Serialize)]
pub struct AttachmentDetailResponse {
    pub id: i64,
    pub filename: String,
    pub file_size: i64,
    pub mime_type: String,
    pub status: String,
    pub file_extension: String,
    pub text_length: Option<i64>,
    pub error_message: Option<String>,
    pub error_code: Option<RawJson>,
    pub truncation_info: Option<RawJson>,
    pub created_at: Option<String>,
    pub external_media_type: Option<&'static str>,
    pub text_count: Option<i64>,
    pub video_count: Option<i64>,
    pub image_count: Option<RawJson>,
    pub comment_count: Option<RawJson>,
    pub fetched_comment_count: Option<RawJson>,
    pub site: Option<RawJson>,
    pub source_url: Option<RawJson>,
    pub cover_url: Option<RawJson>,
    pub subtask_id: Option<i64>,
}

impl AttachmentDetailResponse {
    /// `AttachmentDetailResponse.from_context(context)`.
    pub fn from_context(context: &SubtaskContextRow) -> Self {
        let display = display_fields(context);
        AttachmentDetailResponse {
            id: context.id,
            filename: context.original_filename(),
            file_size: context.file_size(),
            mime_type: context.mime_type(),
            status: context.status.clone(),
            file_extension: context.file_extension(),
            text_length: Some(i64::from(context.text_length)),
            error_message: context.error_message.clone(),
            // `from_context` never sets `error_code` (declaration default).
            error_code: None,
            truncation_info: None,
            created_at: context.created_at.map(format_datetime),
            external_media_type: display.external_media_type,
            text_count: display.text_count,
            video_count: display.video_count,
            image_count: None,
            comment_count: display.comment_count,
            fetched_comment_count: display.fetched_comment_count,
            site: display.site,
            source_url: display.source_url,
            cover_url: display.cover_url,
            subtask_id: (context.subtask_id > 0).then_some(context.subtask_id),
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
