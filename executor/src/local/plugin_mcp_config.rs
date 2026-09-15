//! Device-owned MCP overrides. Package declarations remain immutable.

use std::{fs, io::Write, path::Path};

use fs2::FileExt;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::plugin_task_token::package::{apply_component_config, declarations};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpConfigRequest {
    pub marketplace_name: String,
    pub plugin_name: String,
    pub marketplace_path: Option<String>,
    pub component_config: Option<Map<String, Value>>,
}

fn file_name(market: &str, name: &str) -> Result<String, String> {
    if [market, name]
        .iter()
        .any(|value| value.trim().is_empty() || value.contains('@'))
    {
        return Err("Invalid plugin identity".into());
    }
    Ok(format!(
        "{:x}.json",
        Sha256::digest(format!("{name}@{market}"))
    ))
}

pub(crate) fn read_config(
    home: &Path,
    market: &str,
    name: &str,
) -> Result<Map<String, Value>, String> {
    let path = home
        .join("capabilities/plugin-state/mcp-headers")
        .join(file_name(market, name)?);
    match fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).map_err(|_| "Invalid plugin MCP settings".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(_) => Err("Cannot read plugin MCP settings".into()),
    }
}

pub fn configure(request: PluginMcpConfigRequest) -> Result<Map<String, Value>, String> {
    configure_at(&super::plugin_catalog::executor_home_path()?, request)
}

fn configure_at(
    home: &Path,
    request: PluginMcpConfigRequest,
) -> Result<Map<String, Value>, String> {
    let Some(patch) = request.component_config else {
        return read_config(home, &request.marketplace_name, &request.plugin_name);
    };
    let root = super::plugin_catalog::local_plugin_root(
        Path::new(
            request
                .marketplace_path
                .as_deref()
                .ok_or("Plugin marketplace is unavailable")?,
        ),
        &request.plugin_name,
    )?;
    let servers = declarations(&root, false)?;
    for (key, value) in &patch {
        let server = key
            .strip_prefix("mcp:")
            .and_then(|name| servers.get(name))
            .ok_or("Unknown plugin MCP component")?;
        if !value.is_null() {
            let object = value.as_object().ok_or("Invalid plugin MCP settings")?;
            if object.len() != 1 || !object.get("headers").is_some_and(Value::is_object) {
                return Err("Invalid plugin MCP settings".into());
            }
            apply_component_config(&key[4..], server.clone(), &patch)?;
        }
    }
    persist_config(home, &request.marketplace_name, &request.plugin_name, patch)
}

fn persist_config(
    home: &Path,
    market: &str,
    plugin: &str,
    patch: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let directory = home.join("capabilities/plugin-state/mcp-headers");
    fs::create_dir_all(&directory).map_err(|_| "Cannot prepare plugin MCP settings")?;
    let name = file_name(market, plugin)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(directory.join(format!("{name}.lock")))
        .map_err(|_| "Cannot lock plugin MCP settings")?;
    lock.lock_exclusive()
        .map_err(|_| "Cannot lock plugin MCP settings")?;
    let mut config = read_config(home, market, plugin)?;
    for (key, value) in patch {
        if value.is_null() {
            config.remove(&key);
        } else {
            config.insert(key, value);
        }
    }
    let mut file = tempfile::NamedTempFile::new_in(&directory)
        .map_err(|_| "Cannot prepare plugin MCP settings")?;
    file.write_all(&serde_json::to_vec(&config).map_err(|_| "Invalid plugin MCP settings")?)
        .map_err(|_| "Cannot write plugin MCP settings")?;
    file.persist(directory.join(name))
        .map_err(|_| "Cannot save plugin MCP settings")?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persists_validated_overrides_without_changing_package_or_other_marketplaces() {
        let temp = tempfile::tempdir().unwrap();
        let market = temp.path().join("market");
        let root = market.join("plugins/example");
        fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example"}"#,
        )
        .unwrap();
        let source = json!({"business": {"url":"https://example.test/mcp", "headers":{"X-Author":"default"}},
            "local": {"command":"server"}}).to_string();
        fs::write(root.join(".mcp.json"), &source).unwrap();
        let request = |patch: Value| PluginMcpConfigRequest {
            marketplace_name: "market".into(),
            plugin_name: "example".into(),
            marketplace_path: Some(market.to_string_lossy().into_owned()),
            component_config: Some(patch.as_object().unwrap().clone()),
        };
        let patch = json!({"mcp:business":{"headers":{"Authorization":"Bearer ${{task_token}}"}}});
        let saved = configure_at(temp.path(), request(patch.clone())).unwrap();
        assert_eq!(Value::Object(saved.clone()), patch);
        let native = temp.path().join("codex");
        let cache = native.join("plugins/cache/market/example/1.0.0");
        fs::create_dir_all(cache.join(".codex-plugin")).unwrap();
        fs::copy(
            root.join(".codex-plugin/plugin.json"),
            cache.join(".codex-plugin/plugin.json"),
        )
        .unwrap();
        fs::copy(root.join(".mcp.json"), cache.join(".mcp.json")).unwrap();
        fs::write(
            native.join("config.toml"),
            "[plugins.\"example@market\"]\nenabled = true\n",
        )
        .unwrap();
        fs::write(
            native.join("plugins/installed_plugins.json"),
            json!({"plugins": {
                "example@market": [{"installPath": cache}]
            }})
            .to_string(),
        )
        .unwrap();
        let configured = crate::plugin_task_token::package::load_from_executor_home(
            &native,
            false,
            &crate::protocol::ExecutionRequest::default(),
            temp.path(),
        )
        .unwrap();
        assert_eq!(
            configured["plugin_example_market_business"]["headers"]["Authorization"],
            "Bearer ${{task_token}}"
        );
        assert_eq!(
            read_config(temp.path(), "market", "example").unwrap(),
            saved
        );
        assert!(read_config(temp.path(), "another-market", "example")
            .unwrap()
            .is_empty());
        for invalid in [
            json!({"mcp:local":{"headers":{"X-Test":"value"}}}),
            json!({"mcp:missing":null}),
            json!({"mcp:business":{"headers":{"Bad Header":"value"}}}),
            json!({"mcp:business":{"headers":{"X-Test":"bad\nvalue"}}}),
        ] {
            assert!(configure_at(temp.path(), request(invalid)).is_err());
            assert_eq!(
                read_config(temp.path(), "market", "example").unwrap(),
                saved
            );
        }
        assert!(
            configure_at(temp.path(), request(json!({"mcp:business":null})))
                .unwrap()
                .is_empty()
        );
        assert_eq!(fs::read_to_string(root.join(".mcp.json")).unwrap(), source);
        assert!(crate::plugin_task_token::package::load_from_executor_home(
            &native,
            false,
            &crate::protocol::ExecutionRequest::default(),
            temp.path(),
        )
        .unwrap()
        .is_empty());
    }
}
