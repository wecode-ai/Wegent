// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `refresh_task_image_download_urls`
//! (`app/services/execution/agents/image/download_url.py`): every generated
//! image block of an assembled task detail response gets a fresh one-hour
//! public download URL.
//!
//! The result payloads are opaque stored JSON whose unknown keys must survive
//! byte-for-byte (`dict(block)` copy semantics), so the walk works on the
//! decoded value and re-serializes only a payload it actually refreshed.
use chrono::{DateTime, Duration, Utc};
use serde_json::Value;
use serde_json::value::RawValue;

use crate::attachments::public_link::{build_public_attachment_download_url, public_base_url};
use crate::config::AuthConfig;
use crate::json_compat::raw_json;

/// `IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS`.
const IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS: i64 = 3600;

/// `refresh_task_image_download_urls`: the task-level result first, then every
/// subtask result in subtask order.
///
/// The source signs each URL with its own `datetime.now(timezone.utc)`; one
/// timestamp per request keeps that difference sub-second.
pub(crate) fn refresh_task_image_download_urls(
    config: &AuthConfig,
    results: &mut [&mut Box<RawValue>],
    now: DateTime<Utc>,
) -> anyhow::Result<()> {
    for result in results.iter_mut() {
        if let Some(refreshed) = refresh_image_result_download_urls(config, result.get(), now)? {
            **result = refreshed;
        }
    }
    Ok(())
}

/// `refresh_image_result_download_urls`: the refreshed payload, or `None` when
/// the source returns the value unchanged (not an object, no `blocks` list, or
/// no image block with usable attachment ids).
fn refresh_image_result_download_urls(
    config: &AuthConfig,
    raw: &str,
    now: DateTime<Utc>,
) -> anyhow::Result<Option<Box<RawValue>>> {
    // A payload that is not stored JSON is not a `dict` in the source and
    // stays unchanged.
    let Ok(mut payload) = serde_json::from_str::<Value>(raw) else {
        return Ok(None);
    };
    let Some(blocks) = payload.get_mut("blocks").and_then(Value::as_array_mut) else {
        return Ok(None);
    };
    let mut refreshed = false;
    for block in blocks.iter_mut() {
        let Value::Object(fields) = block else {
            continue;
        };
        if fields.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let Some(candidates) = fields.get("image_attachment_ids").and_then(Value::as_array) else {
            continue;
        };
        let ids: Vec<i64> = candidates.iter().filter_map(attachment_id).collect();
        if ids.is_empty() {
            continue;
        }
        let mut urls = Vec::with_capacity(ids.len());
        for id in ids {
            urls.push(Value::String(build_public_attachment_download_url(
                config,
                public_base_url(),
                id,
                Duration::seconds(IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS),
                now,
            )?));
        }
        // `refreshed_block["image_download_urls"] = [...]` and the expiry
        // marker; every other stored key keeps its position and value.
        fields.insert("image_download_urls".to_owned(), Value::Array(urls));
        fields.insert(
            "image_download_url_expires_in_seconds".to_owned(),
            Value::from(IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS),
        );
        refreshed = true;
    }
    Ok(refreshed.then(|| raw_json(&payload)))
}

