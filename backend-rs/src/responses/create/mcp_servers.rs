// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

//! MCP server assembly for the execution request
//! (`app/services/execution/request_builder.py:_load_system_mcp_servers`,
//! `_build_mcp_servers`, and the `mcp_servers` half of `_build_bot_config`).
//!
//! Two shapes are produced from the same inputs: `metadata.bot[].mcp_servers`
//! keeps the Ghost CRD entries verbatim (`headers`, no `auth` promotion), while
//! the request-level `mcp_servers` merges the deployment `CHAT_MCP_SERVERS`
//! entries first and lets the bot's servers win by name.
use serde_json::{Map, Value};

use super::ghost::MergedGhostCapabilities;

/// `_build_bot_config`/`_build_mcp_servers` (bot-level half): the merged Ghost
/// `mcpServers` as `{"name": name, **config}`, keeping the CRD's `headers` (not
/// promoted to `auth`) and every other config key.
pub(super) fn ghost_mcp_servers(merged: &MergedGhostCapabilities) -> Vec<Value> {
    merged
        .mcp_servers
        .iter()
        .map(|(name, config)| {
            let mut entry = Map::new();
            entry.insert("name".into(), Value::String(name.clone()));
            if let Some(config) = config.as_object() {
                for (key, value) in config {
                    entry.insert(key.clone(), value.clone());
                }
            }
            Value::Object(entry)
        })
        .collect()
}

/// `_load_system_mcp_servers`: the deployment's `CHAT_MCP_SERVERS` JSON, in the
/// chat_shell list form (`{"name", "url", "type", "auth"?}`).
///
/// The setting accepts either `{"mcpServers": {...}}` or a direct mapping, and
/// each entry's type falls back through `transport` to `streamable-http`.
pub(super) fn load_system_mcp_servers() -> Vec<Value> {
    let configured = crate::config::env_or_dotenv("CHAT_MCP_SERVERS");
    system_mcp_servers_from(configured.as_deref()).unwrap_or_default()
}

/// Parse the `CHAT_MCP_SERVERS` JSON: `None` for absent/blank/`{}` input or an
/// unparsable document, which the source treats as no system servers.
fn system_mcp_servers_from(configured: Option<&str>) -> Option<Vec<Value>> {
    let configured = configured
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "{}")?;
    let parsed: Value = match serde_json::from_str(configured) {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::warn!(%error, "CHAT_MCP_SERVERS is not valid JSON");
            return None;
        }
    };
    let servers = parsed.get("mcpServers").unwrap_or(&parsed);
    let servers = servers.as_object()?;
    Some(
        servers
            .iter()
            .filter_map(|(name, config)| {
                let config = config.as_object()?;
                let mut entry = Map::new();
                entry.insert("name".into(), Value::String(name.clone()));
                entry.insert(
                    "url".into(),
                    config
                        .get("url")
                        .cloned()
                        .unwrap_or(Value::String(String::new())),
                );
                let server_type = match config.get("type") {
                    Some(value) => value.clone(),
                    None => config
                        .get("transport")
                        .cloned()
                        .unwrap_or_else(|| Value::String("streamable-http".into())),
                };
                entry.insert("type".into(), server_type);
                if let Some(headers) = config.get("headers") {
                    entry.insert("auth".into(), headers.clone());
                }
                Some(Value::Object(entry))
            })
            .collect(),
    )
}

/// `_build_mcp_servers`' name-keyed merge: system entries keep their positions,
/// a bot entry overrides the same name in place, and bot-only names append.
pub(super) fn merge_mcp_servers(system: Vec<Value>, bot: Vec<Value>) -> Vec<Value> {
    let mut order: Vec<String> = Vec::new();
    let mut by_name: std::collections::HashMap<String, Value> = std::collections::HashMap::new();
    for server in system.into_iter().chain(bot) {
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("server")
            .to_string();
        if !by_name.contains_key(&name) {
            order.push(name.clone());
        }
        by_name.insert(name, server);
    }
    order
        .into_iter()
        .filter_map(|name| by_name.remove(&name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ghost_mcp_servers_keep_the_crd_shape() {
        // Recorded `metadata.bot[0].mcp_servers`: `{"name", url, type,
        // "headers"}` — the CRD config is copied verbatim (no `auth` rewrite).
        let mut merged = MergedGhostCapabilities::default();
        merged.mcp_servers.insert(
            "sample-poi".to_string(),
            json!({
                "url": "https://mcp.example.invalid/search-poi",
                "type": "streamable-http",
                "headers": {"Authorization": "Bearer example-token"},
            }),
        );
        let servers = ghost_mcp_servers(&merged);
        assert_eq!(servers.len(), 1);
        assert_eq!(
            servers[0],
            json!({
                "name": "sample-poi",
                "url": "https://mcp.example.invalid/search-poi",
                "type": "streamable-http",
                "headers": {"Authorization": "Bearer example-token"},
            })
        );
    }

    #[test]
    fn system_mcp_servers_merge_before_bot_servers() {
        // `_build_mcp_servers`: system entries keep their order, bot entries win
        // by name in place, and bot-only names append (recorded tools list:
        // four system servers then `sample-poi`).
        let system = vec![
            json!({"name": "webpageFetchServer", "url": "https://ai.example/mcp", "type": "streamable-http"}),
            json!({"name": "documentFetchServer", "url": "https://mcp.example.invalid/document-fetch", "type": "streamable-http", "auth": {"Authorization": "Bearer example-token"}}),
        ];
        let bot = vec![
            json!({"name": "documentFetchServer", "url": "https://bot.example.invalid/mcp", "type": "streamable-http"}),
            json!({"name": "sample-poi", "url": "https://mcp.example.invalid/search-poi", "type": "streamable-http"}),
        ];
        let merged = merge_mcp_servers(system, bot);
        let names: Vec<&str> = merged
            .iter()
            .map(|server| server["name"].as_str().unwrap_or_default())
            .collect();
        assert_eq!(
            names,
            ["webpageFetchServer", "documentFetchServer", "sample-poi"]
        );
        // The bot entry overrides the system one in place.
        assert_eq!(merged[1]["url"], json!("https://bot.example.invalid/mcp"));
        assert!(merged[1].get("auth").is_none());
    }

    #[test]
    fn system_mcp_servers_parse_the_deployment_setting() {
        // `_load_system_mcp_servers` accepts `{"mcpServers": ...}` and a direct
        // mapping; `transport` is the fallback for a missing `type`.
        let parsed: Value = json!({
            "mcpServers": {
                "webpageFetchServer": {"url": "https://ai.example/mcp", "type": "streamable-http"},
                "documentFetchServer": {"url": "https://mcp.example.invalid/document-fetch", "transport": "sse", "headers": {"Authorization": "Bearer example-token"}},
            }
        });
        let text = parsed.to_string();
        let servers = system_mcp_servers_from(Some(&text)).expect("parsed");
        assert_eq!(servers.len(), 2);
        assert_eq!(servers[0]["name"], json!("webpageFetchServer"));
        assert_eq!(servers[0]["type"], json!("streamable-http"));
        assert_eq!(servers[1]["type"], json!("sse"));
        assert_eq!(
            servers[1]["auth"],
            json!({"Authorization": "Bearer example-token"})
        );
    }
}
