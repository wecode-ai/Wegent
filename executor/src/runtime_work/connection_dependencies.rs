use crate::local::app_ipc::AppIpcError;
use serde_json::Value;
fn failure(code: &str, message: impl Into<String>) -> AppIpcError {
    AppIpcError::new(code, message)
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
