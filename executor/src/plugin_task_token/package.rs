//! Keep task-authenticated MCPs out of native plugin loading. Their source
//! declarations are retained in the cache while native auto-loading is filtered.

use crate::{mcp_utils::extract_mcp_servers_config, protocol::ExecutionRequest};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Component, Path},
};

const DEFAULT_SOURCE: &str = ".wegent-default-mcp-source.json";

pub(super) fn declared(server: &Value) -> bool {
    server.get("command").is_none()
        && server
            .get("headers")
            .and_then(Value::as_object)
            .is_some_and(|headers| {
                headers
                    .values()
                    .filter_map(Value::as_str)
                    .any(|value| value.contains("${{task_token}}"))
            })
}

fn read(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|_| "Plugin MCP configuration is unavailable")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid plugin MCP configuration".into())
}

fn write(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "Invalid plugin MCP configuration")?;
    if fs::read(path).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap())
        .map_err(|_| "Cannot prepare plugin MCP configuration")?;
    file.write_all(&bytes)
        .map_err(|_| "Cannot write plugin MCP configuration")?;
    file.persist(path)
        .map_err(|_| "Cannot activate plugin MCP configuration")?;
    Ok(())
}

fn servers(root: &Path, declaration: &Value) -> Result<Map<String, Value>, String> {
    let document = if let Some(path) = declaration.as_str() {
        let path = Path::new(path);
        if path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
        {
            return Err("Plugin MCP configuration must stay inside the plugin".into());
        }
        let file = root
            .join(path)
            .canonicalize()
            .map_err(|_| "Plugin MCP configuration is unavailable")?;
        if !file.starts_with(root.canonicalize().map_err(|_| "Plugin is unavailable")?) {
            return Err("Plugin MCP path escapes the plugin".into());
        }
        if file == root.join(".mcp.json").canonicalize().unwrap_or_default()
            && root.join(DEFAULT_SOURCE).is_file()
        {
            read(&root.join(DEFAULT_SOURCE))?
        } else {
            read(&file)?
        }
    } else {
        declaration.clone()
    };
    extract_mcp_servers_config(&document)
        .or_else(|| document.get("mcpServers"))
        .unwrap_or(&document)
        .as_object()
        .cloned()
        .ok_or_else(|| "Invalid plugin MCP server map".into())
}

fn declarations(root: &Path, claude: bool) -> Result<Map<String, Value>, String> {
    let runtime = if claude { "claude" } else { "codex" };
    let path = root.join(format!(".{runtime}-plugin/plugin.json"));
    if !path.is_file() {
        return Ok(Map::new());
    }
    let source_path = root.join(format!(".wegent-task-mcp-source-{runtime}.json"));
    let native = format!("./.wegent-native-mcp-{runtime}.json");
    let manifest = read(&path)?;
    let source = if manifest["mcpServers"].as_str() == Some(&native) {
        read(&source_path)?
    } else {
        manifest.get("mcpServers").cloned().unwrap_or_else(|| {
            if root.join(".mcp.json").is_file() {
                json!("./.mcp.json")
            } else {
                json!({})
            }
        })
    };
    let mut all = if claude && root.join(".mcp.json").is_file() {
        servers(root, &json!("./.mcp.json"))?
    } else {
        Map::new()
    };
    all.extend(servers(root, &source)?);
    Ok(all)
}

pub(crate) fn requires_native_proxy(root: &Path, claude: bool) -> Result<bool, String> {
    Ok(declarations(root, claude)?.values().any(declared))
}

pub(crate) fn materialize(root: &Path, claude: bool) -> Result<BTreeMap<String, Value>, String> {
    let all = declarations(root, claude)?;
    let authenticated: BTreeMap<_, _> = all
        .iter()
        .filter(|(_, server)| declared(server))
        .map(|(name, server)| (name.clone(), server.clone()))
        .collect();
    if authenticated.is_empty() {
        return Ok(authenticated);
    }
    let runtime = if claude { "claude" } else { "codex" };
    let path = root.join(format!(".{runtime}-plugin/plugin.json"));
    let source_path = root.join(format!(".wegent-task-mcp-source-{runtime}.json"));
    let native = format!("./.wegent-native-mcp-{runtime}.json");
    let mut manifest = read(&path)?;
    if root.is_symlink() || path.is_symlink() || path.parent().is_some_and(Path::is_symlink) {
        return Err("TaskToken plugins require a copied native cache, not a source link".into());
    }
    write(&source_path, &json!({"mcpServers": all}))?;
    if claude && root.join(".mcp.json").is_file() {
        if root.join(".mcp.json").is_symlink() {
            return Err("TaskToken MCP configuration must be copied into the native cache".into());
        }
        let default = servers(root, &json!("./.mcp.json"))?;
        write(&root.join(DEFAULT_SOURCE), &json!({"mcpServers": default}))?;
        let filtered: Map<_, _> = default
            .into_iter()
            .filter(|(_, server)| !declared(server))
            .collect();
        // Claude always loads .mcp.json in addition to manifest declarations.
        write(&root.join(".mcp.json"), &json!({"mcpServers": filtered}))?;
    }
    let native_servers: Map<_, _> = all
        .into_iter()
        .filter(|(_, server)| !declared(server))
        .collect();
    write(&root.join(&native), &json!({"mcpServers": native_servers}))?;
    manifest["mcpServers"] = json!(native);
    write(&path, &manifest)?;
    Ok(authenticated)
}

