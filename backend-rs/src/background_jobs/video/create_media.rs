// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Reference material authorization, source limits and direct image staging.

use crate::{AppState, responses::create::dispatch::ExecutionRequest};
use anyhow::{Context, Result, bail};
use brz_mysql::{FromMysqlRow, Json};
use serde_json::{Value, json};

pub(super) struct Media {
    pub images: Vec<Value>,
    pub videos: Vec<Value>,
    pub audios: Vec<Value>,
}

fn normalize_prompt(text: &str) -> String {
    let text = text
        .split_once("[User Question]:")
        .map(|(_, text)| text)
        .unwrap_or(text)
        .trim();
    let regex = regex::Regex::new(r"(?is)\A(?:\s*<attachment\b[^>]*>.*?</attachment>\s*)+")
        .expect("attachment wrapper");
    regex.replace(text, "").trim().into()
}

pub(super) fn prompt_and_images(request: &ExecutionRequest) -> (String, Vec<Value>) {
    let mut images = Vec::new();
    for attachment in &request.attachments {
        if !attachment["mime_type"]
            .as_str()
            .unwrap_or("")
            .starts_with("image/")
        {
            continue;
        }
        if let Some(url) = attachment["url"]
            .as_str()
            .or_else(|| attachment["content"].as_str())
            .filter(|url| !url.is_empty())
        {
            let mut image = json!({"url":url});
            if let Some(id) = attachment["id"]
                .as_i64()
                .filter(|id| *id != 0)
                .or_else(|| attachment["attachment_id"].as_i64())
            {
                image["attachment_id"] = json!(id);
            }
            images.push(image);
        }
    }
    let prompt = if let Some(prompt) = request.prompt.as_str() {
        normalize_prompt(prompt)
    } else if let Some(blocks) = request.prompt.as_array() {
        let mut texts = Vec::new();
        for block in blocks {
            if block["type"] == "input_text" {
                if let Some(text) = block["text"]
                    .as_str()
                    .filter(|text| !text.trim().is_empty())
                {
                    texts.push(text);
                }
            } else if block["type"] == "input_image"
                && let Some(url) = block["image_url"]
                    .as_str()
                    .filter(|url| !url.trim().is_empty())
            {
                images.push(json!({"url":url}));
            }
        }
        normalize_prompt(&texts.join("\n"))
    } else {
        normalize_prompt(&request.prompt.to_string())
    };
    (prompt, images)
}

fn image_identity(image: &Value) -> String {
    if let Some(id) = image["attachment_id"].as_i64() {
        format!("attachment:{id}")
    } else {
        format!("url:{}", image["url"].as_str().unwrap_or(""))
    }
}

pub(super) fn merge_images(images: &mut Vec<Value>, uploaded: Vec<Value>) {
    for uploaded in uploaded {
        let identity = image_identity(&uploaded);
        if let Some(existing) = images
            .iter_mut()
            .find(|image| image_identity(image) == identity)
        {
            if let Some(map) = uploaded.as_object() {
                existing
                    .as_object_mut()
                    .expect("image descriptor")
                    .extend(map.clone());
            }
        } else {
            images.push(uploaded)
        }
    }
}

#[derive(FromMysqlRow)]
struct Attachment {
    id: i64,
    user_id: i64,
    name: String,
    type_data: Option<Json<Value>>,
    updated_at: chrono::NaiveDateTime,
}

pub(super) async fn uploaded(
    state: &AppState,
    request: &ExecutionRequest,
    user: i64,
) -> Result<Media> {
    let mut media = Media {
        images: Vec::new(),
        videos: Vec::new(),
        audios: Vec::new(),
    };
    let Some(subtask) = request.user_subtask_id.filter(|id| *id != 0) else {
        return Ok(media);
    };
    let mut rows:Vec<Attachment>=state.mysql.fetch_all("SELECT id,user_id,name,type_data,updated_at FROM subtask_contexts WHERE subtask_id=? AND context_type='attachment' ORDER BY created_at,id",(subtask,)).await?;
    let order: Vec<_> = request
        .attachments
        .iter()
        .filter_map(|attachment| attachment["id"].as_i64())
        .collect();
    if !order.is_empty() {
        rows.sort_by_key(|row| {
            order
                .iter()
                .position(|id| *id == row.id)
                .unwrap_or(order.len())
        });
    }
    for row in rows {
        if row.user_id != user {
            continue;
        }
        let data = row.type_data.map(|data| data.0).unwrap_or(json!({}));
        let mime = data["mime_type"].as_str().unwrap_or("");
        let kind = if mime.starts_with("image/") {
            "image"
        } else if mime.starts_with("video/") {
            "video"
        } else if mime.starts_with("audio/") {
            "audio"
        } else {
            continue;
        };
        let mut descriptor = json!({"attachment_id":row.id,"storage_backend":data["storage_backend"].as_str().unwrap_or("mysql"),"storage_key":data["storage_key"].as_str().unwrap_or(""),"updated_at":row.updated_at.format("%Y-%m-%dT%H:%M:%S%.f").to_string(),"filename":data["original_filename"].as_str().unwrap_or(&row.name),"file_extension":data["file_extension"].as_str().unwrap_or(""),"file_size":data["file_size"].as_i64().unwrap_or(0),"mime_type":mime});
        if kind != "image" {
            if let Some(external) = state.video_extensions.resolve_material(&data, kind) {
                if let Some(map) = external.as_object() {
                    descriptor.as_object_mut().unwrap().extend(map.clone());
                }
            } else {
                descriptor["url"] = json!(public_url(state, row.id)?);
            }
        }
        match kind {
            "image" => media.images.push(descriptor),
            "video" => media.videos.push(descriptor),
            _ => media.audios.push(descriptor),
        }
    }
    Ok(media)
}

