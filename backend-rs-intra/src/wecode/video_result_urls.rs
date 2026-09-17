//! `WeiboVideoGenerationExtension.refresh_result_urls`
//! (`wecode/video/services/generation_extension.py`): re-sign the temporary
//! Weibo playback URLs of an assembled task detail response.
//!
//! The source walks the task-level `result.blocks` first and then every
//! subtask's `result.blocks`, keeps the `type == "video"` blocks, and re-signs
//! each distinct raw `video_url` through the internal multimedia signing
//! service (`super::media_signing::sign_urls`). A signing failure is logged
//! and leaves the response unchanged.
use std::collections::HashMap;

use async_trait::async_trait;
use brz_redis::RedisService;
use serde_json::Value;
use serde_json::value::RawValue;

use super::media_signing::{force_https_url, media_uid, sign_urls};
use wegent_backend_rs::video_result_urls::VideoResultUrlRefresh;

/// The internal Weibo video integration's client-facing URL refresh.
pub struct WeiboVideoResultUrls {
    /// The dedicated TAuth2 Redis endpoint (`app/services/tauth.py`), shared
    /// with the AIGC playback route.
    redis: Option<RedisService>,
}

impl WeiboVideoResultUrls {
    pub fn new(redis: Option<RedisService>) -> Self {
        Self { redis }
    }
}

#[async_trait]
impl VideoResultUrlRefresh for WeiboVideoResultUrls {
    async fn refresh_result_urls(
        &self,
        client: &brz_http::Client,
        results: &mut [&mut Box<RawValue>],
    ) -> anyhow::Result<()> {
        // `_video_blocks`: every payload is parsed once, and a payload
        // without a `blocks` list never changes.
        let mut payloads: Vec<Option<Value>> = results
            .iter()
            .map(|result| serde_json::from_str(result.get()).ok())
            .collect();
        let blocks = video_blocks(&payloads);
        if truthy_block_field(&payloads, &blocks, "media_id").is_empty() {
            return Ok(());
        }
        // `uid = _media_uid()` runs before the source's signing `try`, so a
        // missing media uid fails the request instead of leaving the URLs in
        // place.
        let uid = match media_uid() {
            Ok(uid) => uid,
            Err(error) => {
                return Err(anyhow::anyhow!("media uid unavailable: {}", error.stage()));
            }
        };
        let raw_urls = truthy_block_field(&payloads, &blocks, "video_url");
        let signed = match sign_urls(client, self.redis.as_ref(), &uid, &raw_urls).await {
            Ok(signed) => signed,
            Err(error) => {
                tracing::warn!(
                    stage = error.stage(),
                    "Failed to refresh Weibo playback URLs"
                );
                return Ok(());
            }
        };
        for index in apply_signed_urls(&mut payloads, &blocks, &signed) {
            if let Some(raw) = payloads[index]
                .as_ref()
                .and_then(|payload| serde_json::value::to_raw_value(payload).ok())
            {
                *results[index] = raw;
            }
        }
        Ok(())
    }
}

/// `_video_blocks`: the `type == "video"` blocks of every result payload,
/// addressed as `(payload index, block index)` in payload order.
fn video_blocks(payloads: &[Option<Value>]) -> Vec<(usize, usize)> {
    let mut blocks = Vec::new();
    for (payload_index, payload) in payloads.iter().enumerate() {
        let Some(list) = payload
            .as_ref()
            .and_then(|payload| payload.get("blocks"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for (block_index, block) in list.iter().enumerate() {
            if block.get("type").and_then(Value::as_str) == Some("video") {
                blocks.push((payload_index, block_index));
            }
        }
    }
    blocks
}

/// `str(block.get(key))` for every truthy `key` value of the given blocks,
/// de-duplicated in first occurrence order.
fn truthy_block_field(
    payloads: &[Option<Value>],
    blocks: &[(usize, usize)],
    key: &str,
) -> Vec<String> {
    let mut values: Vec<String> = Vec::new();
    for &(payload_index, block_index) in blocks {
        let Some(value) = block_at(payloads, payload_index, block_index)
            .and_then(|block| block.get(key).filter(|value| is_truthy(value)))
        else {
            continue;
        };
        let text = python_str(value);
        if !values.contains(&text) {
            values.push(text);
        }
    }
    values
}

/// Apply the signing results to the video blocks, mirroring
/// `block["video_url"] = _https(signed_url)`; returns the payload indices that
/// changed.
fn apply_signed_urls(
    payloads: &mut [Option<Value>],
    blocks: &[(usize, usize)],
    signed: &HashMap<String, Option<String>>,
) -> Vec<usize> {
    let mut changed: Vec<usize> = Vec::new();
    for &(payload_index, block_index) in blocks {
        let Some(block) = payloads[payload_index]
            .as_mut()
            .and_then(|payload| payload.get_mut("blocks"))
            .and_then(|blocks| blocks.get_mut(block_index))
        else {
            continue;
        };
        // `str(block.get("video_url") or "")`: a missing or falsy URL never
        // carries a signed entry.
        let raw_url = block
            .get("video_url")
            .filter(|value| is_truthy(value))
            .map(python_str)
            .unwrap_or_default();
        let Some(Some(signed_url)) = signed.get(&raw_url) else {
            continue;
        };
        let Value::Object(fields) = block else {
            continue;
        };
        fields.insert(
            "video_url".to_owned(),
            Value::String(force_https_url(signed_url)),
        );
        if !changed.contains(&payload_index) {
            changed.push(payload_index);
        }
    }
    changed
}

fn block_at(
    payloads: &[Option<Value>],
    payload_index: usize,
    block_index: usize,
) -> Option<&Value> {
    payloads[payload_index]
        .as_ref()?
        .get("blocks")?
        .get(block_index)
}

/// Python truthiness (`bool(value)`).
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
    }
}

