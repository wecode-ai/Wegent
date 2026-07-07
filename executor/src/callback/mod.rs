// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{error::Error, future::Future, pin::Pin, time::Duration};

use reqwest::Client;
use serde_json::{Map, Number, Value};

use crate::{emitter::EventEnvelope, logging::log_executor_event, runner::EventSink};

const DEFAULT_TIMEOUT_SECONDS: u64 = 10;
const DEFAULT_MAX_CALLBACK_ATTEMPTS: usize = 10;
const DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS: u64 = 1_000;
const DEFAULT_CALLBACK_RETRY_MAX_DELAY_MS: u64 = 8_000;
const RESPONSE_PREVIEW_LIMIT: usize = 500;

#[derive(Debug, Clone)]
pub struct CallbackRetryConfig {
    max_attempts: usize,
    base_delay: Duration,
    max_delay: Duration,
}

impl CallbackRetryConfig {
    pub fn new(max_attempts: usize, base_delay: Duration, max_delay: Duration) -> Self {
        let max_attempts = max_attempts.max(1);
        let max_delay = max_delay.max(base_delay);
        Self {
            max_attempts,
            base_delay,
            max_delay,
        }
    }

    fn delay_before_next_attempt(&self, attempt: usize) -> Duration {
        let exponent = attempt.saturating_sub(1).min(31) as u32;
        self.base_delay
            .saturating_mul(2_u32.saturating_pow(exponent))
            .min(self.max_delay)
    }
}

impl Default for CallbackRetryConfig {
    fn default() -> Self {
        Self::new(
            DEFAULT_MAX_CALLBACK_ATTEMPTS,
            Duration::from_millis(DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS),
            Duration::from_millis(DEFAULT_CALLBACK_RETRY_MAX_DELAY_MS),
        )
    }
}

#[derive(Debug, Clone)]
pub struct CallbackSink {
    callback_url: String,
    client: Client,
    retry_config: CallbackRetryConfig,
}

impl CallbackSink {
    pub fn new(callback_url: impl Into<String>) -> Result<Self, String> {
        Self::new_with_retry_config(callback_url, CallbackRetryConfig::default())
    }

    pub fn new_with_retry_config(
        callback_url: impl Into<String>,
        retry_config: CallbackRetryConfig,
    ) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECONDS))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            callback_url: callback_url.into(),
            client,
            retry_config,
        })
    }
}

impl EventSink for CallbackSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let callback_url = self.callback_url.trim().to_owned();
        let client = self.client.clone();
        let retry_config = self.retry_config.clone();
        Box::pin(async move {
            if callback_url.is_empty() {
                log_executor_event(
                    "callback skipped because url is empty",
                    &callback_fields(&callback_url, &event),
                );
                return Ok(());
            }

            let fields = callback_fields(&callback_url, &event);
            let log_success = should_log_successful_callback(&event);

            let callback_payload = callback_payload(&event).inspect_err(|error| {
                let mut failed_fields = fields.clone();
                failed_fields.push(("error", error.clone()));
                log_executor_event("callback payload rejected", &failed_fields);
            })?;

            send_callback_with_retries(
                &client,
                &callback_url,
                &callback_payload,
                fields,
                log_success,
                retry_config,
            )
            .await
        })
    }
}

