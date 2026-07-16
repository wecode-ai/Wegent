// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};

use crate::image_preprocessor::prepare_image_bytes_for_model;

static SAVE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn is_vision_prompt(prompt: &Value) -> bool {
    prompt.as_array().into_iter().flatten().any(|block| {
        matches!(
            block.get("type").and_then(Value::as_str),
            Some("input_image" | "image" | "localImage" | "local_image")
        )
    })
}

pub fn append_text_to_vision_prompt(prompt: &Value, text: &str, prepend: bool) -> Value {
    let Some(blocks) = prompt.as_array() else {
        return prompt.clone();
    };

    let mut result = blocks.clone();
    for block in &mut result {
        if block.get("type").and_then(Value::as_str) != Some("input_text") {
            continue;
        }

        let existing = block.get("text").and_then(Value::as_str).unwrap_or("");
        let updated_text = if prepend {
            format!("{text}\n\n{existing}")
        } else {
            format!("{existing}\n{text}")
        };
        if let Some(object) = block.as_object_mut() {
            object.insert("text".to_owned(), Value::String(updated_text));
        }
        return Value::Array(result);
    }

    let text_block = json!({"type": "input_text", "text": text});
    if prepend {
        result.insert(0, text_block);
    } else {
        result.push(text_block);
    }
    Value::Array(result)
}

pub fn convert_openai_to_anthropic_content(content_blocks: &Value) -> Value {
    let Some(blocks) = content_blocks.as_array() else {
        return content_blocks.clone();
    };

    Value::Array(blocks.iter().filter_map(convert_content_block).collect())
}

pub async fn convert_openai_to_anthropic_content_async(content_blocks: Value) -> Value {
    tokio::task::spawn_blocking(move || convert_openai_to_anthropic_content(&content_blocks))
        .await
        .expect("multimodal conversion task panicked")
}

pub fn create_multimodal_query(anthropic_content: &Value) -> Value {
    json!([{
        "type": "user",
        "message": {
            "role": "user",
            "content": anthropic_content,
        },
    }])
}

pub fn save_vision_images(prompt: &Value, task_id: Option<&str>) -> io::Result<Vec<PathBuf>> {
    save_vision_images_to(prompt, &default_executor_home(), task_id)
}

pub fn save_vision_images_to(
    prompt: &Value,
    executor_home: &Path,
    task_id: Option<&str>,
) -> io::Result<Vec<PathBuf>> {
    let Some(blocks) = prompt.as_array() else {
        return Ok(Vec::new());
    };

    let pics_dir = executor_home
        .join("docs")
        .join("pics")
        .join(current_month_dir());
    fs::create_dir_all(&pics_dir)?;

    let mut saved_paths = Vec::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("input_image") {
            continue;
        }

        let image_url = block
            .get("image_url")
            .or_else(|| block.get("url"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let (media_type, data) = parse_data_uri(image_url);
        let Ok(image_bytes) = general_purpose::STANDARD.decode(data) else {
            continue;
        };

        let prefix = task_id
            .filter(|value| !value.is_empty())
            .map(|value| format!("{value}_"))
            .unwrap_or_default();
        let path = pics_dir.join(format!(
            "{prefix}{}{}",
            unique_filename_stem(),
            image_extension(&media_type)
        ));
        fs::write(&path, image_bytes)?;
        saved_paths.push(path);
    }

    Ok(saved_paths)
}

pub fn parse_data_uri(data_uri: &str) -> (String, String) {
    let Some(rest) = data_uri.strip_prefix("data:") else {
        return ("image/png".to_owned(), data_uri.to_owned());
    };
    let Some((media_type, data)) = rest.split_once(";base64,") else {
        return ("image/png".to_owned(), data_uri.to_owned());
    };
    if media_type.is_empty() || data.is_empty() {
        return ("image/png".to_owned(), data_uri.to_owned());
    }
    (media_type.to_owned(), data.to_owned())
}

fn convert_content_block(block: &Value) -> Option<Value> {
    match block.get("type").and_then(Value::as_str).unwrap_or("") {
        "input_text" => text_value(block)
            .filter(|text| !text.trim().is_empty())
            .map(|text| json!({"type": "text", "text": text})),
        "text" => text_value(block)
            .filter(|text| !text.trim().is_empty())
            .map(|_| block.clone()),
        "input_image" => {
            let image_url = block
                .get("image_url")
                .or_else(|| block.get("url"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let (media_type, data) = parse_data_uri(image_url);
            let (media_type, data) = prepare_base64_image_for_model(&media_type, &data);
            Some(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
                    "data": data,
                },
            }))
        }
        _ => Some(block.clone()),
    }
}

fn text_value(block: &Value) -> Option<&str> {
    block.get("text").and_then(Value::as_str)
}

fn prepare_base64_image_for_model(media_type: &str, data: &str) -> (String, String) {
    let Ok(image_data) = general_purpose::STANDARD.decode(data) else {
        return (media_type.to_owned(), data.to_owned());
    };

    let prepared = prepare_image_bytes_for_model(&image_data, media_type, None);
    if !prepared.resized {
        return (media_type.to_owned(), data.to_owned());
    }

    (
        prepared.mime_type,
        general_purpose::STANDARD.encode(prepared.data),
    )
}

fn default_executor_home() -> PathBuf {
    if let Some(home) = std::env::var_os("WEGENT_EXECUTOR_HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .map(|home| home.join(".wegent-executor"))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"))
}

fn image_extension(media_type: &str) -> &'static str {
    match media_type.to_ascii_lowercase().as_str() {
        "image/jpeg" | "image/jpg" => ".jpg",
        "image/gif" => ".gif",
        "image/webp" => ".webp",
        "image/bmp" => ".bmp",
        "image/svg+xml" => ".svg",
        _ => ".png",
    }
}

fn unique_filename_stem() -> String {
    let counter = SAVE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("{:x}{nanos:x}{counter:x}", std::process::id())
}

fn current_month_dir() -> String {
    let days_since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() / 86_400)
        .unwrap_or_default() as i64;
    let (year, month) = year_month_from_unix_days(days_since_epoch);
    format!("{year:04}{month:02}")
}

fn year_month_from_unix_days(days_since_epoch: i64) -> (i32, u32) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_parameter = (5 * day_of_year + 2) / 153;
    let month = month_parameter + if month_parameter < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + if month <= 2 { 1 } else { 0 };
    (year as i32, month as u32)
}