/// `str(value)` for a block field: the source stringifies the value before
/// using it as a signing-map key. Non-scalar fields stringify differently from
/// Python, but both the signing request and the lookup apply the same
/// function, so an unserializable URL still yields no signed entry.
fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const RAW_A: &str = "http://cdn.example.invalid/o0/a.mp4";
    const RAW_B: &str = "http://cdn.example.invalid/o0/b.mp4";
    const SIGNED_A: &str = "https://cdn.example.invalid/o0/a.mp4?Expires=1789119959&ssig=x";

    fn payloads(values: Vec<Value>) -> Vec<Option<Value>> {
        values.into_iter().map(Some).collect()
    }

    #[test]
    fn video_blocks_follow_payload_and_block_order() {
        let payloads = payloads(vec![
            json!({"blocks": [
                {"type": "video", "media_id": "1", "video_url": RAW_A},
                {"type": "image", "url": "http://cdn.example.invalid/i.png"}
            ]}),
            json!({"blocks": [{"type": "video", "media_id": "2", "video_url": RAW_B}]}),
            json!({"video_config": {"model": "Seedance-2.5"}}),
            json!(null),
        ]);
        let blocks = video_blocks(&payloads);
        assert_eq!(blocks, vec![(0, 0), (1, 0)]);
        assert_eq!(
            truthy_block_field(&payloads, &blocks, "media_id"),
            vec!["1", "2"]
        );
    }

    #[test]
    fn truthy_fields_drop_empty_values_and_duplicates() {
        let payloads = payloads(vec![json!({"blocks": [
            {"type": "video", "media_id": "1", "video_url": RAW_A},
            {"type": "video", "media_id": "1", "video_url": RAW_A},
            {"type": "video", "media_id": 0, "video_url": ""},
            {"type": "video", "video_url": RAW_B}
        ]})]);
        let blocks = video_blocks(&payloads);
        assert_eq!(
            truthy_block_field(&payloads, &blocks, "media_id"),
            vec!["1"]
        );
        assert_eq!(
            truthy_block_field(&payloads, &blocks, "video_url"),
            vec![RAW_A, RAW_B]
        );
    }

    #[test]
    fn signed_urls_replace_only_matching_blocks() {
        let block = json!({
            "type": "video",
            "media_id": "5341574624903174",
            "video_url": RAW_A,
            "cover_url": "https://wx.example.invalid/a.jpg",
            "video_duration": 5.056,
            "video_progress": 100
        });
        let mut payloads = payloads(vec![
            json!({"blocks": [block.clone()]}),
            json!({"blocks": [
                {"type": "video", "media_id": "2", "video_url": ""},
                {"type": "video", "video_url": RAW_B}
            ]}),
        ]);
        let blocks = video_blocks(&payloads);
        let signed: HashMap<String, Option<String>> = HashMap::from([
            (RAW_A.to_owned(), Some(SIGNED_A.to_owned())),
            (RAW_B.to_owned(), None),
        ]);
        assert_eq!(apply_signed_urls(&mut payloads, &blocks, &signed), vec![0]);
        // Only `video_url` changes: every other field keeps its value.
        let mut expected = block;
        expected["video_url"] = json!(SIGNED_A);
        assert_eq!(payloads[0], Some(json!({"blocks": [expected]})));
        // An unsigned URL and a media-id-less block stay untouched.
        assert_eq!(
            payloads[1],
            Some(json!({"blocks": [
                {"type": "video", "media_id": "2", "video_url": ""},
                {"type": "video", "video_url": RAW_B}
            ]}))
        );
    }

    #[test]
    fn payload_without_video_blocks_is_untouched() {
        let payloads = payloads(vec![json!({"blocks": [{"type": "image"}]}), json!(null)]);
        let blocks = video_blocks(&payloads);
        assert!(blocks.is_empty());
        assert!(truthy_block_field(&payloads, &blocks, "media_id").is_empty());
    }
}
