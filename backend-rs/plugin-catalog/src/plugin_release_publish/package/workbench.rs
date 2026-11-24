// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Wework workbench contribution declarations
//! (`PluginPackageParser._parse_workbench_*`).

use serde_json::{Map, Value, json};

use crate::http_compat::FastApiError;

use super::connectors::is_hex64;
use super::{Archive, bad_request, normalize_relative, optional_string, py_string, py_truthy};

/// `_parse_workbench_component`
pub(super) fn parse_workbench_component(
    archive: &Archive,
    root: &str,
    manifest: &Value,
) -> Result<Value, FastApiError> {
    let api_version = manifest
        .get("apiVersion")
        .filter(|value| py_truthy(value))
        .map(py_string)
        .unwrap_or_else(|| "1".to_owned());
    if api_version != "1" {
        return Err(bad_request(
            ".wework-plugin/plugin.json apiVersion must be \"1\"",
        ));
    }
    let frontend = parse_workbench_frontend(archive, root, manifest.get("frontend"))?;
    let desktop = parse_workbench_desktop(archive, root, manifest.get("desktop"))?;
    if frontend.is_none() && desktop.is_none() {
        return Err(bad_request(
            ".wework-plugin/plugin.json must declare frontend or desktop",
        ));
    }
    let required = py_truthy(manifest.get("required").unwrap_or(&Value::Null));
    let pinned = py_truthy(
        manifest
            .get("pinnedToClientVersion")
            .unwrap_or(&Value::Null),
    );
    let client_version = optional_string(manifest.get("clientVersion"));
    if required && !pinned {
        return Err(bad_request(
            ".wework-plugin/plugin.json required plugins must set pinnedToClientVersion",
        ));
    }
    if pinned && client_version.is_none() {
        return Err(bad_request(
            ".wework-plugin/plugin.json pinned plugins must declare clientVersion",
        ));
    }
    let mut component = Map::new();
    component.insert("apiVersion".into(), json!("1"));
    component.insert("required".into(), json!(required));
    component.insert("pinnedToClientVersion".into(), json!(pinned));
    if let Some(client_version) = client_version {
        component.insert("clientVersion".into(), json!(client_version));
    }
    if let Some(frontend) = frontend {
        component.insert("frontend".into(), frontend);
    }
    if let Some(desktop) = desktop {
        component.insert("desktop".into(), desktop);
    }
    Ok(Value::Object(component))
}

fn parse_workbench_frontend(
    archive: &Archive,
    root: &str,
    value: Option<&Value>,
) -> Result<Option<Value>, FastApiError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let Some(object) = value.as_object() else {
        return Err(bad_request(
            ".wework-plugin/plugin.json frontend must be an object",
        ));
    };
    let entry = workbench_package_path(object.get("entry"), "frontend.entry")?;
    require_archive_file(archive, root, &entry, "frontend.entry")?;
    let export = object
        .get("export")
        .filter(|value| py_truthy(value))
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    Ok(Some(json!({
        "entry": entry,
        "export": if export.is_empty() { "default".to_owned() } else { export },
        "sha256": workbench_sha256(object.get("sha256"), "frontend.sha256")?,
    })))
}

fn parse_workbench_desktop(
    archive: &Archive,
    root: &str,
    value: Option<&Value>,
) -> Result<Option<Value>, FastApiError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let Some(object) = value.as_object() else {
        return Err(bad_request(
            ".wework-plugin/plugin.json desktop must be an object",
        ));
    };
    let command = workbench_package_path(object.get("command"), "desktop.command")?;
    require_archive_file(archive, root, &command, "desktop.command")?;
    let raw_args = object.get("args").filter(|value| py_truthy(value));
    let raw_capabilities = object.get("capabilities").filter(|value| py_truthy(value));
    let args = string_array(raw_args, "desktop.args")?;
    let capabilities = string_array(raw_capabilities, "desktop.capabilities")?
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    Ok(Some(json!({
        "command": command,
        "args": args,
        "sha256": workbench_sha256(object.get("sha256"), "desktop.sha256")?,
        "capabilities": capabilities,
    })))
}

fn string_array(value: Option<&Value>, field: &str) -> Result<Vec<String>, FastApiError> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        return Err(bad_request(format!(
            ".wework-plugin/plugin.json {field} must be a string array"
        )));
    };
    let mut values = Vec::with_capacity(items.len());
    for item in items {
        let Some(item) = item.as_str() else {
            return Err(bad_request(format!(
                ".wework-plugin/plugin.json {field} must be a string array"
            )));
        };
        values.push(item.trim().to_owned());
    }
    Ok(values)
}

fn workbench_package_path(value: Option<&Value>, field: &str) -> Result<String, FastApiError> {
    let path = value.map(py_string).unwrap_or_default().trim().to_owned();
    if path.is_empty()
        || path.starts_with('/')
        || path.split('/').any(|part| part == "..")
        || path.ends_with('/')
    {
        return Err(bad_request(format!(
            ".wework-plugin/plugin.json {field} must be a package-relative file"
        )));
    }
    Ok(normalize_relative(path.strip_prefix("./").unwrap_or(&path)))
}

fn workbench_sha256(value: Option<&Value>, field: &str) -> Result<String, FastApiError> {
    let digest = value
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if !is_hex64(&digest) {
        return Err(bad_request(format!(
            ".wework-plugin/plugin.json {field} must be a SHA-256 hex digest"
        )));
    }
    Ok(digest)
}

fn require_archive_file(
    archive: &Archive,
    root: &str,
    relative: &str,
    field: &str,
) -> Result<(), FastApiError> {
    if !archive.contains(&format!("{root}{relative}")) {
        return Err(bad_request(format!(
            ".wework-plugin/plugin.json {field} points to a missing file"
        )));
    }
    Ok(())
}
