// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Project plugin-owned Python stdio commands into the desktop runtime copy.

use super::*;

impl GlobalCapabilityStore {
    pub(super) fn prepare_runtime_copy(&self, root: &Path) -> Result<(), CapabilitySyncError> {
        ensure_dual_plugin_manifests(root)?;
        ensure_plugin_hook_permissions(root)?;
        for (path, config) in self.managed_python_configs(root, root) {
            write_json(&root.join(path), &config)?;
        }
        Ok(())
    }

    pub(super) fn managed_python_configs(
        &self,
        root: &Path,
        manifests: &Path,
    ) -> BTreeMap<PathBuf, Value> {
        self.managed_mcp_python
            .as_deref()
            .map(|python| projected_configs(root, manifests, python))
            .unwrap_or_default()
    }

    pub(super) fn managed_python_configs_current(&self, source: &Path, runtime: &Path) -> bool {
        self.managed_python_configs(source, source)
            .into_iter()
            .all(|(path, expected)| {
                let Some(actual) = read_json(runtime, &path) else {
                    return false;
                };
                if PLUGIN_MANIFEST_PATHS
                    .iter()
                    .any(|manifest| path == Path::new(manifest))
                {
                    actual.get("mcpServers") == expected.get("mcpServers")
                } else {
                    actual == expected
                }
            })
    }
}

fn projected_configs(root: &Path, manifests: &Path, python: &Path) -> BTreeMap<PathBuf, Value> {
    let mut configs = BTreeMap::new();
    let mut default_config = [".mcp.json", "mcp.json"]
        .into_iter()
        .find(|path| root.join(path).is_file());
    for path in PLUGIN_MANIFEST_PATHS {
        let Some(mut manifest) = read_json(manifests, Path::new(path)) else {
            continue;
        };
        match manifest.get_mut("mcpServers") {
            Some(Value::String(path)) => project_file(root, Path::new(path), python, &mut configs),
            Some(servers @ Value::Object(_)) => {
                if update_config(servers, root, python) {
                    configs.insert(PathBuf::from(path), manifest);
                }
            }
            _ => {
                if let Some(path) = default_config.take() {
                    project_file(root, Path::new(path), python, &mut configs);
                }
            }
        }
    }
    configs
}

fn project_file(root: &Path, path: &Path, python: &Path, configs: &mut BTreeMap<PathBuf, Value>) {
    let path = path
        .components()
        .filter(|component| !matches!(component, std::path::Component::CurDir))
        .collect::<PathBuf>();
    if let Some(mut config) = read_json(root, &path) {
        if update_config(&mut config, root, python) {
            configs.insert(path, config);
        }
    }
}

fn read_json(root: &Path, relative: &Path) -> Option<Value> {
    let path = package_file(root, relative)?;
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn package_file(root: &Path, relative: &Path) -> Option<PathBuf> {
    let mut path = root.to_owned();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::Normal(name) => path.push(name),
            _ => return None,
        }
        if fs::symlink_metadata(&path).ok()?.file_type().is_symlink() {
            return None;
        }
    }
    path.is_file().then_some(path)
}

fn update_config(config: &mut Value, root: &Path, python: &Path) -> bool {
    let wrapper = ["mcpServers", "mcp_servers"]
        .into_iter()
        .find(|key| config.get(key).is_some_and(Value::is_object));
    let servers = if let Some(key) = wrapper {
        config[key].as_object_mut()
    } else {
        config.as_object_mut()
    };
    let mut changed = false;
    if let Some(servers) = servers {
        for server in servers.values_mut() {
            if is_plugin_python_stdio(server, root) {
                let args = server["args"].as_array_mut().expect("validated MCP args");
                // The plugin launcher joins host preparation before opening MCP stdio.
                args.splice(0..0, [json!("plugin-python"), json!("--mcp")]);
                server["command"] = json!(python);
                // Native MCP children receive these host capabilities by name.
                // The launcher removes them before starting plugin code.
                let environment = server
                    .as_object_mut()
                    .unwrap()
                    .entry("env_vars")
                    .or_insert_with(|| json!([]));
                if let Some(environment) = environment.as_array_mut() {
                    environment.extend([
                        json!("WEWORK_PYTHON_RUNTIME_URL"),
                        json!("WEWORK_PYTHON_RUNTIME_TOKEN"),
                        json!("WEGENT_PYTHON_PATH"),
                    ]);
                }
                // Scope the download budget to this managed connector, including
                // configurations that express the native timeout in milliseconds.
                let timeout = server["startup_timeout_sec"]
                    .as_f64()
                    .or_else(|| server["startup_timeout_ms"].as_f64().map(|ms| ms / 1000.0))
                    .unwrap_or_default()
                    .max(16.0 * 60.0 + 10.0);
                server.as_object_mut().unwrap().remove("startup_timeout_ms");
                server["startup_timeout_sec"] = json!(timeout);
                changed = true;
            }
        }
    }
    changed
}

fn is_plugin_python_stdio(server: &Value, root: &Path) -> bool {
    if !matches!(
        server["command"].as_str(),
        Some("python" | "python3" | "python.exe" | "python3.exe")
    ) || !matches!(server["type"].as_str(), None | Some("stdio"))
        || server.get("url").is_some()
        || has_explicit_python_environment(server)
    {
        return false;
    }
    let Some(args) = server["args"]
        .as_array()
        .filter(|args| args.iter().all(Value::is_string))
    else {
        return false;
    };
    let Some(script) = args.first().and_then(Value::as_str).map(Path::new) else {
        return false;
    };
    // With no cwd, Codex can resolve a relative argument in the task workspace.
    let Some(cwd) = server["cwd"].as_str().map(Path::new) else {
        return false;
    };
    script
        .extension()
        .is_some_and(|extension| extension == "py")
        && !script.is_absolute()
        && package_file(root, &cwd.join(script)).is_some()
}

fn has_explicit_python_environment(server: &Value) -> bool {
    // PATH can select a plugin's own interpreter even for an unqualified command.
    let python_key = |name: &str| {
        name.eq_ignore_ascii_case("PATH") || name.to_ascii_uppercase().starts_with("PYTHON")
    };
    server["env"]
        .as_object()
        .is_some_and(|env| env.keys().any(|name| python_key(name)))
        || server["env_vars"].as_array().is_some_and(|env| {
            env.iter().any(|entry| {
                entry
                    .as_str()
                    .or_else(|| entry["name"].as_str())
                    .is_some_and(python_key)
            })
        })
}
