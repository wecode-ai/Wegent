use crate::local::app_ipc::AppIpcError;
use serde_json::Value;
fn failure(code: &str, message: impl Into<String>) -> AppIpcError {
    AppIpcError::new(code, message)
}

pub(super) fn installed_plugin_by_key(
    installed: &Value,
    plugin_key: &str,
) -> Result<(Value, Value), AppIpcError> {
    let invalid = || {
        failure(
            "dependency_unavailable",
            "The exact installed plugin is unavailable",
        )
    };
    let mut sources = Vec::new();
    for market in installed["marketplaces"].as_array().ok_or_else(invalid)? {
        for plugin in market["plugins"].as_array().into_iter().flatten() {
            if plugin["name"].as_str() != Some(plugin_key) {
                continue;
            }
            let marketplace = market["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            let id = plugin["id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            sources.push(serde_json::json!({"marketplaceId":marketplace,"pluginId":id}));
        }
    }
    if sources.len() != 1 {
        return Err(invalid());
    }
    let source = sources.pop().unwrap();
    let plugin = installed_plugin(installed, &source)?;
    Ok((plugin, source))
}

pub(super) fn installed_dependency(
    installed: &Value,
    payload: &Value,
) -> Result<Value, AppIpcError> {
    let plugin = installed_plugin(installed, &payload["source"])?;
    let version = plugin
        .get("localVersion")
        .filter(|v| !v.is_null())
        .or_else(|| plugin.get("version"))
        .unwrap_or(&Value::Null);
    if version != &payload["expectedVersion"]
        || !plugin["name"].as_str().is_some_and(|name| !name.is_empty())
    {
        return Err(failure(
            "dependency_unavailable",
            "The resolved Codex plugin version is no longer available",
        ));
    }
    Ok(plugin)
}

pub(super) fn installed_plugin(installed: &Value, source: &Value) -> Result<Value, AppIpcError> {
    let invalid = || {
        failure(
            "dependency_unavailable",
            "The exact Codex plugin dependency is not ready",
        )
    };
    if installed["marketplaceLoadErrors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
    {
        return Err(invalid());
    }
    let matches: Vec<Value> = installed["marketplaces"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .filter(|market| market["name"] == source["marketplaceId"])
        .flat_map(|market| {
            market["plugins"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |plugin| {
                    let mut plugin = plugin.clone();
                    plugin["marketplacePath"] = market["path"].clone();
                    plugin
                })
        })
        .filter(|plugin| plugin["id"] == source["pluginId"])
        .collect();
    if matches.len() != 1 {
        return Err(invalid());
    }
    let plugin = &matches[0];
    if plugin["installed"] != true || plugin["enabled"] != true {
        return Err(invalid());
    }
    Ok(plugin.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inventory() -> Value {
        json!({"marketplaceLoadErrors":[],"marketplaces":[{"name":"fixture","path":"/market",
            "plugins":[{"id":"plugin@fixture","name":"plugin","installed":true,"enabled":true,
                "localVersion":"1.0.0"}]}]})
    }

    #[test]
    fn plugin_key_resolves_one_exact_enabled_installation() {
        let installed = inventory();
        let (plugin, source) = installed_plugin_by_key(&installed, "plugin").unwrap();
        assert_eq!(
            source,
            json!({"marketplaceId":"fixture","pluginId":"plugin@fixture"})
        );
        assert_eq!(plugin["localVersion"], "1.0.0");
        assert_eq!(plugin["marketplacePath"], "/market");
        for field in ["installed", "enabled"] {
            let mut unavailable = inventory();
            unavailable["marketplaces"][0]["plugins"][0][field] = json!(false);
            assert!(installed_plugin_by_key(&unavailable, "plugin").is_err());
        }
        let mut failed = inventory();
        failed["marketplaceLoadErrors"] = json!([{"message":"unavailable"}]);
        assert!(installed_plugin_by_key(&failed, "plugin").is_err());
        assert!(installed_plugin_by_key(&installed, "foreign").is_err());
    }

    #[test]
    fn duplicate_plugin_names_cannot_choose_an_enabled_installation() {
        let mut installed = inventory();
        let mut duplicate = installed["marketplaces"][0].clone();
        duplicate["name"] = json!("another-market");
        duplicate["plugins"][0]["id"] = json!("plugin@another-market");
        duplicate["plugins"][0]["enabled"] = json!(false);
        installed["marketplaces"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(installed_plugin_by_key(&installed, "plugin").is_err());
    }
}
