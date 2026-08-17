// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, VecDeque};
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use axum::http::StatusCode;
use base64::Engine;
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::{proxy_client_without_redirects, VisionSidecarUpstream};
use crate::logging::log_executor_event;
use crate::protocol::{
    CODEX_FILES_MENTIONED_HEADER, CODEX_IMAGE_REFERENCE_PREFIX, CODEX_REQUEST_MARKER,
};
use crate::server::HttpError;

const DESCRIPTION_MAX_CHARS: usize = 2_000;
const CONTEXT_MAX_CHARS: usize = 800;
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;
const VISION_CONCURRENCY: usize = 3;
const DESCRIPTION_CACHE_MAX_ENTRIES: usize = 256;
const DESCRIPTION_CACHE_MAX_BYTES: usize = 1024 * 1024;
const DESCRIPTION_PREFIX: &str =
    "[Image content described by a vision model because the primary model cannot see images:\n";
const DESCRIPTION_FAILED_PREFIX: &str =
    "[An image was attached but could not be processed by the vision sidecar: ";
const DESCRIPTION_LIMIT_REACHED: &str =
    "[An image was attached but the per-turn vision description limit was reached.]";

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ImageJob {
    image_url: String,
    detail: Option<String>,
    context: String,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    description: String,
    size_bytes: usize,
}

#[derive(Debug, Default)]
struct DescriptionCache {
    entries: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
    bytes: usize,
}

impl DescriptionCache {
    fn get(&mut self, key: &str) -> Option<String> {
        let description = self.entries.get(key)?.description.clone();
        self.touch(key);
        Some(description)
    }

    fn insert(&mut self, key: String, description: String) {
        let size_bytes = key.len().saturating_add(description.len());
        if size_bytes > DESCRIPTION_CACHE_MAX_BYTES {
            return;
        }
        if let Some(existing) = self.entries.remove(&key) {
            self.bytes = self.bytes.saturating_sub(existing.size_bytes);
            self.order.retain(|candidate| candidate != &key);
        }
        while self.entries.len() >= DESCRIPTION_CACHE_MAX_ENTRIES
            || self.bytes.saturating_add(size_bytes) > DESCRIPTION_CACHE_MAX_BYTES
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(entry.size_bytes);
            }
        }
        self.bytes = self.bytes.saturating_add(size_bytes);
        self.order.push_back(key.clone());
        self.entries.insert(
            key,
            CacheEntry {
                description,
                size_bytes,
            },
        );
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|candidate| candidate != key);
        self.order.push_back(key.to_owned());
    }
}

fn description_cache() -> &'static Mutex<DescriptionCache> {
    static CACHE: OnceLock<Mutex<DescriptionCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(DescriptionCache::default()))
}

fn vision_concurrency_limiter() -> &'static Semaphore {
    static LIMITER: OnceLock<Semaphore> = OnceLock::new();
    LIMITER.get_or_init(|| Semaphore::new(VISION_CONCURRENCY))
}

#[derive(Debug)]
struct DescriptionExecution {
    job: ImageJob,
    cache_key: Option<String>,
    outcome: Result<String, String>,
}

