// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! `TranscriptSegmentCommitRequest` validation for
//! `POST /api/wework-transcripts/{transcript_id}/segments`.
//!
//! Mirrors `app.schemas.wework_transcript`'s pydantic v2 validation of the
//! multipart `metadata` manifest: the lax scalar coercions, field bounds and
//! patterns, `populate_by_name` aliases, and the `ValidationError.errors()`
//! entries the endpoint renders as its 422 detail.

use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

/// `MAX_ENCRYPTED_TRANSCRIPT_SEGMENT_BYTES` (`app.schemas.wework_transcript`).
pub(crate) const MAX_SEGMENT_BYTES: i64 = 256 * 1024 * 1024 + 33;

/// `TranscriptSegmentCommitRequest` (`app.schemas.wework_transcript`) after
/// pydantic validation. `populate_by_name=True` accepts the snake_case names
/// as well; the recorded client sends the camelCase aliases.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SegmentRequest {
    pub(crate) client_id: String,
    pub(crate) base_sequence: i64,
    pub(crate) fencing_token: i64,
    pub(crate) title: Option<String>,
    pub(crate) sequence: i64,
    pub(crate) sha256: String,
    pub(crate) size_bytes: i64,
    pub(crate) format: String,
    pub(crate) turn_id: String,
    pub(crate) summary: Value,
}

/// `TranscriptSegmentCommitRequest.model_validate_json(metadata)`: pydantic v2
/// validation of the JSON manifest. A failure is the endpoint's
/// `HTTPException(422, detail=exc.errors())`.
pub(crate) fn parse_segment_request(raw: &str) -> Result<SegmentRequest, FastApiError> {
    let value: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(error) => {
            return Err(FastApiError::validation(vec![pydantic_error(
                "json_invalid",
                &[],
                &format!("Invalid JSON: {error}"),
                &Value::String(raw.to_string()),
                Some(json!({"error": error.to_string()})),
            )]));
        }
    };
    let Value::Object(object) = &value else {
        return Err(FastApiError::validation(vec![pydantic_error(
            "model_type",
            &[],
            "Input should be an object",
            &value,
            Some(json!({"class_name": "TranscriptSegmentCommitRequest"})),
        )]));
    };

    let mut errors: Vec<Value> = Vec::new();
    let client_id = string_field(object, "clientId", "client_id", 1, Some(100), &mut errors);
    let base_sequence = match int_field(object, "baseSequence", "base_sequence", &mut errors) {
        Some(value) if value < 0 => {
            push_bound_error(
                &mut errors,
                "baseSequence",
                "base_sequence",
                object,
                "greater_than_equal",
                "Input should be greater than or equal to 0",
                json!({"ge": 0}),
            );
            None
        }
        other => other,
    };
    let fencing_token = match int_field(object, "fencingToken", "fencing_token", &mut errors) {
        Some(value) if value < 1 => {
            push_bound_error(
                &mut errors,
                "fencingToken",
                "fencing_token",
                object,
                "greater_than_equal",
                "Input should be greater than or equal to 1",
                json!({"ge": 1}),
            );
            None
        }
        other => other,
    };
    let title = optional_string(object, "title", 512, &mut errors);
    let sequence = match int_field(object, "sequence", "sequence", &mut errors) {
        Some(value) if value < 1 => {
            push_bound_error(
                &mut errors,
                "sequence",
                "sequence",
                object,
                "greater_than_equal",
                "Input should be greater than or equal to 1",
                json!({"ge": 1}),
            );
            None
        }
        other => other,
    };
    let sha256 = match string_field(object, "sha256", "sha256", 0, None, &mut errors) {
        Some(text) if is_sha256(&text) => Some(text),
        Some(_) => {
            push_pattern_error(&mut errors, "sha256", "sha256", object, SHA256_PATTERN);
            None
        }
        None => None,
    };
    let size_bytes = match int_field(object, "sizeBytes", "size_bytes", &mut errors) {
        Some(value) if value <= 0 => {
            push_bound_error(
                &mut errors,
                "sizeBytes",
                "size_bytes",
                object,
                "greater_than",
                "Input should be greater than 0",
                json!({"gt": 0}),
            );
            None
        }
        Some(value) if value > MAX_SEGMENT_BYTES => {
            push_bound_error(
                &mut errors,
                "sizeBytes",
                "size_bytes",
                object,
                "less_than_equal",
                &format!("Input should be less than or equal to {MAX_SEGMENT_BYTES}"),
                json!({"le": MAX_SEGMENT_BYTES}),
            );
            None
        }
        other => other,
    };
    let format = match string_field(object, "format", "format", 0, Some(32), &mut errors) {
        Some(text) if is_segment_format(&text) => Some(text),
        Some(_) => {
            push_pattern_error(&mut errors, "format", "format", object, FORMAT_PATTERN);
            None
        }
        None => None,
    };
    let turn_id = string_field(object, "turnId", "turn_id", 1, Some(100), &mut errors);
    let summary = required_object(object, "summary", "summary", &mut errors);

    if !errors.is_empty() {
        return Err(FastApiError::validation(errors));
    }

    Ok(SegmentRequest {
        client_id: client_id.expect("validated"),
        base_sequence: base_sequence.expect("validated"),
        fencing_token: fencing_token.expect("validated"),
        title,
        sequence: sequence.expect("validated"),
        sha256: sha256.expect("validated"),
        size_bytes: size_bytes.expect("validated"),
        format: format.expect("validated"),
        turn_id: turn_id.expect("validated"),
        summary: summary.expect("validated"),
    })
}

