// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Project plugin-owned Python stdio commands into the desktop runtime copy.

use super::*;

impl GlobalCapabilityStore {
    pub(super) fn prepare_runtime_copy(&self, root: &Path) -> Result<(), CapabilitySyncError> {
        ensure_dual_plugin_manifests(root)?;
        ensure_plugin_hook_permissions(root)?;
        for (path, config) in self.managed_python_configs(root, root)? {
            write_json(&root.join(path), &config)?;
        }
        Ok(())
    }

    pub(super) fn managed_python_configs(
        &self,
        root: &Path,
        manifests: &Path,
    ) -> Result<BTreeMap<PathBuf, Value>, CapabilitySyncError> {
        let Some(python) = self.managed_mcp_python.as_deref() else {
            return Ok(BTreeMap::new());
        };
        projected_configs(root, manifests, python, false)
    }

    pub(super) fn managed_python_configs_current(
        &self,
        source: &Path,
        runtime: &Path,
        was_projected: bool,
    ) -> Result<bool, CapabilitySyncError> {
        let Some(python) = self.managed_mcp_python.as_deref() else {
            return Ok(true);
        };
        if was_projected {
            validate_default_mcp_sources(source, runtime)?;
        }
        let configs = projected_configs(source, source, python, was_projected)?;
        // A recorded Python MCP cannot be proved current from an empty projection.
        if was_projected && configs.is_empty() {
            return Err(CapabilitySyncError::invalid_payload(
                "Plugin Python MCP sources are unavailable; preserving the cached runtime",
            ));
        }
        Ok(configs.into_iter().all(|(path, expected)| {
            let Ok(Some(actual)) = read_json(runtime, &path, false) else {
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
        }))
    }
}

fn validate_default_mcp_sources(source: &Path, runtime: &Path) -> Result<(), CapabilitySyncError> {
    for path in [".mcp.json", "mcp.json"].map(Path::new) {
        if package_file(source, path, false)?.is_some() {
            continue;
        }
        if read_json(runtime, path, false)
            .ok()
            .flatten()
            .as_ref()
            .is_some_and(contains_projected_mcp)
        {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Plugin Python MCP source {} is unavailable; preserving the cached runtime",
                path.display()
            )));
        }
    }
    Ok(())
}

fn contains_projected_mcp(config: &Value) -> bool {
    (config["args"][0] == "plugin-python" && config["args"][1] == "--mcp")
        || config
            .as_object()
            .is_some_and(|object| object.values().any(contains_projected_mcp))
}

fn projected_configs(
    root: &Path,
    manifests: &Path,
    python: &Path,
    require_source_files: bool,
) -> Result<BTreeMap<PathBuf, Value>, CapabilitySyncError> {
    let mut configs = BTreeMap::new();
    let codex = read_json(manifests, Path::new(CODEX_PLUGIN_MANIFEST_PATH), false)?;
    let claude = read_json(manifests, Path::new(CLAUDE_PLUGIN_MANIFEST_PATH), false)?;
    let normalized = normalized_plugin_manifests(codex.as_ref(), claude.as_ref())?;
    let mut default_config = [".mcp.json", "mcp.json"]
        .into_iter()
        .find(|path| root.join(path).is_file());
    for (path, mut manifest) in PLUGIN_MANIFEST_PATHS.into_iter().zip(normalized) {
        match manifest.get_mut("mcpServers") {
            Some(Value::String(path)) => project_file(
                root,
                Path::new(path),
                python,
                &mut configs,
                require_source_files,
            )?,
            Some(servers @ Value::Object(_)) => {
                if update_config(servers, root, python, require_source_files)? {
                    configs.insert(PathBuf::from(path), manifest);
                }
            }
            _ => {
                if let Some(path) = default_config.take() {
                    project_file(
                        root,
                        Path::new(path),
                        python,
                        &mut configs,
                        require_source_files,
                    )?;
                }
            }
        }
    }
    Ok(configs)
}

fn project_file(
    root: &Path,
    path: &Path,
    python: &Path,
    configs: &mut BTreeMap<PathBuf, Value>,
    require_source_files: bool,
) -> Result<(), CapabilitySyncError> {
    let path = path
        .components()
        .filter(|component| !matches!(component, std::path::Component::CurDir))
        .collect::<PathBuf>();
    if let Some(mut config) = read_json(root, &path, require_source_files)? {
        // A bare server may share a wrapper's name; its command or URL identifies it.
        let is_server = |value: &Value| value["command"].is_string() || value["url"].is_string();
        let wrapper = ["mcpServers", "mcp_servers"].into_iter().find(|key| {
            config
                .get(key)
                .is_some_and(|value| value.is_object() && !is_server(value))
        });
        let changed = if let Some(key) = wrapper {
            update_config(&mut config[key], root, python, require_source_files)?
        } else {
            update_config(&mut config, root, python, require_source_files)?
        };
        if changed {
            configs.insert(path, config);
        }
    }
    Ok(())
}

