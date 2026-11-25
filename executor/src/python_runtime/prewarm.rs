// SPDX-License-Identifier: Apache-2.0

use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

/// Wait for demand changes during login preparation; actual failures still end the attempt.
pub(crate) fn start() -> Option<tokio::task::JoinHandle<()>> {
    if !super::managed_python_bridge_configured() {
        return None;
    }
    Some(tokio::spawn(async {
        loop {
            let demanded = has_demand().await.unwrap_or(false);
            if demanded {
                match super::prewarm_managed_python().await {
                    Ok(true) => return,
                    Ok(false) => {}
                    Err(error) => {
                        crate::logging::log_executor_event(
                            "plugin Python prewarm failed",
                            &[("error", error)],
                        );
                        return;
                    }
                }
            }
            crate::services::capability_activation::changed().await;
        }
    }))
}

pub(crate) async fn has_demand() -> Result<bool, String> {
    let _activation = crate::services::capability_activation::begin_execution().await;
    tokio::task::spawn_blocking(installed_plugins_need_python)
        .await
        .map_err(|_| "Plugin Python demand could not be inspected".to_owned())
}

fn installed_plugins_need_python() -> bool {
    let manifest = crate::local::capabilities::default_manifest_path();
    let Ok(shared) = crate::services::workbench::workbench_root() else {
        return false;
    };
    managed_plugins_need_python(&manifest, &shared.join("shared/plugins"))
        || native_roots(&crate::agents::wework_codex_home())
            .into_iter()
            .any(|root| package_needs_python(&root))
}

fn managed_plugins_need_python(manifest: &Path, shared: &Path) -> bool {
    let Some(parent) = manifest.parent() else {
        return false;
    };
    let Some(value) = read_json(manifest) else {
        return false;
    };
    value["plugins"]
        .as_object()
        .into_iter()
        .flat_map(|plugins| plugins.values())
        .filter(|plugin| plugin["enabled"] != false)
        .any(|plugin| {
            // Publication records this path only for a projected Python MCP.
            let projected_mcp = plugin["managed"] == true
                && plugin["runtime"]["managed_mcp_python"]
                    .as_str()
                    .is_some_and(|path| Path::new(path).is_absolute());
            projected_mcp
                || crate::local::plugin_catalog::managed_plugin_root(parent, shared, plugin)
                    .is_ok_and(|root| package_needs_python(&root))
        })
}

