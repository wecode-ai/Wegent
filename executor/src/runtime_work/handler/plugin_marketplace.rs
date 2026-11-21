// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::super::local_connector_auth;
use super::*;
use crate::local::plugin_cache::{
    native_cache_segment, read_codex_marketplace_cache, CachedCodexPlugin,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use toml_edit::DocumentMut;

const WEWORK_PERSONAL_MARKETPLACE_ID: &str = "wework-personal";
const MARKETPLACE_QR_DRAIN_BUDGET: Duration = Duration::from_secs(10);
const MARKETPLACE_LOGOUT_BUDGET: Duration = Duration::from_secs(45);
const MARKETPLACE_MANIFEST_TIMEOUT: Duration = Duration::from_secs(2);

impl RuntimeWorkRpcHandler {
    async fn read_marketplace_config(&self) -> Result<Value, AppIpcError> {
        self.codex_app_server
            .request("config/read", json!({"includeLayers": true}))
            .await
            .map_err(marketplace_management_error)
    }

    pub(super) async fn list_configured_marketplaces(&self) -> Result<Value, AppIpcError> {
        let _guard = codex_app_server_restart_gate().lock().await;
        let config = self.read_marketplace_config().await?;
        configured_marketplace_entries(&config, &crate::agents::wework_codex_home())
    }

    pub(super) async fn check_git_marketplace_versions(
        &self,
        params: Value,
    ) -> Result<Value, AppIpcError> {
        let name = string_field(&params, "marketplaceName")
            .ok_or_else(|| AppIpcError::new("bad_request", "marketplaceName is required"))?;
        let source_revision = string_field(&params, "sourceRevision")
            .ok_or_else(|| AppIpcError::new("bad_request", "sourceRevision is required"))?;
        let config = self.read_marketplace_config().await?;
        let marketplace = confirmed_marketplace_source(&config, &name, &source_revision)?;
        if marketplace["source_type"] != "git" {
            return Err(marketplace_management_error(
                "The marketplace is not a Git source",
            ));
        }
        let source = marketplace["source"]
            .as_str()
            .ok_or_else(|| marketplace_management_error("The Git marketplace source is missing"))?;
        let reference = marketplace["ref"].as_str();
        let sparse_paths = if marketplace["sparse_paths"].is_null() {
            Vec::new()
        } else {
            serde_json::from_value(marketplace["sparse_paths"].clone())
                .map_err(marketplace_management_error)?
        };
        let preview = self
            .codex_app_server
            .read_git_marketplace_versions(&name, source, reference, &sparse_paths)
            .await;
        let _guard = codex_app_server_restart_gate().lock().await;
        let current = self.read_marketplace_config().await?;
        confirmed_marketplace_source(&current, &name, &source_revision)?;
        let versions = preview.map_err(marketplace_management_error)?;
        let installed =
            marketplace_installations(&current, &crate::agents::wework_codex_home(), &name)?;
        let versions: Vec<_> = versions
            .into_iter()
            .filter_map(|mut candidate| {
                let plugin_name = candidate["pluginName"].as_str()?;
                let id = format!("{plugin_name}@{name}");
                current["config"]["plugins"].get(&id)?;
                let package = installed.get(&id).and_then(Option::as_ref);
                candidate["installedVersion"] = json!(installed_package_version(package));
                Some(candidate)
            })
            .collect();
        Ok(json!({"versions": versions}))
    }

    pub(super) async fn remove_marketplace_with_plugins(
        &self,
        params: Value,
    ) -> Result<Value, AppIpcError> {
        let marketplace_name = string_field(&params, "marketplaceName")
            .ok_or_else(|| AppIpcError::new("bad_request", "marketplaceName is required"))?;
        let source_revision = string_field(&params, "sourceRevision")
            .ok_or_else(|| AppIpcError::new("bad_request", "sourceRevision is required"))?;
        let confirmed: Vec<String> = serde_json::from_value(params["confirmedPluginIds"].clone())
            .map_err(|_| {
            AppIpcError::new("bad_request", "confirmedPluginIds must be a list")
        })?;
        if !native_cache_segment(&marketplace_name) {
            return Err(marketplace_management_error(
                "Invalid Codex marketplace cache identity",
            ));
        }
        let home = crate::agents::wework_codex_home();
        let marketplace_cache = marketplace_cache_root(&home).join(&marketplace_name);
        let removal = local_connector_auth::MarketplaceRemoval::begin(marketplace_cache.clone())?;
        let review = async |begin_cleanup: Option<&MarketplaceInstallations>| {
            let _marketplace = self.bundled_plugin_marketplace_reconciliation.lock().await;
            let _native = codex_app_server_restart_gate().lock().await;
            let config = self.read_marketplace_config().await?;
            let installed = confirmed_marketplace_removal(
                &config,
                &home,
                &marketplace_name,
                &source_revision,
                &confirmed,
            )?;
            if let Some(reviewed) = begin_cleanup {
                confirm_reviewed_marketplace_packages(reviewed, &installed)?;
                // Publish the write guard before releasing the native mutation lock.
                removal.begin_cleanup(&home);
            }
            Ok::<_, AppIpcError>((config, installed))
        };
        let (_, reviewed_installations) = review(None).await?;
        // Keep the logout window available even when a QR request is slow.
        removal
            .wait_for_qr_auth(tokio::time::Instant::now() + MARKETPLACE_QR_DRAIN_BUDGET)
            .await?;
        let (config, installed) = review(Some(&reviewed_installations)).await?;

        // Browser sessions belong to the installation across cache version changes.
        let plugin_dirs: Vec<_> = installed
            .keys()
            .filter_map(|id| id.rsplit_once('@'))
            .map(|(name, _)| marketplace_cache.join(name))
            .collect();
        local_connector_auth::cancel_marketplace_plugin_sessions(&plugin_dirs).await;
        logout_marketplace_connectors(&config, &installed).await;

        let _marketplace = self.bundled_plugin_marketplace_reconciliation.lock().await;
        let _native = codex_app_server_restart_gate().lock().await;
        let current = self.read_marketplace_config().await?;
        let installed = confirmed_marketplace_removal(
            &current,
            &home,
            &marketplace_name,
            &source_revision,
            &confirmed,
        )?;
        confirm_reviewed_marketplace_packages(&reviewed_installations, &installed)?;
        for plugin_id in installed.keys() {
            self.codex_app_server
                .request("plugin/uninstall", json!({"pluginId": plugin_id}))
                .await
                .map_err(marketplace_management_error)?;
            crate::services::capability_activation::notify_changed();
        }
        let current = self.read_marketplace_config().await?;
        confirmed_marketplace_removal(&current, &home, &marketplace_name, &source_revision, &[])?;
        let result = self
            .codex_app_server
            .request(
                "marketplace/remove",
                json!({"marketplaceName": marketplace_name}),
            )
            .await
            .map_err(marketplace_management_error)?;
        crate::services::capability_activation::notify_changed();
        Ok(result)
    }

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
                self.write_configured_marketplace_source(&marketplace_id, &source)
                    .await?;
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
        self.write_configured_marketplace_source(&marketplace_id, &source)
            .await?;
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

    async fn write_configured_marketplace_source(
        &self,
        marketplace_id: &str,
        source: &str,
    ) -> Result<(), AppIpcError> {
        // Native edits share the writer with marketplace/add; a host-side whole-file
        // replacement can erase a marketplace registered after its snapshot was read.
        self.codex_app_server
            .request(
                "config/batchWrite",
                configured_marketplace_source_update(marketplace_id, source),
            )
            .await
            .map(|_| ())
            .map_err(plugin_marketplace_reconciliation_error)
    }
}

fn marketplace_cache_root(home: &Path) -> PathBuf {
    home.canonicalize()
        .unwrap_or_else(|_| home.to_path_buf())
        .join("plugins/cache")
}

pub(super) async fn check_marketplace_write(
    method: &str,
    params: &Value,
) -> Result<(), AppIpcError> {
    check_marketplace_write_at(&crate::agents::wework_codex_home(), method, params).await
}

async fn check_marketplace_write_at(
    home: &Path,
    method: &str,
    params: &Value,
) -> Result<(), AppIpcError> {
    if !matches!(
        method,
        "plugin/install"
            | "plugin/uninstall"
            | "marketplace/remove"
            | "marketplace/upgrade"
            | "config/value/write"
    ) {
        return Ok(());
    }
    let mut cleaning = local_connector_auth::MarketplaceRemoval::cleaning_marketplaces(home);
    if cleaning.is_empty() {
        return Ok(());
    }
    let mut install_marketplace = None;
    if method == "plugin/install" {
        if let Some(path) = string_field(params, "marketplacePath") {
            let name = read_install_marketplace_name(PathBuf::from(path)).await;
            // A cancelled removal can release its protection during the bounded read.
            cleaning = local_connector_auth::MarketplaceRemoval::cleaning_marketplaces(home);
            if cleaning.is_empty() {
                return Ok(());
            }
            install_marketplace = Some(name?);
        }
    }
    if marketplace_write_conflicts(method, params, install_marketplace.as_deref(), &cleaning) {
        return Err(AppIpcError::new(
            "marketplace_removal_in_progress",
            "The plugin marketplace is being removed",
        ));
    }
    Ok(())
}

async fn read_install_marketplace_name(path: PathBuf) -> Result<String, AppIpcError> {
    let mut read = tokio::task::spawn_blocking(move || {
        crate::local::plugin_catalog::read_marketplace_manifest_name(&path)
    });
    match tokio::time::timeout(MARKETPLACE_MANIFEST_TIMEOUT, &mut read).await {
        Ok(result) => result
            .map_err(marketplace_management_error)?
            .map_err(marketplace_management_error),
        Err(_) => {
            read.abort();
            Err(AppIpcError::new(
                "marketplace_manifest_timeout",
                "Reading the marketplace manifest timed out. Retry the installation.",
            ))
        }
    }
}

fn marketplace_write_conflicts(
    method: &str,
    params: &Value,
    install_marketplace: Option<&str>,
    cleaning: &[String],
) -> bool {
    let is_cleaning = |name: &str| {
        cleaning
            .iter()
            .any(|market| market.eq_ignore_ascii_case(name.trim()))
    };
    let plugin_market_is_cleaning = |id: &str| {
        id.rsplit_once('@')
            .is_some_and(|(_, market)| is_cleaning(market))
    };
    match method {
        "plugin/install" => install_marketplace
            .or_else(|| params["remoteMarketplaceName"].as_str())
            .is_some_and(is_cleaning),
        "plugin/uninstall" => params["pluginId"]
            .as_str()
            .is_some_and(plugin_market_is_cleaning),
        "marketplace/remove" => params["marketplaceName"].as_str().is_some_and(is_cleaning),
        "marketplace/upgrade" => params["marketplaceName"].as_str().is_none_or(is_cleaning),
        "config/value/write" => {
            let Some(path) = params["keyPath"].as_str() else {
                return false;
            };
            let matches_key = |section, key: Option<&str>| {
                let conflicts: &dyn Fn(&str) -> bool = match section {
                    "marketplaces" => &is_cleaning,
                    "plugins" => &plugin_market_is_cleaning,
                    _ => return false,
                };
                if let Some(key) = key {
                    return conflicts(key);
                }
                params["mergeStrategy"] != "upsert"
                    || params["value"]
                        .as_object()
                        .is_none_or(|entries| entries.keys().any(|key| conflicts(key)))
            };
            if let Ok(keys) = toml_edit::Key::parse(path) {
                return keys.first().is_some_and(|section| {
                    matches_key(section.get(), keys.get(1).map(toml_edit::Key::get))
                });
            }
            // The app server also accepts unquoted plugin IDs containing '@'.
            let mut keys = path
                .split('.')
                .map(|key| key.trim().trim_matches(['\'', '"']));
            keys.next()
                .is_some_and(|section| matches_key(section, keys.next()))
        }
        _ => false,
    }
}

fn marketplace_management_error(error: impl std::fmt::Display) -> AppIpcError {
    AppIpcError::new("marketplace_management_failed", error.to_string())
}

fn is_user_layer(layer: &Value) -> bool {
    layer["name"]["type"] == "user" && layer["name"]["profile"].is_null()
}

fn configured_user_marketplace<'a>(config: &'a Value, name: &str) -> Option<&'a Value> {
    if matches!(
        name.to_ascii_lowercase().as_str(),
        WEWORK_PERSONAL_MARKETPLACE_ID
            | "personal"
            | "default"
            | "wegent"
            | "wework"
            | "wegent-market"
            | "wegent-marketplace"
            | "openai-bundled"
            | "openai-primary-runtime"
            | "openai-api-curated"
            | "openai-curated"
            | "openai-curated-remote"
            | "openai-official"
    ) || !native_cache_segment(name)
    {
        return None;
    }
    let mut owned = None;
    for layer in config["layers"].as_array()? {
        let Some(marketplaces) = layer["config"]["marketplaces"].as_object() else {
            continue;
        };
        for (id, marketplace) in marketplaces {
            if !id.eq_ignore_ascii_case(name) {
                continue;
            }
            if !is_user_layer(layer) || id != name || owned.is_some() {
                return None;
            }
            if matches!(marketplace["source_type"].as_str(), Some("local" | "git")) {
                owned = Some(marketplace);
            }
        }
    }
    owned
}

