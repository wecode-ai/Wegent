// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Python `json.dumps(value, ensure_ascii=False)` rendering for the
//! responses API (`_dump_arguments` in
//! `app/services/openapi/output_builder.py`): `", "` / `": "` separators
//! and non-ASCII characters kept verbatim.

use serde_json::Value;

/// Python `json.dumps(value, ensure_ascii=False)`: `, ` / `: ` separators.
pub fn python_json_dumps(value: &Value) -> String {
    let mut out = String::new();
    write_python_json(value, &mut out);
    out
}

fn write_python_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&number.to_string()),
        Value::String(text) => write_python_json_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_python_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_python_json_string(key, out);
                out.push_str(": ");
                write_python_json(item, out);
            }
            out.push('}');
        }
    }
}

/// `json.dumps` string escaping: ASCII control characters use the `\uXXXX`
/// form, everything else (including non-ASCII) stays verbatim.
fn write_python_json_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