fn native_roots(home: &Path) -> HashSet<PathBuf> {
    let content = fs::read_to_string(home.join("config.toml")).unwrap_or_default();
    let Ok(config) = content.parse::<toml_edit::DocumentMut>() else {
        return HashSet::new();
    };
    let Some(plugins) = config
        .get("plugins")
        .and_then(|value| value.as_table_like())
    else {
        return HashSet::new();
    };
    let mut roots = HashSet::new();
    for (key, entry) in plugins.iter() {
        if entry.get("enabled").and_then(|value| value.as_bool()) != Some(true) {
            continue;
        }
        let Some((name, marketplace)) = key.rsplit_once('@') else {
            continue;
        };
        if ![name, marketplace].iter().all(|part| {
            !part.is_empty()
                && Path::new(part).components().count() == 1
                && !part.contains(['/', '\\'])
                && *part != "."
                && *part != ".."
        }) {
            continue;
        }
        let Ok(versions) = fs::read_dir(home.join("plugins/cache").join(marketplace).join(name))
        else {
            continue;
        };
        // Native caches are populated by plugin activation; inspect package roots only.
        roots.extend(
            versions
                .flatten()
                .filter_map(|entry| entry.path().canonicalize().ok())
                .filter(|root| root.is_dir()),
        );
    }
    roots
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn package_needs_python(root: &Path) -> bool {
    let Some(manifest) = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
        .iter()
        .find_map(|marker| read_json(&root.join(marker)))
    else {
        return false;
    };
    if manifest["runtimeRequirements"]["python"].is_object() {
        return true;
    }
    if manifest["connectors"].as_array().is_some_and(|connectors| {
        connectors.iter().any(|connector| {
            connector["accountAuth"]["adapter"]
                .as_str()
                .is_some_and(super::is_python_program)
                || ["health", "start", "poll", "logout"].iter().any(|action| {
                    connector["localAuth"][action][0]
                        .as_str()
                        .is_some_and(super::is_python_program)
                })
        })
    }) {
        return true;
    }
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut inspected = 0;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 8 {
            continue;
        }
        let Ok(entries) = fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            inspected += 1;
            if inspected > 4096 {
                return false;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("py"))
            {
                return true;
            }
            if kind.is_dir()
                && !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | ".venv" | "node_modules" | "__pycache__")
                )
            {
                pending.push((path, depth + 1));
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_scripts_and_declared_commands_without_executing_package_code() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".codex-plugin")).unwrap();
        let marker = root.path().join(".codex-plugin/plugin.json");
        fs::write(&marker, r#"{"name":"native"}"#).unwrap();
        assert!(!package_needs_python(root.path()));
        fs::write(
            root.path().join("script.py"),
            "raise RuntimeError('must not execute')",
        )
        .unwrap();
        assert!(package_needs_python(root.path()));
        fs::remove_file(root.path().join("script.py")).unwrap();
        fs::write(
            marker,
            r#"{"name":"python","connectors":[{"localAuth":{"start":["python3","-c","pass"]}}]}"#,
        )
        .unwrap();
        assert!(package_needs_python(root.path()));
    }

    #[test]
    fn native_inventory_only_includes_enabled_plugin_packages() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("plugins/cache/test/python/1.0");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            home.path().join("config.toml"),
            "[plugins.'python@test']\nenabled = false\n",
        )
        .unwrap();
        assert!(native_roots(home.path()).is_empty());
        fs::write(
            home.path().join("config.toml"),
            "[plugins.'python@test']\nenabled = true\n",
        )
        .unwrap();
        assert!(native_roots(home.path()).contains(&root.canonicalize().unwrap()));
    }

    #[test]
    fn managed_inventory_rechecks_disabled_and_removed_demand() {
        let home = tempfile::tempdir().unwrap();
        let capabilities = home.path().join("capabilities");
        let package = capabilities.join("store/plugins/python");
        fs::create_dir_all(package.join(".codex-plugin")).unwrap();
        fs::write(
            package.join(".codex-plugin/plugin.json"),
            r#"{"name":"python","runtimeRequirements":{"python":{}}}"#,
        )
        .unwrap();
        let manifest = capabilities.join("manifest-v2.json");
        let shared = home.path().join("shared/plugins");
        for (plugins, expected) in [
            (
                serde_json::json!({"python":{"enabled":true,"store_path":"store/plugins/python"}}),
                true,
            ),
            (
                serde_json::json!({"python":{"enabled":false,"store_path":"store/plugins/python"}}),
                false,
            ),
            (serde_json::json!({}), false),
        ] {
            fs::write(
                &manifest,
                serde_json::to_vec(&serde_json::json!({"plugins":plugins})).unwrap(),
            )
            .unwrap();
            assert_eq!(managed_plugins_need_python(&manifest, &shared), expected);
        }
    }

    #[test]
    fn projected_mcp_requests_python_without_relying_on_the_script_scan() {
        let home = tempfile::tempdir().unwrap();
        let capabilities = home.path().join("capabilities");
        let package = capabilities.join("store/plugins/python");
        let scripts = package.join("a/b/c/d/e/f/g/h/i");
        fs::create_dir_all(&scripts).unwrap();
        fs::create_dir(package.join(".codex-plugin")).unwrap();
        fs::write(
            package.join(".codex-plugin/plugin.json"),
            r#"{"name":"python"}"#,
        )
        .unwrap();
        fs::write(scripts.join("probe.py"), "pass\n").unwrap();
        assert!(!package_needs_python(&package));
        let manifest = capabilities.join("manifest-v2.json");
        let shared = home.path().join("shared/plugins");
        let interpreter = home.path().join("managed-runtimes/python/bin/python3");
        assert!(!interpreter.exists());
        for (available, enabled, managed, absolute, expected) in [
            (true, true, true, true, true),
            (false, true, true, true, true),
            (false, false, true, true, false),
            (false, true, false, true, false),
            (false, true, true, false, false),
        ] {
            if !available && package.exists() {
                fs::remove_dir_all(&package).unwrap();
            }
            let marker = if absolute {
                interpreter.clone()
            } else {
                PathBuf::from("python3")
            };
            fs::write(
                &manifest,
                serde_json::to_vec(&serde_json::json!({
                    "plugins":{"python":{
                        "managed":managed,"enabled":enabled,"store_path":"store/plugins/python",
                        "runtime":{"managed_mcp_python":marker}
                    }}
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(managed_plugins_need_python(&manifest, &shared), expected);
        }
    }
}
