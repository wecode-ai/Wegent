//! TOML encoding used by MCP command configuration and context bindings.
use serde_json::Value;

pub fn toml_key_path(segments: &[&str]) -> String {
    segments
        .iter()
        .map(|segment| toml_key_segment(segment))
        .collect::<Vec<_>>()
        .join(".")
}

pub fn toml_key_segment(segment: &str) -> String {
    if segment
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '_' || character == '-')
    {
        segment.to_owned()
    } else {
        serde_json::to_string(segment).unwrap_or_else(|_| "\"invalid\"".to_owned())
    }
}

pub fn toml_value(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

pub fn toml_json_value(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(|item| match item {
                    Value::String(value) => toml_value(value),
                    _ => item.to_string(),
                })
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::String(value) => toml_value(value),
        _ => value.to_string(),
    }
}
