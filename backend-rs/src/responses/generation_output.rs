// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Image and video generation output items
//! (`build_generation_output_item_from_block` in
//! `app/services/openapi/output_builder.py`).
//!
//! A persisted `blocks` entry whose `type` is `image` or `video` becomes an
//! `ImageGenerationCallOutputItem` / `VideoGenerationCallOutputItem`. The item
//! carries the block's own number forms and, for a block with an attachment
//! id, a freshly signed one-hour public download URL.
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::Value;

use super::http_error::HttpError;
use super::output_builder::{OutputItem, ToolOrTextBlock};
use crate::attachments::public_link::{build_public_attachment_download_url, public_base_url};
use crate::config::AuthConfig;

/// `VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS`
/// (`app/services/openapi/output_builder.py`).
const VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS: i64 = 3600;
/// `IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS`
/// (`app/services/execution/agents/image/download_url.py`).
const IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS: i64 = 3600;

/// `ImageGenerationCallOutputItem`.
#[derive(Debug, Serialize)]
pub struct ImageGenerationCallItem {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    status: &'static str,
    image_urls: Vec<String>,
    image_download_urls: Vec<String>,
    image_attachment_ids: Vec<i64>,
    metadata: serde_json::Map<String, Value>,
}

/// `VideoGenerationCallOutputItem` (Wegent extension).
#[derive(Debug, Serialize)]
pub struct VideoGenerationCallItem {
    #[serde(rename = "type")]
    kind: &'static str,
    id: String,
    status: &'static str,
    video_url: Option<Value>,
    video_attachment_id: Option<i64>,
    metadata: serde_json::Map<String, Value>,
}

/// `_generation_status`: the block's own status mapped onto the item's
/// `in_progress`/`completed`/`failed`, else the caller's default.
fn generation_status(block: &ToolOrTextBlock, default_status: &'static str) -> &'static str {
    let block_status = block.status.as_deref().unwrap_or("").trim().to_lowercase();
    if matches!(block_status.as_str(), "error" | "failed") {
        return "failed";
    }
    if block.is_placeholder.unwrap_or(false)
        || matches!(
            block_status.as_str(),
            "pending" | "queued" | "creating" | "streaming" | "in_progress"
        )
    {
        return "in_progress";
    }
    if matches!(block_status.as_str(), "done" | "completed") {
        return "completed";
    }
    default_status
}

/// `build_generation_output_item_from_block`: an `image`/`video` block as its
/// generation item, or `None` for a block of another kind (or without an id).
pub(super) fn build_generation_output_item_from_block(
    block: &ToolOrTextBlock,
    default_status: &'static str,
    config: &AuthConfig,
) -> Result<Option<OutputItem>, HttpError> {
    let block_id = block.id.clone().unwrap_or_default();
    if block_id.is_empty() {
        return Ok(None);
    }
    let status = generation_status(block, default_status);
    match block.kind.as_deref() {
        Some("image") => Ok(Some(OutputItem::ImageGenerationCall(
            build_image_generation_item(block, block_id, status, config)?,
        ))),
        Some("video") => Ok(Some(OutputItem::VideoGenerationCall(
            build_video_generation_item(block, block_id, status, config)?,
        ))),
        _ => Ok(None),
    }
}

/// The `image` branch of `build_generation_output_item_from_block`.
fn build_image_generation_item(
    block: &ToolOrTextBlock,
    id: String,
    status: &'static str,
    config: &AuthConfig,
) -> Result<ImageGenerationCallItem, HttpError> {
    let image_urls = string_list(block.image_urls.as_deref());
    let attachment_ids = int_list(block.image_attachment_ids.as_deref());
    let download_urls = if attachment_ids.is_empty() {
        string_list(block.image_download_urls.as_deref())
    } else {
        let now = Utc::now();
        let mut urls = Vec::with_capacity(attachment_ids.len());
        for attachment_id in &attachment_ids {
            urls.push(build_download_url(
                config,
                *attachment_id,
                IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS,
                now,
            )?);
        }
        urls
    };

    let mut metadata = serde_json::Map::new();
    // `block.get("image_count") or len(image_urls)`: a falsy count falls back
    // to the number of image URLs.
    let count = block
        .image_count
        .as_ref()
        .filter(|value| python_truthy(value))
        .cloned()
        .unwrap_or_else(|| Value::from(image_urls.len() as i64));
    metadata.insert("count".to_owned(), count);
    insert_if_present(&mut metadata, "size", block.image_size.as_ref());
    insert_if_present(
        &mut metadata,
        "download_url_expires_in_seconds",
        block.image_download_url_expires_in_seconds.as_ref(),
    );

    Ok(ImageGenerationCallItem {
        kind: "image_generation_call",
        id,
        status,
        image_urls,
        image_download_urls: download_urls,
        image_attachment_ids: attachment_ids,
        metadata,
    })
}

/// The `video` branch of `build_generation_output_item_from_block`.
fn build_video_generation_item(
    block: &ToolOrTextBlock,
    id: String,
    status: &'static str,
    config: &AuthConfig,
) -> Result<VideoGenerationCallItem, HttpError> {
    let attachment_id = block.video_attachment_id.as_ref().and_then(Value::as_i64);
    let video_url = match attachment_id {
        Some(attachment_id) => Some(Value::String(build_download_url(
            config,
            attachment_id,
            VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS,
            Utc::now(),
        )?)),
        // `block.get("video_url") or None`: a falsy stored URL stays null.
        None => block.video_url.clone().filter(python_truthy),
    };

    let mut metadata = serde_json::Map::new();
    insert_if_present(&mut metadata, "thumbnail", block.video_thumbnail.as_ref());
    insert_if_present(&mut metadata, "duration", block.video_duration.as_ref());
    insert_if_present(&mut metadata, "progress", block.video_progress.as_ref());
    if attachment_id.is_some() {
        metadata.insert(
            "download_url_expires_in_seconds".to_owned(),
            Value::from(VIDEO_DOWNLOAD_URL_EXPIRES_SECONDS),
        );
    }

    Ok(VideoGenerationCallItem {
        kind: "wegent_video_generation_call",
        id,
        status,
        video_url,
        video_attachment_id: attachment_id,
        metadata,
    })
}

/// `[value for value in values if isinstance(value, str)]`.
fn string_list(values: Option<&[Value]>) -> Vec<String> {
    values
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

/// `[value for value in values if isinstance(value, int)]`.
fn int_list(values: Option<&[Value]>) -> Vec<i64> {
    values
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_i64)
        .collect()
}

/// `{key: value for ... if value is not None}`: JSON null (or an absent field)
/// contributes no metadata entry.
fn insert_if_present(
    metadata: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&Value>,
) {
    if let Some(value) = value.filter(|value| !value.is_null()) {
        metadata.insert(key.to_owned(), value.clone());
    }
}

/// Python truthiness (`value or <default>`): null, false, zero, the empty
/// string, and empty collections are falsy.
fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// `build_video_download_url` / `build_image_download_url`: the signed
/// one-hour public attachment download URL.
fn build_download_url(
    config: &AuthConfig,
    attachment_id: i64,
    expires_seconds: i64,
    now: DateTime<Utc>,
) -> Result<String, HttpError> {
    build_public_attachment_download_url(
        config,
        public_base_url(),
        attachment_id,
        Duration::seconds(expires_seconds),
        now,
    )
    .map_err(|error| {
        tracing::error!(%error, attachment_id, "generation download URL signing failed");
        HttpError::internal("Internal server error")
    })
}
