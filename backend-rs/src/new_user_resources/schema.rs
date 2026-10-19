//! Validation-only projections of `app.schemas.kind` for batch writes.
//!
//! The embedded schemas are generated from Ghost/Bot/Team/Task.model_json_schema.
//! Validation does not replace the original document written by KindBaseService.
use std::sync::OnceLock;

use anyhow::{Result, bail, ensure};
use serde_json::Value;

static SCHEMAS: OnceLock<Value> = OnceLock::new();

pub(super) fn validate(kind: &str, resource: &Value) -> Result<()> {
    let schemas = SCHEMAS.get_or_init(|| {
        serde_json::from_str(include_str!("schema.json")).expect("compiled CRD schemas")
    });
    let Some(schema) = schemas.get(kind) else {
        return Ok(());
    };
    check(schema, schema, resource, 0)?;
    if kind == "Bot" {
        if let Some(policy) = resource
            .pointer("/spec/execution_policy")
            .filter(|v| !v.is_null())
        {
            ensure!(
                (policy.get("mode").and_then(Value::as_str) == Some("fixed"))
                    == policy.get("environment_id").is_some_and(|v| !v.is_null()),
                "invalid execution policy target"
            );
        }
        if let Some(policy) = resource
            .pointer("/spec/model_policy")
            .filter(|v| !v.is_null())
        {
            ensure!(
                (policy.get("mode").and_then(Value::as_str) == Some("fixed"))
                    == policy.get("model").is_some_and(|v| !v.is_null()),
                "invalid fixed model policy"
            );
            if let Some(model) = policy.get("model").filter(|v| !v.is_null()) {
                ensure!(
                    (model.get("source").and_then(Value::as_str) == Some("cloud"))
                        == model.get("cloud_model").is_some_and(|v| !v.is_null()),
                    "invalid cloud model source"
                );
            }
        }
    }
    if kind == "Team"
        && let Some(value) = resource.pointer("/spec/quick_phrases")
        && !value.is_null()
    {
        let phrases = value
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("invalid quick phrases"))?;
        let mut count = 0;
        for phrase in phrases {
            let phrase = phrase
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("invalid quick phrase"))?
                .trim();
            if !phrase.is_empty() {
                count += 1;
                ensure!(phrase.chars().count() <= 120, "quick phrase too long");
            }
        }
        ensure!(count <= 6, "too many quick phrases");
    }
    Ok(())
}

fn check(root: &Value, schema: &Value, value: &Value, depth: usize) -> Result<()> {
    ensure!(depth <= 64, "resource nesting exceeds limit");
    if let Some(reference) = schema.get("$ref").and_then(Value::as_str) {
        let schema = root
            .pointer(reference.trim_start_matches('#'))
            .ok_or_else(|| anyhow::anyhow!("invalid schema reference"))?;
        return check(root, schema, value, depth + 1);
    }
    if let Some(alternatives) = schema.get("anyOf").and_then(Value::as_array) {
        ensure!(
            alternatives
                .iter()
                .any(|s| check(root, s, value, depth + 1).is_ok()),
            "invalid resource field"
        );
        return Ok(());
    }
    if let Some(expected) = schema.get("const") {
        ensure!(value == expected, "invalid constant");
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        ensure!(values.contains(value), "invalid enum value");
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("object") => {
            let object = value
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("expected object"))?;
            if let Some(required) = schema.get("required").and_then(Value::as_array) {
                for key in required.iter().filter_map(Value::as_str) {
                    ensure!(object.contains_key(key), "missing required resource field");
                }
            }
            let properties = schema.get("properties").and_then(Value::as_object);
            for (name, value) in object {
                if let Some(field) = properties.and_then(|p| p.get(name)) {
                    // QuickPhraseMixin's before-validator accepts null as [].
                    if name == "quick_phrases" && value.is_null() {
                        continue;
                    }
                    check(root, field, value, depth + 1)?;
                } else if let Some(extra) = schema.get("additionalProperties") {
                    if extra == &Value::Bool(false) {
                        bail!("unexpected resource property");
                    }
                    if extra.is_object() {
                        check(root, extra, value, depth + 1)?;
                    }
                }
            }
        }
        Some("array") => {
            let values = value
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("expected array"))?;
            if let Some(min) = schema.get("minItems").and_then(Value::as_u64) {
                ensure!(values.len() as u64 >= min, "too few items");
            }
            if let Some(max) = schema.get("maxItems").and_then(Value::as_u64) {
                ensure!(values.len() as u64 <= max, "too many items");
            }
            if let Some(items) = schema.get("items") {
                for value in values {
                    check(root, items, value, depth + 1)?;
                }
            }
        }
        Some("string") => {
            let text = value
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("expected string"))?;
            let count = text.chars().count() as u64;
            if let Some(min) = schema.get("minLength").and_then(Value::as_u64) {
                ensure!(count >= min, "string too short");
            }
            if let Some(max) = schema.get("maxLength").and_then(Value::as_u64) {
                ensure!(count <= max, "string too long");
            }
            if schema.get("pattern").and_then(Value::as_str) == Some("^[1-9][0-9]*$") {
                ensure!(
                    !text.is_empty()
                        && text.as_bytes()[0] >= b'1'
                        && text.as_bytes()[0] <= b'9'
                        && text.bytes().all(|b| b.is_ascii_digit()),
                    "invalid environment identifier"
                );
            }
            if schema.get("format").and_then(Value::as_str) == Some("date-time") {
                ensure!(
                    chrono::DateTime::parse_from_rfc3339(text).is_ok()
                        || chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S%.f")
                            .is_ok(),
                    "invalid datetime"
                );
            }
        }
        Some("boolean") => {
            brz_json::adapters::boolean(value)?;
        }
        Some("integer" | "number") => {
            let number = if schema.get("type").and_then(Value::as_str) == Some("integer") {
                brz_json::adapters::integer(value)? as f64
            } else {
                brz_json::adapters::number(value)?
            };
            if let Some(min) = schema.get("minimum").and_then(Value::as_f64) {
                ensure!(number >= min, "number too small");
            }
            if let Some(max) = schema.get("maximum").and_then(Value::as_f64) {
                ensure!(number <= max, "number too large");
            }
        }
        Some("null") => ensure!(value.is_null(), "expected null"),
        None => (),
        _ => bail!("unsupported compiled resource schema"),
    }
    Ok(())
}