pub(super) fn public_url(state: &AppState, id: i64) -> Result<String> {
    let base=crate::config::env_or_dotenv("ATTACHMENT_PUBLIC_BASE_URL").filter(|base|!base.trim().is_empty()).context("ATTACHMENT_PUBLIC_BASE_URL must be configured to send local attachments to a remote video provider")?;
    let token = crate::attachments::public_link::generate_public_attachment_token(
        &state.auth,
        id,
        chrono::Duration::hours(1),
        chrono::Utc::now(),
    )?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("token", &token)
        .finish();
    Ok(format!(
        "{}/api/attachments/download/shared?{query}",
        base.trim().trim_end_matches('/')
    ))
}

pub(super) fn direct_stage(state: &AppState, images: Vec<Value>) -> Result<Vec<Value>> {
    images
        .into_iter()
        .map(|mut image| {
            if image["url"].as_str().unwrap_or("").is_empty() {
                let id = image["attachment_id"]
                    .as_i64()
                    .context("Video reference image has no readable URL")?;
                image["url"] = json!(public_url(state, id)?);
            }
            Ok(image)
        })
        .collect()
}

pub(super) fn image_mode(config: &Value, images: &[Value]) -> Option<String> {
    if images.is_empty() {
        None
    } else {
        Some(
            match config["generation_mode_id"].as_str() {
                Some("reference" | "omni_reference" | "edit" | "extend") => "reference",
                _ => "first_frame",
            }
            .into(),
        )
    }
}

pub(super) fn validate(
    config: &Value,
    images: &[Value],
    videos: &[Value],
    audios: &[Value],
) -> Result<()> {
    let capabilities = &config["videoConfig"]["capabilities"];
    if !images.is_empty() && capabilities["supports_image_input"] == false {
        bail!("This model does not support reference images")
    }
    if !videos.is_empty() && capabilities["supports_video_input"] != true {
        bail!("This model does not support reference videos")
    }
    if !audios.is_empty() && capabilities["supports_audio_input"] != true {
        bail!("This model does not support reference audios")
    }
    let mode_id = config["generation_mode_id"].as_str().unwrap_or("");
    if matches!(mode_id, "first_last_frame" | "keyframe") {
        if !videos.is_empty() {
            bail!("Mode '{mode_id}' does not support reference videos")
        }
        if !audios.is_empty() {
            bail!("Mode '{mode_id}' does not support reference audios")
        }
    }
    for (kind, materials) in [("image", images), ("video", videos), ("audio", audios)] {
        validate_metadata(capabilities, kind, materials)?;
    }
    let image_limit =
        if !videos.is_empty() && !capabilities["max_reference_images_with_video"].is_null() {
            &capabilities["max_reference_images_with_video"]
        } else {
            &capabilities["max_reference_images"]
        };
    let mode = capabilities["generation_modes"]
        .as_array()
        .and_then(|modes| modes.iter().find(|mode| mode["id"] == mode_id));
    let choose = |key: &str, fallback: &Value| {
        mode.and_then(|mode| mode.get(key))
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| fallback.clone())
    };
    let mode_image = choose("max_images_first_last", &choose("max_images", image_limit));
    limit(images.len(), &mode_image, "images", mode_id)?;
    limit(
        videos.len(),
        &choose("max_videos", &capabilities["max_reference_videos"]),
        "videos",
        mode_id,
    )?;
    limit(
        audios.len(),
        &choose("max_audios", &capabilities["max_reference_audios"]),
        "audios",
        mode_id,
    )?;
    limit(
        images.len() + videos.len() + audios.len(),
        &choose("max_total", &capabilities["max_reference_materials"]),
        "materials",
        mode_id,
    )?;
    if let Some(mode) = mode {
        if (mode["image_required"] == true || mode["first_frame_required"] == true)
            && images.is_empty()
        {
            bail!("Mode '{mode_id}' requires at least one reference image")
        }
        if mode["video_allowed"] == false && !videos.is_empty() {
            bail!("Mode '{mode_id}' does not support reference videos")
        }
        if mode["audio_allowed"] == false && !audios.is_empty() {
            bail!("Mode '{mode_id}' does not support reference audios")
        }
    } else {
        if capabilities["image_input_required"] == true && images.is_empty() {
            bail!("This model requires at least one reference image")
        }
        if capabilities["reference_material_required"] == true
            && images.is_empty()
            && videos.is_empty()
            && audios.is_empty()
        {
            bail!("This model requires at least one reference material")
        }
    }
    Ok(())
}