fn read_json(
    root: &Path,
    relative: &Path,
    required: bool,
) -> Result<Option<Value>, CapabilitySyncError> {
    let Some(path) = package_file(root, relative, required)? else {
        return Ok(None);
    };
    Ok(Some(serde_json::from_slice(&fs::read(path)?)?))
}

fn package_file(
    root: &Path,
    relative: &Path,
    required: bool,
) -> Result<Option<PathBuf>, CapabilitySyncError> {
    if relative.components().any(|component| {
        !matches!(
            component,
            std::path::Component::CurDir | std::path::Component::Normal(_)
        )
    }) {
        return Ok(None);
    }
    let mut path = root.to_owned();
    for component in relative.components() {
        match component {
            std::path::Component::CurDir => continue,
            std::path::Component::Normal(name) => path.push(name),
            _ => return Ok(None),
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if required => {
                return Err(CapabilitySyncError::invalid_payload(format!(
                    "Plugin Python MCP source {} is unavailable: {error}",
                    relative.display()
                )))
            }
            Err(_) => return Ok(None),
        };
        if metadata.file_type().is_symlink() {
            return Ok(None);
        }
    }
    if path.is_file() {
        Ok(Some(path))
    } else if required {
        Err(CapabilitySyncError::invalid_payload(format!(
            "Plugin Python MCP source {} is not a regular file",
            relative.display()
        )))
    } else {
        Ok(None)
    }
}

fn update_config(
    config: &mut Value,
    root: &Path,
    python: &Path,
    require_source_files: bool,
) -> Result<bool, CapabilitySyncError> {
    let mut changed = false;
    if let Some(servers) = config.as_object_mut() {
        for server in servers.values_mut() {
            if is_plugin_python_stdio(server, root, require_source_files)? {
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
    Ok(changed)
}

fn is_plugin_python_stdio(
    server: &Value,
    root: &Path,
    require_source_files: bool,
) -> Result<bool, CapabilitySyncError> {
    if !matches!(
        server["command"].as_str(),
        Some("python" | "python3" | "python.exe" | "python3.exe")
    ) || !matches!(server["type"].as_str(), None | Some("stdio"))
        || server.get("url").is_some()
        || has_explicit_python_environment(server)
    {
        return Ok(false);
    }
    let Some(args) = server["args"]
        .as_array()
        .filter(|args| args.iter().all(Value::is_string))
    else {
        return Ok(false);
    };
    let Some(script) = args.first().and_then(Value::as_str).map(Path::new) else {
        return Ok(false);
    };
    // With no cwd, Codex can resolve a relative argument in the task workspace.
    let Some(cwd) = server["cwd"].as_str().map(Path::new) else {
        return Ok(false);
    };
    if !script
        .extension()
        .is_some_and(|extension| extension == "py")
        || script.is_absolute()
    {
        return Ok(false);
    }
    Ok(package_file(root, &cwd.join(script), require_source_files)?.is_some())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_mcp_wrappers_preserve_services_named_after_wrappers() {
        for wrapper in [None, Some("mcpServers"), Some("mcp_servers")] {
            let root = tempfile::tempdir().unwrap();
            fs::create_dir(root.path().join(".codex-plugin")).unwrap();
            write_json(
                &root.path().join(CODEX_PLUGIN_MANIFEST_PATH),
                &json!({
                    "name":"demo", "mcpServers":"./.mcp.json"
                }),
            )
            .unwrap();
            fs::write(root.path().join("server.py"), "pass\n").unwrap();
            let service = json!({"command":"python3", "cwd":"./", "args":["server.py"]});
            let servers = json!({"service":service, "mcpServers":service, "mcp_servers":service});
            let config = wrapper.map_or_else(|| servers.clone(), |key| json!({key:servers}));
            write_json(&root.path().join(".mcp.json"), &config).unwrap();
            let launcher = root.path().join("executor-bin");
            let projected = projected_configs(root.path(), root.path(), &launcher, false).unwrap();
            let mut result = projected[Path::new(".mcp.json")].clone();
            if let Some(key) = wrapper {
                result = result[key].clone();
            }
            for name in ["service", "mcpServers", "mcp_servers"] {
                assert_eq!(
                    result[name]["command"],
                    json!(launcher),
                    "{wrapper:?}: {name}"
                );
                assert_eq!(
                    result[name]["args"],
                    json!(["plugin-python", "--mcp", "server.py"])
                );
            }
        }
    }
}