pub(super) async fn replace_images_with_descriptions(
    sidecar: Option<&VisionSidecarUpstream>,
    body: &[u8],
) -> Result<Vec<u8>, HttpError> {
    let Some(sidecar) = sidecar else {
        return Ok(body.to_vec());
    };
    let mut request = serde_json::from_slice::<Value>(body).map_err(|error| HttpError {
        status: StatusCode::BAD_REQUEST,
        detail: format!("Invalid Codex Responses request: {error}"),
    })?;
    let context = request_context(&request);
    let mut jobs = Vec::new();
    collect_image_jobs(&request, &context, &mut jobs);
    if jobs.is_empty() {
        return Ok(body.to_vec());
    }

    let started_at = Instant::now();
    log_executor_event(
        "vision sidecar request started",
        &[
            ("image_count", jobs.len().to_string()),
            (
                "max_descriptions",
                sidecar.max_descriptions_per_turn.to_string(),
            ),
            ("api_format", sidecar.api_format.clone()),
            ("vision_model", sidecar.model_id.clone()),
            ("concurrency", VISION_CONCURRENCY.to_string()),
        ],
    );

    let mut descriptions = HashMap::new();
    let mut unique_jobs = Vec::new();
    let mut duplicate_count = 0;
    for job in &jobs {
        if unique_jobs.contains(job) {
            duplicate_count += 1;
            continue;
        }
        unique_jobs.push(job.clone());
    }

    let mut cache_hits = 0;
    let mut executions = Vec::new();
    for job in unique_jobs {
        let cache_key = description_cache_key(&job, sidecar);
        let cached = cache_key.as_deref().and_then(|key| {
            description_cache()
                .lock()
                .expect("vision description cache should not be poisoned")
                .get(key)
        });
        if let Some(description) = cached {
            cache_hits += 1;
            descriptions.insert(job, description);
            continue;
        }
        executions.push((job, cache_key));
    }

    let capped_count = executions
        .len()
        .saturating_sub(sidecar.max_descriptions_per_turn);
    for (job, _) in executions.iter().skip(sidecar.max_descriptions_per_turn) {
        descriptions.insert(job.clone(), DESCRIPTION_LIMIT_REACHED.to_owned());
    }
    executions.truncate(sidecar.max_descriptions_per_turn);
    let cache_misses = executions.len();

    let outcomes = stream::iter(executions)
        .map(|(job, cache_key)| async move {
            DescriptionExecution {
                outcome: describe_image(sidecar, &job).await,
                job,
                cache_key,
            }
        })
        .buffer_unordered(VISION_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    let mut successful_descriptions = 0;
    let mut failed_descriptions = 0;
    for execution in outcomes {
        let description = match execution.outcome {
            Ok(description) => {
                successful_descriptions += 1;
                if let Some(cache_key) = execution.cache_key {
                    description_cache()
                        .lock()
                        .expect("vision description cache should not be poisoned")
                        .insert(cache_key, description.clone());
                }
                description
            }
            Err(error) => {
                failed_descriptions += 1;
                format!("{DESCRIPTION_FAILED_PREFIX}{error}]")
            }
        };
        descriptions.insert(execution.job, description);
    }

    let (cache_entries, cache_bytes) = {
        let cache = description_cache()
            .lock()
            .expect("vision description cache should not be poisoned");
        (cache.entries.len(), cache.bytes)
    };
    log_executor_event(
        "vision sidecar request completed",
        &[
            ("image_count", jobs.len().to_string()),
            ("description_count", descriptions.len().to_string()),
            ("success_count", successful_descriptions.to_string()),
            ("failed_count", failed_descriptions.to_string()),
            ("capped_count", capped_count.to_string()),
            ("duplicate_count", duplicate_count.to_string()),
            ("cache_hits", cache_hits.to_string()),
            ("cache_misses", cache_misses.to_string()),
            ("cache_entries", cache_entries.to_string()),
            ("cache_bytes", cache_bytes.to_string()),
            ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
        ],
    );

    let mut index = 0;
    replace_image_blocks(&mut request, &jobs, &descriptions, &mut index);
    serde_json::to_vec(&request).map_err(|error| HttpError {
        status: StatusCode::INTERNAL_SERVER_ERROR,
        detail: format!("Failed to encode vision sidecar request: {error}"),
    })
}

fn request_context(request: &Value) -> String {
    let mut parts = Vec::new();
    collect_text(request.get("input"), &mut parts);
    let context = strip_generated_attachment_markup(&parts.join("\n"));
    truncate_chars_from_end(&context, CONTEXT_MAX_CHARS)
}

fn collect_text(value: Option<&Value>, parts: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(items) => {
            for item in items {
                collect_text(Some(item), parts);
            }
        }
        Value::Object(object) => {
            if matches!(
                object.get("type").and_then(Value::as_str),
                Some("input_text" | "text")
            ) {
                if let Some(text) = object.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            for key in ["content", "output"] {
                collect_text(object.get(key), parts);
            }
        }
        _ => {}
    }
}

fn collect_image_jobs(value: &Value, context: &str, jobs: &mut Vec<ImageJob>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_image_jobs(item, context, jobs);
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("input_image") {
                jobs.push(ImageJob {
                    image_url: object
                        .get("image_url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    detail: object
                        .get("detail")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    context: context.to_owned(),
                });
                return;
            }
            for key in ["input", "content", "output"] {
                if let Some(child) = object.get(key) {
                    collect_image_jobs(child, context, jobs);
                }
            }
        }
        _ => {}
    }
}

