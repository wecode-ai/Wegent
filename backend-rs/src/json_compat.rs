// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Typed projections and opaque values at legacy JSON boundaries.
use brz_json::{OpaqueJson, raw_json, raw_null};
use serde_json::Value;

/// Serialize an optional opaque value at a response boundary. Input null and
/// a missing input key are both represented as `None`; the response model
/// chooses either a concrete default, JSON null, or field omission.
pub(crate) trait OptionalOpaqueJsonExt {
    fn raw_or(&self, default: impl serde::Serialize) -> brz_json::RawJson;
    fn raw_option(&self) -> Option<brz_json::RawJson>;
    fn raw_with_object_null_default(&self, key: &str) -> brz_json::RawJson;
}

impl OptionalOpaqueJsonExt for Option<OpaqueJson> {
    fn raw_or(&self, default: impl serde::Serialize) -> brz_json::RawJson {
        self.as_ref().map_or_else(
            || brz_json::to_raw_value(&default).expect("JSON default serializes"),
            OpaqueJson::to_raw_value,
        )
    }

    fn raw_option(&self) -> Option<brz_json::RawJson> {
        self.as_ref().map(OpaqueJson::to_raw_value)
    }

    fn raw_with_object_null_default(&self, key: &str) -> brz_json::RawJson {
        let Some(value) = self.as_ref() else {
            return raw_null();
        };
        let mut value = value.to_value();
        if let serde_json::Value::Object(object) = &mut value {
            object
                .entry(key.to_owned())
                .or_insert(serde_json::Value::Null);
        }
        raw_json(&value)
    }
}

/// Render one JSON string scalar like Python's `json.dumps` default
/// (`ensure_ascii=True`): ASCII stays as-is (with the standard JSON
/// escapes), non-ASCII becomes `\uXXXX` (surrogate pairs for astral
/// characters).
pub fn python_json_string(value: &str) -> String {
    render_json_string(value, true)
}

/// Render one JSON string scalar like Python's `json.dumps(..., ensure_ascii=False)`:
/// ASCII keeps the standard JSON escapes and every non-ASCII character stays
/// literal.
fn render_json_string(value: &str, ensure_ascii: bool) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            other if (other as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", other as u32));
            }
            other if (other as u32) < 0x7f => out.push(other),
            other if !ensure_ascii => out.push(other),
            other => {
                let code = other as u32;
                if code <= 0xffff {
                    out.push_str(&format!("\\u{code:04x}"));
                } else {
                    // Surrogate pair for astral code points.
                    let code = code - 0x1_0000;
                    let high = 0xd800 + (code >> 10);
                    let low = 0xdc00 + (code & 0x3ff);
                    out.push_str(&format!("\\u{high:04x}\\u{low:04x}"));
                }
            }
        }
    }
    out.push('"');
    out
}

/// Render a JSON value like Python's `json.dumps` default
/// (`ensure_ascii=True`, separators `", "` / `": "`). Numbers keep their
/// `serde_json` representation, which matches Python for the integer and
/// float literals the kind CRDs carry.
///
/// This is the rendering SQLAlchemy's `JSON` column type applies on write
/// (`json.dumps` is its default serializer), and the rendering the cached
/// kind reader applies to `model_to_dict` output.
pub fn python_json_value(value: &Value) -> String {
    render_json_value(value, true)
}

/// Render a JSON value like Python's `json.dumps(..., ensure_ascii=False)`
/// (separators `", "` / `": "`, non-ASCII kept literal). The source's
/// `_build_subtask_content_fields` applies it to non-string message content
/// before the value is stored.
pub fn python_json_value_no_ascii(value: &Value) -> String {
    render_json_value(value, false)
}

fn render_json_value(value: &Value, ensure_ascii: bool) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => render_json_string(text, ensure_ascii),
        Value::Array(items) => {
            let mut out = String::from("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&render_json_value(item, ensure_ascii));
            }
            out.push(']');
            out
        }
        Value::Object(map) => {
            let mut out = String::from("{");
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                out.push_str(&render_json_string(key, ensure_ascii));
                out.push_str(": ");
                out.push_str(&render_json_value(item, ensure_ascii));
            }
            out.push('}');
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_json_string_escapes_non_ascii() {
        assert_eq!(python_json_string("严笑"), "\"\\u4e25\\u7b11\"");
        assert_eq!(python_json_string("a\"b\\c\n"), "\"a\\\"b\\\\c\\n\"");
        assert_eq!(python_json_string("\u{1f600}"), "\"\\ud83d\\ude00\"");
        assert_eq!(python_json_string("Chat"), "\"Chat\"");
    }

    #[test]
    fn python_json_value_renders_ensure_ascii_with_python_separators() {
        let value = serde_json::json!({
            "modelRef": {"name": "example-model(公网)", "namespace": "default"},
            "count": 2,
            "ratio": 1.5,
            "flag": true,
            "missing": null
        });
        assert_eq!(
            python_json_value(&value),
            "{\"modelRef\": {\"name\": \"example-model(\\u516c\\u7f51)\", \
             \"namespace\": \"default\"}, \"count\": 2, \"ratio\": 1.5, \"flag\": true, \
             \"missing\": null}"
        );
    }
}