async fn send_callback_with_retries(
    client: &Client,
    callback_url: &str,
    callback_payload: &Value,
    fields: Vec<(&'static str, String)>,
    log_success: bool,
    retry_config: CallbackRetryConfig,
) -> Result<(), String> {
    let mut last_error = String::new();
    for attempt in 1..=retry_config.max_attempts {
        let attempt_fields = callback_attempt_fields(&fields, attempt, retry_config.max_attempts);
        if log_success {
            log_executor_event("callback request started", &attempt_fields);
        }

        let is_final_attempt = attempt == retry_config.max_attempts;
        let started = std::time::Instant::now();
        match send_callback_once(
            client,
            callback_url,
            callback_payload,
            &attempt_fields,
            log_success || is_final_attempt,
        )
        .await
        {
            Ok(status) => {
                let mut success_fields = attempt_fields;
                success_fields.push(("status", status.to_string()));
                success_fields.push(("elapsed_ms", started.elapsed().as_millis().to_string()));
                if log_success {
                    log_executor_event("callback request finished", &success_fields);
                }
                return Ok(());
            }
            Err(error) => {
                last_error = error;
                if !is_final_attempt {
                    let retry_delay = retry_config.delay_before_next_attempt(attempt);
                    if log_success {
                        log_callback_retrying(&attempt_fields, attempt, retry_delay, &last_error);
                    }
                    if !retry_delay.is_zero() {
                        tokio::time::sleep(retry_delay).await;
                    }
                }
            }
        }
    }

    Err(last_error)
}

async fn send_callback_once(
    client: &Client,
    callback_url: &str,
    callback_payload: &Value,
    fields: &[(&'static str, String)],
    log_failure: bool,
) -> Result<u16, String> {
    let response = client
        .post(callback_url)
        .json(callback_payload)
        .send()
        .await
        .map_err(|error| {
            if log_failure {
                log_callback_transport_error(fields, &error);
            }
            error.to_string()
        })?;

    let status = response.status();
    if !status.is_success() {
        let response_preview = match response.text().await {
            Ok(text) => truncate_for_log(&text),
            Err(error) => format!("<failed to read response body: {error}>"),
        };
        let mut failed_fields = fields.to_vec();
        failed_fields.push(("status", status.as_u16().to_string()));
        failed_fields.push(("response_preview", response_preview));
        if log_failure {
            log_executor_event("callback response rejected", &failed_fields);
        }
        return Err(format!(
            "callback failed: status={} url={}",
            status.as_u16(),
            fields
                .iter()
                .find(|(key, _)| *key == "callback_url")
                .map(|(_, value)| value.as_str())
                .unwrap_or("")
        ));
    }

    Ok(status.as_u16())
}

fn should_log_successful_callback(event: &EventEnvelope) -> bool {
    !matches!(
        event.event_type.as_str(),
        "response.output_text.delta" | "response.reasoning_summary_text.delta"
    )
}

fn callback_fields(callback_url: &str, event: &EventEnvelope) -> Vec<(&'static str, String)> {
    vec![
        ("task_id", event.task_id.to_string()),
        ("subtask_id", event.subtask_id.to_string()),
        ("event_type", event.event_type.clone()),
        ("callback_url", callback_url.to_owned()),
        (
            "message_id",
            event
                .message_id
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (
            "executor_name",
            event.executor_name.clone().unwrap_or_default(),
        ),
        (
            "executor_namespace",
            event.executor_namespace.clone().unwrap_or_default(),
        ),
    ]
}

fn callback_attempt_fields(
    fields: &[(&'static str, String)],
    attempt: usize,
    max_attempts: usize,
) -> Vec<(&'static str, String)> {
    let mut attempt_fields = fields.to_vec();
    attempt_fields.push(("attempt", attempt.to_string()));
    attempt_fields.push(("max_attempts", max_attempts.to_string()));
    attempt_fields
}

fn log_callback_retrying(
    fields: &[(&'static str, String)],
    attempt: usize,
    retry_delay: Duration,
    error: &str,
) {
    let mut retry_fields = fields.to_vec();
    retry_fields.push(("next_attempt", (attempt + 1).to_string()));
    retry_fields.push(("retry_delay_ms", retry_delay.as_millis().to_string()));
    retry_fields.push(("error_len", error.len().to_string()));
    log_executor_event("callback request retrying", &retry_fields);
}

fn callback_payload(event: &EventEnvelope) -> Result<Value, String> {
    let mut object = Map::new();
    object.insert(
        "event_type".to_owned(),
        Value::String(event.event_type.clone()),
    );
    object.insert("task_id".to_owned(), numeric_callback_id(&event.task_id)?);
    object.insert(
        "subtask_id".to_owned(),
        numeric_callback_id(&event.subtask_id)?,
    );
    object.insert("data".to_owned(), event.data.clone());
    if let Some(message_id) = event.message_id {
        object.insert(
            "message_id".to_owned(),
            Value::Number(Number::from(message_id)),
        );
    }
    if let Some(executor_name) = &event.executor_name {
        object.insert(
            "executor_name".to_owned(),
            Value::String(executor_name.clone()),
        );
    }
    if let Some(executor_namespace) = &event.executor_namespace {
        object.insert(
            "executor_namespace".to_owned(),
            Value::String(executor_namespace.clone()),
        );
    }
    Ok(Value::Object(object))
}

fn numeric_callback_id(value: &str) -> Result<Value, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("callback task identity is empty".to_owned());
    }
    trimmed
        .parse::<i64>()
        .map(Number::from)
        .map(Value::Number)
        .map_err(|_| format!("callback task identity is not numeric: {trimmed}"))
}

fn log_callback_transport_error(fields: &[(&'static str, String)], error: &reqwest::Error) {
    let mut failed_fields = fields.to_vec();
    failed_fields.push(("error", error.to_string()));
    failed_fields.push(("is_timeout", error.is_timeout().to_string()));
    failed_fields.push(("is_connect", error.is_connect().to_string()));
    failed_fields.push(("is_request", error.is_request().to_string()));
    failed_fields.push(("source_chain", error_source_chain(error)));
    log_executor_event("callback request failed", &failed_fields);
}

fn error_source_chain(error: &dyn Error) -> String {
    let mut sources = Vec::new();
    let mut current = error.source();
    while let Some(source) = current {
        sources.push(source.to_string());
        current = source.source();
    }
    truncate_for_log(&sources.join(" | "))
}

fn truncate_for_log(value: &str) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(RESPONSE_PREVIEW_LIMIT).collect();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_retry_config_uses_capped_exponential_backoff() {
        let config = CallbackRetryConfig::default();

        assert_eq!(config.max_attempts, 10);
        assert_eq!(config.delay_before_next_attempt(1), Duration::from_secs(1));
        assert_eq!(config.delay_before_next_attempt(2), Duration::from_secs(2));
        assert_eq!(config.delay_before_next_attempt(3), Duration::from_secs(4));
        assert_eq!(config.delay_before_next_attempt(4), Duration::from_secs(8));
        assert_eq!(config.delay_before_next_attempt(5), Duration::from_secs(8));
        assert_eq!(config.delay_before_next_attempt(10), Duration::from_secs(8));
    }

    #[test]
    fn retry_config_keeps_at_least_one_attempt() {
        let config = CallbackRetryConfig::new(0, Duration::ZERO, Duration::ZERO);

        assert_eq!(config.max_attempts, 1);
        assert_eq!(config.delay_before_next_attempt(1), Duration::ZERO);
    }
}