fn replace_image_blocks(
    value: &mut Value,
    jobs: &[ImageJob],
    descriptions: &HashMap<ImageJob, String>,
    index: &mut usize,
) {
    match value {
        Value::Array(items) => {
            for item in items {
                replace_image_blocks(item, jobs, descriptions, index);
            }
        }
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("input_image") {
                let job = jobs.get(*index);
                *index += 1;
                let replacement = job
                    .and_then(|job| descriptions.get(job))
                    .cloned()
                    .unwrap_or_else(|| DESCRIPTION_LIMIT_REACHED.to_owned());
                *value = json!({"type": "input_text", "text": replacement});
                return;
            }
            for key in ["input", "content", "output"] {
                if let Some(child) = object.get_mut(key) {
                    replace_image_blocks(child, jobs, descriptions, index);
                }
            }
        }
        _ => {}
    }
}

fn description_cache_key(job: &ImageJob, sidecar: &VisionSidecarUpstream) -> Option<String> {
    if !job.image_url.starts_with("data:") {
        return None;
    }
    let normalized_context = job.context.split_whitespace().collect::<Vec<_>>().join(" ");
    let identity = [
        sidecar.api_format.as_str(),
        sidecar.request_url.as_str(),
        sidecar.model_id.as_str(),
        job.detail.as_deref().unwrap_or("high"),
        &sha256_hex(job.image_url.as_bytes()),
        &sha256_hex(normalized_context.as_bytes()),
    ]
    .join("\0");
    Some(sha256_hex(identity.as_bytes()))
}

fn sha256_hex(value: &[u8]) -> String {
    format!("{:x}", Sha256::digest(value))
}

async fn describe_image(sidecar: &VisionSidecarUpstream, job: &ImageJob) -> Result<String, String> {
    validate_image_url(&job.image_url)?;
    validate_vision_request_url(&sidecar.request_url)?;
    let deadline = tokio::time::Instant::now() + sidecar.timeout;
    let _permit = tokio::time::timeout_at(deadline, vision_concurrency_limiter().acquire())
        .await
        .map_err(|_| "vision model queue wait timed out".to_owned())?
        .expect("vision concurrency limiter should remain open");
    let client = proxy_client_without_redirects(sidecar.proxy_url.as_deref())
        .map_err(|error| error.detail)?;
    let body = vision_request_body(sidecar, job);
    let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
    if remaining.is_zero() {
        return Err("vision model queue wait timed out".to_owned());
    }
    let mut request = client
        .post(&sidecar.request_url)
        .bearer_auth(&sidecar.api_key)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .timeout(remaining)
        .json(&body);
    if sidecar.api_format == "anthropic-messages" {
        request = request
            .header("x-api-key", &sidecar.api_key)
            .header("anthropic-version", "2023-06-01");
    }
    for (key, value) in &sidecar.default_headers {
        request = request.header(key, value);
    }
    let response = request.send().await.map_err(vision_request_error)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("vision model returned HTTP {}", status.as_u16()));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|error| format!("vision model returned invalid JSON: {error}"))?;
    let text = extract_description(&sidecar.api_format, &payload)
        .ok_or_else(|| "vision model returned no description".to_owned())?;
    let text = truncate_chars(text.trim(), DESCRIPTION_MAX_CHARS);
    if text.is_empty() {
        return Err("vision model returned an empty description".to_owned());
    }
    Ok(format!("{DESCRIPTION_PREFIX}{text}]"))
}

