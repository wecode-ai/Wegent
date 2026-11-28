//! Explicit installation belongs to the owning Runtime, never its read-only collector.
use super::*;

static INSTALL_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn denied() -> AppIpcError {
    AppIpcError::new(
        "connection_dependency_denied",
        "Connection installation plan changed or is invalid",
    )
}

fn native_install_params(catalog: &Value, target: &Value) -> Result<Value, AppIpcError> {
    let mut matches = catalog["marketplaces"]
        .as_array()
        .ok_or_else(denied)?
        .iter()
        .filter(|market| market["name"] == target["marketplaceId"])
        .flat_map(|market| {
            market["plugins"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |plugin| (market, plugin))
        })
        .filter(|(_, plugin)| plugin["id"] == target["pluginId"]);
    let (market, plugin) = matches.next().ok_or_else(denied)?;
    let version = plugin
        .get("localVersion")
        .filter(|value| !value.is_null())
        .unwrap_or(&plugin["version"]);
    if matches.next().is_some()
        || plugin["installed"] == true
        || plugin["availability"] == "DISABLED_BY_ADMIN"
        || version != &target["version"]
        || plugin["name"].as_str().is_none_or(str::is_empty)
    {
        return Err(denied());
    }
    let mut params = json!({"pluginName":plugin["name"]});
    if let Some(path) = market["path"].as_str().filter(|path| !path.is_empty()) {
        params["marketplacePath"] = json!(path);
    } else {
        params["remoteMarketplaceName"] = market["name"].clone();
    }
    Ok(params)
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn install_connection_dependencies(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let _installation = INSTALL_GATE.lock().await;
        let provider = payload["providerId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(denied)?;
        let aliases = payload["aliases"].as_array().ok_or_else(denied)?;
        if aliases
            .iter()
            .any(|alias| alias.as_str().is_none_or(str::is_empty))
        {
            return Err(denied());
        }
        let catalog = self
            .handle_codex_app_server_rpc(json!({"method":"plugin/list","params":{"cwds":[]}}))
            .await?;
        let plan = self
            .connection_call(
                "planDependencyInstallation",
                Some(provider),
                json!({"aliases":aliases,"catalog":catalog}),
            )
            .await?;
        let installations = plan["installations"].as_array().ok_or_else(denied)?;
        // The same gate covers ordinary native plugin edits. Do not hold it
        // while DSH plans or refreshes inventory through the read endpoint.
        let marketplace_gate = self.bundled_plugin_marketplace_reconciliation.lock().await;
        let native_gate = codex_app_server_restart_gate().lock().await;
        let current_catalog = self
            .handle_codex_app_server_rpc_locked(
                "plugin/list".into(),
                json!({"params":{"cwds":[]}}),
                &native_gate,
            )
            .await?;
        let mut seen = std::collections::HashSet::new();
        let mut actions = std::collections::BTreeMap::new();
        for item in installations {
            let alias = item["alias"].as_str().ok_or_else(denied)?;
            if !aliases.contains(&json!(alias)) || !seen.insert(alias) {
                return Err(denied());
            }
            let grant = super::super::connection_host::declared_dependency(
                provider,
                &item["target"],
                Some(alias),
            )?;
            if item["version"] != grant["version"] {
                return Err(denied());
            }
            let expected = native_install_params(&catalog, &item["target"])?;
            let params = native_install_params(&current_catalog, &item["target"])?;
            if expected != params {
                return Err(denied());
            }
            let key = (
                grant["marketplaceId"]
                    .as_str()
                    .ok_or_else(denied)?
                    .to_owned(),
                grant["pluginId"].as_str().ok_or_else(denied)?.to_owned(),
            );
            if actions
                .insert(key, params.clone())
                .is_some_and(|old| old != params)
            {
                return Err(denied());
            }
        }
        for params in actions.into_values() {
            self.handle_codex_app_server_rpc_locked(
                "plugin/install".into(),
                json!({"params":params}),
                &native_gate,
            )
            .await?;
        }
        drop(native_gate);
        drop(marketplace_gate);
        let current = self
            .connection_call("dependencyPlan", Some(provider), json!({}))
            .await?;
        let dependencies = current.as_array().ok_or_else(denied)?;
        for alias in aliases {
            if !dependencies
                .iter()
                .any(|item| item["alias"] == *alias && item["status"] == "ready")
            {
                return Err(AppIpcError::new(
                    "dependency_conflict",
                    "Connection dependency is not ready after installation",
                ));
            }
        }
        Ok(json!({"dependencies":current}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog() -> Value {
        json!({"marketplaces":[{"name":"company","path":"/native/marketplace.json","plugins":[{"id":"mail@company","name":"mail","version":"1.2.0","installed":false}]}]})
    }
    fn target() -> Value {
        json!({"marketplaceId":"company","pluginId":"mail@company","version":"1.2.0","name":"injected","marketplacePath":"/untrusted/marketplace.json"})
    }
    #[test]
    fn installation_uses_the_native_catalog_path_and_name() {
        assert_eq!(
            native_install_params(&catalog(), &target()).unwrap(),
            json!({"pluginName":"mail","marketplacePath":"/native/marketplace.json"})
        );
    }
    #[test]
    fn installation_rejects_catalog_changes_and_disabled_or_shared_plugins() {
        for (key, value) in [
            ("installed", json!(true)),
            ("availability", json!("DISABLED_BY_ADMIN")),
            ("version", json!("2.0.0")),
            ("id", json!("other@company")),
        ] {
            let mut catalog = catalog();
            catalog["marketplaces"][0]["plugins"][0][key] = value;
            assert!(native_install_params(&catalog, &target()).is_err());
        }
        let mut duplicate = catalog();
        let market = duplicate["marketplaces"][0].clone();
        duplicate["marketplaces"]
            .as_array_mut()
            .unwrap()
            .push(market);
        assert!(native_install_params(&duplicate, &target()).is_err());
    }
}
