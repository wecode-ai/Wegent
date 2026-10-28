// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Seedance request contracts, including 2.5 reference roles and asset staging.

use crate::AppState;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

pub(super) async fn create(
    state: &AppState,
    config: &Value,
    prompt: &str,
    mode: Option<&str>,
    mut images: Vec<Value>,
    videos: &[Value],
    audios: &[Value],
) -> Result<String> {
    if config["protocol"]
        .as_str()
        .is_some_and(|protocol| !protocol.is_empty() && protocol != "seedance")
    {
        bail!("Unknown video provider")
    }
    stage_assets(config, &mut images).await;
    let payload = payload(
        config,
        prompt,
        mode,
        &images,
        videos,
        audios,
        |kind, descriptor, role| {
            state
                .video_extensions
                .provider_content("seedance", kind, descriptor, role)
        },
    )?;
    let base = config["base_url"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/');
    let http = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(30))
        .build()?;
    let mut request = http
        .as_reqwest()
        .post(format!("{base}/contents/generations/tasks"))
        .bearer_auth(config["api_key"].as_str().unwrap_or(""))
        .header("Content-Type", "application/json")
        .json(&payload);
    if let Some(headers) = config["default_headers"].as_object() {
        for (key, value) in headers {
            if let Some(value) = value.as_str() {
                request = request.header(key, value);
            }
        }
    }
    let response = request.send().await?;
    let status = response.status();
    let bytes =
        super::super::super::knowledge::sources::bounded_body(response, 10 * 1024 * 1024).await?;
    if !status.is_success() {
        bail!(
            "Seedance API error ({}): {}",
            status.as_u16(),
            String::from_utf8_lossy(&bytes)
        )
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    value["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .context("Seedance API returned no job ID")
}

fn capability(config: &Value, key: &str, options: &str, default: Value) -> Value {
    let value = config.get(key).cloned().unwrap_or(default);
    config["capabilities"][options]
        .as_array()
        .and_then(|options| {
            options
                .iter()
                .find(|option| option["value"] == value || option["label"] == value)
        })
        .map(|option| {
            if crate::json_compat::python_truthy(&option["value"]) {
                option["value"].clone()
            } else {
                option["label"].clone()
            }
        })
        .unwrap_or(value)
}

fn payload(
    config: &Value,
    prompt: &str,
    mode: Option<&str>,
    images: &[Value],
    videos: &[Value],
    audios: &[Value],
    external: impl Fn(&str, &Value, &str) -> Option<Value>,
) -> Result<Value> {
    let mut content = vec![json!({"type":"text","text":prompt})];
    for (index, image) in images.iter().enumerate() {
        let Some(url) = image["url"].as_str().filter(|url| !url.is_empty()) else {
            continue;
        };
        let role = match mode {
            Some("first_frame") if index == 0 => "first_frame",
            Some("first_frame") if index == 1 => "last_frame",
            Some("last_frame") => "last_frame",
            _ => "reference_image",
        };
        content.push(json!({"type":"image_url","image_url":{"url":url},"role":role}));
    }
    for (kind, materials, role) in [
        ("video", videos, "reference_video"),
        ("audio", audios, "reference_audio"),
    ] {
        for material in materials {
            if let Some(custom) = external(kind, material, role) {
                content.push(custom);
                continue;
            }
            if let Some(url) = material["url"].as_str().filter(|url| !url.is_empty()) {
                let key = format!("{kind}_url");
                let mut value = json!({"type":key,"role":role});
                value[&key] = json!({"url":url});
                content.push(value);
            }
        }
    }
    reject_credentials(&content)?;
    let video = &config["videoConfig"];
    let model = config["model_id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .or_else(|| video["model"].as_str().filter(|v| !v.is_empty()))
        .or_else(|| config["model"].as_str().filter(|v| !v.is_empty()))
        .unwrap_or("doubao-seedance-1-5-pro-251215");
    let v25 = model.starts_with("doubao-seedance-2-5");
    let mut value = json!({"model":model,"content":content,"resolution":capability(video,"resolution","resolutions",json!(if v25{"720p"}else{"480p"})),"ratio":capability(video,"ratio","aspect_ratios",json!(if v25{"adaptive"}else{"16:9"})),"duration":video.get("duration").cloned().unwrap_or(json!(if v25{-1}else{5})),"watermark":video.get("watermark").cloned().unwrap_or(json!(false))});
    let audio = video
        .get("generate_audio")
        .filter(|v| !v.is_null())
        .or_else(|| {
            video["capabilities"]
                .get("generate_audio")
                .filter(|v| !v.is_null())
        });
    if let Some(audio) = audio {
        value["generate_audio"] = audio.clone();
    }
    if v25 {
        let generation = config["generation_mode_id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or_else(|| video["generation_mode_id"].as_str())
            .unwrap_or("");
        let task_type = video["omni_reference_task_type"]
            .as_str()
            .filter(|v| !v.is_empty())
            .or(match generation {
                "omni_reference" => Some("auto"),
                "reference" | "edit" | "extend" => Some(generation),
                _ => None,
            });
        if let Some(task_type) = task_type {
            value["omni_reference_task_type"] = json!(task_type);
        }
        for key in ["output_format", "priority"] {
            if let Some(raw) = video.get(key).filter(|v| !v.is_null()) {
                value[key] = raw.clone();
            }
        }
    } else if let Some(mode) = mode {
        value["image_mode"] = json!(mode);
    }
    Ok(value)
}

fn reject_credentials(content: &[Value]) -> Result<()> {
    for material in content {
        let key = material["type"].as_str().unwrap_or("");
        if let Some(raw) = material[key]["url"].as_str()
            && let Ok(url) = url::Url::parse(raw)
        {
            for (key, _) in url.query_pairs() {
                let normalized = key.trim().to_lowercase().replace('_', "-");
                let compact = normalized.replace('-', "");
                if [
                    "access-token",
                    "api-key",
                    "ossaccesskeyid",
                    "signature",
                    "security-token",
                    "x-oss-signature",
                    "x-oss-credential",
                    "x-oss-security-token",
                ]
                .contains(&normalized.as_str())
                    || ["credential", "securitytoken", "signature"]
                        .iter()
                        .any(|suffix| compact.ends_with(suffix))
                    || (compact.contains("access") && compact.contains("key"))
                {
                    bail!(
                        "Credential-bearing media URLs are not allowed in video provider requests; configure a public CDN endpoint"
                    )
                }
            }
        }
    }
    Ok(())
}

async fn stage_assets(config: &Value, images: &mut [Value]) {
    let Some(base) = crate::config::env_or_dotenv("SEEDANCE_ASSET_BASE_URL")
        .filter(|value| !value.trim().is_empty())
    else {
        return;
    };
    let Some(group) = crate::config::env_or_dotenv("SEEDANCE_ASSET_GROUP_ID")
        .filter(|value| !value.trim().is_empty())
    else {
        return;
    };
    let Some(user) = config["default_headers"]
        .as_object()
        .and_then(|headers| {
            headers.iter().find(|(key, value)| {
                key.eq_ignore_ascii_case("wecode-user") && crate::json_compat::python_truthy(value)
            })
        })
        .and_then(|(_, value)| value.as_str())
    else {
        return;
    };
    let Ok(http) = brz_http::Client::builder()
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
    else {
        return;
    };
    for image in images {
        let Some(url) = image["url"]
            .as_str()
            .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        else {
            continue;
        };
        if let Ok(Some(asset)) = stage_asset(
            &http,
            base.trim().trim_end_matches('/'),
            group.trim(),
            user,
            url,
        )
        .await
        {
            image["url"] = json!(asset);
        }
    }
}

async fn stage_asset(
    http: &brz_http::Client,
    base: &str,
    group: &str,
    user: &str,
    url: &str,
) -> Result<Option<String>> {
    let response = http
        .post(format!("{base}/CreateAsset"))?
        .header("wecode-user", user)
        .json(&json!({"GroupId":group,"URL":url,"AssetType":"Image"}))
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let value: Value = response.json().await?;
    let Some(id) = value["Id"].as_str().filter(|id| !id.trim().is_empty()) else {
        return Ok(None);
    };
    if value["Status"] == "Active" {
        return Ok(Some(format!("asset://{}", id.trim())));
    }
    let interval = crate::config::env_or_dotenv("SEEDANCE_ASSET_STATUS_POLL_INTERVAL_SECONDS")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(5)
        .max(1);
    let timeout = crate::config::env_or_dotenv("SEEDANCE_ASSET_STATUS_TIMEOUT_SECONDS")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(60)
        .max(interval);
    let mut elapsed = 0;
    while elapsed <= timeout {
        let response = http
            .post(format!("{base}/GetAsset"))?
            .header("wecode-user", user)
            .json(&json!({"Id":id}))
            .send()
            .await?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let value: Value = response.json().await?;
        if value["Status"] == "Active" {
            return Ok(Some(format!("asset://{}", id.trim())));
        }
        if elapsed + interval > timeout {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
        elapsed += interval;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v25_uses_resolved_model_capabilities_and_reference_roles() {
        let config = json!({"model_id":"doubao-seedance-2-5-pro","generation_mode_id":"omni_reference","videoConfig":{"resolution":"高清","capabilities":{"resolutions":[{"label":"高清","value":"1080p"}],"generate_audio":true},"output_format":"mp4","priority":"flex"}});
        let result = payload(
            &config,
            "video",
            Some("first_frame"),
            &[
                json!({"url":"https://cdn/a"}),
                json!({"url":"https://cdn/b"}),
                json!({"url":"https://cdn/c"}),
            ],
            &[],
            &[],
            |_, _, _| None,
        )
        .unwrap();
        assert_eq!(result["resolution"], "1080p");
        assert_eq!(result["ratio"], "adaptive");
        assert_eq!(result["duration"], -1);
        assert_eq!(result["omni_reference_task_type"], "auto");
        assert!(result.get("image_mode").is_none());
        assert_eq!(result["content"][1]["role"], "first_frame");
        assert_eq!(result["content"][2]["role"], "last_frame");
        assert_eq!(result["content"][3]["role"], "reference_image");
    }
    #[test]
    fn credential_urls_are_rejected_but_public_attachment_tokens_are_allowed() {
        for key in [
            "X-Amz-Credential",
            "X_OSS_Signature",
            "OSSAccessKeyId",
            "api_key",
        ] {
            assert!(reject_credentials(&[json!({"type":"image_url","image_url":{"url":format!("https://cdn/a?{key}=secret")}})]).is_err());
        }
        assert!(reject_credentials(&[json!({"type":"video_url","video_url":{"url":"https://cdn/api/attachments/download/shared?token=jwt"}})]).is_ok());
    }
}
