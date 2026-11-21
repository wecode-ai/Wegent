// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Connector declarations preserve the versioned account credential contract.

use super::super::package::{File, text};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn connectors(files: &BTreeMap<String, File>, root: &str, manifest: &Value) -> Result<Value> {
    let Some(items) = manifest["connectors"].as_array() else {
        return Ok(json!([]));
    };
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for item in items {
        if !item.is_object() {
            continue;
        }
        let slug = text(&item["slug"]).unwrap_or_default();
        if !matches(&slug, r"^[a-z0-9][a-z0-9_-]{0,99}$") || seen.contains(&slug) {
            continue;
        }
        let policy = text(&item["authPolicy"]).unwrap_or_else(|| "optional".into());
        if !["on_install", "on_use", "optional"].contains(&policy.as_str()) {
            continue;
        }
        let mut parsed = json!({"slug":slug,"authPolicy":policy});
        for key in ["displayName", "description", "authorizationGroup"] {
            if !item[key].is_null() {
                if !item[key].is_string() {
                    bail!("Invalid plugin connector declaration")
                }
                parsed[key] = item[key].clone();
            }
        }
        if let Some(local) = local_auth(&item["localAuth"]) {
            parsed["localAuth"] = local;
        }
        if item.get("accountAuth").is_some() {
            parsed["accountAuth"] = account_auth(&item["accountAuth"])?;
            let adapter = parsed["accountAuth"]["adapter"].as_str().unwrap();
            let adapter = adapter.trim_start_matches("./");
            if !files.contains_key(&format!("{root}{adapter}")) {
                bail!("Account auth adapter is missing from plugin package")
            }
        }
        seen.insert(slug);
        result.push(parsed);
    }
    Ok(json!(result))
}
fn matches(value: &str, expression: &str) -> bool {
    regex::Regex::new(expression)
        .expect("constant pattern")
        .is_match(value)
}
fn relative(value: &str) -> bool {
    !value.starts_with(['/', '~'])
        && !value.contains('\\')
        && !value.split('/').any(|p| p == "..")
        && !matches(value, r"^[A-Za-z]:")
}