fn vision_request_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "vision model request timed out".to_owned()
    } else if error.is_connect() {
        "vision model connection failed".to_owned()
    } else {
        "vision model request failed".to_owned()
    }
}

fn vision_request_body(sidecar: &VisionSidecarUpstream, job: &ImageJob) -> Value {
    let prompt = vision_prompt(&job.context);
    match sidecar.api_format.as_str() {
        "openai-chat-completions" => json!({
            "model": sidecar.model_id,
            "stream": false,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": job.image_url,
                            "detail": job.detail.as_deref().unwrap_or("high")
                        }
                    }
                ]
            }]
        }),
        "anthropic-messages" => json!({
            "model": sidecar.model_id,
            "stream": false,
            "max_tokens": 2_000,
            "messages": [{
                "role": "user",
                "content": [
                    anthropic_image_block(&job.image_url),
                    {"type": "text", "text": prompt}
                ]
            }]
        }),
        _ => json!({
            "model": sidecar.model_id,
            "stream": false,
            "store": false,
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": job.image_url,
                        "detail": job.detail.as_deref().unwrap_or("high")
                    }
                ]
            }]
        }),
    }
}

fn vision_prompt(context: &str) -> String {
    let suffix = if context.is_empty() {
        String::new()
    } else {
        format!("\n\nThe user's request about this image:\n{context}")
    };
    format!(
        "Describe this image thoroughly and factually for a text-only coding model. \
Transcribe visible text verbatim. Include relevant UI layout, errors, code, charts, \
colors, and spatial relationships. Focus on details needed to answer the user's request. \
Output only the description.{suffix}"
    )
}

pub(super) fn anthropic_image_block(image_url: &str) -> Value {
    if let Some((media_type, data)) = parse_data_url(image_url) {
        json!({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": data
            }
        })
    } else {
        json!({
            "type": "image",
            "source": {"type": "url", "url": image_url}
        })
    }
}

fn extract_description<'a>(api_format: &str, payload: &'a Value) -> Option<&'a str> {
    match api_format {
        "openai-chat-completions" => payload
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str),
        "anthropic-messages" => payload
            .get("content")
            .and_then(Value::as_array)?
            .iter()
            .find(|item| item.get("type").and_then(Value::as_str) == Some("text"))?
            .get("text")
            .and_then(Value::as_str),
        _ => payload
            .get("output_text")
            .and_then(Value::as_str)
            .or_else(|| {
                payload
                    .get("output")
                    .and_then(Value::as_array)?
                    .iter()
                    .flat_map(|item| {
                        item.get("content")
                            .and_then(Value::as_array)
                            .into_iter()
                            .flatten()
                    })
                    .find_map(|item| {
                        matches!(
                            item.get("type").and_then(Value::as_str),
                            Some("output_text" | "text")
                        )
                        .then(|| item.get("text").and_then(Value::as_str))
                        .flatten()
                    })
            }),
    }
}

