// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::agents::replace_config;
use toml_edit::{table, value, DocumentMut};

const WEWORK_PERSONAL_MARKETPLACE_ID: &str = "wework-personal";

impl RuntimeWorkRpcHandler {
    pub(super) async fn reconcile_bundled_plugin_marketplace(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let marketplace_id = string_field(&payload, "marketplaceId")
            .ok_or_else(|| AppIpcError::new("bad_request", "marketplaceId is required"))?;
        if marketplace_id != WEWORK_PERSONAL_MARKETPLACE_ID {
            return Err(AppIpcError::new(
                "bad_request",
                format!("Unsupported bundled plugin marketplace: {marketplace_id}"),
            ));
        }
        let source = string_field(&payload, "source")
            .ok_or_else(|| AppIpcError::new("bad_request", "source is required"))?;
        let _guard = self.bundled_plugin_marketplace_reconciliation.lock().await;
        let available = self
            .codex_app_server
            .request(
                "plugin/list",
                json!({
                    "cwds": null,
                    "marketplaceKinds": ["local"],
                }),
            )
            .await
            .map_err(plugin_marketplace_reconciliation_error)?;
        let existing_marketplace = marketplace_entry(&available, &marketplace_id);
        let configured_marketplace = configured_marketplace(&marketplace_id)
            .map_err(plugin_marketplace_reconciliation_error)?;
        let app_server_source = existing_marketplace.and_then(marketplace_source);
        let configured_source = configured_marketplace
            .as_ref()
            .and_then(|entry| entry.source.clone());
        let existing_source = app_server_source
            .clone()
            .or_else(|| configured_source.clone());
        let existing_marketplace_present =
            existing_marketplace.is_some() || configured_marketplace.is_some();
        let app_server_source_matches = app_server_source
            .as_deref()
            .is_some_and(|existing| marketplace_sources_match(existing, &source));
        let configured_source_matches = configured_source
            .as_deref()
            .is_some_and(|existing| marketplace_sources_match(existing, &source));
        if app_server_source_matches || (app_server_source.is_none() && configured_source_matches) {
            if !configured_source_matches {
                write_configured_marketplace_source(&marketplace_id, &source)
                    .map_err(plugin_marketplace_reconciliation_error)?;
            }
            log_plugin_marketplace_reconciliation(&marketplace_id, "unchanged", &source);
            return Ok(json!({
                "marketplaceName": marketplace_id,
                "action": "unchanged",
            }));
        }

        if should_remove_existing_marketplace(
            existing_marketplace_present,
            existing_source.as_deref(),
        ) {
            self.codex_app_server
                .request(
                    "marketplace/remove",
                    json!({"marketplaceName": marketplace_id}),
                )
                .await
                .map_err(plugin_marketplace_reconciliation_error)?;
        }

        let added = self
            .codex_app_server
            .request(
                "marketplace/add",
                json!({
                    "source": source,
                    "refName": null,
                    "sparsePaths": null,
                }),
            )
            .await;
        let added = match added {
            Ok(added) => added,
            Err(add_error) => {
                let rollback_error = if let Some(previous_source) = existing_source.as_deref() {
                    self.codex_app_server
                        .request(
                            "marketplace/add",
                            json!({
                                "source": previous_source,
                                "refName": null,
                                "sparsePaths": null,
                            }),
                        )
                        .await
                        .err()
                } else {
                    None
                };
                let rollback = rollback_error
                    .map(|error| format!("; restoring the previous source also failed: {error}"))
                    .unwrap_or_default();
                return Err(AppIpcError::new(
                    "bundled_plugin_marketplace_reconciliation_failed",
                    format!(
                        "Failed to register bundled plugin marketplace {marketplace_id}: {add_error}{rollback}"
                    ),
                ));
            }
        };
        let added_name = added
            .get("marketplaceName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if added_name != marketplace_id {
            return Err(AppIpcError::new(
                "bundled_plugin_marketplace_reconciliation_failed",
                format!("Bundled plugin marketplace {marketplace_id} resolved to {added_name}"),
            ));
        }
        write_configured_marketplace_source(&marketplace_id, &source)
            .map_err(plugin_marketplace_reconciliation_error)?;
        let action = if existing_marketplace_present {
            "replaced"
        } else {
            "added"
        };
        log_plugin_marketplace_reconciliation(&marketplace_id, action, &source);
        Ok(json!({
            "marketplaceName": marketplace_id,
            "action": action,
        }))
    }
}

fn marketplace_entry<'a>(response: &'a Value, marketplace_id: &str) -> Option<&'a Value> {
    response
        .get("marketplaces")
        .and_then(Value::as_array)
        .and_then(|marketplaces| {
            marketplaces.iter().find(|marketplace| {
                marketplace.get("name").and_then(Value::as_str) == Some(marketplace_id)
            })
        })
}

fn marketplace_source(marketplace: &Value) -> Option<String> {
    marketplace
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|source| !source.is_empty())
        .map(str::to_owned)
}

fn should_remove_existing_marketplace(
    existing_marketplace_present: bool,
    existing_source: Option<&str>,
) -> bool {
    existing_marketplace_present && existing_source.is_some()
}

#[derive(Debug, PartialEq, Eq)]
struct ConfiguredMarketplace {
    source: Option<String>,
}