fn account_auth(raw: &Value) -> Result<Value> {
    let map = raw
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Invalid plugin accountAuth declaration"))?;
    if map.keys().any(|key| {
        ![
            "protocolVersion",
            "credentialType",
            "adapter",
            "oauth2",
            "exportMode",
            "localEnvironment",
        ]
        .contains(&key.as_str())
    }) || raw
        .get("protocolVersion")
        .is_some_and(|v| v.as_i64() != Some(1))
    {
        bail!("Invalid account auth protocol version")
    }
    let credential = raw["credentialType"]
        .as_str()
        .filter(|v| ["password", "bearer", "oauth2"].contains(v))
        .ok_or_else(|| anyhow::anyhow!("Invalid account credential type"))?;
    let adapter = raw["adapter"]
        .as_str()
        .filter(|v| {
            !v.is_empty()
                && v.len() <= 256
                && relative(v)
                && !v.contains(':')
                && matches(v, r"^[A-Za-z0-9_./-]+$")
                && [".py", ".mjs", ".sh", ".ps1"]
                    .iter()
                    .any(|suffix| v.ends_with(suffix))
        })
        .ok_or_else(|| anyhow::anyhow!("Account auth adapter must be a relative script path"))?;
    let mut parsed = json!({"protocolVersion":1,"credentialType":credential,"adapter":adapter});
    if !raw["oauth2"].is_null() {
        let operations = raw["oauth2"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("Invalid OAuth operations"))?;
        let mut unique = BTreeSet::new();
        if credential != "oauth2"
            || operations.is_empty()
            || operations.iter().any(|v| {
                v.as_str().is_none_or(|v| {
                    !["authorize", "refresh", "revoke"].contains(&v) || !unique.insert(v)
                })
            })
        {
            bail!("Invalid OAuth operations")
        }
        parsed["oauth2"] = raw["oauth2"].clone();
    }
    if !raw["exportMode"].is_null() {
        if raw["exportMode"] != "exclusive" || credential != "oauth2" {
            bail!("Exclusive export requires OAuth credentials")
        }
        parsed["exportMode"] = "exclusive".into();
    }
    if !raw["localEnvironment"].is_null() {
        let environment = raw["localEnvironment"]
            .as_object()
            .filter(|v| !v.is_empty() && v.len() <= 16)
            .ok_or_else(|| anyhow::anyhow!("Invalid local environment declaration"))?;
        for (name, value) in environment {
            if !matches(name, r"^[A-Z][A-Z0-9_]{0,63}$") {
                bail!("Invalid local environment name")
            }
            let map = value
                .as_object()
                .ok_or_else(|| anyhow::anyhow!("Invalid local environment declaration"))?;
            match value["type"].as_str() {
                Some("directory") if map.len() == 1 => {}
                Some("enum") if map.len() == 2 => {
                    let values = value["values"]
                        .as_array()
                        .filter(|v| !v.is_empty() && v.len() <= 16)
                        .ok_or_else(|| anyhow::anyhow!("Invalid local enum declaration"))?;
                    let mut unique = BTreeSet::new();
                    if values.iter().any(|v| {
                        v.as_str().is_none_or(|v| {
                            !matches(v, r"^[A-Za-z0-9_.-]{1,64}$") || !unique.insert(v)
                        })
                    }) {
                        bail!("Invalid local enum declaration")
                    }
                }
                _ => bail!("Invalid local environment declaration"),
            }
        }
        parsed["localEnvironment"] = raw["localEnvironment"].clone();
    }
    Ok(parsed)
}
fn commands(raw: &Value) -> Vec<String> {
    raw.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(text)
                .filter(|v| relative(v))
                .collect()
        })
        .unwrap_or_default()
}
fn local_auth(raw: &Value) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    let kind = text(&raw["kind"]).unwrap_or_else(|| "local_qr".into());
    if !["local_qr", "browser_oauth"].contains(&kind.as_str()) {
        return None;
    }
    let health = commands(&raw["health"]);
    let start = commands(&raw["start"]);
    let poll = commands(&raw["poll"]);
    if health.is_empty() || start.is_empty() || kind == "local_qr" && poll.is_empty() {
        return None;
    }
    let tool = if raw["tool"].is_null() {
        None
    } else {
        Some(tool(&raw["tool"])?)
    };
    let default_timeout = if kind == "browser_oauth" { 300 } else { 45 };
    let ok = raw["okValues"]
        .as_array()
        .map(|v| v.iter().filter_map(text).collect::<Vec<_>>())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec!["ok".into()]);
    let mut value = json!({"kind":kind,"health":health,"start":start,"poll":poll,"logout":commands(&raw["logout"]),"qrField":text(&raw["qrField"]).unwrap_or_else(||"qr_path".into()),"statusField":text(&raw["statusField"]).unwrap_or_else(||"status".into()),"okValues":ok,"pollIntervalSeconds":integer(&raw["pollIntervalSeconds"]).unwrap_or(2).clamp(1,30),"timeoutSeconds":integer(&raw["timeoutSeconds"]).unwrap_or(default_timeout).clamp(15,600),"logoutOnUninstall":raw["logoutOnUninstall"].as_bool().unwrap_or(kind=="local_qr")});
    if let Some(tool) = tool {
        value["tool"] = tool;
    }
    Some(value)
}
fn integer(raw: &Value) -> Option<i64> {
    raw.as_i64()
        .or_else(|| raw.as_str().and_then(|v| v.parse().ok()))
}
fn tool(raw: &Value) -> Option<Value> {
    let id = text(&raw["id"])?;
    let source = text(&raw["source"])?;
    if !matches(&id, r"^[a-z0-9][a-z0-9_-]{0,63}$") {
        return None;
    }
    if source == "bundled" {
        return Some(json!({"id":id,"source":source}));
    }
    if source != "managed" {
        return None;
    }
    let version = text(&raw["version"])?;
    if !matches(&version, r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$") {
        return None;
    }
    let artifacts = raw["artifacts"].as_object().filter(|v| !v.is_empty())?;
    let mut parsed = serde_json::Map::new();
    for (target, raw) in artifacts {
        if !matches(target, r"^(darwin|linux|windows)-(x64|arm64)$") {
            return None;
        }
        let url = text(&raw["url"])?;
        let sha = text(&raw["sha256"])?.to_lowercase();
        let archive = text(&raw["archive"])?;
        let path = text(&raw["binaryPath"])?;
        if !url.starts_with("https://")
            || !matches(&sha, r"^[a-f0-9]{64}$")
            || !["tar_gz", "zip"].contains(&archive.as_str())
            || !relative(&path)
        {
            return None;
        }
        parsed.insert(
            target.clone(),
            json!({"url":url,"sha256":sha,"archive":archive,"binaryPath":path}),
        );
    }
    Some(json!({"id":id,"source":source,"version":version,"artifacts":parsed}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_auth_rejects_credential_contract_and_adapter_escapes() {
        assert!(account_auth(&json!({"credentialType":"password","adapter":"scripts/auth.py","exportMode":"exclusive"})).is_err());
        assert!(
            account_auth(&json!({"credentialType":"oauth2","adapter":"../outside.py"})).is_err()
        );
        assert!(
            account_auth(
                &json!({"protocolVersion":true,"credentialType":"bearer","adapter":"auth.py"})
            )
            .is_err()
        );
        assert!(account_auth(&json!({"credentialType":"oauth2","adapter":"auth.py","oauth2":["refresh","refresh"]})).is_err());
    }
}
