// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Plugin package parsing and normalization
//! (`app.services.plugin_package_parser`).
//!
//! The release endpoint parses the uploaded ZIP before publication so the
//! artifact identity must equal the release metadata, and the marketplace
//! publish step parses it again for the manifest, interface, and component
//! inventory. Parse failures are the source's `400` details; unsafe archives
//! are rejected later by the package scanner with `422` details.

use std::collections::BTreeMap;
use std::io::{Cursor, Read};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use zip::ZipArchive;

use crate::http_compat::FastApiError;
use brz_http_server::StatusCode;

mod components;
mod connectors;
#[cfg(test)]
mod tests;
mod workbench;

use components::{
    parse_bin_files, parse_json_file_components, parse_markdown_files, parse_mcps, parse_skills,
};
use connectors::parse_connectors;
use workbench::parse_workbench_component;

/// `MAX_PLUGIN_PACKAGE_SIZE_BYTES`
const MAX_PLUGIN_PACKAGE_SIZE_BYTES: usize = 50 * 1024 * 1024;
/// `MAX_INLINE_INTERFACE_ASSET_BYTES`
const MAX_INLINE_INTERFACE_ASSET_BYTES: u64 = 512 * 1024;
/// `CODEX_PLUGIN_MANIFEST_PATH`
const CODEX_MANIFEST: &str = ".codex-plugin/plugin.json";
/// `CLAUDE_PLUGIN_MANIFEST_PATH`
const CLAUDE_MANIFEST: &str = ".claude-plugin/plugin.json";
/// `WEWORK_PLUGIN_MANIFEST_PATH`
const WORKBENCH_MANIFEST: &str = ".wework-plugin/plugin.json";

/// One parsed plugin package.
#[derive(Debug, Clone)]
pub struct UploadInfo {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: Option<String>,
    pub manifest: Value,
    pub components: Value,
    pub interface: Option<Value>,
}

/// The decoded ZIP entries needed by the parser. `by_name` resolves the last
/// duplicate like Python's `ZipFile.NameToInfo`.
struct Archive {
    names: Vec<String>,
    by_name: BTreeMap<String, usize>,
    contents: Vec<Vec<u8>>,
}

impl Archive {
    fn open(package: &[u8]) -> Result<Self, FastApiError> {
        let mut archive =
            ZipArchive::new(Cursor::new(package)).map_err(|_| bad_request("Invalid plugin ZIP"))?;
        let mut names = Vec::with_capacity(archive.len());
        let mut by_name = BTreeMap::new();
        let mut contents = Vec::with_capacity(archive.len());
        for index in 0..archive.len() {
            let name = archive
                .by_index(index)
                .map_err(|_| bad_request("Invalid plugin ZIP"))?
                .name()
                .to_owned();
            let mut member = archive
                .by_index(index)
                .map_err(|_| bad_request("Invalid plugin ZIP"))?;
            let mut content = Vec::new();
            member
                .read_to_end(&mut content)
                .map_err(|_| bad_request("Invalid plugin ZIP"))?;
            by_name.insert(name.clone(), index);
            names.push(name);
            contents.push(content);
        }
        Ok(Self {
            names,
            by_name,
            contents,
        })
    }

    fn contains(&self, name: &str) -> bool {
        self.by_name.contains_key(name)
    }

    fn read(&self, name: &str) -> Option<&[u8]> {
        self.by_name
            .get(name)
            .map(|index| self.contents[*index].as_slice())
    }
}

fn bad_request(detail: impl Into<String>) -> FastApiError {
    FastApiError::detail(StatusCode::BAD_REQUEST, detail.into())
}

/// `plugin_package_parser.parse_package`.
pub fn parse(package: &[u8]) -> Result<UploadInfo, FastApiError> {
    if package.len() > MAX_PLUGIN_PACKAGE_SIZE_BYTES {
        return Err(FastApiError::detail(
            StatusCode::PAYLOAD_TOO_LARGE,
            "Plugin package is too large",
        ));
    }
    let archive = Archive::open(package)?;
    validate_archive_paths(&archive)?;
    let (root, manifest_relative_path) = detect_plugin_root(&archive)?;
    let manifest = read_json(&archive, &format!("{root}{manifest_relative_path}"))?;
    let workbench_manifest = read_optional_json(&archive, &format!("{root}{WORKBENCH_MANIFEST}"))?;
    let components = parse_components(&archive, &root, &manifest, workbench_manifest.as_ref())?;
    ensure_account_auth_adapters(&archive, &root, &components)?;
    let interface = parse_interface(manifest.get("interface"))?
        .map(|interface| inline_interface_assets(&archive, &root, interface));
    let name = manifest
        .get("name")
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(bad_request("Plugin manifest must include a non-empty name"));
    }
    Ok(UploadInfo {
        display_name: display_name(&manifest, &name),
        description: description(&manifest),
        version: manifest
            .get("version")
            .filter(|value| py_truthy(value))
            .map(py_string),
        manifest,
        components,
        interface,
        name,
    })
}