fn configured_marketplace(marketplace_id: &str) -> Result<Option<ConfiguredMarketplace>, String> {
    let config_path = crate::agents::wework_codex_home().join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to read Codex config {}: {error}",
                config_path.display()
            ));
        }
    };
    let config = content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "Failed to parse Codex config {}: {error}",
            config_path.display()
        )
    })?;
    let marketplace = config
        .get("marketplaces")
        .and_then(|item| item.as_table_like())
        .and_then(|marketplaces| marketplaces.get(marketplace_id));
    Ok(marketplace.map(|marketplace| ConfiguredMarketplace {
        source: marketplace
            .get("source")
            .and_then(|source| source.as_str())
            .map(str::trim)
            .filter(|source| !source.is_empty())
            .map(str::to_owned),
    }))
}

fn write_configured_marketplace_source(marketplace_id: &str, source: &str) -> Result<(), String> {
    let config_path = crate::agents::wework_codex_home().join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => {
            return Err(format!(
                "Failed to read Codex config {}: {error}",
                config_path.display()
            ));
        }
    };
    let updated =
        set_configured_marketplace_source(&content, marketplace_id, source).map_err(|error| {
            format!(
                "Failed to parse Codex config {}: {error}",
                config_path.display()
            )
        })?;
    replace_config(&config_path, updated)
}

fn set_configured_marketplace_source(
    content: &str,
    marketplace_id: &str,
    source: &str,
) -> Result<String, String> {
    let mut config = content
        .parse::<DocumentMut>()
        .map_err(|error| error.to_string())?;
    if !config.contains_key("marketplaces") {
        config["marketplaces"] = table();
    }
    let marketplaces = config["marketplaces"]
        .as_table_like_mut()
        .ok_or_else(|| "marketplaces must be a table".to_owned())?;
    if !marketplaces.contains_key(marketplace_id) {
        marketplaces.insert(marketplace_id, table());
    }
    let marketplace = marketplaces
        .get_mut(marketplace_id)
        .and_then(|item| item.as_table_like_mut())
        .ok_or_else(|| format!("marketplaces.{marketplace_id} must be a table"))?;
    marketplace.insert("source_type", value("local"));
    marketplace.insert("source", value(source));
    Ok(config.to_string())
}

fn marketplace_sources_match(left: &str, right: &str) -> bool {
    let left = normalized_marketplace_source(left);
    let right = normalized_marketplace_source(right);
    match (fs::canonicalize(&left), fs::canonicalize(&right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn normalized_marketplace_source(source: &str) -> String {
    let normalized = source
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_owned();
    for manifest_suffix in [
        "/.agents/plugins/marketplace.json",
        "/.claude-plugin/marketplace.json",
    ] {
        if let Some(root) = normalized.strip_suffix(manifest_suffix) {
            return root.to_owned();
        }
    }
    normalized
}

fn plugin_marketplace_reconciliation_error(error: String) -> AppIpcError {
    AppIpcError::new("bundled_plugin_marketplace_reconciliation_failed", error)
}

fn log_plugin_marketplace_reconciliation(marketplace_id: &str, action: &str, source: &str) {
    log_executor_event(
        "bundled plugin marketplace reconciled",
        &[
            ("marketplace_id", marketplace_id.to_owned()),
            ("action", action.to_owned()),
            ("source", source.to_owned()),
        ],
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_registered_marketplace_source() {
        let response = json!({
            "marketplaces": [
                {"name": "team", "path": "/plugins/team"},
                {"name": "wework-personal", "path": "/plugins/personal"},
            ]
        });

        assert_eq!(
            marketplace_entry(&response, WEWORK_PERSONAL_MARKETPLACE_ID)
                .and_then(marketplace_source)
                .as_deref(),
            Some("/plugins/personal")
        );
    }

    #[test]
    fn finds_a_registered_marketplace_even_when_codex_omits_its_path() {
        let response = json!({
            "marketplaces": [{"name": "wework-personal", "plugins": []}]
        });

        let marketplace = marketplace_entry(&response, WEWORK_PERSONAL_MARKETPLACE_ID)
            .expect("the registered marketplace should be detected");
        assert_eq!(marketplace_source(marketplace), None);
        assert!(!should_remove_existing_marketplace(true, None));
        assert!(should_remove_existing_marketplace(
            true,
            Some("/plugins/personal")
        ));
    }

    #[test]
    fn compares_marketplace_sources_without_separator_noise() {
        assert!(marketplace_sources_match(
            r"C:\plugins\wework-personal\",
            "C:/plugins/wework-personal"
        ));
        assert!(marketplace_sources_match(
            "/plugins/wework-personal/.agents/plugins/marketplace.json",
            "/plugins/wework-personal"
        ));
        assert!(!marketplace_sources_match(
            "/old/plugins/wework-personal",
            "/new/plugins/wework-personal"
        ));
    }

    #[test]
    fn rewrites_the_managed_marketplace_source_without_changing_plugin_settings() {
        let updated = set_configured_marketplace_source(
            concat!(
                "[marketplaces.wework-personal]\n",
                "source_type = \"local\"\n",
                "source = \"/old/wework-personal\"\n\n",
                "[plugins.\"kept@wework-personal\"]\n",
                "enabled = false\n",
            ),
            WEWORK_PERSONAL_MARKETPLACE_ID,
            "/current/wework-personal",
        )
        .unwrap();
        let config = updated.parse::<DocumentMut>().unwrap();

        assert_eq!(
            config["marketplaces"][WEWORK_PERSONAL_MARKETPLACE_ID]["source"].as_str(),
            Some("/current/wework-personal")
        );
        assert_eq!(
            config["plugins"]["kept@wework-personal"]["enabled"].as_bool(),
            Some(false)
        );
    }
}
