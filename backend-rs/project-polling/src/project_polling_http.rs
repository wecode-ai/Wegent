// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Bounded provider transport and incremental polling cursors.

use chrono::{DateTime, Duration, NaiveDateTime, SecondsFormat, Utc};
use serde_json::{Value, json};

pub(super) type Result<T> = std::result::Result<T, PollError>;

#[derive(Debug)]
pub(super) struct PollError {
    pub message: String,
    pub retry_after: Option<i64>,
    pub disable: bool,
}

impl std::fmt::Display for PollError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PollError {}

impl PollError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retry_after: None,
            disable: false,
        }
    }
    pub fn disabled(message: impl Into<String>) -> Self {
        Self {
            disable: true,
            ..Self::new(message)
        }
    }
}

impl From<brz_http::Error> for PollError {
    fn from(error: brz_http::Error) -> Self {
        // Transport errors must not include a URL that might carry credentials.
        Self::new(format!(
            "Event source request failed: {}",
            error.without_url()
        ))
    }
}

#[derive(Clone, Debug)]
pub(super) struct Input {
    pub identity: String,
    pub title: String,
    pub payload: Value,
    pub headers: Value,
    pub occurred_at: Option<String>,
}

impl Input {
    pub fn new(
        identity: String,
        title: String,
        payload: Value,
        headers: Value,
        occurred: &Value,
    ) -> Self {
        Self {
            identity,
            title,
            payload,
            headers,
            occurred_at: optional_text(occurred),
        }
    }
}

pub(super) struct Page {
    pub inputs: Vec<Input>,
    pub cursor: Value,
    pub complete: bool,
}

pub(super) struct Http<'a> {
    pub client: &'a brz_http::Client,
    pub source: &'a str,
    pub credential: &'a str,
}

impl Http<'_> {
    pub async fn get(&self, url: &str, params: &[(&str, String)]) -> Result<Value> {
        let mut url =
            url::Url::parse(url).map_err(|_| PollError::new("Event source URL is invalid"))?;
        url.query_pairs_mut()
            .extend_pairs(params.iter().map(|(k, v)| (*k, v.as_str())));
        let mut request = self
            .client
            .get(url.as_str())?
            .timeout(std::time::Duration::from_secs(30));
        if self.source == "github" {
            request = request
                .header("Authorization", format!("Bearer {}", self.credential))
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28");
        } else {
            request = request.header("PRIVATE-TOKEN", self.credential);
        }
        let response = request.send().await?;
        let status = response.status().as_u16();
        let limited = status == 403
            && response
                .headers()
                .get("x-ratelimit-remaining")
                .is_some_and(|v| v == "0");
        if matches!(status, 401 | 403) && !limited {
            return Err(PollError::disabled("Event source credential was rejected"));
        }
        if status == 429 || limited {
            let mut error = PollError::new("Event source rate limit exceeded");
            error.retry_after = Some(retry_after(response.headers(), Utc::now().timestamp()));
            return Err(error);
        }
        if !(200..300).contains(&status) {
            return Err(PollError::new(format!(
                "Event source returned HTTP {status}"
            )));
        }
        let bytes = response.bytes().await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| PollError::new("Event source returned invalid JSON"))
    }

    pub async fn list(
        &self,
        url: &str,
        params: &[(&str, String)],
        key: Option<&str>,
    ) -> Result<Vec<Value>> {
        let mut values = Vec::new();
        for page in 1..=10 {
            let mut params = params.to_vec();
            params.extend([("per_page", "100".into()), ("page", page.to_string())]);
            let payload = self.get(url, &params).await?;
            let payload = key
                .filter(|_| payload.is_object())
                .map_or(&payload, |key| &payload[key]);
            let rows = array(payload, "Event source list response is invalid")?;
            values.extend(rows.iter().filter(|v| v.is_object()).cloned());
            if rows.len() < 100 {
                break;
            }
        }
        Ok(values)
    }
}

pub(super) fn retry_after(headers: &brz_http::reqwest::header::HeaderMap, now: i64) -> i64 {
    let seconds = |key: &str| {
        headers
            .get(key)?
            .to_str()
            .ok()?
            .parse::<u64>()
            .ok()
            .map(|n| n.min(i64::MAX as u64) as i64)
    };
    seconds("retry-after")
        .or_else(|| seconds("x-ratelimit-reset").map(|n| n.saturating_sub(now)))
        .map(|n| n.clamp(1, 86_400))
        .unwrap_or(300)
}

pub(super) fn text(value: &Value) -> &str {
    value.as_str().unwrap_or("").trim()
}
pub(super) fn optional_text(value: &Value) -> Option<String> {
    (!text(value).is_empty()).then(|| text(value).into())
}
pub(super) fn number(value: &Value) -> String {
    value.as_str().map(str::to_owned).unwrap_or_else(|| {
        if value.is_null() {
            "None".into()
        } else {
            value.to_string()
        }
    })
}
pub(super) fn object(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}
pub(super) fn array<'a>(value: &'a Value, error: &str) -> Result<&'a Vec<Value>> {
    value.as_array().ok_or_else(|| PollError::new(error))
}
pub(super) fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    let result = text(&value[key]);
    if result.is_empty() {
        Err(PollError::new(format!("Observed resource requires {key}")))
    } else {
        Ok(result)
    }
}
pub(super) fn datetime(value: &Value) -> Option<DateTime<Utc>> {
    let value = text(value);
    DateTime::parse_from_rfc3339(value)
        .map(|v| v.with_timezone(&Utc))
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|v| v.and_utc())
        })
}
pub(super) fn after(value: &Value, cutoff: Option<DateTime<Utc>>) -> bool {
    cutoff.is_none_or(|cutoff| datetime(value).is_some_and(|v| v > cutoff))
}
pub(super) fn utc_iso(value: DateTime<Utc>) -> String {
    value.to_rfc3339_opts(SecondsFormat::AutoSi, true)
}

pub(super) struct Cursor {
    pub watermark: Value,
    pub started: String,
    pub page: i64,
}
impl Cursor {
    pub fn new(value: &Value) -> Self {
        Self {
            watermark: optional_text(&value["watermark"]).map_or(Value::Null, Value::String),
            started: optional_text(&value["scan_started_at"])
                .unwrap_or_else(|| utc_iso(Utc::now())),
            page: value["page"]
                .as_i64()
                .or_else(|| text(&value["page"]).parse().ok())
                .unwrap_or(1)
                .max(1),
        }
    }
    pub fn cutoff(&self) -> Option<DateTime<Utc>> {
        datetime(&self.watermark).map(|v| v - Duration::seconds(120))
    }
    pub fn next(&self, complete: bool) -> Value {
        if complete {
            json!({"watermark":self.started,"page":1})
        } else {
            json!({"watermark":self.watermark,"scan_started_at":self.started,"page":self.page+1})
        }
    }
}
