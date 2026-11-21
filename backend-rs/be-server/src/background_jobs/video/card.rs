// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Data-only CardBlock normalization and external endpoint policy.

use crate::AppState;
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub status: String,
    pub progress: i64,
    pub progress_text: String,
    pub card: Value,
    pub error: Option<String>,
}

pub async fn fetch(state: &AppState, url: &str) -> Result<Snapshot> {
    let parsed = url::Url::parse(url).context("Card workflow query URL is invalid")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        bail!("Card workflow query URL is invalid")
    }
    if !state.video_extensions.allows_card_url(url)
        && !crate::url_ssrf::validate_url_for_ssrf(url).await
    {
        bail!("Card workflow query URL is not allowed")
    }
    let http = brz_http::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(15))
        .configure(|builder| builder.redirect(brz_http::reqwest::redirect::Policy::none()))
        .build()?;
    let response = http
        .as_reqwest()
        .get(url)
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Card workflow status request failed"))?;
    if !response.status().is_success() {
        bail!("Card workflow status request failed")
    }
    let bytes = super::super::knowledge::sources::bounded_body(response, 10 * 1024 * 1024).await?;
    let raw: Value =
        serde_json::from_slice(&bytes).context("Card workflow returned an invalid response")?;
    normalize(state, &raw)
}

fn normalize(state: &AppState, raw: &Value) -> Result<Snapshot> {
    if !raw.is_object() {
        bail!("Card workflow returned an invalid response")
    }
    Ok(normalize_with(raw, |card| {
        state.video_extensions.normalize_card(card)
    }))
}

fn normalize_with(raw: &Value, normalizer: impl FnOnce(Value) -> Value) -> Snapshot {
    let data = raw
        .get("wb_data")
        .filter(|value| value.is_object())
        .unwrap_or(raw);
    let raw_status = data["status"].as_str().unwrap_or("").trim().to_lowercase();
    let status = if [
        "pending",
        "processing",
        "completed",
        "failed",
        "partial_ready",
    ]
    .contains(&raw_status.as_str())
    {
        raw_status.clone()
    } else {
        "failed".into()
    };
    let mut card = sanitize(normalizer(data["card"].clone()), None);
    if !card.is_object() {
        card = json!({});
    }
    for key in ["video_url", "cover_url"] {
        if card.get(key).is_none() && is_http(&data[key]) {
            card[key] = data[key].clone();
        }
    }
    let progress = data["progress"]
        .as_f64()
        .filter(|value| value.is_finite())
        .unwrap_or_default()
        .clamp(0.0, 100.0) as i64;
    let error = data
        .get("error_message")
        .or_else(|| data.get("error"))
        .or_else(|| raw.get("error"))
        .filter(|value| !value.is_null())
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .or_else(|| {
            (status == "failed").then(|| format!("Card workflow failed with status '{raw_status}'"))
        });
    Snapshot {
        status,
        progress,
        progress_text: data["progress_text"].as_str().unwrap_or_default().into(),
        card,
        error,
    }
}

fn is_http(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|value| url::Url::parse(value).ok())
        .is_some_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
}
fn sanitize(value: Value, key: Option<&str>) -> Value {
    if key.is_some_and(|key| ["cover_url", "link", "url", "video_url"].contains(&key))
        && !is_http(&value)
    {
        return Value::Null;
    }
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| {
                    !key.starts_with('_')
                        && !["polling_url", "prompt", "query_url", "skill", "task_url"]
                            .contains(&key.as_str())
                })
                .filter_map(|(key, value)| {
                    let value = sanitize(value, Some(&key));
                    (!value.is_null()).then_some((key, value))
                })
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| sanitize(value, None))
                .filter(|value| !value.is_null())
                .collect(),
        ),
        value => value,
    }
}

pub fn block(id: &str, context: &Value, snapshot: &Snapshot) -> Value {
    let (status, card_status) = match snapshot.status.as_str() {
        "completed" => ("done", "populated"),
        "failed" => ("error", "error"),
        "partial_ready" => ("streaming", "partial_ready"),
        _ => ("pending", "pending"),
    };
    json!({"id":id,"type":"card","status":status,"card_type":context["card_type"],"card_id":id,"card_status":card_status,"card_data":snapshot.card,
        "card_preview_data":{"title":snapshot.card.get("title").filter(|title|!title.is_null()&&title.as_str()!=Some("")).unwrap_or(&context["preview_title"]),
        "progress":snapshot.progress,"progress_text":if snapshot.progress_text.is_empty(){context["progress_text"].as_str().unwrap_or("")}else{&snapshot.progress_text},
        "video_url":snapshot.card["video_url"],"cover_url":snapshot.card["cover_url"]},"card_error":snapshot.error,"timestamp":chrono::Utc::now().timestamp_millis()})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_workflow_fields_and_invalid_public_urls_do_not_escape() {
        let snapshot = normalize_with(
            &json!({"wb_data":{"status":"partial_ready","progress":150,"card":{"title":"ok","query_url":"secret","_token":"secret","video_url":"javascript:alert(1)","items":[{"prompt":"secret","url":"https://example.test"}]}}}),
            |value| value,
        );
        assert_eq!(snapshot.progress, 100);
        assert_eq!(snapshot.status, "partial_ready");
        assert!(!snapshot.card.to_string().contains("secret"));
        assert!(!snapshot.card.to_string().contains("javascript"));
    }
}
