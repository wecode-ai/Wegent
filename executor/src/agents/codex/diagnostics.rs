// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::io::{self, Write};
use std::sync::OnceLock;

use regex::Regex;
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
    let sanitized = sanitize_raw_log_value(value, None, true);
    let preview = serde_json::to_string(&sanitized)
        .unwrap_or_else(|error| format!("failed to serialize codex raw message preview: {error}"));
    truncate_text(&preview, RAW_LOG_PREVIEW_CHARS)
}

pub(super) fn debug_stdout_value(value: &Value) -> Value {
    sanitize_raw_log_value(value, None, false)
}

fn sanitize_raw_log_value(value: &Value, key: Option<&str>, preview: bool) -> Value {
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
                        sanitize_raw_log_value(value, Some(key.as_str()), preview),
                    )
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| sanitize_raw_log_value(item, None, preview))
                .collect(),
        ),
        Value::String(text) => {
            let sanitized = redact_diagnostic_text(text);
            if preview && should_summarize_raw_log_string(key, text) {
                Value::String(format!(
                    "[{} chars omitted; preview: {}]",
                    text.chars().count(),
                    truncate_text(&sanitized, RAW_LOG_STRING_PREVIEW_CHARS)
                ))
            } else {
                Value::String(sanitized)
            }
        }
        _ => value.clone(),
    }
}

/// Removes common credential forms embedded in tool output and diagnostic text.
pub(super) fn redact_diagnostic_text(text: &str) -> String {
    static AUTHORIZATION: OnceLock<Regex> = OnceLock::new();
    static CREDENTIAL_FIELD: OnceLock<Regex> = OnceLock::new();
    let authorization = AUTHORIZATION.get_or_init(|| {
        Regex::new(r#"(?i)(\b(?:authorization["']?\s*[:=]\s*["']?(?:bearer|basic)|bearer)[ \t]+)[a-z0-9._~+/-]+=*"#)
            .expect("authorization redaction pattern is valid")
    });
    let credential_field = CREDENTIAL_FIELD.get_or_init(|| {
        Regex::new(
            r#"(?i)(\b(?:api[_-]?key|(?:access|refresh|auth|bearer|private)[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)"#,
        )
        .expect("credential field redaction pattern is valid")
    });
    let sanitized = authorization.replace_all(text, "${1}[redacted]");
    credential_field
        .replace_all(&sanitized, "${1}[redacted]")
        .into_owned()
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    // Token usage counters are diagnostic metadata, not authentication tokens.
    if matches!(
        normalized.as_str(),
        "inputtokens"
            | "outputtokens"
            | "totaltokens"
            | "cachedinputtokens"
            | "reasoningtokens"
            | "reasoningoutputtokens"
    ) {
        return false;
    }
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

    #[test]
    fn debug_stdout_redacts_sensitive_values_of_every_type() {
        let message = json!({
            "authorization": ["Bearer private-value"],
            "credentials": {"value": "private-value"},
            "password": 123456,
            "nested": [{"apiKey": ["private-value"]}],
            "usage": {"reasoning_tokens": 42},
            "requestId": "request-123",
        });

        let sanitized = debug_stdout_value(&message);

        for key in ["authorization", "credentials", "password"] {
            assert_eq!(sanitized[key], "[redacted]");
        }
        assert_eq!(sanitized["nested"][0]["apiKey"], "[redacted]");
        assert_eq!(sanitized["usage"]["reasoning_tokens"], 42);
        assert_eq!(sanitized["requestId"], "request-123");
        assert!(!sanitized.to_string().contains("private-value"));
    }

    #[test]
    fn diagnostic_strings_redact_embedded_credentials_before_previewing() {
        let output = concat!(
            "读取日志\nAuthorization: Bearer fake-bearer-value\n",
            "authorization: Basic ZmFrZTpwYXNzd29yZA==\n",
            "API_KEY=fake-api-value access_token='fake token value'\n",
            r#"{"refreshToken":"fake-refresh-value","status":"ok"}"#,
        );
        let description = "Basic implementation uses 42 reasoning tokens.";
        let message = json!({"stdout": output, "nested": [output], "description": description});

        for recorded in [
            debug_stdout_value(&message).to_string(),
            raw_log_preview(&message),
        ] {
            for secret in [
                "fake-bearer-value",
                "ZmFrZTpwYXNzd29yZA==",
                "fake-api-value",
                "fake token value",
                "fake-refresh-value",
            ] {
                assert!(
                    !recorded.contains(secret),
                    "unredacted credential: {secret}"
                );
            }
            assert!(recorded.contains("读取日志"));
            assert!(recorded.contains("[redacted]"));
        }
        assert!(debug_stdout_value(&message)["stdout"]
            .as_str()
            .unwrap()
            .contains("ok"));
        assert_eq!(debug_stdout_value(&message)["description"], description);
    }
}