fn validate_image_url(image_url: &str) -> Result<(), String> {
    if image_url.starts_with("https://") {
        return Ok(());
    }
    let Some((media_type, data)) = parse_data_url(image_url) else {
        return Err("unsupported image URL scheme; expected data: or https:".to_owned());
    };
    if !matches!(
        media_type,
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "image/gif"
    ) {
        return Err(format!("unsupported image type {media_type}"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "malformed base64 image".to_owned())?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("image exceeds the 20 MB vision sidecar limit".to_owned());
    }
    Ok(())
}

fn validate_vision_request_url(request_url: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(request_url)
        .map_err(|_| "vision model endpoint is not a valid URL".to_owned())?;
    if url.scheme() == "https" {
        return Ok(());
    }
    let is_loopback = url.host_str().is_some_and(|host| {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if url.scheme() == "http" && is_loopback {
        return Ok(());
    }
    Err("vision model endpoint must use HTTPS unless it is loopback".to_owned())
}

fn parse_data_url(image_url: &str) -> Option<(&str, &str)> {
    let rest = image_url.strip_prefix("data:")?;
    let (metadata, data) = rest.split_once(',')?;
    let media_type = metadata.strip_suffix(";base64")?;
    Some((media_type, data))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_owned();
    }
    value.chars().take(limit).collect()
}

fn truncate_chars_from_end(value: &str, limit: usize) -> String {
    let character_count = value.chars().count();
    if character_count <= limit {
        return value.to_owned();
    }
    value
        .chars()
        .skip(character_count.saturating_sub(limit))
        .collect()
}

fn strip_generated_attachment_markup(value: &str) -> String {
    let mut inside_image = false;
    let mut inside_file_references = false;
    value
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            if trimmed == CODEX_FILES_MENTIONED_HEADER {
                inside_file_references = true;
                return false;
            }
            if inside_file_references {
                if trimmed == CODEX_REQUEST_MARKER {
                    inside_file_references = false;
                }
                return false;
            }
            if inside_image {
                if trimmed.contains("</image>") {
                    inside_image = false;
                }
                return false;
            }
            if trimmed.starts_with(CODEX_IMAGE_REFERENCE_PREFIX) {
                inside_image = !trimmed.contains("</image>");
                return false;
            }
            true
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sidecar(request_url: String) -> VisionSidecarUpstream {
        VisionSidecarUpstream {
            request_url,
            api_format: "openai-responses".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: format!("vision-test-{}", uuid::Uuid::new_v4()),
            max_descriptions_per_turn: 8,
            timeout: std::time::Duration::from_secs(5),
        }
    }

    #[test]
    fn collects_and_replaces_images_without_touching_tools() {
        let mut request = json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Inspect this error"},
                    {"type": "input_image", "image_url": "data:image/png;base64,YQ=="}
                ]
            }],
            "tools": [{
                "type": "function",
                "name": "input_image"
            }]
        });
        let context = request_context(&request);
        let mut jobs = Vec::new();
        collect_image_jobs(&request, &context, &mut jobs);
        let descriptions = HashMap::from([(
            jobs[0].clone(),
            "[Image content described by a vision model:\nA compiler error]".to_owned(),
        )]);
        let mut index = 0;

        replace_image_blocks(&mut request, &jobs, &descriptions, &mut index);

        assert_eq!(
            request.pointer("/input/0/content/1/type"),
            Some(&Value::String("input_text".to_owned()))
        );
        assert_eq!(
            request.pointer("/tools/0/name"),
            Some(&Value::String("input_image".to_owned()))
        );
    }

    #[test]
    fn builds_requests_for_supported_vision_protocols() {
        let job = ImageJob {
            image_url: "data:image/png;base64,YQ==".to_owned(),
            detail: Some("high".to_owned()),
            context: "Fix the screenshot error".to_owned(),
        };
        let mut sidecar = VisionSidecarUpstream {
            request_url: "https://example.com/responses".to_owned(),
            api_format: "openai-responses".to_owned(),
            api_key: "secret".to_owned(),
            default_headers: Vec::new(),
            proxy_url: None,
            model_id: "vision".to_owned(),
            max_descriptions_per_turn: 8,
            timeout: std::time::Duration::from_secs(45),
        };

        assert_eq!(
            vision_request_body(&sidecar, &job).pointer("/input/0/content/1/type"),
            Some(&Value::String("input_image".to_owned()))
        );
        sidecar.api_format = "openai-chat-completions".to_owned();
        assert_eq!(
            vision_request_body(&sidecar, &job).pointer("/messages/0/content/1/type"),
            Some(&Value::String("image_url".to_owned()))
        );
        sidecar.api_format = "anthropic-messages".to_owned();
        assert_eq!(
            vision_request_body(&sidecar, &job).pointer("/messages/0/content/0/type"),
            Some(&Value::String("image".to_owned()))
        );
    }

    #[test]
    fn validates_supported_image_sources_and_size() {
        assert!(validate_image_url("https://example.com/image.png").is_ok());
        assert!(validate_image_url("data:image/png;base64,YQ==").is_ok());
        assert!(validate_image_url("http://example.com/image.png").is_err());
        assert!(validate_image_url("data:image/svg+xml;base64,YQ==").is_err());
    }

    #[test]
    fn validates_secure_or_loopback_vision_endpoints() {
        assert!(validate_vision_request_url("https://vision.example/v1/responses").is_ok());
        assert!(validate_vision_request_url("http://localhost:8080/v1/responses").is_ok());
        assert!(validate_vision_request_url("http://127.0.0.1:8080/v1/responses").is_ok());
        assert!(validate_vision_request_url("http://[::1]:8080/v1/responses").is_ok());
        assert!(validate_vision_request_url("http://vision.example/v1/responses").is_err());
        assert!(validate_vision_request_url("http://127.0.0.1.vision.example/v1").is_err());
        assert!(validate_vision_request_url("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_vision_request_url("file:///tmp/vision").is_err());
    }

    #[test]
    fn request_context_keeps_text_nearest_the_current_image() {
        let oldest = format!("oldest-marker-{}", "x".repeat(CONTEXT_MAX_CHARS));
        let latest = "latest image request";
        let request = json!({
            "input": [{
                "type": "message",
                "content": [
                    {"type": "input_text", "text": oldest},
                    {"type": "input_text", "text": latest},
                    {"type": "input_image", "image_url": "data:image/png;base64,YQ=="}
                ]
            }]
        });

        let context = request_context(&request);

        assert_eq!(context.chars().count(), CONTEXT_MAX_CHARS);
        assert!(!context.contains("oldest-marker"));
        assert!(context.ends_with(latest));
    }

    #[test]
    fn request_context_ignores_generated_image_reference_paths() {
        let request_with_path = |path: &str| {
            json!({
                "input": [{
                    "type": "message",
                    "content": [{
                        "type": "input_text",
                        "text": format!(
                            "{CODEX_FILES_MENTIONED_HEADER}\n\n## vision-sidecar.png: {path}\n\n{CODEX_REQUEST_MARKER}\nDescribe this image.\n\n{CODEX_IMAGE_REFERENCE_PREFIX}name=[Image #1] path=\"{path}\">\n</image>"
                        )
                    }]
                }]
            })
        };

        let first = request_context(&request_with_path("/tmp/100/vision-sidecar.png"));
        let second = request_context(&request_with_path("/tmp/200/vision-sidecar.png"));

        assert_eq!(first, "Describe this image.\n");
        assert_eq!(first, second);
    }

    #[test]
    fn extracts_descriptions_from_each_protocol() {
        assert_eq!(
            extract_description(
                "openai-responses",
                &json!({"output": [{"content": [{"type": "output_text", "text": "one"}]}]})
            ),
            Some("one")
        );
        assert_eq!(
            extract_description(
                "openai-chat-completions",
                &json!({"choices": [{"message": {"content": "two"}}]})
            ),
            Some("two")
        );
        assert_eq!(
            extract_description(
                "anthropic-messages",
                &json!({"content": [{"type": "text", "text": "three"}]})
            ),
            Some("three")
        );
    }

    #[tokio::test]
    async fn replaces_image_with_live_sidecar_description() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::sync::Arc;
        use tokio::{net::TcpListener, sync::Mutex};

        async fn describe(
            State(captured): State<Arc<Mutex<Option<Value>>>>,
            Json(body): Json<Value>,
        ) -> Json<Value> {
            *captured.lock().await = Some(body);
            Json(json!({
                "output": [{
                    "content": [{
                        "type": "output_text",
                        "text": "A terminal shows TypeError at UserPanel.tsx:84."
                    }]
                }]
            }))
        }

        let captured = Arc::new(Mutex::new(None));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("sidecar listener");
        let address = listener.local_addr().expect("sidecar address");
        let app = Router::new()
            .route("/responses", post(describe))
            .with_state(captured.clone());
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("sidecar server should run");
        });
        let mut sidecar = test_sidecar(format!("http://{address}/responses"));
        sidecar.model_id = "vision-model".to_owned();
        let body = serde_json::to_vec(&json!({
            "model": "deepseek-v4-flash",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Fix this screenshot"},
                    {"type": "input_image", "image_url": "data:image/png;base64,YQ=="}
                ]
            }]
        }))
        .expect("request body");

        let rewritten = replace_images_with_descriptions(Some(&sidecar), &body)
            .await
            .expect("vision rewrite");
        let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");

        assert_eq!(
            rewritten.pointer("/input/0/content/1/type"),
            Some(&Value::String("input_text".to_owned()))
        );
        assert!(rewritten
            .pointer("/input/0/content/1/text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("UserPanel.tsx:84")));
        let sidecar_request = captured
            .lock()
            .await
            .clone()
            .expect("captured sidecar request");
        assert_eq!(sidecar_request["model"], "vision-model");
        assert_eq!(
            sidecar_request.pointer("/input/0/content/1/type"),
            Some(&Value::String("input_image".to_owned()))
        );
    }

    #[tokio::test]
    async fn keeps_file_id_and_image_url_descriptions_positionally_aligned() {
        use axum::{routing::post, Json, Router};
        use tokio::net::TcpListener;

        async fn describe() -> Json<Value> {
            Json(json!({"output_text": "The valid second image."}))
        }

        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("sidecar listener");
        let address = listener.local_addr().expect("sidecar address");
        tokio::spawn(async move {
            axum::serve(listener, Router::new().route("/responses", post(describe)))
                .await
                .expect("sidecar server should run");
        });
        let sidecar = test_sidecar(format!("http://{address}/responses"));
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "file_id": "file-not-supported"},
                    {"type": "input_image", "image_url": "data:image/png;base64,c2Vjb25k"}
                ]
            }]
        }))
        .expect("request body");

        let rewritten = replace_images_with_descriptions(Some(&sidecar), &body)
            .await
            .expect("vision rewrite");
        let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");
        let first = rewritten
            .pointer("/input/0/content/0/text")
            .and_then(Value::as_str)
            .expect("first replacement");
        let second = rewritten
            .pointer("/input/0/content/1/text")
            .and_then(Value::as_str)
            .expect("second replacement");

        assert!(first.contains("unsupported image URL scheme"));
        assert!(second.contains("The valid second image."));
    }

    #[tokio::test]
    async fn does_not_follow_vision_endpoint_redirects() {
        use axum::{extract::State, response::Redirect, routing::post, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::net::TcpListener;

        async fn redirect(State(target): State<String>) -> Redirect {
            Redirect::temporary(&target)
        }

        async fn redirected_target(State(calls): State<Arc<AtomicUsize>>) {
            calls.fetch_add(1, Ordering::SeqCst);
        }

        let redirected_calls = Arc::new(AtomicUsize::new(0));
        let target_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("redirect target listener");
        let target_address = target_listener
            .local_addr()
            .expect("redirect target address");
        let target_app = Router::new()
            .route("/captured", post(redirected_target))
            .with_state(redirected_calls.clone());
        tokio::spawn(async move {
            axum::serve(target_listener, target_app)
                .await
                .expect("redirect target should run");
        });

        let redirect_listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("redirect listener");
        let redirect_address = redirect_listener.local_addr().expect("redirect address");
        let redirect_app = Router::new()
            .route("/responses", post(redirect))
            .with_state(format!("http://{target_address}/captured"));
        tokio::spawn(async move {
            axum::serve(redirect_listener, redirect_app)
                .await
                .expect("redirect server should run");
        });

        let sidecar = test_sidecar(format!("http://{redirect_address}/responses"));
        let job = ImageJob {
            image_url: "data:image/png;base64,YQ==".to_owned(),
            detail: None,
            context: "describe".to_owned(),
        };
        let error = describe_image(&sidecar, &job)
            .await
            .expect_err("redirect must fail closed");

        assert_eq!(error, "vision model returned HTTP 307");
        assert_eq!(redirected_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn caches_successful_data_image_descriptions() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::net::TcpListener;

        async fn describe(State(calls): State<Arc<AtomicUsize>>) -> Json<Value> {
            calls.fetch_add(1, Ordering::SeqCst);
            Json(json!({"output_text": "A cached screenshot description."}))
        }

        let calls = Arc::new(AtomicUsize::new(0));
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("sidecar listener");
        let address = listener.local_addr().expect("sidecar address");
        let app = Router::new()
            .route("/responses", post(describe))
            .with_state(calls.clone());
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("sidecar server should run");
        });
        let sidecar = test_sidecar(format!("http://{address}/responses"));
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Read this unique cache test"},
                    {"type": "input_image", "image_url": "data:image/png;base64,Y2FjaGU="}
                ]
            }]
        }))
        .expect("request body");

        replace_images_with_descriptions(Some(&sidecar), &body)
            .await
            .expect("first vision rewrite");
        replace_images_with_descriptions(Some(&sidecar), &body)
            .await
            .expect("cached vision rewrite");

        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn describes_images_with_bounded_concurrency() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::{net::TcpListener, time::sleep};

        #[derive(Clone)]
        struct ConcurrencyState {
            active: Arc<AtomicUsize>,
            maximum: Arc<AtomicUsize>,
        }

        async fn describe(State(state): State<ConcurrencyState>) -> Json<Value> {
            let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
            state.maximum.fetch_max(active, Ordering::SeqCst);
            sleep(std::time::Duration::from_millis(50)).await;
            state.active.fetch_sub(1, Ordering::SeqCst);
            Json(json!({"output_text": "A screenshot."}))
        }

        let state = ConcurrencyState {
            active: Arc::new(AtomicUsize::new(0)),
            maximum: Arc::new(AtomicUsize::new(0)),
        };
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("sidecar listener");
        let address = listener.local_addr().expect("sidecar address");
        let app = Router::new()
            .route("/responses", post(describe))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app)
                .await
                .expect("sidecar server should run");
        });
        let sidecar = test_sidecar(format!("http://{address}/responses"));
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "https://example.com/1.png"},
                    {"type": "input_image", "image_url": "https://example.com/2.png"},
                    {"type": "input_image", "image_url": "https://example.com/3.png"},
                    {"type": "input_image", "image_url": "https://example.com/4.png"}
                ]
            }]
        }))
        .expect("request body");

        let second_body = serde_json::to_vec(&json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "https://example.com/5.png"},
                    {"type": "input_image", "image_url": "https://example.com/6.png"},
                    {"type": "input_image", "image_url": "https://example.com/7.png"},
                    {"type": "input_image", "image_url": "https://example.com/8.png"}
                ]
            }]
        }))
        .expect("second request body");

        let (first, second) = tokio::join!(
            replace_images_with_descriptions(Some(&sidecar), &body),
            replace_images_with_descriptions(Some(&sidecar), &second_body)
        );
        first.expect("first vision rewrite");
        second.expect("second vision rewrite");

        let maximum = state.maximum.load(Ordering::SeqCst);
        assert!(maximum > 1, "descriptions should run concurrently");
        assert!(
            maximum <= VISION_CONCURRENCY,
            "concurrency must be bounded across simultaneous turns"
        );
    }

    #[tokio::test]
    async fn invalid_images_fail_closed_without_reaching_primary_model() {
        let sidecar = test_sidecar("http://127.0.0.1:1/responses".to_owned());
        let body = serde_json::to_vec(&json!({
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{
                    "type": "input_image",
                    "image_url": "data:image/svg+xml;base64,YQ=="
                }]
            }]
        }))
        .expect("request body");

        let rewritten = replace_images_with_descriptions(Some(&sidecar), &body)
            .await
            .expect("vision rewrite");
        let rewritten: Value = serde_json::from_slice(&rewritten).expect("rewritten request");

        assert_eq!(
            rewritten.pointer("/input/0/content/0/type"),
            Some(&Value::String("input_text".to_owned()))
        );
        assert!(rewritten
            .pointer("/input/0/content/0/text")
            .and_then(Value::as_str)
            .is_some_and(|text| text.contains("unsupported image type")));
        assert!(rewritten.pointer("/input/0/content/0/image_url").is_none());
    }
}