/// `^[0-9a-f]{64}$`.
pub(crate) const SHA256_PATTERN: &str = "^[0-9a-f]{64}$";
/// `^codex-(delta|snapshot)\.v1\.tgz\.aes256gcm$`.
pub(crate) const FORMAT_PATTERN: &str = "^codex-(delta|snapshot)\\.v1\\.tgz\\.aes256gcm$";

/// The field's input value and the key name actually used in the body (the
/// alias wins over the snake_case name, and pydantic reports the used key in
/// `loc`).
fn field_value<'a>(
    object: &'a Map<String, Value>,
    alias: &'a str,
    name: &'a str,
) -> Option<(&'a str, &'a Value)> {
    if let Some(value) = object.get(alias) {
        Some((alias, value))
    } else {
        object.get(name).map(|value| (name, value))
    }
}

fn string_field(
    object: &Map<String, Value>,
    alias: &str,
    name: &'static str,
    min: usize,
    max: Option<usize>,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let Some((loc, value)) = field_value(object, alias, name) else {
        errors.push(pydantic_error(
            "missing",
            &[alias],
            "Field required",
            &Value::Object(object.clone()),
            None,
        ));
        return None;
    };
    let Value::String(text) = value else {
        errors.push(pydantic_error(
            "string_type",
            &[loc],
            "Input should be a valid string",
            value,
            None,
        ));
        return None;
    };
    let length = text.chars().count();
    if length < min {
        errors.push(pydantic_error(
            "string_too_short",
            &[loc],
            &format!("String should have at least {min} character{}", plural(min)),
            value,
            Some(json!({"min_length": min})),
        ));
        return None;
    }
    if let Some(max) = max
        && length > max
    {
        errors.push(pydantic_error(
            "string_too_long",
            &[loc],
            &format!("String should have at most {max} character{}", plural(max)),
            value,
            Some(json!({"max_length": max})),
        ));
        return None;
    }
    Some(text.clone())
}

fn optional_string(
    object: &Map<String, Value>,
    name: &'static str,
    max: usize,
    errors: &mut Vec<Value>,
) -> Option<String> {
    match object.get(name) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => {
            if text.chars().count() > max {
                push_string_too_long(errors, name, name, object, max);
                return None;
            }
            Some(text.clone())
        }
        Some(value) => {
            errors.push(pydantic_error(
                "string_type",
                &[name],
                "Input should be a valid string",
                value,
                None,
            ));
            None
        }
    }
}

fn int_field(
    object: &Map<String, Value>,
    alias: &str,
    name: &'static str,
    errors: &mut Vec<Value>,
) -> Option<i64> {
    let Some((loc, value)) = field_value(object, alias, name) else {
        errors.push(pydantic_error(
            "missing",
            &[alias],
            "Field required",
            &Value::Object(object.clone()),
            None,
        ));
        return None;
    };
    match parse_int(value) {
        Ok(parsed) => Some(parsed),
        Err((kind, message)) => {
            errors.push(pydantic_error(kind, &[loc], message, value, None));
            None
        }
    }
}

