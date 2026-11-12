// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use toml_edit::DocumentMut;

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