type MarketplaceInstallations = BTreeMap<String, Option<CachedCodexPlugin>>;

fn configured_marketplace_entries(config: &Value, home: &Path) -> Result<Value, AppIpcError> {
    let layers = config["layers"]
        .as_array()
        .ok_or_else(|| marketplace_management_error("Invalid marketplace configuration layers"))?;
    let mut marketplaces = Vec::new();
    for id in layers
        .iter()
        .filter(|layer| is_user_layer(layer))
        .filter_map(|layer| layer["config"]["marketplaces"].as_object())
        .flat_map(|marketplaces| marketplaces.keys())
    {
        let Some(source) = configured_user_marketplace(config, id) else {
            continue;
        };
        let installed = marketplace_installations(config, home, id)
            .map(|items| {
                items.into_iter().map(|(id, package)| {
                    let (name, _) = id.rsplit_once('@').expect("qualified plugin id");
                    let display = package.as_ref().map(|package| &package.manifest["interface"]["displayName"]);
                    json!({
                        "id": id,
                        "name": display.and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or(name),
                        "version": installed_package_version(package.as_ref()),
                    })
                }).collect::<Vec<_>>()
            })
            .map_err(|error| {
                log_executor_event(
                    "marketplace installation list unavailable",
                    &[("marketplace", id.to_owned()), ("error_code", error.code)],
                );
            })
            .ok();
        marketplaces.push(json!({
            "id": id,
            "sourceType": source["source_type"],
            "gitRef": source["ref"],
            "sourceRevision": marketplace_source_revision(source),
            "installed": installed,
        }));
    }
    Ok(json!(marketplaces))
}