/// Pydantic v2 lax integer coercion: booleans and integral floats coerce,
/// numeric strings parse, fractional floats and non-numeric strings fail.
pub(crate) fn parse_int(value: &Value) -> Result<i64, (&'static str, &'static str)> {
    match value {
        Value::Bool(flag) => Ok(i64::from(*flag)),
        Value::Number(number) => {
            if let Some(parsed) = number.as_i64() {
                Ok(parsed)
            } else {
                number.as_f64().map_or(
                    Err((
                        "int_parsing",
                        "Input should be a valid integer, unable to parse string as an integer",
                    )),
                    integral_float,
                )
            }
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if let Ok(parsed) = trimmed.parse::<i64>() {
                Ok(parsed)
            } else if let Ok(parsed) = trimmed.parse::<f64>() {
                integral_float(parsed)
            } else {
                Err((
                    "int_parsing",
                    "Input should be a valid integer, unable to parse string as an integer",
                ))
            }
        }
        Value::Null | Value::Array(_) | Value::Object(_) => {
            Err(("int_type", "Input should be a valid integer"))
        }
    }
}

fn integral_float(value: f64) -> Result<i64, (&'static str, &'static str)> {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        Ok(value as i64)
    } else {
        Err((
            "int_from_float",
            "Input should be a valid integer, got a number with a fractional part",
        ))
    }
}

fn required_object(
    object: &Map<String, Value>,
    alias: &str,
    name: &'static str,
    errors: &mut Vec<Value>,
) -> Option<Value> {
    let Some((loc, value)) = field_value(object, alias, name) else {
        errors.push(pydantic_error(
            "missing",
            &[alias],
            "Field required",
            &Value::Object(object.clone()),
            None,
        ));
        return None;
    };
    if value.is_object() {
        Some(value.clone())
    } else {
        errors.push(pydantic_error(
            "dict_type",
            &[loc],
            "Input should be an object",
            value,
            None,
        ));
        None
    }
}

fn push_bound_error(
    errors: &mut Vec<Value>,
    alias: &str,
    name: &str,
    object: &Map<String, Value>,
    kind: &str,
    message: &str,
    ctx: Value,
) {
    let Some((loc, value)) = field_value(object, alias, name) else {
        return;
    };
    errors.push(pydantic_error(kind, &[loc], message, value, Some(ctx)));
}

fn push_pattern_error(
    errors: &mut Vec<Value>,
    alias: &str,
    name: &str,
    object: &Map<String, Value>,
    pattern: &str,
) {
    let Some((loc, value)) = field_value(object, alias, name) else {
        return;
    };
    errors.push(pydantic_error(
        "string_pattern_mismatch",
        &[loc],
        &format!("String should match pattern '{pattern}'"),
        value,
        Some(json!({"pattern": pattern})),
    ));
}

fn push_string_too_long(
    errors: &mut Vec<Value>,
    alias: &str,
    name: &str,
    object: &Map<String, Value>,
    max: usize,
) {
    let Some((loc, value)) = field_value(object, alias, name) else {
        return;
    };
    errors.push(pydantic_error(
        "string_too_long",
        &[loc],
        &format!("String should have at most {max} characters"),
        value,
        Some(json!({"max_length": max})),
    ));
}

fn plural(count: usize) -> &'static str {
    if count == 1 { "" } else { "s" }
}

/// One pydantic v2 error entry, including the documentation URL pydantic
/// attaches to `ValidationError.errors()`.
pub(crate) fn pydantic_error(
    kind: &str,
    loc: &[&str],
    message: &str,
    input: &Value,
    ctx: Option<Value>,
) -> Value {
    let mut entry = json!({
        "type": kind,
        "loc": loc,
        "msg": message,
        "input": input,
        "url": format!("https://errors.pydantic.dev/2.12/v/{kind}"),
    });
    if let Some(ctx) = ctx {
        entry["ctx"] = ctx;
    }
    entry
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn is_segment_format(value: &str) -> bool {
    matches!(
        value,
        "codex-delta.v1.tgz.aes256gcm" | "codex-snapshot.v1.tgz.aes256gcm"
    )
}