pub(super) fn load(
    home: &Path,
    claude: bool,
    request: &ExecutionRequest,
) -> Result<BTreeMap<String, Value>, String> {
    let mut enabled = BTreeMap::<String, bool>::new();
    let config = if claude {
        toml_edit::DocumentMut::new()
    } else {
        fs::read_to_string(home.join("config.toml"))
            .unwrap_or_default()
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "Invalid Codex plugin configuration")?
    };
    if claude {
        if home.join("settings.json").is_file() {
            if let Some(entries) = read(&home.join("settings.json"))?["enabledPlugins"].as_object()
            {
                enabled.extend(
                    entries
                        .iter()
                        .map(|(key, value)| (key.clone(), value == true)),
                );
            }
        }
    } else if let Some(plugins) = config
        .get("plugins")
        .and_then(toml_edit::Item::as_table_like)
    {
        for (key, item) in plugins.iter() {
            enabled.insert(
                key.into(),
                item.get("enabled").and_then(toml_edit::Item::as_bool) == Some(true),
            );
        }
    }
    for key in request
        .extra
        .get("project_plugin_ids")
        .or_else(|| request.extra.get("projectPluginIds"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        enabled.insert(key.into(), true);
    }
    let installed_path = home.join("plugins/installed_plugins.json");
    let installed = if installed_path.is_file() {
        read(&installed_path)?
    } else {
        json!({})
    };
    let capability_path = super::executor_home().join("capabilities/manifest.json");
    let capabilities = if capability_path.is_file() {
        read(&capability_path)?
    } else {
        json!({})
    };
    let mut result = BTreeMap::new();
    for (key, _) in enabled.into_iter().filter(|(_, enabled)| *enabled) {
        let Some((name, market)) = key.rsplit_once('@') else {
            continue;
        };
        if [name, market].iter().any(|part| {
            part.is_empty()
                || !part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_ .".contains(c))
                || part.contains("..")
        }) {
            return Err("Invalid plugin identity".into());
        }
        let record = &capabilities["plugins"][&key];
        let cached = installed["plugins"][&key]
            .as_array()
            .and_then(|entries| entries.first())
            .and_then(|entry| entry["installPath"].as_str())
            .map(std::path::PathBuf::from);
        let managed = record["runtime"][if claude { "claude_link" } else { "codex_link" }]
            .as_str()
            .map(std::path::PathBuf::from);
        let path = if let Some(path) = cached.or(managed).filter(|path| path.is_dir()) {
            path
        } else {
            let Some(source) = config
                .get("marketplaces")
                .and_then(|item| item.get(market))
                .and_then(|item| item.get("source"))
                .and_then(toml_edit::Item::as_str)
            else {
                continue;
            };
            let root = Path::new(source);
            let catalog = read(&root.join(".agents/plugins/marketplace.json"))?;
            let Some(relative) = catalog["plugins"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|entry| entry["name"] == name)
                .and_then(|entry| entry["source"].as_str())
            else {
                continue;
            };
            let source_root = root.join(relative);
            let manifest = read(&source_root.join(".codex-plugin/plugin.json"))?;
            let Some(version) = manifest["version"].as_str() else {
                continue;
            };
            let path = home
                .join("plugins/cache")
                .join(market)
                .join(name)
                .join(version);
            if !path.is_dir() {
                continue;
            }
            path
        };
        for (server_name, server) in materialize(&path, claude)? {
            if record["component_states"][format!("mcp:{server_name}")] == false {
                continue;
            }
            let qualified = format!(
                "plugin_{}_{}",
                key.replace(['@', '.', '-'], "_"),
                server_name
            );
            if result.insert(qualified, server).is_some() {
                return Err("Plugin MCP identity collision".into());
            }
        }
    }
    Ok(result)
}
