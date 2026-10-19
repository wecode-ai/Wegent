// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Python-compatible JSON serialization for the streaming callback pipeline.
//!
//! The source writes several different JSON encodings to Redis, and Replay
//! matches the exact bytes. Two writers are mirrored here:
//!
//! - [`python_dumps`] mirrors `json.dumps(value)` with its default
//!   `", "` / `": "` separators and `ensure_ascii=True` escaping (used for
//!   block metadata, the Socket.IO emit envelopes, and the callback-channel
//!   event payloads).
//! - [`orjson_dumps`] mirrors `orjson.dumps(value)`: compact separators and
//!   UTF-8 with no ASCII escaping (used by the cache manager for the
//!   task-streaming status object).
//! - [`python_dumps_utf8`] mirrors `json.dumps(value, ensure_ascii=False)`,
//!   the CLI OIDC callback's `users.preferences` rendering.
use serde_json::Value;

/// `json.dumps(value)` with CPython's default separators and ASCII escaping.
pub(crate) fn python_dumps(value: &Value) -> String {
    let mut out = String::new();
    write_python_with(&mut out, value, write_python_string);
    out
}

/// `json.dumps(value, ensure_ascii=False)`: CPython's default separators and
/// number rendering, with characters outside `!`..`~` kept as UTF-8.
pub(crate) fn python_dumps_utf8(value: &Value) -> String {
    let mut out = String::new();
    write_python_with(&mut out, value, write_compact_string);
    out
}

/// CPython's JSON encoder body: `write_string` selects the escaping mode.
fn write_python_with(out: &mut String, value: &Value, write_string: fn(&mut String, &str)) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&python_number(number)),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_python_with(out, item, write_string);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_string(out, key);
                out.push_str(": ");
                write_python_with(out, item, write_string);
            }
            out.push('}');
        }
    }
}

/// `orjson.dumps(value)`: compact separators, UTF-8, no ASCII escaping.
pub(crate) fn orjson_dumps(value: &Value) -> String {
    let mut out = String::new();
    write_compact(&mut out, value);
    out
}

fn write_compact(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&python_number(number)),
        Value::String(text) => write_compact_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_compact(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_compact_string(out, key);
                out.push(':');
                write_compact(out, item);
            }
            out.push('}');
        }
    }
}

/// CPython `json` escapes every character outside `!`..`~` plus `"` and `\`.
fn write_python_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (' '..='~').contains(&c) => out.push(c),
            c => write_unicode_escape(out, c),
        }
    }
    out.push('"');
}

/// orjson keeps UTF-8 bytes and escapes only `"`, `\`, and control characters.
fn write_compact_string(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_unicode_escape(out: &mut String, ch: char) {
    let code = ch as u32;
    if code <= 0xffff {
        out.push_str(&format!("\\u{code:04x}"));
    } else {
        // Encode a non-BMP scalar as its UTF-16 surrogate pair, exactly like
        // CPython's ASCII-escaping JSON encoder.
        let adjusted = code - 0x1_0000;
        let high = 0xd800 + (adjusted >> 10);
        let low = 0xdc00 + (adjusted & 0x3ff);
        out.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
    }
}

/// Render a number the way CPython does (`1.0` keeps its `.0` suffix).
fn python_number(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() {
        return value.to_string();
    }
    if let Some(value) = number.as_u64() {
        return value.to_string();
    }
    let value = number.as_f64().unwrap_or(f64::NAN);
    let rendered = value.to_string();
    if rendered
        .chars()
        .any(|c| c.is_ascii_alphabetic() || c == '.')
    {
        rendered
    } else {
        format!("{rendered}.0")
    }
}

/// CPython `datetime.now(timezone.utc).isoformat()`: microsecond precision and
/// a `+00:00` offset.
pub(crate) fn utc_isoformat(timestamp: chrono::DateTime<chrono::Utc>) -> String {
    use chrono::SecondsFormat;
    timestamp.to_rfc3339_opts(SecondsFormat::Micros, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_dumps_escapes_non_ascii() {
        let value = json!({
            "query": "垃圾用户",
            "max_results": 20,
            "ok": true,
            "missing": null,
        });
        assert_eq!(
            python_dumps(&value),
            "{\"query\": \"\\u5783\\u573e\\u7528\\u6237\", \"max_results\": 20, \"ok\": true, \"missing\": null}"
        );
    }

    #[test]
    fn python_dumps_keeps_astral_surrogate_pairs() {
        assert_eq!(python_dumps(&json!("\u{1f600}")), "\"\\ud83d\\ude00\"");
    }

    #[test]
    fn orjson_dumps_is_compact_and_utf8() {
        let value = json!({"a": 1, "query": "垃圾"});
        assert_eq!(orjson_dumps(&value), "{\"a\":1,\"query\":\"垃圾\"}");
    }

    #[test]
    fn python_dumps_keeps_float_suffix() {
        assert_eq!(python_dumps(&json!(1.0)), "1.0");
        assert_eq!(python_dumps(&json!(2)), "2");
    }

    #[test]
    fn python_dumps_utf8_keeps_non_ascii_and_python_spacing() {
        let value = json!({"name": "胡伟", "employee_id": "220577", "n": 2});
        assert_eq!(
            python_dumps_utf8(&value),
            "{\"name\": \"胡伟\", \"employee_id\": \"220577\", \"n\": 2}"
        );
        // Control characters keep CPython's escapes under `ensure_ascii=False`.
        assert_eq!(python_dumps_utf8(&json!("a\nb")), "\"a\\nb\"");
    }

    #[test]
    fn isoformat_uses_microseconds_and_offset() {
        let timestamp = chrono::DateTime::parse_from_rfc3339("2026-10-10T06:15:14.399419Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(utc_isoformat(timestamp), "2026-10-10T06:15:14.399419+00:00");
    }
}
