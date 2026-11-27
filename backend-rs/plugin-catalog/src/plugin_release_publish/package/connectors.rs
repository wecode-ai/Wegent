// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Connector declarations and their device/account authentication contracts
//! (`PluginPackageParser._parse_connectors`, `_parse_local_auth*`,
//! `PluginAccountAuthDefinition`).

use std::collections::BTreeSet;

use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

use super::{bad_request, py_string};

/// `_parse_connectors`
pub(super) fn parse_connectors(manifest: &Value) -> Result<Value, FastApiError> {
    let Some(items) = manifest.get("connectors").and_then(Value::as_array) else {
        return Ok(json!([]));
    };
    let mut connectors = Vec::new();
    let mut seen = BTreeSet::new();
    for item in items {
        let Some(item) = item.as_object() else {
            continue;
        };
        let slug = item
            .get("slug")
            .map(py_string)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if !valid_slug(&slug) || !seen.insert(slug.clone()) {
            continue;
        }
        let auth_policy = match item.get("authPolicy") {
            None => "optional".to_owned(),
            Some(value) => {
                let policy = py_string(value);
                if !matches!(policy.as_str(), "on_install" | "on_use" | "optional") {
                    continue;
                }
                policy
            }
        };
        let local_auth = parse_local_auth(item.get("localAuth"));
        let account_auth = match item.get("accountAuth") {
            None => None,
            Some(value) => Some(
                parse_account_auth(value)
                    .ok_or_else(|| bad_request("Invalid plugin accountAuth declaration"))?,
            ),
        };
        let mut connector = Map::new();
        connector.insert("slug".into(), json!(slug));
        for key in ["displayName", "description"] {
            match item.get(key) {
                None | Some(Value::Null) => {}
                Some(Value::String(text)) => {
                    connector.insert(key.into(), json!(text));
                }
                // `Optional[str]` rejects a non-string declaration.
                Some(_) => return Err(bad_request("Invalid plugin connector declaration")),
            }
        }
        if let Some(value) = item.get("authorizationGroup") {
            connector.insert(
                "authorizationGroup".into(),
                parse_authorization_group(value)?,
            );
        }
        connector.insert("authPolicy".into(), json!(auth_policy));
        if let Some(local_auth) = local_auth {
            connector.insert("localAuth".into(), local_auth);
        }
        if let Some(account_auth) = account_auth {
            connector.insert("accountAuth".into(), account_auth);
        }
        connectors.push(Value::Object(connector));
    }
    Ok(json!(connectors))
}

fn parse_authorization_group(value: &Value) -> Result<Value, FastApiError> {
    let invalid = || bad_request("Invalid plugin connector declaration");
    let Some(object) = value.as_object() else {
        return Err(invalid());
    };
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "displayName"))
    {
        return Err(invalid());
    }
    let Some(id) = object.get("id").and_then(Value::as_str) else {
        return Err(invalid());
    };
    if !valid_slug(id) {
        return Err(invalid());
    }
    let Some(display) = object.get("displayName").and_then(Value::as_str) else {
        return Err(invalid());
    };
    let length = display.chars().count();
    if length == 0 || length > 100 {
        return Err(invalid());
    }
    Ok(json!({"id": id, "displayName": display}))
}

fn valid_slug(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    let count = value.chars().count();
    if count > 100 {
        return false;
    }
    let mut last = value.chars().last().unwrap();
    if count > 1 {
        for character in value.chars().skip(1) {
            if !(character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '_' | '-' | '.'))
            {
                return false;
            }
            last = character;
        }
    }
    count == 1 || last.is_ascii_lowercase() || last.is_ascii_digit()
}

