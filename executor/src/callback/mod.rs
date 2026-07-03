// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{error::Error, future::Future, pin::Pin, time::Duration};

use reqwest::Client;
use serde_json::{Map, Number, Value};

use crate::{emitter::EventEnvelope, logging::log_executor_event, runner::EventSink};

const DEFAULT_TIMEOUT_SECONDS: u64 = 10;
const RESPONSE_PREVIEW_LIMIT: usize = 500;

#[derive(Debug, Clone)]
pub struct CallbackSink {
    callback_url: String,
    client: Client,
}

impl CallbackSink {
    pub fn new(callback_url: impl Into<String>) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECONDS))
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            callback_url: callback_url.into(),
            client,
        })
    }
}

impl EventSink for CallbackSink {
    type SendFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn send(&self, event: EventEnvelope) -> Self::SendFuture {
        let callback_url = self.callback_url.trim().to_owned();
        let client = self.client.clone();
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
            if log_success {
                log_executor_event("callback request started", &fields);
            }

            let callback_payload = callback_payload(&event).inspect_err(|error| {
                let mut failed_fields = fields.clone();
                failed_fields.push(("error", error.clone()));
                log_executor_event("callback payload rejected", &failed_fields);
            })?;

            let response = client
                .post(callback_url)
                .json(&callback_payload)
                .send()
                .await
                .map_err(|error| {
                    log_callback_transport_error(&fields, &error);
                    error.to_string()
                })?;

            let status = response.status();
            if !status.is_success() {
                let response_preview = match response.text().await {
                    Ok(text) => truncate_for_log(&text),
                    Err(error) => format!("<failed to read response body: {error}>"),
                };
                let mut failed_fields = fields.clone();
                failed_fields.push(("status", status.as_u16().to_string()));
                failed_fields.push(("response_preview", response_preview));
                log_executor_event("callback response rejected", &failed_fields);
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

            let mut success_fields = fields;
            success_fields.push(("status", status.as_u16().to_string()));
            if log_success {
                log_executor_event("callback request finished", &success_fields);
            }
            Ok(())
        })
    }
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