fn limit(count: usize, value: &Value, kind: &str, mode: &str) -> Result<()> {
    if let Some(limit) = value.as_u64()
        && count as u64 > limit
    {
        let suffix = if mode.is_empty() {
            String::new()
        } else {
            format!(" for mode '{mode}'")
        };
        bail!("Too many reference {kind}{suffix}: {count} > {limit}")
    }
    Ok(())
}
fn validate_metadata(config: &Value, kind: &str, materials: &[Value]) -> Result<()> {
    let formats: Vec<_> = config[format!("{kind}_formats")]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|value| value.to_lowercase().trim_start_matches('.').to_owned())
        .collect();
    let max_size = config[format!("{kind}_max_size_mb")].as_f64();
    for material in materials {
        let filename = material["filename"].as_str().unwrap_or("");
        let extension = material["file_extension"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| filename.rsplit_once('.').map(|(_, extension)| extension))
            .unwrap_or("")
            .to_lowercase()
            .trim_start_matches('.')
            .to_owned();
        if !formats.is_empty() && !extension.is_empty() && !formats.contains(&extension) {
            bail!("Unsupported reference {kind} format: {extension}")
        }
        if let (Some(limit), Some(size)) = (max_size, material["file_size"].as_f64())
            && size > limit * 1024.0 * 1024.0
        {
            bail!("Reference {kind} exceeds maximum size ({limit} MB)")
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(caps: Value, mode: &str) -> Value {
        json!({"videoConfig":{"capabilities":caps},"generation_mode_id":mode})
    }
    #[test]
    fn source_material_constraints_apply_even_without_optional_mode_flags() {
        assert!(
            validate(&config(json!({}), ""), &[], &[json!({})], &[])
                .unwrap_err()
                .to_string()
                .contains("reference videos")
        );
        assert!(validate(&config(json!({"supports_video_input":true,"generation_modes":[{"id":"first_last_frame"}]}),"first_last_frame"),&[],&[json!({})],&[]).is_err());
        assert!(validate(&config(json!({"supports_video_input":true,"max_reference_images":3,"max_reference_images_with_video":1}),""),&[json!({}),json!({})],&[json!({})],&[]).unwrap_err().to_string().contains("Too many reference images"));
    }
    #[test]
    fn mode_falls_back_to_global_limits_and_checks_uploaded_metadata() {
        assert!(validate(&config(json!({"supports_video_input":true,"max_reference_videos":1,"generation_modes":[{"id":"reference","video_allowed":true}]}),"reference"),&[],&[json!({}),json!({})],&[]).is_err());
        let config = config(json!({"image_formats":["png"],"image_max_size_mb":2}), "");
        assert!(validate(&config, &[json!({"filename":"x.jpg"})], &[], &[]).is_err());
        assert!(
            validate(
                &config,
                &[json!({"filename":"x.png","file_size":3*1024*1024})],
                &[],
                &[]
            )
            .is_err()
        );
        for mode in ["reference", "omni_reference", "edit", "extend"] {
            assert_eq!(
                image_mode(&json!({"generation_mode_id":mode}), &[json!({})]).as_deref(),
                Some("reference")
            );
        }
    }
    #[test]
    fn prompt_wrappers_are_removed_and_upload_metadata_merges_in_place() {
        let request = ExecutionRequest {
            prompt: json!([{"type":"input_text","text":"<attachment>context</attachment>\n[User Question]:\nA video"},{"type":"input_image","image_url":"data:image/png;base64,abc"}]),
            ..ExecutionRequest::default()
        };
        let (prompt, images) = prompt_and_images(&request);
        assert_eq!(prompt, "A video");
        assert_eq!(images[0]["url"], "data:image/png;base64,abc");
        let mut images = vec![json!({"url":"old","attachment_id":7})];
        merge_images(
            &mut images,
            vec![json!({"attachment_id":7,"storage_key":"k"})],
        );
        assert_eq!(images.len(), 1);
        assert_eq!(images[0]["url"], "old");
        assert_eq!(images[0]["storage_key"], "k");
    }
}
