// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Strict `accountAuth` definition parsing.
//!
//! Source: `app/schemas/plugin_account_auth.py::PluginAccountAuthDefinition`
//! and its `PluginAuthLocalDirectory` / `PluginAuthLocalEnum` members. The
//! schema forbids unknown members (`extra="forbid"`), validates types
//! strictly, and serializes with `model_dump(exclude_none=True)` in field
//! declaration order.

use serde_json::{Map, Value};

/// `CredentialType`.
const CREDENTIAL_TYPES: [&str; 3] = ["password", "bearer", "oauth2"];
/// `oauth2`'s allowed operations.
const OAUTH_OPERATIONS: [&str; 3] = ["authorize", "refresh", "revoke"];
/// `PluginAccountAuthDefinition`'s declared members (`extra="forbid"`).
const DEFINITION_FIELDS: [&str; 6] = [
    "protocolVersion",
    "credentialType",
    "adapter",
    "oauth2",
    "exportMode",
    "localEnvironment",
];
/// `_validate_adapter`'s accepted script suffixes.
const ADAPTER_SUFFIXES: [&str; 4] = [".py", ".mjs", ".sh", ".ps1"];

/// `PluginAccountAuthDefinition.model_validate(...).model_dump(exclude_none=True)`.
///
/// A validation failure is not a `PluginAccountAuthError` in the source, so it
/// surfaces as an internal error rather than a refused connector.
pub(crate) fn parse(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    if object
        .keys()
        .any(|key| !DEFINITION_FIELDS.contains(&key.as_str()))
    {
        return Err(());
    }
    // `protocolVersion: Literal[1]` with a strict `type(value) is int` guard.
    let protocol = object.get("protocolVersion").ok_or(())?;
    if !matches!(protocol, Value::Number(number) if number.is_i64() && number.as_i64() == Some(1)) {
        return Err(());
    }
    let credential_type = object
        .get("credentialType")
        .and_then(Value::as_str)
        .ok_or(())?;
    if !CREDENTIAL_TYPES.contains(&credential_type) {
        return Err(());
    }
    let adapter = object.get("adapter").and_then(Value::as_str).ok_or(())?;
    if !valid_adapter(adapter) {
        return Err(());
    }
    let oauth2 = match object.get("oauth2") {
        None | Some(Value::Null) => None,
        Some(value) => Some(valid_oauth2(value)?),
    };
    let export_mode = match object.get("exportMode") {
        None | Some(Value::Null) => None,
        Some(Value::String(mode)) if mode == "exclusive" => Some("exclusive"),
        _ => return Err(()),
    };
    let local_environment = match object.get("localEnvironment") {
        None | Some(Value::Null) => None,
        Some(value) => Some(valid_local_environment(value)?),
    };
    // `validate_oauth_operations` (model validator).
    if export_mode.is_some() && credential_type != "oauth2" {
        return Err(());
    }
    if oauth2.is_some() && credential_type != "oauth2" {
        return Err(());
    }
    let mut out = Map::new();
    out.insert("protocolVersion".to_string(), Value::from(1));
    out.insert(
        "credentialType".to_string(),
        Value::String(credential_type.to_string()),
    );
    out.insert("adapter".to_string(), Value::String(adapter.to_string()));
    if let Some(operations) = oauth2 {
        out.insert("oauth2".to_string(), operations);
    }
    if let Some(mode) = export_mode {
        out.insert("exportMode".to_string(), Value::String(mode.to_string()));
    }
    if let Some(environment) = local_environment {
        out.insert("localEnvironment".to_string(), environment);
    }
    Ok(Value::Object(out))
}

/// `_validate_adapter`: a bounded relative script path.
fn valid_adapter(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 {
        return false;
    }
    if value.starts_with('/')
        || value.starts_with('~')
        || value.contains('\\')
        || value.contains(':')
    {
        return false;
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'/' | b'-'))
    {
        return false;
    }
    // `PurePosixPath(value).parts` never contains `..` for this alphabet unless
    // the path has a `..` segment.
    if value.split('/').any(|part| part == "..") {
        return false;
    }
    ADAPTER_SUFFIXES
        .iter()
        .any(|suffix| value.ends_with(suffix))
}