/// `_parse_local_auth`
fn parse_local_auth(raw: Option<&Value>) -> Option<Value> {
    let raw = raw?.as_object()?;
    let kind = match raw.get("kind") {
        None => "local_qr".to_owned(),
        Some(value) => {
            let kind = py_string(value).trim().to_owned();
            if !matches!(kind.as_str(), "local_qr" | "browser_oauth") {
                return None;
            }
            kind
        }
    };
    let command_list = |key: &str| -> Vec<String> {
        let Some(items) = raw.get(key).and_then(Value::as_array) else {
            return Vec::new();
        };
        items
            .iter()
            .map(|item| item.as_str().map(str::trim).unwrap_or("").to_owned())
            .filter(|text| {
                !text.is_empty()
                    && !text.starts_with('/')
                    && !text.starts_with('~')
                    && !text.split('/').any(|part| part == "..")
                    && !windows_absolute(text)
            })
            .collect()
    };
    let health = command_list("health");
    let start = command_list("start");
    let poll = command_list("poll");
    let logout = command_list("logout");
    if health.is_empty() || start.is_empty() || (kind == "local_qr" && poll.is_empty()) {
        return None;
    }
    let tool = parse_local_auth_tool(raw.get("tool"));
    if raw.get("tool").is_some_and(|value| !value.is_null()) && tool.is_none() {
        return None;
    }
    let poll_interval = match raw.get("pollIntervalSeconds") {
        None => 2,
        Some(value) => match int_coerce(value) {
            Some(value) => value.clamp(1, 30),
            None => 2,
        },
    };
    let default_timeout = if kind == "browser_oauth" { 300 } else { 45 };
    let timeout = match raw.get("timeoutSeconds") {
        None => default_timeout,
        Some(value) => match int_coerce(value) {
            Some(value) => value.clamp(15, 600),
            None => default_timeout,
        },
    };
    let ok_values = match raw.get("okValues").and_then(Value::as_array) {
        None => vec!["ok".to_owned()],
        Some(items) => {
            let values = items
                .iter()
                .map(|item| py_string(item).trim().to_owned())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if values.is_empty() {
                vec!["ok".to_owned()]
            } else {
                values
            }
        }
    };
    let logout_on_uninstall = match raw.get("logoutOnUninstall") {
        Some(Value::Bool(value)) => *value,
        _ => kind == "local_qr",
    };
    let qr_field = raw
        .get("qrField")
        .map(|value| py_string(value).trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "qr_path".to_owned());
    let status_field = raw
        .get("statusField")
        .map(|value| py_string(value).trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "status".to_owned());
    let mut definition = Map::new();
    definition.insert("kind".into(), json!(kind));
    definition.insert("health".into(), json!(health));
    definition.insert("start".into(), json!(start));
    definition.insert("poll".into(), json!(poll));
    definition.insert("logout".into(), json!(logout));
    if let Some(tool) = tool {
        definition.insert("tool".into(), tool);
    }
    definition.insert("qrField".into(), json!(qr_field));
    definition.insert("statusField".into(), json!(status_field));
    definition.insert("okValues".into(), json!(ok_values));
    definition.insert("pollIntervalSeconds".into(), json!(poll_interval));
    definition.insert("timeoutSeconds".into(), json!(timeout));
    definition.insert("logoutOnUninstall".into(), json!(logout_on_uninstall));
    Some(Value::Object(definition))
}

fn windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes.get(2), Some(b'\\') | Some(b'/'))
}

/// `_parse_local_auth_tool`
fn parse_local_auth_tool(raw: Option<&Value>) -> Option<Value> {
    let raw = raw?.as_object()?;
    let tool_id = raw
        .get("id")
        .map(|value| py_string(value).trim().to_owned())
        .unwrap_or_default();
    if !pattern(&tool_id, |value| {
        matches!(
            value.chars().next(),
            Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit()
        ) && value.chars().count() <= 64
            && value
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    }) {
        return None;
    }
    let source = raw
        .get("source")
        .map(|value| py_string(value).trim().to_owned())
        .unwrap_or_default();
    if !matches!(source.as_str(), "bundled" | "managed") {
        return None;
    }
    let version = raw
        .get("version")
        .map(|value| py_string(value).trim().to_owned())
        .filter(|value| !value.is_empty());
    let mut definition = Map::new();
    definition.insert("id".into(), json!(tool_id));
    definition.insert("source".into(), json!(source));
    if source == "bundled" {
        return Some(Value::Object(definition));
    }
    let version = version?;
    if !pattern(&version, |value| {
        matches!(value.chars().next(), Some(c) if c.is_ascii_alphanumeric())
            && value.chars().count() <= 64
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    }) {
        return None;
    }
    let artifacts = raw.get("artifacts").and_then(Value::as_object)?;
    if artifacts.is_empty() {
        return None;
    }
    let mut parsed_artifacts = Map::new();
    for (target, artifact) in artifacts {
        parsed_artifacts.insert(target.clone(), parse_local_auth_artifact(target, artifact)?);
    }
    definition.insert("version".into(), json!(version));
    definition.insert("artifacts".into(), Value::Object(parsed_artifacts));
    Some(Value::Object(definition))
}

/// `_parse_local_auth_artifact`
fn parse_local_auth_artifact(target: &str, raw: &Value) -> Option<Value> {
    if !matches!(
        target,
        "darwin-x64"
            | "darwin-arm64"
            | "linux-x64"
            | "linux-arm64"
            | "windows-x64"
            | "windows-arm64"
    ) {
        return None;
    }
    let raw = raw.as_object()?;
    let url = raw.get("url").map(py_string).unwrap_or_default();
    let url = url.trim().to_owned();
    let sha256 = raw
        .get("sha256")
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    let archive = raw
        .get("archive")
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    let binary_path = raw
        .get("binaryPath")
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !url.starts_with("https://") || !is_hex64(&sha256) {
        return None;
    }
    if !matches!(archive.as_str(), "tar_gz" | "zip") {
        return None;
    }
    if binary_path.is_empty()
        || binary_path.starts_with('/')
        || binary_path.starts_with('~')
        || binary_path.contains('\\')
        || binary_path.split('/').any(|part| part == "..")
        || windows_absolute(&binary_path)
    {
        return None;
    }
    Some(json!({
        "url": url,
        "sha256": sha256,
        "archive": archive,
        "binaryPath": binary_path,
    }))
}

