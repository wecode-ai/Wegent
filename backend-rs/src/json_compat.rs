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
    render_json_value(value, true, false)
}

/// Apply SQLAlchemy's Python JSON serializer to a typed metadata document.
pub fn python_json<T: serde::Serialize>(value: &T) -> Result<String, serde_json::Error> {
    serde_json::to_value(value).map(|value| python_json_value(&value))
}

/// Render a JSON value like `json.dumps(value, separators=(",", ":"))`
/// (`ensure_ascii=True`): PyJWT's JWS payload encoder
/// (`jwt/api_jws.py:encode`), which keeps the mapping insertion order and
/// escapes non-ASCII the same way.
pub fn python_json_compact(value: &Value) -> String {
    render_json_value(value, true, true)
}

/// Render a JSON value like Python's `json.dumps(..., ensure_ascii=False)`
/// (separators `", "` / `": "`, non-ASCII kept literal). The source's
/// `_build_subtask_content_fields` applies it to non-string message content
/// before the value is stored.
pub fn python_json_value_no_ascii(value: &Value) -> String {
    render_json_value(value, false, false)
}

fn render_json_value(value: &Value, ensure_ascii: bool, compact: bool) -> String {
    let (item_separator, key_separator) = if compact { (",", ":") } else { (", ", ": ") };
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => render_json_string(text, ensure_ascii),
        Value::Array(items) => {
            let mut out = String::from("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(item_separator);
                }
                out.push_str(&render_json_value(item, ensure_ascii, compact));
            }
            out.push(']');
            out
        }
        Value::Object(map) => {
            let mut out = String::from("{");
            for (index, (key, item)) in map.iter().enumerate() {
                if index > 0 {
                    out.push_str(item_separator);
                }
                out.push_str(&render_json_string(key, ensure_ascii));
                out.push_str(key_separator);
                out.push_str(&render_json_value(item, ensure_ascii, compact));
            }
            out.push('}');
            out
        }
    }
}

/// Python truthiness (`bool(value)`) for a decoded JSON value: `None`,
/// `False`, numeric zero, the empty string, and empty arrays/objects are
/// falsy; every other value is truthy.
pub fn python_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_none_or(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// Python `str(value)` for a decoded JSON value. Containers render through
/// `repr()`, which is also what `str()` applies to their elements.
pub fn python_str(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(_) | Value::Object(_) => python_repr(value),
        other => python_scalar_repr(other),
    }
}

/// Python `repr(value)` for a decoded JSON value.
pub fn python_repr(value: &Value) -> String {
    match value {
        Value::String(text) => python_string_repr(text),
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(python_repr).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Object(map) => {
            let parts: Vec<String> = map
                .iter()
                .map(|(key, value)| format!("{}: {}", python_string_repr(key), python_repr(value)))
                .collect();
            format!("{{{}}}", parts.join(", "))
        }
        other => python_scalar_repr(other),
    }
}

/// Python `repr()` of a JSON scalar: `None`, `True`, `False`, and decimals.
/// Floats use Rust's shortest round-trip rendering, which matches Python's
/// `repr()` for the common integral and fractional values (only the exponent
/// spelling of extreme magnitudes can differ).
fn python_scalar_repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        Value::Number(number) => {
            if let Some(signed) = number.as_i64() {
                signed.to_string()
            } else if let Some(unsigned) = number.as_u64() {
                unsigned.to_string()
            } else {
                let float = number.as_f64().unwrap_or_default();
                format!("{float:?}")
            }
        }
        Value::String(text) => text.clone(),
        Value::Array(_) | Value::Object(_) => python_repr(value),
    }
}

/// Python's single-quoted string `repr()`: single quotes unless the text
/// contains a single quote and no double quote.
fn python_string_repr(text: &str) -> String {
    if text.contains('\'') && !text.contains('"') {
        format!("\"{text}\"")
    } else {
        format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_truthiness_matches_the_source_coercions() {
        assert!(!python_truthy(&Value::Null));
        assert!(!python_truthy(&json!(false)));
        assert!(python_truthy(&json!(true)));
        assert!(!python_truthy(&json!(0)));
        assert!(!python_truthy(&json!(0.0)));
        assert!(python_truthy(&json!(-1)));
        assert!(!python_truthy(&json!("")));
        assert!(python_truthy(&json!("0")));
        assert!(!python_truthy(&json!([])));
        assert!(!python_truthy(&json!({})));
        assert!(python_truthy(&json!([null])));
    }

    #[test]
    fn python_str_matches_the_source_coercions() {
        assert_eq!(python_str(&Value::Null), "None");
        assert_eq!(python_str(&json!(true)), "True");
        assert_eq!(python_str(&json!(false)), "False");
        assert_eq!(python_str(&json!(7)), "7");
        assert_eq!(python_str(&json!(-3)), "-3");
        assert_eq!(python_str(&json!("ok")), "ok");
        assert_eq!(python_str(&json!(["a", 1])), "['a', 1]");
        assert_eq!(python_str(&json!({"k": "v"})), "{'k': 'v'}");
    }

    #[test]
    fn python_json_string_escapes_non_ascii() {
        assert_eq!(python_json_string("示例"), "\"\\u793a\\u4f8b\"");
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

    #[test]
    fn python_json_compact_matches_the_jws_payload_separators() {
        let value = serde_json::json!({
            "iss": "wegent",
            "aud": "example-audience",
            "user_name": "示例",
            "issuer_id": 402,
            "enabled": true,
            "missing": null
        });
        assert_eq!(
            python_json_compact(&value),
            "{\"iss\":\"wegent\",\"aud\":\"example-audience\",\"user_name\":\"\\u793a\\u4f8b\",\
             \"issuer_id\":402,\"enabled\":true,\"missing\":null}"
        );
    }
}