/// `isinstance(attachment_id, int)`: only JSON integers are signed. The
/// source's `bool` case (`bool` subclasses `int`) cannot appear in a stored
/// `image_attachment_ids` list.
fn attachment_id(value: &Value) -> Option<i64> {
    value.as_i64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{DecodingKey, Validation, decode};
    use serde_json::json;
    use std::str::FromStr;

    fn config() -> AuthConfig {
        AuthConfig {
            jwt_key: "test-key".to_string(),
            legacy_jwt_keys: Vec::new(),
            algorithm: "HS256".to_string(),
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::from_timestamp(1_789_887_883, 0).expect("fixed time")
    }

    fn raw(value: Value) -> Box<RawValue> {
        raw_json(&value)
    }

    /// Refresh one payload and return the resulting JSON text.
    fn refresh_one(value: Value) -> String {
        let mut boxed = raw(value);
        refresh_task_image_download_urls(&config(), &mut [&mut boxed], now()).expect("refreshes");
        boxed.get().to_owned()
    }

    fn decode_token(url: &str) -> Value {
        let token = url.split_once("?token=").expect("token query").1;
        let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
        validation.validate_aud = false;
        // The fixture's fixed `iat`/`exp` predate the test run.
        validation.validate_exp = false;
        validation.required_spec_claims.clear();
        decode::<Value>(token, &DecodingKey::from_secret(b"test-key"), &validation)
            .expect("token verifies")
            .claims
    }

    /// Refresh one stored payload text and return the resulting text.
    fn refresh_text(text: &str) -> String {
        let mut boxed = serde_json::from_str::<Box<RawValue>>(text).expect("test payload is JSON");
        refresh_task_image_download_urls(&config(), &mut [&mut boxed], now()).expect("refreshes");
        boxed.get().to_owned()
    }

    fn json_of(text: &str) -> Value {
        Value::from_str(text).expect("refreshed payload is JSON")
    }

    #[test]
    fn image_blocks_get_fresh_urls_and_the_expiry_marker() {
        let body = json_of(&refresh_one(json!({
            "value": "done",
            "blocks": [{
                "id": "b1",
                "type": "image",
                "image_attachment_ids": [1330367],
                "image_download_urls": ["https://stored.invalid/old"],
            }],
        })));

        assert_eq!(body["value"], "done");
        assert_eq!(body["blocks"][0]["id"], "b1");
        let url = body["blocks"][0]["image_download_urls"][0]
            .as_str()
            .expect("url");
        assert!(
            url.contains("/api/attachments/download/shared?token="),
            "{url}"
        );
        let claims = decode_token(url);
        assert_eq!(claims["attachment_id"], 1330367);
        assert_eq!(claims["purpose"], "public_attachment_download");
        assert_eq!(claims["iat"], 1_789_887_883);
        assert_eq!(claims["exp"], 1_789_891_483);
        assert_eq!(
            body["blocks"][0]["image_download_url_expires_in_seconds"],
            3600
        );
    }

    #[test]
    fn every_attachment_id_is_signed_once_in_order() {
        let body = json_of(&refresh_one(json!({
            "blocks": [{"type": "image", "image_attachment_ids": [7, "8", 9.5, null, 10]}],
        })));

        let urls = body["blocks"][0]["image_download_urls"]
            .as_array()
            .expect("urls")
            .clone();
        assert_eq!(urls.len(), 2);
        assert_eq!(decode_token(urls[0].as_str().unwrap())["attachment_id"], 7);
        assert_eq!(decode_token(urls[1].as_str().unwrap())["attachment_id"], 10);
        // The refreshed block keeps its other keys.
        assert_eq!(
            body["blocks"][0]["image_attachment_ids"],
            json!([7, "8", 9.5, null, 10])
        );
    }

    #[test]
    fn payloads_without_a_signable_image_block_stay_byte_identical() {
        for text in [
            r#"{"value": "no blocks"}"#,
            r#"{"blocks": "not a list", "extra": null}"#,
            r#"{"blocks": []}"#,
            r#"{"blocks": [{"type": "text", "image_attachment_ids": [7], "content": null}]}"#,
            r#"{"blocks": [{"type": "image"}]}"#,
            r#"{"blocks": [{"type": "image", "image_attachment_ids": null}]}"#,
            r#"{"blocks": [{"type": "image", "image_attachment_ids": "7"}]}"#,
            r#"{"blocks": [{"type": "image", "image_attachment_ids": ["7"]}]}"#,
            r#"{"blocks": [{"type": "image", "image_attachment_ids": []}]}"#,
            r#"{"blocks": [null, {"b": 1, "a": null}]}"#,
            r#"["not", "an", "object"]"#,
        ] {
            assert_eq!(refresh_text(text), text, "{text}");
        }
    }

    #[test]
    fn non_json_payloads_stay_unchanged() {
        assert!(
            refresh_image_result_download_urls(&config(), "not json", now())
                .expect("no-op")
                .is_none()
        );
    }

    #[test]
    fn unrefreshed_blocks_keep_null_keys_exactly() {
        // The refreshed payload is re-serialized, so untouched blocks must
        // keep explicit nulls instead of dropping the key.
        let body = json_of(&refresh_one(json!({
            "blocks": [
                {"type": "text", "image_attachment_ids": null, "content": null},
                {"type": "image", "image_attachment_ids": [7], "cover_url": null},
            ],
        })));

        assert_eq!(
            body["blocks"][0],
            json!({"type": "text", "image_attachment_ids": null, "content": null})
        );
        assert!(body["blocks"][1]["cover_url"].is_null());
    }

    #[test]
    fn task_result_and_subtask_results_are_both_refreshed() {
        let mut task_result =
            raw(json!({"blocks": [{"type": "image", "image_attachment_ids": [1]}]}));
        let mut subtask_result =
            raw(json!({"blocks": [{"type": "image", "image_attachment_ids": [2]}]}));
        let mut untouched = raw(json!({"value": "no image"}));
        let untouched_before = untouched.get().to_owned();
        let mut results: Vec<&mut Box<RawValue>> =
            vec![&mut task_result, &mut subtask_result, &mut untouched];
        refresh_task_image_download_urls(&config(), &mut results, now()).expect("refreshes");
        drop(results);

        for (result, expected_id) in [(&task_result, 1), (&subtask_result, 2)] {
            let body = json_of(result.get());
            let url = body["blocks"][0]["image_download_urls"][0]
                .as_str()
                .expect("url");
            assert_eq!(decode_token(url)["attachment_id"], expected_id);
        }
        assert_eq!(untouched.get(), untouched_before);
    }
}