/// `_validate_archive_paths`
fn validate_archive_paths(archive: &Archive) -> Result<(), FastApiError> {
    for name in &archive.names {
        if name.starts_with('/') || name.split('/').any(|part| part == "..") {
            return Err(bad_request(format!("Unsafe path in plugin ZIP: {name}")));
        }
    }
    Ok(())
}

/// `_detect_plugin_root`
fn detect_plugin_root(archive: &Archive) -> Result<(String, String), FastApiError> {
    let mut candidates: Vec<(usize, usize, usize, String, String)> = Vec::new();
    for name in &archive.names {
        for (preference, manifest_path) in [CODEX_MANIFEST, CLAUDE_MANIFEST].iter().enumerate() {
            if !name.ends_with(manifest_path) {
                continue;
            }
            let root = &name[..name.len() - manifest_path.len()];
            let depth = root.split('/').filter(|part| !part.is_empty()).count();
            candidates.push((
                depth,
                preference,
                name.len(),
                root.to_owned(),
                (*manifest_path).to_owned(),
            ));
        }
    }
    if candidates.is_empty() {
        return Err(bad_request(
            "Plugin must include .codex-plugin/plugin.json or .claude-plugin/plugin.json",
        ));
    }
    candidates.sort();
    let (_, _, _, root, manifest_path) = candidates.remove(0);
    Ok((root, manifest_path))
}

/// `_read_json`
fn read_json(archive: &Archive, path: &str) -> Result<Value, FastApiError> {
    let Some(bytes) = archive.read(path) else {
        return Err(bad_request(format!("Missing {path}")));
    };
    let text =
        std::str::from_utf8(bytes).map_err(|_| bad_request(format!("Invalid JSON in {path}")))?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| bad_request(format!("Invalid JSON in {path}")))?;
    if !value.is_object() {
        return Err(bad_request(format!("{path} must be a JSON object")));
    }
    Ok(value)
}

/// `_read_optional_json`: a missing file is `None`, every other failure raises.
fn read_optional_json(archive: &Archive, path: &str) -> Result<Option<Value>, FastApiError> {
    match read_json(archive, path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.detail_message() == Some(&format!("Missing {path}")) => Ok(None),
        Err(error) => Err(error),
    }
}

fn non_directories(archive: &Archive) -> impl Iterator<Item = &String> {
    archive.names.iter().filter(|name| !name.ends_with('/'))
}

/// `_parse_components`
fn parse_components(
    archive: &Archive,
    root: &str,
    manifest: &Value,
    workbench: Option<&Value>,
) -> Result<Value, FastApiError> {
    let names = non_directories(archive).collect::<Vec<_>>();
    let mut components = Map::new();
    components.insert("skills".into(), json!(parse_skills(archive, root, &names)));
    components.insert(
        "commands".into(),
        json!(parse_markdown_files(root, &names, "commands")),
    );
    components.insert(
        "agents".into(),
        json!(parse_markdown_files(root, &names, "agents")),
    );
    components.insert(
        "hooks".into(),
        json!(parse_json_file_components(root, &names, "hooks")),
    );
    components.insert("mcps".into(), json!(parse_mcps(archive, root, manifest)?));
    components.insert("connectors".into(), parse_connectors(manifest)?);
    components.insert(
        "lsps".into(),
        json!(parse_json_file_components(root, &names, ".lsp.json")),
    );
    components.insert(
        "monitors".into(),
        json!(parse_json_file_components(root, &names, "monitors")),
    );
    components.insert("bins".into(), json!(parse_bin_files(root, &names)));
    if let Some(settings) = read_optional_json(archive, &format!("{root}settings.json"))? {
        components.insert("settings".into(), settings);
    }
    if let Some(workbench) = workbench {
        components.insert(
            "workbench".into(),
            parse_workbench_component(archive, root, workbench)?,
        );
    }
    Ok(Value::Object(components))
}

