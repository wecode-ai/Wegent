// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Manifest metadata is validated before a mirrored release enters review.

mod auth;
use super::package::{File, normalize, read_json, text};
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path};

pub fn components(files: &BTreeMap<String, File>, root: &str, manifest: &Value) -> Result<Value> {
    let mut value = json!({"skills":[],"commands":[],"agents":[],"hooks":[],"mcps":[],"connectors":[],"lsps":[],"monitors":[],"bins":[]});
    for (name, file) in files {
        if file.directory {
            continue;
        }
        let Some(relative) = name.strip_prefix(root) else {
            continue;
        };
        let path = Path::new(relative);
        for (folder, suffix, key) in [
            ("commands/", ".md", "commands"),
            ("agents/", ".md", "agents"),
            ("hooks/", ".json", "hooks"),
            ("monitors/", ".json", "monitors"),
        ] {
            if relative.starts_with(folder) && relative.ends_with(suffix) {
                value[key].as_array_mut().unwrap().push(json!({"name":path.file_stem().and_then(|v|v.to_str()).unwrap_or(""),"path":relative}));
            }
        }
        if relative == ".lsp.json" {
            value["lsps"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":relative,"path":relative}));
        }
        if relative.starts_with("bin/") {
            value["bins"].as_array_mut().unwrap().push(json!({"name":path.file_name().and_then(|v|v.to_str()).unwrap_or(""),"path":relative}));
        }
        if relative.starts_with("skills/") && relative.ends_with("/SKILL.md") {
            let parent = path.parent().unwrap();
            let mut metadata = BTreeMap::new();
            if let Ok(source) = std::str::from_utf8(&file.bytes) {
                let mut lines = source.lines();
                if lines.next().is_some_and(|line| line.trim() == "---") {
                    for line in lines.take_while(|line| line.trim() != "---") {
                        if let Some((key, value)) = line.split_once(':')
                            && ["name", "description"].contains(&key.trim())
                        {
                            metadata.insert(
                                key.trim().to_owned(),
                                value.trim().trim_matches(['\'', '"']).to_owned(),
                            );
                        }
                    }
                }
            }
            value["skills"].as_array_mut().unwrap().push(json!({"name":metadata.get("name").filter(|v|!v.is_empty()).cloned().unwrap_or_else(||parent.file_name().and_then(|v|v.to_str()).unwrap_or("").into()),"description":metadata.get("description").cloned().unwrap_or_default(),"path":parent.to_str().unwrap_or("")}));
        }
    }
    let servers = if manifest["mcpServers"].is_object() {
        Some(manifest["mcpServers"].clone())
    } else {
        let path = manifest["mcpServers"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(".mcp.json")
            .trim()
            .trim_start_matches("./");
        read_json(files, &format!("{root}{path}"))?
    };
    if let Some(data) = servers {
        let map = if data.get("mcp_servers").is_some() {
            &data["mcp_servers"]
        } else if data.get("mcpServers").is_some() {
            &data["mcpServers"]
        } else {
            &data
        };
        if let Some(map) = map.as_object() {
            let mut items = map.iter().collect::<Vec<_>>();
            items.sort_by_key(|(key, _)| *key);
            value["mcps"]=json!(items.into_iter().map(|(name,server)|json!({"name":name,"server":if server.is_object(){server.clone()}else{json!({})}})).collect::<Vec<_>>());
        }
    }
    value["connectors"] = auth::connectors(files, root, manifest)?;
    if let Some(settings) = read_json(files, &format!("{root}settings.json"))? {
        value["settings"] = settings;
    }
    if let Some(manifest) = read_json(files, &format!("{root}.wework-plugin/plugin.json"))? {
        value["workbench"] = workbench(files, root, &manifest)?;
    }
    Ok(value)
}

pub fn interface(files: &BTreeMap<String, File>, root: &str, raw: &Value) -> Result<Value> {
    if !raw.is_object() {
        return Ok(json!({}));
    }
    let mut interface = json!({"capabilities":[],"screenshots":[]});
    for key in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
        "websiteUrl",
        "privacyPolicyUrl",
        "termsOfServiceUrl",
        "brandColor",
        "composerIcon",
        "logo",
        "logoDark",
    ] {
        if let Some(text) = text(&raw[key]) {
            interface[key] = text.into();
        }
    }
    for (key, alias) in [
        ("websiteUrl", "websiteURL"),
        ("privacyPolicyUrl", "privacyPolicyURL"),
        ("termsOfServiceUrl", "termsOfServiceURL"),
    ] {
        if interface.get(key).is_none()
            && let Some(text) = text(&raw[alias])
        {
            interface[key] = text.into();
        }
    }
    for key in ["capabilities", "screenshots"] {
        if let Some(items) = raw[key].as_array() {
            interface[key] = json!(items.iter().filter_map(text).collect::<Vec<_>>());
        }
    }
    let prompts = if let Some(prompt) = raw["defaultPrompt"].as_str() {
        vec![prompt.trim().to_owned()]
    } else {
        raw["defaultPrompt"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .take(3)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    if !prompts.is_empty() && prompts.iter().any(|p| !p.is_empty()) {
        interface["defaultPrompt"] = json!(prompts);
    }
    for key in ["composerIcon", "logo", "logoDark"] {
        let Some(path) = interface[key].as_str() else {
            continue;
        };
        let path = path.trim_start_matches("./");
        if path.contains(':') || path.starts_with('/') || path.split('/').any(|p| p == "..") {
            continue;
        }
        let media = match Path::new(path)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "gif" => "image/gif",
            "jpeg" | "jpg" => "image/jpeg",
            "png" => "image/png",
            "svg" => "image/svg+xml",
            "webp" => "image/webp",
            _ => continue,
        };
        if let Some(file) = files.get(&format!("{root}{path}"))
            && file.bytes.len() <= 512 * 1024
        {
            interface[key] = format!("data:{media};base64,{}", STANDARD.encode(&file.bytes)).into();
        }
    }
    Ok(interface)
}

fn workbench(files: &BTreeMap<String, File>, root: &str, raw: &Value) -> Result<Value> {
    if text(&raw["apiVersion"]).as_deref().unwrap_or("1") != "1" {
        bail!("Unsupported workbench API version")
    }
    let required = raw["required"].as_bool().unwrap_or(false);
    let pinned = raw["pinnedToClientVersion"].as_bool().unwrap_or(false);
    let version = text(&raw["clientVersion"]);
    if required && !pinned || pinned && version.is_none() {
        bail!("Required workbench plugins must pin a client version")
    }
    let mut value = json!({"apiVersion":"1","required":required,"pinnedToClientVersion":pinned});
    if let Some(version) = version {
        value["clientVersion"] = version.into();
    }
    for (kind, field) in [("frontend", "entry"), ("desktop", "command")] {
        let declaration = &raw[kind];
        if declaration.is_null() {
            continue;
        }
        if !declaration.is_object() {
            bail!("Workbench declaration must be an object")
        }
        let path = text(&declaration[field])
            .ok_or_else(|| anyhow::anyhow!("Workbench package path is missing"))?;
        let path = normalize(&path)?;
        if path.is_empty()
            || !files
                .get(&format!("{root}{path}"))
                .is_some_and(|file| !file.directory)
        {
            bail!("Workbench entry is missing")
        }
        let digest = text(&declaration["sha256"])
            .unwrap_or_default()
            .to_lowercase();
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            bail!("Workbench SHA-256 is invalid")
        }
        let mut parsed = json!({field:path,"sha256":digest});
        if kind == "frontend" {
            parsed["export"] = text(&declaration["export"])
                .unwrap_or_else(|| "default".into())
                .into();
        } else {
            for key in ["args", "capabilities"] {
                let items = match declaration.get(key) {
                    None | Some(Value::Null) => vec![],
                    Some(Value::Array(items)) if items.iter().all(Value::is_string) => {
                        items.clone()
                    }
                    _ => bail!("Workbench arguments must be string arrays"),
                };
                parsed[key] = json!(if key == "capabilities" {
                    items
                        .into_iter()
                        .filter_map(|v| text(&v))
                        .map(Value::String)
                        .collect::<Vec<_>>()
                } else {
                    items
                });
            }
        }
        value[kind] = parsed;
    }
    if value.get("frontend").is_none() && value.get("desktop").is_none() {
        bail!("Workbench plugin must declare frontend or desktop")
    }
    Ok(value)
}