fn marketplace_source_revision(source: &Value) -> String {
    let identity = json!([
        source["source_type"],
        source["source"],
        source["ref"],
        source["sparse_paths"]
    ]);
    format!("{:x}", Sha256::digest(identity.to_string()))
}

fn confirmed_marketplace_source<'a>(
    config: &'a Value,
    name: &str,
    source_revision: &str,
) -> Result<&'a Value, AppIpcError> {
    configured_user_marketplace(config, name)
        .filter(|source| marketplace_source_revision(source) == source_revision)
        .ok_or_else(|| {
            AppIpcError::new(
                "marketplace_source_changed",
                "The marketplace source changed. Review and try again.",
            )
        })
}

fn confirmed_marketplace_removal(
    config: &Value,
    home: &Path,
    name: &str,
    source_revision: &str,
    confirmed: &[String],
) -> Result<MarketplaceInstallations, AppIpcError> {
    confirmed_marketplace_source(config, name, source_revision)?;
    let installed = marketplace_installations(config, home, name)?;
    confirm_marketplace_plugins(&installed, confirmed.to_vec())?;
    for plugin_id in installed.keys() {
        if config["layers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|layer| {
                !is_user_layer(layer) && layer["config"]["plugins"].get(plugin_id).is_some()
            })
        {
            return Err(marketplace_management_error(
                "An installed plugin is configured outside the user layer",
            ));
        }
        super::super::connection_host::assert_dependency_unused(plugin_id)?;
    }
    Ok(installed)
}