/// `for connector in components.connectors: accountAuth adapter must exist`
fn ensure_account_auth_adapters(
    archive: &Archive,
    root: &str,
    components: &Value,
) -> Result<(), FastApiError> {
    let Some(connectors) = components.get("connectors").and_then(Value::as_array) else {
        return Ok(());
    };
    for connector in connectors {
        let Some(adapter) = connector
            .get("accountAuth")
            .and_then(|auth| auth.get("adapter"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let normalized = normalize_relative(adapter);
        if !archive.contains(&format!("{root}{normalized}")) {
            return Err(bad_request(
                "Account auth adapter is missing from plugin package",
            ));
        }
    }
    Ok(())
}

fn normalize_relative(value: &str) -> String {
    value
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect::<Vec<_>>()
        .join("/")
}

/// `_parse_interface`
fn parse_interface(raw: Option<&Value>) -> Result<Option<Value>, FastApiError> {
    let Some(raw) = raw.and_then(Value::as_object) else {
        return Ok(None);
    };
    let optional = |key: &str| optional_string(raw.get(key));
    let list = |key: &str| -> Vec<String> {
        raw.get(key)
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| py_string(item).trim().to_owned())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut interface = Map::new();
    for key in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
    ] {
        if let Some(value) = optional(key) {
            interface.insert(key.into(), json!(value));
        }
    }
    interface.insert("capabilities".into(), json!(list("capabilities")));
    for (key, alias) in [
        ("websiteUrl", "websiteURL"),
        ("privacyPolicyUrl", "privacyPolicyURL"),
        ("termsOfServiceUrl", "termsOfServiceURL"),
    ] {
        let value = optional(key).or_else(|| optional(alias));
        if let Some(value) = value {
            interface.insert(key.into(), json!(value));
        }
    }
    if let Some(prompt) = default_prompts(raw.get("defaultPrompt")) {
        interface.insert("defaultPrompt".into(), json!(prompt));
    }
    for key in ["brandColor", "composerIcon", "logo", "logoDark"] {
        if let Some(value) = optional(key) {
            interface.insert(key.into(), json!(value));
        }
    }
    interface.insert("screenshots".into(), json!(list("screenshots")));
    Ok(Some(Value::Object(interface)))
}

/// `_inline_interface_assets`
fn inline_interface_assets(archive: &Archive, root: &str, mut interface: Value) -> Value {
    for key in ["composerIcon", "logo", "logoDark"] {
        let Some(value) = interface.get(key).and_then(Value::as_str) else {
            continue;
        };
        if let Some(resolved) = interface_asset_data_url(archive, root, value) {
            interface[key] = json!(resolved);
        }
    }
    interface
}

/// `_interface_asset_data_url`: `None` keeps the declared value.
fn interface_asset_data_url(archive: &Archive, root: &str, value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("data:")
        || lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("file://")
        || value.starts_with('/')
    {
        return None;
    }
    let relative = normalize_relative(value.strip_prefix("./").unwrap_or(value));
    if relative.is_empty() || relative.split('/').any(|part| part == "..") {
        return None;
    }
    let suffix = relative
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let media_type = match suffix.as_str() {
        "gif" => "image/gif",
        "jpeg" => "image/jpeg",
        "jpg" => "image/jpeg",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => return None,
    };
    let member_name = format!("{root}{relative}");
    let member = archive.read(&member_name)?;
    if member.len() as u64 > MAX_INLINE_INTERFACE_ASSET_BYTES {
        return None;
    }
    Some(format!(
        "data:{media_type};base64,{}",
        STANDARD.encode(member)
    ))
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .map(py_string)
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// `_default_prompts`
fn default_prompts(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        Some(Value::String(prompt)) => {
            let prompt = prompt.trim().to_owned();
            (!prompt.is_empty()).then(|| vec![prompt])
        }
        Some(Value::Array(items)) => {
            let prompts = items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim().to_owned())
                .filter(|item| !item.is_empty())
                .take(3)
                .collect::<Vec<_>>();
            (!prompts.is_empty()).then_some(prompts)
        }
        _ => None,
    }
}

/// `_display_name`
fn display_name(manifest: &Value, fallback: &str) -> String {
    let direct = manifest
        .get("displayName")
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !direct.is_empty() {
        return direct;
    }
    if let Some(interface) = manifest.get("interface").and_then(Value::as_object) {
        let name = interface
            .get("displayName")
            .map(py_string)
            .unwrap_or_default()
            .trim()
            .to_owned();
        if !name.is_empty() {
            return name;
        }
    }
    fallback.to_owned()
}

/// `_description`
fn description(manifest: &Value) -> String {
    let direct = manifest
        .get("description")
        .map(py_string)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if !direct.is_empty() {
        return direct;
    }
    if let Some(interface) = manifest.get("interface").and_then(Value::as_object)
        && let Some(value) = interface
            .get("shortDescription")
            .filter(|value| py_truthy(value))
            .or_else(|| {
                interface
                    .get("longDescription")
                    .filter(|value| py_truthy(value))
            })
    {
        return py_string(value);
    }
    String::new()
}

/// Python's `str(value)` for manifest scalars.
fn py_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Null => "None".to_owned(),
        Value::Bool(true) => "True".to_owned(),
        Value::Bool(false) => "False".to_owned(),
        other => other.to_string(),
    }
}

/// Python truthiness for JSON values.
fn py_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(object) => !object.is_empty(),
    }
}
