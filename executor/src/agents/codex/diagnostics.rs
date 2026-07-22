// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::{self, Write};

use serde_json::Value;

const RAW_LOG_PREVIEW_CHARS: usize = 1200;
const RAW_LOG_LARGE_STRING_CHARS: usize = 2048;
const RAW_LOG_STRING_PREVIEW_CHARS: usize = 240;

struct ByteCounter {
    length: usize,
}

impl Write for ByteCounter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.length += buffer.len();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Measures serialized JSON without allocating the serialized payload.
pub(super) fn serialized_json_len(value: &Value) -> serde_json::Result<usize> {
    let mut counter = ByteCounter { length: 0 };
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.length)
}

/// Builds a bounded diagnostic preview with sensitive fields redacted.
pub(super) fn raw_log_preview(value: &Value) -> String {
    let sanitized = sanitize_raw_log_value(value, None);
    let preview = serde_json::to_string(&sanitized)
        .unwrap_or_else(|error| format!("failed to serialize codex raw message preview: {error}"));
    truncate_text(&preview, RAW_LOG_PREVIEW_CHARS)
}

fn sanitize_raw_log_value(value: &Value, key: Option<&str>) -> Value {
    if key.is_some_and(is_sensitive_key) {
        return Value::String("[redacted]".to_owned());
    }
    match value {
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        sanitize_raw_log_value(value, Some(key.as_str())),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| sanitize_raw_log_value(item, None))
                .collect(),
        ),
        Value::String(text) if should_summarize_raw_log_string(key, text) => {
            Value::String(format!(
                "[{} chars omitted; preview: {}]",
                text.chars().count(),
                truncate_text(text, RAW_LOG_STRING_PREVIEW_CHARS)
            ))
        }
        _ => value.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    [
        "apikey",
        "authorization",
        "authtoken",
        "bearertoken",
        "content",
        "cookie",
        "credential",
        "password",
        "secret",
        "token",
    ]
    .iter()
    .any(|fragment| normalized.contains(fragment))
}

fn should_summarize_raw_log_string(key: Option<&str>, text: &str) -> bool {
    matches!(
        key,
        Some("aggregatedOutput")
            | Some("toolOutput")
            | Some("tool_output")
            | Some("toolOutputDelta")
            | Some("tool_output_delta")
            | Some("output")
            | Some("stdout")
            | Some("stderr")
    ) || text.len() > RAW_LOG_LARGE_STRING_CHARS
}

/// Reads a string field for structured diagnostic metadata.
pub(super) fn json_string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// Formats a scalar JSON field for structured diagnostic metadata.
pub(super) fn json_scalar_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string())
        })
        .unwrap_or_default()
}

/// Lists object keys without exposing their values.
pub(super) fn json_object_keys(value: &Value) -> String {
    value
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>().join(","))
        .unwrap_or_default()
}

/// Reads a nested string field for structured diagnostic metadata.
pub(super) fn nested_json_string_field(value: &Value, object_key: &str, key: &str) -> String {
    value
        .get(object_key)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

/// Truncates text on character boundaries and marks truncated output.
pub(super) fn truncate_text(text: &str, max_chars: usize) -> String {
    let mut result = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index >= max_chars {
            result.push('…');
            return result;
        }
        result.push(ch);
    }
    result
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn raw_log_preview_summarizes_large_command_output() {
        let message = json!({"params": {"output": "x".repeat(4096)}});

        let preview = raw_log_preview(&message);

        assert!(preview.contains("4096 chars omitted"));
        assert!(preview.len() < serialized_json_len(&message).unwrap());
    }

    #[test]
    fn raw_log_preview_redacts_secrets_and_content() {
        let message = json!({
            "api_key": "sk-secret-api-key",
            "authorization": "Bearer secret-token",
            "auth": {"token": "nested-secret"},
            "fileContent": "contents-from-auth-json",
            "metadata": {"requestId": "request-123"},
        });

        let preview = raw_log_preview(&message);

        for secret in [
            "sk-secret-api-key",
            "secret-token",
            "nested-secret",
            "contents-from-auth-json",
        ] {
            assert!(!preview.contains(secret));
        }
        assert!(preview.contains("request-123"));
        assert!(preview.contains("[redacted]"));
    }
}