/// `oauth2: list[Literal["authorize", "refresh", "revoke"]]`, non-empty and
/// distinct.
fn valid_oauth2(value: &Value) -> Result<Value, ()> {
    let items = value.as_array().ok_or(())?;
    if items.is_empty() {
        return Err(());
    }
    let mut seen: Vec<&str> = Vec::with_capacity(items.len());
    for item in items {
        let operation = item.as_str().ok_or(())?;
        if !OAUTH_OPERATIONS.contains(&operation) || seen.contains(&operation) {
            return Err(());
        }
        seen.push(operation);
    }
    Ok(Value::Array(
        seen.into_iter()
            .map(|operation| Value::String(operation.to_string()))
            .collect(),
    ))
}

/// `localEnvironment`: 1..=16 uppercase-named entries, each a strict
/// directory or enum declaration.
fn valid_local_environment(value: &Value) -> Result<Value, ()> {
    let object = value.as_object().ok_or(())?;
    if object.is_empty() || object.len() > 16 {
        return Err(());
    }
    let mut out = Map::new();
    for (name, entry) in object {
        if !valid_environment_name(name) {
            return Err(());
        }
        out.insert(name.clone(), valid_environment_entry(entry)?);
    }
    Ok(Value::Object(out))
}

/// `[A-Z][A-Z0-9_]{0,63}`.
fn valid_environment_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() > 64 {
        return false;
    }
    bytes[0].is_ascii_uppercase()
        && bytes[1..]
            .iter()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || *byte == b'_')
}

/// `PluginAuthLocalDirectory | PluginAuthLocalEnum` (`strict`, `extra="forbid"`).
fn valid_environment_entry(entry: &Value) -> Result<Value, ()> {
    let object = entry.as_object().ok_or(())?;
    match object.get("type").and_then(Value::as_str) {
        Some("directory") => {
            if object.len() != 1 {
                return Err(());
            }
            let mut out = Map::new();
            out.insert("type".to_string(), Value::String("directory".to_string()));
            Ok(Value::Object(out))
        }
        Some("enum") => {
            if object.len() != 2 {
                return Err(());
            }
            let values = object.get("values").and_then(Value::as_array).ok_or(())?;
            if values.is_empty() || values.len() > 16 {
                return Err(());
            }
            let mut seen: Vec<&str> = Vec::with_capacity(values.len());
            for value in values {
                let text = value.as_str().ok_or(())?;
                if !valid_enum_value(text) || seen.contains(&text) {
                    return Err(());
                }
                seen.push(text);
            }
            let mut out = Map::new();
            out.insert("type".to_string(), Value::String("enum".to_string()));
            out.insert(
                "values".to_string(),
                Value::Array(
                    seen.into_iter()
                        .map(|text| Value::String(text.to_string()))
                        .collect(),
                ),
            );
            Ok(Value::Object(out))
        }
        _ => Err(()),
    }
}