fn confirm_reviewed_marketplace_packages(
    reviewed: &MarketplaceInstallations,
    current: &MarketplaceInstallations,
) -> Result<(), AppIpcError> {
    if current != reviewed {
        return Err(AppIpcError::new(
            "marketplace_installations_changed",
            "Installed plugin packages changed during removal. Review and try again.",
        ));
    }
    Ok(())
}

async fn logout_marketplace_connectors(config: &Value, installed: &MarketplaceInstallations) {
    let targets = installed.iter().filter_map(|(id, package)| {
        config["config"]["plugins"].get(id)?;
        package.as_ref()
    });
    // Cleanup is best effort. Keep commands outside native locks and reserve time
    // for revalidation and uninstall within the existing IPC deadline.
    let cleanup = stream::iter(targets).for_each_concurrent(4, |package| async move {
        local_connector_auth::logout_before_plugin_uninstall(&package.root, &package.manifest)
            .await;
    });
    if tokio::time::timeout(MARKETPLACE_LOGOUT_BUDGET, cleanup)
        .await
        .is_err()
    {
        log_executor_event("marketplace connector logout timed out", &[]);
    }
}

fn marketplace_installations(
    config: &Value,
    home: &Path,
    marketplace_name: &str,
) -> Result<MarketplaceInstallations, AppIpcError> {
    let mut installed: MarketplaceInstallations =
        read_codex_marketplace_cache(home, marketplace_name)
            .map_err(marketplace_management_error)?
            .into_iter()
            .map(|(name, package)| (format!("{name}@{marketplace_name}"), package))
            .collect();
    for id in config["config"]["plugins"]
        .as_object()
        .into_iter()
        .flat_map(|plugins| plugins.keys())
    {
        if let Some((name, market)) = id.rsplit_once('@') {
            if market == marketplace_name {
                if !native_cache_segment(name) {
                    return Err(marketplace_management_error(
                        "Invalid installed plugin identity",
                    ));
                }
                installed.entry(id.to_owned()).or_insert(None);
            }
        }
    }
    Ok(installed)
}