/// `PluginAccountAuthDefinition.model_validate` (`strict=True`, extra forbid).
fn parse_account_auth(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "protocolVersion"
                | "credentialType"
                | "adapter"
                | "oauth2"
                | "exportMode"
                | "localEnvironment"
        )
    }) {
        return None;
    }
    // `validate_protocol_version` runs in `before` mode and requires a real
    // int 1; the declared default (1) is not validated when the key is absent.
    if let Some(value) = object.get("protocolVersion")
        && (value.as_i64() != Some(1) || value.as_bool().is_some())
    {
        return None;
    }
    let credential_type = object.get("credentialType")?.as_str()?;
    if !matches!(credential_type, "password" | "bearer" | "oauth2") {
        return None;
    }
    let adapter = object.get("adapter")?.as_str()?;
    let length = adapter.chars().count();
    if length == 0
        || length > 256
        || adapter.starts_with('/')
        || adapter.starts_with('~')
        || adapter.contains('\\')
        || adapter.contains(':')
        || adapter.split('/').any(|part| part == "..")
        || !adapter
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'))
        || !(adapter.ends_with(".py")
            || adapter.ends_with(".mjs")
            || adapter.ends_with(".sh")
            || adapter.ends_with(".ps1"))
    {
        return None;
    }
    let oauth2 = match object.get("oauth2") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let items = value.as_array()?;
            let mut operations = Vec::with_capacity(items.len());
            for item in items {
                let operation = item.as_str()?;
                if !matches!(operation, "authorize" | "refresh" | "revoke") {
                    return None;
                }
                operations.push(operation.to_owned());
            }
            Some(operations)
        }
    };
    let export_mode = match object.get("exportMode") {
        None | Some(Value::Null) => None,
        Some(value) => {
            if value.as_str() != Some("exclusive") {
                return None;
            }
            Some("exclusive".to_owned())
        }
    };
    let local_environment = match object.get("localEnvironment") {
        None | Some(Value::Null) => None,
        Some(value) => Some(parse_local_environment(value)?),
    };
    // `validate_oauth_operations`
    if export_mode.is_some() && credential_type != "oauth2" {
        return None;
    }
    if let Some(operations) = &oauth2 {
        let distinct = operations.iter().collect::<BTreeSet<_>>();
        if credential_type != "oauth2"
            || operations.is_empty()
            || distinct.len() != operations.len()
        {
            return None;
        }
    }
    let mut definition = Map::new();
    definition.insert("protocolVersion".into(), json!(1));
    definition.insert("credentialType".into(), json!(credential_type));
    definition.insert("adapter".into(), json!(adapter));
    if let Some(oauth2) = oauth2 {
        definition.insert("oauth2".into(), json!(oauth2));
    }
    if let Some(export_mode) = export_mode {
        definition.insert("exportMode".into(), json!(export_mode));
    }
    if let Some(local_environment) = local_environment {
        definition.insert("localEnvironment".into(), local_environment);
    }
    Some(Value::Object(definition))
}

fn parse_local_environment(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let length = object.len();
    if length == 0 || length > 16 {
        return None;
    }
    let mut environment = Map::new();
    for (name, declaration) in object {
        let mut chars = name.chars();
        match chars.next() {
            Some(first) if first.is_ascii_uppercase() => {}
            _ => return None,
        }
        if name.chars().count() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
        {
            return None;
        }
        environment.insert(name.clone(), parse_local_declaration(declaration)?);
    }
    Some(Value::Object(environment))
}

fn parse_local_declaration(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    match object.get("type")?.as_str()? {
        "directory" if object.len() == 1 => Some(json!({"type": "directory"})),
        "enum" if object.len() == 2 => {
            let values = object.get("values")?.as_array()?;
            if values.is_empty() || values.len() > 16 {
                return None;
            }
            let mut parsed = Vec::with_capacity(values.len());
            for value in values {
                let value = value.as_str()?;
                if !pattern(value, |value| {
                    !value.is_empty()
                        && value.chars().count() <= 64
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
                }) {
                    return None;
                }
                parsed.push(value.to_owned());
            }
            let distinct = parsed.iter().collect::<BTreeSet<_>>();
            if distinct.len() != parsed.len() {
                return None;
            }
            Some(json!({"type": "enum", "values": parsed}))
        }
        _ => None,
    }
}

pub(super) fn is_hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn pattern(value: &str, predicate: impl Fn(&str) -> bool) -> bool {
    predicate(value)
}

/// Python `int(value)` for the bounded integer coercions in local auth.
fn int_coerce(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        Value::Bool(value) => Some(i64::from(*value)),
        _ => None,
    }
}