/// `[A-Za-z0-9_.-]{1,64}`.
fn valid_enum_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_recorded_definition_normalizes_to_the_source_dump() {
        // Recording 20261105200002 (case d7eae0ca), ledger 40744 stores this
        // `auth_definition` verbatim.
        let raw = json!({
            "protocolVersion": 1,
            "credentialType": "bearer",
            "adapter": "scripts/account-auth.py",
            "localEnvironment": {
                "DWS_CONFIG_DIR": {"type": "directory"},
                "DWS_KEYCHAIN_DIR": {"type": "directory"},
                "DWS_DISABLE_KEYCHAIN": {"type": "enum", "values": ["1"]}
            }
        });
        assert_eq!(
            parse(&raw).expect("the recorded definition validates"),
            json!({
                "protocolVersion": 1,
                "credentialType": "bearer",
                "adapter": "scripts/account-auth.py",
                "localEnvironment": {
                    "DWS_CONFIG_DIR": {"type": "directory"},
                    "DWS_KEYCHAIN_DIR": {"type": "directory"},
                    "DWS_DISABLE_KEYCHAIN": {"type": "enum", "values": ["1"]}
                }
            })
        );
    }

    #[test]
    fn unknown_members_are_rejected() {
        let raw = json!({
            "protocolVersion": 1,
            "credentialType": "bearer",
            "adapter": "scripts/account-auth.py",
            "extra": true
        });
        assert!(parse(&raw).is_err());
    }

    #[test]
    fn protocol_version_and_credential_type_are_strict() {
        for protocol in [json!("1"), json!(1.0), json!(2), json!(true)] {
            assert!(
                parse(&json!({
                    "protocolVersion": protocol,
                    "credentialType": "bearer",
                    "adapter": "scripts/account-auth.py"
                }))
                .is_err()
            );
        }
        assert!(
            parse(&json!({
                "protocolVersion": 1,
                "credentialType": "password",
                "adapter": "scripts/account-auth.py"
            }))
            .is_ok()
        );
        assert!(
            parse(&json!({
                "protocolVersion": 1,
                "credentialType": "unknown",
                "adapter": "scripts/account-auth.py"
            }))
            .is_err()
        );
    }

    #[test]
    fn adapters_must_be_bounded_relative_scripts() {
        for adapter in [
            "/abs/account.py",
            "~/account.py",
            "scripts\\account.py",
            "c:/account.py",
            "../account.py",
            "scripts/account.txt",
            "",
        ] {
            assert!(
                parse(&json!({
                    "protocolVersion": 1,
                    "credentialType": "bearer",
                    "adapter": adapter
                }))
                .is_err(),
                "{adapter} must be rejected"
            );
        }
        for adapter in ["account.py", "scripts/sub/account.mjs", "x.sh", "y.ps1"] {
            assert!(
                parse(&json!({
                    "protocolVersion": 1,
                    "credentialType": "bearer",
                    "adapter": adapter
                }))
                .is_ok(),
                "{adapter} must be accepted"
            );
        }
    }

    #[test]
    fn oauth_operations_require_oauth_credentials() {
        assert!(
            parse(&json!({
                "protocolVersion": 1,
                "credentialType": "bearer",
                "adapter": "account.py",
                "oauth2": ["authorize"]
            }))
            .is_err()
        );
        assert!(
            parse(&json!({
                "protocolVersion": 1,
                "credentialType": "oauth2",
                "adapter": "account.py",
                "oauth2": ["authorize", "authorize"]
            }))
            .is_err()
        );
        assert!(
            parse(&json!({
                "protocolVersion": 1,
                "credentialType": "oauth2",
                "adapter": "account.py",
                "oauth2": []
            }))
            .is_err()
        );
        assert_eq!(
            parse(&json!({
                "protocolVersion": 1,
                "credentialType": "oauth2",
                "adapter": "account.py",
                "oauth2": ["authorize", "revoke"],
                "exportMode": "exclusive"
            }))
            .expect("exclusive oauth definition"),
            json!({
                "protocolVersion": 1,
                "credentialType": "oauth2",
                "adapter": "account.py",
                "oauth2": ["authorize", "revoke"],
                "exportMode": "exclusive"
            })
        );
    }

    #[test]
    fn local_environment_names_and_entries_are_strict() {
        for bad in [
            json!({"lower": {"type": "directory"}}),
            json!({"A": {"type": "other"}}),
            json!({"A": {"type": "directory", "extra": 1}}),
            json!({"A": {"type": "enum", "values": []}}),
            json!({"A": {"type": "enum", "values": ["a", "a"]}}),
            json!({"A": {"type": "enum", "values": ["bad value"]}}),
        ] {
            assert!(
                parse(&json!({
                    "protocolVersion": 1,
                    "credentialType": "bearer",
                    "adapter": "account.py",
                    "localEnvironment": bad
                }))
                .is_err(),
                "{bad} must be rejected"
            );
        }
    }
}
