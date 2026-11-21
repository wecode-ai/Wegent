// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! Plugin component inventory discovery (`PluginPackageParser._parse_*`):
//! skills, markdown path components, JSON path components, binaries, and MCP
//! servers.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::http_compat::FastApiError;

use super::{Archive, py_truthy, read_optional_json};

fn python_stem(name: &str) -> String {
    let basename = name.rsplit('/').next().unwrap_or(name);
    match basename.rfind('.') {
        Some(index) if index > 0 => basename[..index].to_owned(),
        _ => basename.to_owned(),
    }
}

fn python_name(name: &str) -> String {
    name.rsplit('/').next().unwrap_or(name).to_owned()
}

/// `_relative_path`
fn relative_path(root: &str, path: &str) -> String {
    if root.is_empty() {
        return path.to_owned();
    }
    let prefix = root.trim_end_matches('/');
    path.strip_prefix(prefix)
        .map(|rest| rest.trim_start_matches('/'))
        .unwrap_or(path)
        .to_owned()
}

pub(super) fn parse_skills(archive: &Archive, root: &str, names: &[&String]) -> Vec<Value> {
    let prefix = format!("{root}skills/");
    let mut skills = Vec::new();
    let mut sorted: Vec<&String> = names.to_vec();
    sorted.sort();
    for name in sorted {
        if !name.starts_with(&prefix) || !name.ends_with("/SKILL.md") {
            continue;
        }
        let metadata = read_skill_frontmatter(archive, name);
        let parent = &name[..name.rfind('/').unwrap_or(0)];
        let skill_name = metadata
            .get("name")
            .filter(|value| !value.is_empty())
            .cloned()
            .unwrap_or_else(|| python_name(parent));
        skills.push(json!({
            "name": skill_name,
            "description": metadata.get("description").cloned().unwrap_or_default(),
            "path": relative_path(root, parent),
        }));
    }
    skills
}

/// `_read_skill_frontmatter`
fn read_skill_frontmatter(archive: &Archive, path: &str) -> BTreeMap<String, String> {
    let Some(bytes) = archive.read(path) else {
        return BTreeMap::new();
    };
    let Ok(text) = std::str::from_utf8(bytes) else {
        return BTreeMap::new();
    };
    let lines = text.lines().collect::<Vec<_>>();
    if lines.first().map(|line| line.trim()) != Some("---") {
        return BTreeMap::new();
    }
    let mut metadata = BTreeMap::new();
    for line in &lines[1..] {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key == "name" || key == "description" {
            metadata.insert(
                key.to_owned(),
                value
                    .trim()
                    .trim_matches(|c| c == '"' || c == '\'')
                    .to_owned(),
            );
        }
    }
    metadata
}

pub(super) fn parse_markdown_files(root: &str, names: &[&String], folder: &str) -> Vec<Value> {
    let prefix = format!("{root}{folder}/");
    let mut matched = names
        .iter()
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".md"))
        .collect::<Vec<_>>();
    matched.sort();
    matched
        .into_iter()
        .map(|name| {
            json!({
                "name": python_stem(name),
                "path": &name[root.len()..],
            })
        })
        .collect()
}

pub(super) fn parse_json_file_components(
    root: &str,
    names: &[&String],
    marker: &str,
) -> Vec<Value> {
    if let Some(marker) = marker.strip_prefix('.') {
        let marker = format!(".{marker}");
        let path = format!("{root}{marker}");
        return if names.contains(&&path) {
            vec![json!({"name": marker, "path": marker})]
        } else {
            Vec::new()
        };
    }
    let prefix = format!("{root}{marker}/");
    let mut matched = names
        .iter()
        .filter(|name| name.starts_with(&prefix) && name.ends_with(".json"))
        .collect::<Vec<_>>();
    matched.sort();
    matched
        .into_iter()
        .map(|name| {
            json!({
                "name": python_stem(name),
                "path": &name[root.len()..],
            })
        })
        .collect()
}

pub(super) fn parse_bin_files(root: &str, names: &[&String]) -> Vec<Value> {
    let prefix = format!("{root}bin/");
    let mut matched = names
        .iter()
        .filter(|name| name.starts_with(&prefix))
        .collect::<Vec<_>>();
    matched.sort();
    matched
        .into_iter()
        .map(|name| {
            json!({
                "name": python_name(name),
                "path": &name[root.len()..],
            })
        })
        .collect()
}

pub(super) fn parse_mcps(
    archive: &Archive,
    root: &str,
    manifest: &Value,
) -> Result<Vec<Value>, FastApiError> {
    let raw = &manifest["mcpServers"];
    let data = if raw.is_object() {
        Some(raw.clone())
    } else if let Some(path) = raw.as_str().filter(|value| !value.trim().is_empty()) {
        read_optional_json(archive, &join_root_path(root, path.trim()))?
    } else {
        read_optional_json(archive, &format!("{root}.mcp.json"))?
    };
    let Some(data) = data.filter(py_truthy) else {
        return Ok(Vec::new());
    };
    let Some(servers) = mcp_server_map(&data) else {
        return Ok(Vec::new());
    };
    let Some(servers) = servers.as_object() else {
        return Ok(Vec::new());
    };
    let mut items = servers.iter().collect::<Vec<_>>();
    items.sort_by_key(|(name, _)| *name);
    Ok(items
        .into_iter()
        .map(|(name, server)| {
            json!({
                "name": name,
                "server": if server.is_object() { server.clone() } else { json!({}) },
            })
        })
        .collect())
}

fn mcp_server_map(data: &Value) -> Option<Value> {
    if let Some(servers) = data.get("mcp_servers") {
        return servers.is_object().then(|| servers.clone());
    }
    if let Some(servers) = data.get("mcpServers") {
        return servers.is_object().then(|| servers.clone());
    }
    Some(data.clone())
}

fn join_root_path(root: &str, path: &str) -> String {
    let normalized = path.strip_prefix("./").unwrap_or(path);
    format!("{root}{normalized}")
}