fn installed_package_version(package: Option<&CachedCodexPlugin>) -> Option<&str> {
    package?.manifest["version"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn confirm_marketplace_plugins(
    installed: &MarketplaceInstallations,
    mut confirmed: Vec<String>,
) -> Result<(), AppIpcError> {
    confirmed.sort_unstable();
    if !installed.keys().eq(confirmed.iter()) {
        return Err(AppIpcError::new(
            "marketplace_installations_changed",
            "Installed plugins changed since confirmation. Review and try again.",
        ));
    }
    Ok(())
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

fn configured_marketplace_source_update(marketplace_id: &str, source: &str) -> Value {
    json!({
        "edits": [
            {"keyPath": format!("marketplaces.{marketplace_id}.source_type"),
             "value": "local", "mergeStrategy": "replace"},
            {"keyPath": format!("marketplaces.{marketplace_id}.source"),
             "value": source, "mergeStrategy": "replace"},
        ],
        "filePath": Value::Null,
        "expectedVersion": Value::Null,
        "reloadUserConfig": true,
    })
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

    #[tokio::test]
    async fn marketplace_cleanup_blocks_only_conflicting_native_writes() {
        let home = tempfile::tempdir().unwrap();
        let home_path = home.path();
        let cache = marketplace_cache_root(home.path());
        let removal =
            local_connector_auth::MarketplaceRemoval::begin(cache.join("custom")).unwrap();
        let peer = local_connector_auth::MarketplaceRemoval::begin(cache.join("other")).unwrap();
        assert!(
            local_connector_auth::MarketplaceRemoval::cleaning_marketplaces(home_path).is_empty()
        );
        removal.begin_cleanup(home_path);
        let manifest = home.path().join("marketplace.json");
        let padding = " ".repeat(1024 * 1024);
        let manifest_contents =
            |name: &str| format!(r#"{{"plugins":[],{padding}"name":"{name}"}}"#);
        fs::write(&manifest, manifest_contents("custom")).unwrap();
        for (method, params, blocked) in [
            ("plugin/install", json!({"marketplacePath":manifest}), true),
            (
                "plugin/install",
                json!({"remoteMarketplaceName":"custom"}),
                true,
            ),
            (
                "plugin/install",
                json!({"remoteMarketplaceName":"other"}),
                false,
            ),
            (
                "plugin/uninstall",
                json!({"pluginId":"sample@custom"}),
                true,
            ),
            (
                "plugin/uninstall",
                json!({"pluginId":"sample@other"}),
                false,
            ),
            (
                "marketplace/remove",
                json!({"marketplaceName":"custom"}),
                true,
            ),
            (
                "marketplace/upgrade",
                json!({"marketplaceName":"other"}),
                false,
            ),
            ("marketplace/upgrade", json!({}), true),
            (
                "config/value/write",
                json!({"keyPath":"marketplaces.custom.ref"}),
                true,
            ),
            (
                "config/value/write",
                json!({"keyPath":"marketplaces.other.ref"}),
                false,
            ),
            (
                "config/value/write",
                json!({"keyPath":r#"plugins."sample@custom".enabled"#}),
                true,
            ),
            (
                "config/value/write",
                json!({"keyPath":"plugins.sample@custom.enabled"}),
                true,
            ),
            (
                "config/value/write",
                json!({"keyPath":"plugins", "mergeStrategy":"upsert", "value":{"sample@other":{"enabled":false}}}),
                false,
            ),
            (
                "config/value/write",
                json!({"keyPath":"plugins", "mergeStrategy":"upsert", "value":{
                    "sample@other":{"enabled":false}, "sample@custom":{"enabled":false}
                }}),
                true,
            ),
            (
                "config/value/write",
                json!({"keyPath":"plugins", "mergeStrategy":"replace", "value":{"sample@other":{"enabled":false}}}),
                true,
            ),
            (
                "config/value/write",
                json!({"keyPath":"marketplaces", "mergeStrategy":"upsert", "value":{"other":{"ref":"branch"}}}),
                false,
            ),
            (
                "config/value/write",
                json!({"keyPath":"marketplaces", "mergeStrategy":"upsert", "value":{"custom":{"ref":"branch"}}}),
                true,
            ),
            (
                "config/value/write",
                json!({"keyPath":"marketplaces", "mergeStrategy":"replace", "value":{}}),
                true,
            ),
            ("config/value/write", json!({"keyPath":"model"}), false),
        ] {
            let result = check_marketplace_write_at(home_path, method, &params).await;
            if blocked {
                assert_eq!(
                    result.unwrap_err().code,
                    "marketplace_removal_in_progress",
                    "{method} {params}"
                );
            } else {
                assert!(result.is_ok(), "{method} {params}");
            }
        }
        fs::write(&manifest, manifest_contents("other")).unwrap();
        check_marketplace_write_at(
            home_path,
            "plugin/install",
            &json!({"marketplacePath":manifest}),
        )
        .await
        .expect("the other marketplace should accept a valid large manifest");
        drop(removal);
        assert!(
            local_connector_auth::MarketplaceRemoval::cleaning_marketplaces(home_path).is_empty()
        );
        drop(peer);
    }

    #[test]
    fn marketplace_cleanup_releases_native_gate_when_manifest_read_times_out() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(true)
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let home = tempfile::tempdir().unwrap();
            let home_path = home.path();
            let removal = local_connector_auth::MarketplaceRemoval::begin(
                marketplace_cache_root(home_path).join("custom"),
            )
            .unwrap();
            removal.begin_cleanup(home_path);
            let manifest = home_path.join("marketplace.json");
            fs::write(&manifest, r#"{"name":"other","plugins":[]}"#).unwrap();
            let params = json!({"marketplacePath":manifest});
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let occupied = tokio::task::spawn_blocking(move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
            });
            started_rx.await.unwrap();

            let gate = tokio::sync::Mutex::new(());
            let request = async {
                let _lock = gate.lock().await;
                check_marketplace_write_at(home_path, "plugin/install", &params).await
            };
            let mut request = std::pin::pin!(request);
            assert!(futures_util::poll!(&mut request).is_pending());
            tokio::time::advance(MARKETPLACE_MANIFEST_TIMEOUT + Duration::from_millis(1)).await;
            assert_eq!(
                request.await.unwrap_err().code,
                "marketplace_manifest_timeout"
            );
            let _next = gate
                .try_lock()
                .expect("the timed-out read released the native gate");
            release_tx.send(()).unwrap();
            occupied.await.unwrap();
            tokio::time::resume();
            check_marketplace_write_at(home_path, "plugin/install", &params)
                .await
                .unwrap();
        });
    }

    #[test]
    fn marketplace_listing_keeps_healthy_sources_when_one_inventory_fails() {
        let home = tempfile::tempdir().unwrap();
        let cache = home.path().join("plugins/cache");
        fs::create_dir_all(&cache).unwrap();
        fs::write(cache.join("broken"), "not a directory").unwrap();
        let config = json!({
            "config": {"plugins": {"first@broken": {"enabled": true}, "second@healthy": {"enabled": true}}},
            "layers": [{"name": {"type": "user"}, "config": {"marketplaces": {
                "broken": {"source_type": "local"},
                "healthy": {"source_type": "local"},
            }}}]
        });

        let sources = configured_marketplace_entries(&config, home.path()).unwrap();

        assert_eq!(sources[0]["id"], "broken");
        assert!(sources[0]["installed"].is_null());
        assert_eq!(sources[1]["id"], "healthy");
        assert_eq!(sources[1]["installed"][0]["id"], "second@healthy");
    }

    #[test]
    fn marketplace_removal_revalidates_the_reviewed_installations() {
        let home = tempfile::tempdir().unwrap();
        for (marketplace, version) in [
            ("custom", "9.0.0"),
            ("custom", "10.0.0"),
            ("other", "11.0.0"),
        ] {
            let folder = home.path().join(format!(
                "plugins/cache/{marketplace}/shared/{version}/.codex-plugin"
            ));
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("plugin.json"),
                json!({"name": "shared", "version": version}).to_string(),
            )
            .unwrap();
        }
        let config = json!({"config": {"plugins": {
            "configured@custom": {"enabled": false},
            "shared@other": {"enabled": true},
        }}});
        let installed = marketplace_installations(&config, home.path(), "custom").unwrap();
        assert_eq!(
            installed_package_version(installed["shared@custom"].as_ref()),
            Some("10.0.0")
        );
        assert!(confirm_marketplace_plugins(
            &installed,
            vec!["configured@custom".into(), "shared@custom".into()]
        )
        .is_ok());
        assert!(confirm_marketplace_plugins(&installed, vec!["configured@custom".into()]).is_err());
        assert!(confirm_marketplace_plugins(
            &installed,
            vec!["configured@custom".into(), "shared@other".into()]
        )
        .is_err());
    }

    #[test]
    fn marketplace_removal_rejects_new_source_with_the_same_plugins() {
        let home = tempfile::tempdir().unwrap();
        let original = json!({"source_type": "git", "source": "https://example.invalid/catalog", "ref": "main"});
        let mut config = json!({
            "config": {"plugins": {"sample@custom": {"enabled": true}}},
            "layers": [{"name": {"type": "user"}, "config": {"marketplaces": {"custom": original}}}]
        });
        let original = &config["layers"][0]["config"]["marketplaces"]["custom"];
        let revision = marketplace_source_revision(original);
        let confirmed = ["sample@custom".to_owned()];
        assert!(confirmed_marketplace_removal(
            &config,
            home.path(),
            "custom",
            &revision,
            &confirmed
        )
        .is_ok());

        config["layers"][0]["config"]["marketplaces"]["custom"] =
            json!({"source_type": "local", "source": "/another/catalog"});
        let failure =
            confirmed_marketplace_removal(&config, home.path(), "custom", &revision, &confirmed)
                .err()
                .expect("stale confirmation must not remove the replacement source");
        assert_eq!(failure.code, "marketplace_source_changed");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn marketplace_removal_starts_waiting_connector_cleanups_concurrently() {
        let home = tempfile::tempdir().unwrap();
        let mut installed = MarketplaceInstallations::new();
        let mut config = json!({"config": {"plugins": {}}});
        for (name, peer) in [("first", "second"), ("second", "first")] {
            let root = home.path().join(name);
            fs::create_dir(&root).unwrap();
            fs::write(
                root.join("logout.sh"),
                r#"#!/bin/sh
touch started
waited=0
while [ ! -e "../$1/started" ]; do
    [ "$waited" -lt 50 ] || exit 1
    waited=$((waited + 1))
    sleep 0.02
done
touch finished
printf '{"status":"ok"}\n'
"#,
            )
            .unwrap();
            let manifest = json!({"connectors": [{"slug": "connector", "localAuth": {
                "kind": "browser_oauth", "logoutOnUninstall": true,
                "health": ["logout.sh"], "start": ["logout.sh"],
                "logout": ["logout.sh", peer],
            }}]});
            let id = format!("{name}@custom");
            config["config"]["plugins"][&id] = json!({"enabled": true});
            installed.insert(id, Some(CachedCodexPlugin { root, manifest }));
        }

        logout_marketplace_connectors(&config, &installed).await;

        assert!(home.path().join("first/finished").is_file());
        assert!(home.path().join("second/finished").is_file());
    }

    #[test]
    fn marketplace_removal_cannot_uninstall_from_another_configuration_layer() {
        let mut config = json!({"layers": [
            {"name": {"type": "user", "profile": null}, "config": {
                "marketplaces": {"custom": {"source_type": "git"}}
            }}
        ]});
        assert!(configured_user_marketplace(&config, "custom").is_some());
        config["layers"].as_array_mut().unwrap().push(json!({
            "name": {"type": "system"},
            "config": {"marketplaces": {"CUSTOM": {"source_type": "git"}}}
        }));
        assert!(configured_user_marketplace(&config, "custom").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn native_write_failure_preserves_existing_marketplaces_and_plugin_settings() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = crate::test_env::lock();
        let root = tempfile::tempdir().unwrap();
        let _executor_home = super::super::tests::ScalarEnv::set(
            "WEGENT_EXECUTOR_HOME",
            root.path().to_str().unwrap(),
        );
        let _home =
            super::super::tests::ScalarEnv::set("WEGENT_CODEX_HOME", root.path().to_str().unwrap());
        let config_path = root.path().join("config.toml");
        let original = concat!(
            "personality = \"pragmatic\"\n",
            "[agents]\nmax_concurrent_threads_per_session = 6\n",
            "[marketplaces.wework]\nsource_type = \"local\"\nsource = \"/other\"\n",
            "[plugins.\"kept@wework-personal\"]\nenabled = false\n",
        );
        fs::write(&config_path, original).unwrap();
        let native = root.path().join("codex.sh");
        fs::write(
            &native,
            crate::test_env::with_codex_bundled_catalog(
                r#"#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  case "$line" in
    *'"method":"config/batchWrite"'*)
      printf '{"id":%s,"error":{"code":-32000,"message":"native config write rejected"}}\n' "$id" ;;
    *) printf '{"id":%s,"result":{}}\n' "$id" ;;
  esac
done
"#,
            ),
        )
        .unwrap();
        fs::set_permissions(&native, fs::Permissions::from_mode(0o755)).unwrap();
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let handler = RuntimeWorkRpcHandler::new("device-1", native.to_str().unwrap());
                let error = handler
                    .write_configured_marketplace_source(
                        WEWORK_PERSONAL_MARKETPLACE_ID,
                        "/current/wework-personal",
                    )
                    .await
                    .unwrap_err();
                assert_eq!(
                    error.code,
                    "bundled_plugin_marketplace_reconciliation_failed"
                );
                assert!(error.message.contains("native config write rejected"));
                assert_eq!(fs::read_to_string(&config_path).unwrap(), original);
            });
    }

    #[test]
    fn preserves_windows_marketplace_paths_in_native_config_edits() {
        let source = r"D:\workspace\capabilities\bundled-marketplaces\wework-personal";
        let update = configured_marketplace_source_update(WEWORK_PERSONAL_MARKETPLACE_ID, source);
        assert_eq!(update["edits"][1]["value"].as_str(), Some(source));
    }

    #[test]
    fn native_config_edits_target_only_the_managed_marketplace_source() {
        let update = configured_marketplace_source_update(
            WEWORK_PERSONAL_MARKETPLACE_ID,
            "/current/wework-personal",
        );
        let edits = update["edits"].as_array().unwrap();
        assert_eq!(edits.len(), 2);
        assert_eq!(
            edits[0],
            json!({"keyPath": "marketplaces.wework-personal.source_type",
                   "value": "local", "mergeStrategy": "replace"})
        );
        assert_eq!(
            edits[1],
            json!({"keyPath": "marketplaces.wework-personal.source",
                   "value": "/current/wework-personal", "mergeStrategy": "replace"})
        );
        assert_eq!(update["reloadUserConfig"], true);
    }
}
