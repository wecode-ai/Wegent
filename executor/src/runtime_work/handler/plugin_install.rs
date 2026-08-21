// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::{BufReader, Read};
use tokio::sync::oneshot;
use toml_edit::DocumentMut;

const WEWORK_PERSONAL_MARKETPLACE: &str = "wework-personal";
const LOCAL_INSTALL_COMMIT_TIMEOUT: Duration = Duration::from_secs(15);
const LOCAL_INSTALL_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug)]
struct LocalPluginInstallTarget {
    marketplace_path: PathBuf,
    plugin_name: String,
    plugin_key: String,
    source_root: PathBuf,
    cache_root: PathBuf,
    codex_home: PathBuf,
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn install_local_plugin_before_post_install_network(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let target = resolve_local_plugin_install_target(&payload)
            .map_err(|error| AppIpcError::new("invalid_local_plugin_install", error))?;
        let request_params = json!({
            "marketplacePath": target.marketplace_path,
            "remoteMarketplaceName": Value::Null,
            "pluginName": target.plugin_name,
        });
        let plugin_key = target.plugin_key.clone();
        let client = self.codex_app_server.clone();
        let (result_tx, mut result_rx) = oneshot::channel();

        tokio::spawn(async move {
            let result = client.request("plugin/install", request_params).await;
            if let Err(result) = result_tx.send(result) {
                log_executor_event(
                    "local plugin post-install network work finished",
                    &[
                        ("plugin_key", plugin_key),
                        (
                            "result",
                            if result.is_ok() { "ok" } else { "failed" }.to_owned(),
                        ),
                    ],
                );
            }
        });

        let started_at = Instant::now();
        loop {
            if local_plugin_install_is_committed(&target)
                .map_err(|error| AppIpcError::new("local_plugin_commit_check_failed", error))?
            {
                log_executor_event(
                    "local plugin install committed before post-install network completed",
                    &[
                        ("plugin_key", target.plugin_key.clone()),
                        ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
                    ],
                );
                return Ok(json!({
                    "pluginKey": target.plugin_key,
                    "localCommitted": true,
                }));
            }

            if started_at.elapsed() >= LOCAL_INSTALL_COMMIT_TIMEOUT {
                return Err(AppIpcError::new(
                    "local_plugin_commit_timeout",
                    format!(
                        "Local plugin {} was not committed within {}s",
                        target.plugin_key,
                        LOCAL_INSTALL_COMMIT_TIMEOUT.as_secs()
                    ),
                ));
            }

            tokio::select! {
                result = &mut result_rx => {
                    return match result {
                        Ok(Ok(_)) => Ok(json!({
                            "pluginKey": target.plugin_key,
                            "localCommitted": true,
                        })),
                        Ok(Err(error)) => {
                            if local_plugin_install_is_committed(&target).unwrap_or(false) {
                                Ok(json!({
                                    "pluginKey": target.plugin_key,
                                    "localCommitted": true,
                                }))
                            } else {
                                Err(AppIpcError::new("local_plugin_install_failed", error))
                            }
                        }
                        Err(_) => Err(AppIpcError::new(
                            "local_plugin_install_failed",
                            "Codex plugin installation stopped before local commit",
                        )),
                    };
                }
                _ = sleep(LOCAL_INSTALL_POLL_INTERVAL) => {}
            }
        }
    }
}

