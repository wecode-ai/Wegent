// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Enforce advertised field boundaries before forwarding to the shared PATCH API.
//! Value constraints and business validation remain owned by the Backend.

use serde_json::Value;

const MAX_SCHEMA_DEPTH: usize = 128;

fn invalid_schema() -> String {
    super::failure(
        "invalid_response",
        "The Backend returned an invalid project administration input schema.",
    )
}

pub(super) fn validate(arguments: &Value, schema: &Value) -> Result<(), String> {
    if !schema.is_object() {
        return Err(invalid_schema());
    }
    let mut supplied = arguments.clone();
    if let Some(object) = supplied.as_object_mut() {
        // The Runtime adds this binding; it is not a caller-supplied tool field.
        object.remove("item_id");
    }
    visit(&supplied, schema, schema, "", MAX_SCHEMA_DEPTH)
}

fn reference<'a>(schema: &Value, root: &'a Value) -> Result<Option<&'a Value>, String> {
    let Some(reference) = schema.get("$ref") else {
        return Ok(None);
    };
    reference
        .as_str()
        .and_then(|value| value.strip_prefix('#'))
        .and_then(|pointer| root.pointer(pointer))
        .map(Some)
        .ok_or_else(invalid_schema)
}

fn visit(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    remaining: usize,
) -> Result<(), String> {
    let next = remaining.checked_sub(1).ok_or_else(invalid_schema)?;
    if let Some(resolved) = reference(schema, root)? {
        visit(value, resolved, root, path, next)?;
    }
    for branch in schema["allOf"].as_array().into_iter().flatten() {
        visit(value, branch, root, path, next)?;
    }
    for keyword in ["anyOf", "oneOf"] {
        if let Some(branches) = schema[keyword].as_array() {
            visit_alternatives(value, branches, root, path, next)?;
        }
    }
    if let Some(object) = value.as_object() {
        for (key, child) in object {
            let field_path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            if let Some(property) = schema["properties"].get(key) {
                visit(child, property, root, &field_path, next)?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(super::field_failure(
                    "unsupported_field",
                    &field_path,
                    "Unsupported project configuration field.",
                ));
            } else if let Some(additional) = schema.get("additionalProperties") {
                visit(child, additional, root, &field_path, next)?;
            }
        }
    } else if let (Some(items), Some(schema)) = (value.as_array(), schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            visit(item, schema, root, &format!("{path}.{index}"), next)?;
        }
    }
    Ok(())
}

fn visit_alternatives(
    value: &Value,
    branches: &[Value],
    root: &Value,
    path: &str,
    remaining: usize,
) -> Result<(), String> {
    let mut first_error = None;
    for branch in branches {
        if !matches_kind(value, branch, root, remaining)? {
            continue;
        }
        match visit(value, branch, root, path, remaining) {
            Ok(()) => return Ok(()),
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    // A value with the wrong type is still rejected by the Backend's typed model.
    first_error.map_or(Ok(()), Err)
}

fn matches_kind(
    value: &Value,
    schema: &Value,
    root: &Value,
    remaining: usize,
) -> Result<bool, String> {
    let next = remaining.checked_sub(1).ok_or_else(invalid_schema)?;
    if let Some(resolved) = reference(schema, root)? {
        if !matches_kind(value, resolved, root, next)? {
            return Ok(false);
        }
    }
    Ok(match schema.get("type") {
        Some(Value::String(kind)) => is_kind(value, kind),
        Some(Value::Array(kinds)) => kinds
            .iter()
            .filter_map(Value::as_str)
            .any(|kind| is_kind(value, kind)),
        _ => true,
    })
}

fn is_kind(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "number" => value.is_number(),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nullable_references_keep_closed_fields_and_open_dictionary_values() {
        let schema = json!({
            "$defs": {"Binding": {"type": "object", "additionalProperties": false,
                "properties": {"known": {"type": "string"}}}},
            "properties": {"bindings": {"anyOf": [
                {"type": "object", "additionalProperties": {"$ref": "#/$defs/Binding"}},
                {"type": "null"}
            ]}}
        });
        for value in [
            json!({"bindings": null}),
            json!({"bindings": {"arbitrary-id": {"known": "ok"}}}),
        ] {
            validate(&value, &schema).unwrap();
        }
        let error = validate(
            &json!({"bindings": {"arbitrary-id": {"extra": 1}}}),
            &schema,
        )
        .unwrap_err();
        let error: Value = serde_json::from_str(&error).unwrap();
        assert_eq!(error["error"]["reason_code"], "unsupported_field");
        assert_eq!(
            error["error"]["fields"][0]["path"],
            "bindings.arbitrary-id.extra"
        );
    }

    #[test]
    fn invalid_and_recursive_references_fail_without_forwarding_unchecked_fields() {
        for schema in [
            Value::Null,
            json!({"$ref": "#/$defs/missing"}),
            json!({"$ref": "#"}),
        ] {
            let error: Value =
                serde_json::from_str(&validate(&json!({}), &schema).unwrap_err()).unwrap();
            assert_eq!(error["error"]["reason_code"], "invalid_response");
        }
    }
}