fn resolve_local_plugin_install_target(
    payload: &Value,
) -> Result<LocalPluginInstallTarget, String> {
    let marketplace_path = string_field(payload, "marketplacePath")
        .ok_or_else(|| "marketplacePath is required".to_owned())?;
    let plugin_name =
        string_field(payload, "pluginName").ok_or_else(|| "pluginName is required".to_owned())?;
    validate_path_segment(&plugin_name, "pluginName")?;

    let marketplace_path = PathBuf::from(marketplace_path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve local marketplace manifest: {error}"))?;
    if marketplace_path.file_name().and_then(|name| name.to_str()) != Some("marketplace.json") {
        return Err("marketplacePath must point to marketplace.json".to_owned());
    }
    let marketplace = read_json_file(&marketplace_path, "local marketplace manifest")?;
    if marketplace.get("name").and_then(Value::as_str) != Some(WEWORK_PERSONAL_MARKETPLACE) {
        return Err("only the Wework personal marketplace supports local-first install".to_owned());
    }

    let marketplace_root = marketplace_path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .ok_or_else(|| "personal marketplace manifest path is invalid".to_owned())?
        .canonicalize()
        .map_err(|error| format!("failed to resolve personal marketplace root: {error}"))?;
    let source_path = marketplace
        .get("plugins")
        .and_then(Value::as_array)
        .and_then(|plugins| {
            plugins.iter().find(|plugin| {
                plugin.get("name").and_then(Value::as_str) == Some(plugin_name.as_str())
            })
        })
        .and_then(|plugin| plugin.get("source"))
        .filter(|source| source.get("source").and_then(Value::as_str) == Some("local"))
        .and_then(|source| source.get("path"))
        .and_then(Value::as_str)
        .ok_or_else(|| "plugin must have a local marketplace source".to_owned())?;
    let source_root = marketplace_root
        .join(source_path)
        .canonicalize()
        .map_err(|error| format!("failed to resolve imported plugin source: {error}"))?;
    let expected_source_root = marketplace_root.join("plugins").join(&plugin_name);
    if source_root != expected_source_root || !source_root.starts_with(&marketplace_root) {
        return Err(
            "plugin source must be inside the personal marketplace plugins directory".to_owned(),
        );
    }

    let plugin_manifest = read_json_file(
        &source_root.join(".codex-plugin/plugin.json"),
        "plugin manifest",
    )?;
    if plugin_manifest.get("name").and_then(Value::as_str) != Some(plugin_name.as_str()) {
        return Err("plugin manifest name does not match marketplace entry".to_owned());
    }
    let plugin_version = plugin_manifest
        .get("version")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "plugin manifest version is required".to_owned())?;
    validate_path_segment(plugin_version, "plugin version")?;

    let codex_home = crate::agents::wework_codex_home();
    let cache_root = codex_home
        .join("plugins/cache")
        .join(WEWORK_PERSONAL_MARKETPLACE)
        .join(&plugin_name)
        .join(plugin_version);
    Ok(LocalPluginInstallTarget {
        marketplace_path,
        plugin_key: format!("{plugin_name}@{WEWORK_PERSONAL_MARKETPLACE}"),
        plugin_name,
        source_root,
        cache_root,
        codex_home,
    })
}

fn validate_path_segment(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || matches!(value, "." | "..")
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".+_-".contains(character))
    {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn read_json_file(path: &Path, label: &str) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|error| format!("failed to read {label}: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("invalid {label}: {error}"))
}

fn local_plugin_install_is_committed(target: &LocalPluginInstallTarget) -> Result<bool, String> {
    Ok(
        plugin_config_enabled(&target.codex_home, &target.plugin_key)?
            && source_files_match_cache(&target.source_root, &target.cache_root)?,
    )
}

fn plugin_config_enabled(codex_home: &Path, plugin_key: &str) -> Result<bool, String> {
    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("failed to read Codex config: {error}")),
    };
    let document = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("invalid Codex config: {error}"))?;
    Ok(document
        .get("plugins")
        .and_then(|plugins| plugins.get(plugin_key))
        .and_then(|plugin| plugin.get("enabled"))
        .and_then(|enabled| enabled.as_bool())
        == Some(true))
}

fn source_files_match_cache(source_root: &Path, cache_root: &Path) -> Result<bool, String> {
    if !cache_root.is_dir() {
        return Ok(false);
    }
    source_directory_matches_cache(source_root, cache_root)
}

fn source_directory_matches_cache(source: &Path, cache: &Path) -> Result<bool, String> {
    let entries = fs::read_dir(source)
        .map_err(|error| format!("failed to read plugin source directory: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to read plugin source entry: {error}"))?;
        let source_path = entry.path();
        let cache_path = cache.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect plugin source entry: {error}"))?;
        if file_type.is_dir() {
            if !cache_path.is_dir() || !source_directory_matches_cache(&source_path, &cache_path)? {
                return Ok(false);
            }
        } else if file_type.is_file() {
            if !cache_path.is_file() || !files_equal(&source_path, &cache_path)? {
                return Ok(false);
            }
        } else {
            return Err("plugin source contains an unsupported file type".to_owned());
        }
    }
    Ok(true)
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, String> {
    let left_file = fs::File::open(left)
        .map_err(|error| format!("failed to read plugin source file: {error}"))?;
    let right_file = fs::File::open(right)
        .map_err(|error| format!("failed to read plugin cache file: {error}"))?;
    if left_file.metadata().ok().map(|metadata| metadata.len())
        != right_file.metadata().ok().map(|metadata| metadata.len())
    {
        return Ok(false);
    }
    let mut left_reader = BufReader::new(left_file);
    let mut right_reader = BufReader::new(right_file);
    let mut left_buffer = [0_u8; 16 * 1024];
    let mut right_buffer = [0_u8; 16 * 1024];
    loop {
        let left_read = left_reader
            .read(&mut left_buffer)
            .map_err(|error| format!("failed to read plugin source file: {error}"))?;
        let right_read = right_reader
            .read(&mut right_buffer)
            .map_err(|error| format!("failed to read plugin cache file: {error}"))?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_plugin_fixture(root: &Path, content: &str) {
        fs::create_dir_all(root.join(".codex-plugin")).unwrap();
        fs::create_dir_all(root.join("skills/example")).unwrap();
        fs::write(
            root.join(".codex-plugin/plugin.json"),
            r#"{"name":"example","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(root.join("skills/example/SKILL.md"), content).unwrap();
    }

    #[test]
    fn source_cache_match_ignores_generated_cache_files_but_detects_source_changes() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let cache = temp.path().join("cache");
        write_plugin_fixture(&source, "source");
        write_plugin_fixture(&cache, "source");
        fs::write(cache.join("generated.txt"), "generated").unwrap();

        assert!(source_files_match_cache(&source, &cache).unwrap());
        fs::write(cache.join("skills/example/SKILL.md"), "stale").unwrap();
        assert!(!source_files_match_cache(&source, &cache).unwrap());
    }

    #[test]
    fn config_commit_requires_enabled_personal_plugin_entry() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("config.toml"),
            "[plugins.\"example@wework-personal\"]\nenabled = true\n",
        )
        .unwrap();

        assert!(plugin_config_enabled(temp.path(), "example@wework-personal").unwrap());
        assert!(!plugin_config_enabled(temp.path(), "other@wework-personal").unwrap());
    }

    #[test]
    fn resolves_only_plugin_sources_inside_the_personal_marketplace() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace_root = temp.path().join("wework-personal");
        let manifest_path = marketplace_root.join(".agents/plugins/marketplace.json");
        let plugin_root = marketplace_root.join("plugins/example");
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        write_plugin_fixture(&plugin_root, "source");
        fs::write(
            &manifest_path,
            r#"{"name":"wework-personal","plugins":[{"name":"example","source":{"source":"local","path":"./plugins/example"}}]}"#,
        )
        .unwrap();

        let target = resolve_local_plugin_install_target(&json!({
            "marketplacePath": manifest_path,
            "pluginName": "example",
        }))
        .unwrap();
        assert_eq!(target.source_root, plugin_root.canonicalize().unwrap());
        assert_eq!(target.plugin_key, "example@wework-personal");
    }
}
