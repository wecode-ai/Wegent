// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::agents::replace_config;
use toml_edit::{value, DocumentMut};

const WEWORK_PERSONAL_MARKETPLACE: &str = "wework-personal";
#[derive(Clone, Debug)]
struct LocalPluginInstallTarget {
    plugin_key: String,
    source_root: PathBuf,
    cache_root: PathBuf,
    codex_home: PathBuf,
}

#[derive(Debug)]
struct LocalPluginUninstallTarget {
    plugin_key: String,
    cache_root: PathBuf,
    codex_home: PathBuf,
}

struct LocalPluginRequestContext {
    plugin_name: String,
    marketplace: Value,
    marketplace_root: PathBuf,
    codex_home: PathBuf,
}

impl RuntimeWorkRpcHandler {
    pub(super) async fn sync_bundled_plugin(&self, payload: Value) -> Result<Value, AppIpcError> {
        let target = resolve_local_plugin_install_target(&payload)
            .map_err(|error| AppIpcError::new("invalid_bundled_plugin", error))?;
        let manifest_path = string_field(&payload, "marketplacePath").unwrap_or_default();
        let catalog = read_json_file(Path::new(&manifest_path), "bundled marketplace")
            .map_err(|error| AppIpcError::new("invalid_bundled_plugin", error))?;
        let name = string_field(&payload, "pluginName").unwrap_or_default();
        if !catalog
            .get("plugins")
            .and_then(Value::as_array)
            .is_some_and(|plugins| {
                plugins.iter().any(|plugin| {
                    plugin.get("name").and_then(Value::as_str) == Some(name.as_str())
                        && plugin
                            .pointer("/policy/installation")
                            .and_then(Value::as_str)
                            == Some("INSTALLED_BY_DEFAULT")
                })
            })
        {
            return Err(AppIpcError::new(
                "invalid_bundled_plugin",
                "Plugin is not installed by default",
            ));
        }
        self.sync_bundled_plugin_target(target).await
    }

    async fn sync_bundled_plugin_target(
        &self,
        target: LocalPluginInstallTarget,
    ) -> Result<Value, AppIpcError> {
        // Unchanged plugins remain usable while unrelated work or RPCs are active.
        let check_target = target.clone();
        let current = tokio::task::spawn_blocking(move || {
            let _lock = crate::local::personal_marketplace_lock::acquire_personal_marketplace_lock(
                &check_target
                    .codex_home
                    .join("plugins/cache/wework-personal"),
            )?;
            bundled_plugin_cache_is_current(&check_target)
        })
        .await
        .map_err(|error| AppIpcError::new("bundled_plugin_update_failed", error.to_string()))?
        .map_err(|error| AppIpcError::new("bundled_plugin_update_failed", error))?;
        if current {
            return Ok(json!({"status": "ready", "updated": false}));
        }
        let name = target.plugin_key.clone();
        // Completed turns can still own live processes in the app-server.
        let _turn_admission = self.turn_queue_operation.lock().await;
        let active_tasks = self
            .turn_scheduler
            .lock()
            .expect("runtime turn scheduler lock should not be poisoned")
            .active_tasks;
        if active_tasks > 0 || self.background_terminal_count() > 0 {
            return Ok(json!({"status": "deferred", "updated": false}));
        }
        let result = self
            .codex_app_server
            .mutate_configuration_if_idle(|| async move {
                tokio::task::spawn_blocking(move || sync_bundled_plugin_files(&target))
                    .await
                    .map_err(|error| error.to_string())?
            })
            .await;
        match result {
            Ok(changed) => {
                log_executor_event(
                    "bundled plugin cache synchronized",
                    &[("plugin", name), ("changed", changed.to_string())],
                );
                Ok(json!({"status": "ready", "updated": changed}))
            }
            Err(CodexIdleMutationError::Busy { .. }) => {
                Ok(json!({"status": "deferred", "updated": false}))
            }
            Err(CodexIdleMutationError::Update(error)) => {
                Err(AppIpcError::new("bundled_plugin_update_failed", error))
            }
        }
    }

    pub(super) async fn install_local_plugin(&self, payload: Value) -> Result<Value, AppIpcError> {
        let target = resolve_local_plugin_install_target(&payload)
            .map_err(|error| AppIpcError::new("invalid_local_plugin_install", error))?;
        let plugin_key = target.plugin_key.clone();
        let started_at = Instant::now();
        tokio::task::spawn_blocking(move || install_local_plugin_files(&target))
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "local_plugin_install_failed",
                    format!("failed to join local plugin installation: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new("local_plugin_install_failed", error))?;
        log_executor_event(
            "local plugin install committed",
            &[
                ("plugin_key", plugin_key.clone()),
                ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
            ],
        );
        Ok(json!({
            "pluginKey": plugin_key,
            "localCommitted": true,
        }))
    }

    pub(super) async fn uninstall_local_plugin(
        &self,
        payload: Value,
    ) -> Result<Value, AppIpcError> {
        let target = resolve_local_plugin_uninstall_target(&payload)
            .map_err(|error| AppIpcError::new("invalid_local_plugin_uninstall", error))?;
        super::super::connection_host::assert_dependency_unused(&format!(
            "{}@{}",
            target.plugin_key, WEWORK_PERSONAL_MARKETPLACE
        ))?;
        let plugin_key = target.plugin_key.clone();
        let started_at = Instant::now();
        tokio::task::spawn_blocking(move || uninstall_local_plugin_files(&target))
            .await
            .map_err(|error| {
                AppIpcError::new(
                    "local_plugin_uninstall_failed",
                    format!("failed to join local plugin uninstall: {error}"),
                )
            })?
            .map_err(|error| AppIpcError::new("local_plugin_uninstall_failed", error))?;
        log_executor_event(
            "local plugin uninstall committed",
            &[
                ("plugin_key", plugin_key.clone()),
                ("elapsed_ms", started_at.elapsed().as_millis().to_string()),
            ],
        );
        Ok(json!({
            "pluginKey": plugin_key,
            "localCommitted": true,
        }))
    }
}

fn resolve_local_plugin_install_target(
    payload: &Value,
) -> Result<LocalPluginInstallTarget, String> {
    let context = resolve_local_plugin_request_context(payload)?;
    let plugin_name = context.plugin_name;
    let marketplace = context.marketplace;
    let marketplace_root = context.marketplace_root;
    let codex_home = context.codex_home;

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

    let cache_root = codex_home
        .join("plugins/cache")
        .join(WEWORK_PERSONAL_MARKETPLACE)
        .join(&plugin_name)
        .join(plugin_version);
    Ok(LocalPluginInstallTarget {
        plugin_key: format!("{plugin_name}@{WEWORK_PERSONAL_MARKETPLACE}"),
        source_root,
        cache_root,
        codex_home,
    })
}

fn resolve_local_plugin_uninstall_target(
    payload: &Value,
) -> Result<LocalPluginUninstallTarget, String> {
    // Uninstall only needs an identity and the device-owned cache, not a live catalog.
    let plugin_name =
        string_field(payload, "pluginName").ok_or_else(|| "pluginName is required".to_owned())?;
    validate_path_segment(&plugin_name, "pluginName")?;
    let codex_home = crate::agents::wework_codex_home();
    let plugin_key = format!("{plugin_name}@{WEWORK_PERSONAL_MARKETPLACE}");
    let cache_root = codex_home
        .join("plugins/cache")
        .join(WEWORK_PERSONAL_MARKETPLACE)
        .join(&plugin_name);
    Ok(LocalPluginUninstallTarget {
        plugin_key,
        cache_root,
        codex_home,
    })
}

fn resolve_local_plugin_request_context(
    payload: &Value,
) -> Result<LocalPluginRequestContext, String> {
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
    let codex_home = crate::agents::wework_codex_home();
    Ok(LocalPluginRequestContext {
        plugin_name,
        marketplace,
        marketplace_root,
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

fn install_local_plugin_files(target: &LocalPluginInstallTarget) -> Result<(), String> {
    let _lock = crate::local::personal_marketplace_lock::acquire_personal_marketplace_lock(
        &target.codex_home.join("plugins/cache/wework-personal"),
    )?;
    crate::local::plugin_cache::replace_cache(&target.source_root, &target.cache_root, || {
        set_plugin_config_enabled(&target.codex_home, &target.plugin_key, true)
    })
}

fn sync_bundled_plugin_files(target: &LocalPluginInstallTarget) -> Result<(bool, bool), String> {
    use crate::local::{
        personal_marketplace_lock::acquire_personal_marketplace_lock, plugin_cache,
    };
    let _lock = acquire_personal_marketplace_lock(
        &target.codex_home.join("plugins/cache/wework-personal"),
    )?;
    let configured = bundled_plugin_is_configured(target)?;
    if configured && plugin_cache::cache_matches_source(&target.source_root, &target.cache_root)? {
        return Ok((false, false));
    }
    plugin_cache::replace_cache(&target.source_root, &target.cache_root, || {
        if configured {
            Ok(())
        } else {
            set_plugin_config_enabled(&target.codex_home, &target.plugin_key, true)
        }
    })?;
    Ok((true, true))
}

fn bundled_plugin_cache_is_current(target: &LocalPluginInstallTarget) -> Result<bool, String> {
    Ok(bundled_plugin_is_configured(target)?
        && crate::local::plugin_cache::cache_matches_source(
            &target.source_root,
            &target.cache_root,
        )?)
}

fn bundled_plugin_is_configured(target: &LocalPluginInstallTarget) -> Result<bool, String> {
    let config_path = target.codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.to_string()),
    };
    let document = content
        .parse::<DocumentMut>()
        .map_err(|_| "Invalid Codex config".to_owned())?;
    Ok(document
        .get("plugins")
        .and_then(|plugins| plugins.get(&target.plugin_key))
        .is_some())
}

fn uninstall_local_plugin_files(target: &LocalPluginUninstallTarget) -> Result<(), String> {
    let _lock = crate::local::personal_marketplace_lock::acquire_personal_marketplace_lock(
        &target.codex_home.join("plugins/cache/wework-personal"),
    )?;
    remove_plugin_config(&target.codex_home, &target.plugin_key)?;
    if target.cache_root.is_dir() {
        fs::remove_dir_all(&target.cache_root)
            .map_err(|error| format!("failed to remove local plugin cache: {error}"))?;
    }
    Ok(())
}

fn set_plugin_config_enabled(
    codex_home: &Path,
    plugin_key: &str,
    enabled: bool,
) -> Result<(), String> {
    fs::create_dir_all(codex_home)
        .map_err(|error| format!("failed to prepare Codex home: {error}"))?;
    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Failed to read Codex config: {error}")),
    };
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|_| "Invalid Codex config".to_owned())?;
    document["plugins"][plugin_key]["enabled"] = value(enabled);
    replace_config(&config_path, document.to_string())
}

fn remove_plugin_config(codex_home: &Path, plugin_key: &str) -> Result<(), String> {
    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("failed to read Codex config: {error}")),
    };
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("invalid Codex config: {error}"))?;
    let removed = document
        .get_mut("plugins")
        .and_then(|plugins| plugins.as_table_like_mut())
        .and_then(|plugins| plugins.remove(plugin_key))
        .is_some();
    if !removed {
        return Ok(());
    }
    replace_config(&config_path, document.to_string())
}

#[cfg(test)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn background_terminals_defer_plugin_mutation_until_native_exit() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let codex_home = root.path().join("codex");
        write_plugin_fixture(&source, "new");
        let target = LocalPluginInstallTarget {
            plugin_key: "example@wework-personal".to_owned(),
            source_root: source,
            cache_root: codex_home.join("plugins/cache/wework-personal/example/1.0.0"),
            codex_home,
        };
        install_local_plugin_files(&target).unwrap();
        let mut handler = RuntimeWorkRpcHandler::new("background-plugin-test", "/bin/false");
        handler.store = RuntimeWorkStore::new(root.path().join("index.json"));
        let mut link =
            RuntimeTaskLink::new_pending("task-1".into(), "/project".into(), "Task".into());
        link.thread_id = Some("thread-1".into());
        handler.upsert_local_task(link);
        handler.persist_completed_codex_turn_from_notification("task-1", &json!({
            "method": "turn/completed", "params": {"threadId": "thread-1", "turn": {
                "id": "turn-1", "status": "completed", "items": [{"id": "command-1", "type": "commandExecution", "command": "node server.js", "status": "inProgress", "processId": "42"}]
            }}
        }));
        assert_eq!(handler.background_terminal_count(), 1);
        assert_eq!(
            handler
                .sync_bundled_plugin_target(target.clone())
                .await
                .unwrap(),
            json!({"status": "ready", "updated": false})
        );
        fs::write(target.cache_root.join("skills/example/SKILL.md"), "old").unwrap();
        assert_eq!(
            handler
                .sync_bundled_plugin_target(target.clone())
                .await
                .unwrap(),
            json!({"status": "deferred", "updated": false})
        );
        assert_eq!(
            fs::read_to_string(target.cache_root.join("skills/example/SKILL.md")).unwrap(),
            "old"
        );
        handler.record_background_terminal_notification("task-1", &json!({
            "method": "item/completed", "params": {"threadId": "thread-1", "turnId": "turn-1", "item": {
                "id": "command-1", "type": "commandExecution", "command": "node server.js", "status": "completed", "exitCode": 0
            }}
        }));
        assert_eq!(handler.background_terminal_count(), 0);
        assert_eq!(
            handler
                .sync_bundled_plugin_target(target.clone())
                .await
                .unwrap(),
            json!({"status": "ready", "updated": true})
        );
        assert_eq!(
            fs::read_to_string(target.cache_root.join("skills/example/SKILL.md")).unwrap(),
            "new"
        );
    }

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

    #[tokio::test]
    async fn busy_runtime_allows_current_plugins_but_defers_changed_or_missing_plugins() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let codex_home = root.path().join("codex");
        write_plugin_fixture(&source, "new");
        let target = LocalPluginInstallTarget {
            plugin_key: "example@wework-personal".to_owned(),
            source_root: source,
            cache_root: codex_home.join("plugins/cache/wework-personal/example/1.0.0"),
            codex_home: codex_home.clone(),
        };
        install_local_plugin_files(&target).unwrap();
        set_plugin_config_enabled(&codex_home, &target.plugin_key, false).unwrap();
        let config = fs::read_to_string(codex_home.join("config.toml")).unwrap();
        let handler = RuntimeWorkRpcHandler::new("bundled-plugin-busy-test", "/bin/false");
        handler.turn_scheduler.lock().unwrap().active_tasks = 1;

        assert_eq!(
            handler
                .sync_bundled_plugin_target(target.clone())
                .await
                .unwrap(),
            json!({"status": "ready", "updated": false})
        );
        fs::write(target.cache_root.join("skills/example/SKILL.md"), "old").unwrap();
        assert_eq!(
            handler
                .sync_bundled_plugin_target(target.clone())
                .await
                .unwrap(),
            json!({"status": "deferred", "updated": false})
        );
        assert_eq!(
            fs::read_to_string(target.cache_root.join("skills/example/SKILL.md")).unwrap(),
            "old"
        );
        fs::remove_dir_all(&target.cache_root).unwrap();
        assert_eq!(
            handler
                .sync_bundled_plugin_target(target.clone())
                .await
                .unwrap(),
            json!({"status": "deferred", "updated": false})
        );
        assert!(!target.cache_root.exists());
        assert_eq!(
            fs::read_to_string(codex_home.join("config.toml")).unwrap(),
            config
        );
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
    fn installs_and_uninstalls_personal_plugin_without_app_server() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        let cache = temp
            .path()
            .join("codex/plugins/cache/wework-personal/example/1.0.0");
        let codex_home = temp.path().join("codex");
        write_plugin_fixture(&source, "source");
        let target = LocalPluginInstallTarget {
            plugin_key: "example@wework-personal".to_owned(),
            source_root: source,
            cache_root: cache.clone(),
            codex_home: codex_home.clone(),
        };

        install_local_plugin_files(&target).unwrap();
        assert!(plugin_config_enabled(&codex_home, &target.plugin_key).unwrap());
        assert!(crate::local::plugin_cache::cache_matches_source(
            &target.source_root,
            &target.cache_root
        )
        .unwrap());

        let uninstall_target = LocalPluginUninstallTarget {
            plugin_key: target.plugin_key.clone(),
            cache_root: cache.parent().unwrap().to_path_buf(),
            codex_home: codex_home.clone(),
        };
        uninstall_local_plugin_files(&uninstall_target).unwrap();
        assert!(!cache.parent().unwrap().exists());
        assert!(!plugin_config_enabled(&codex_home, &target.plugin_key).unwrap());
        let config = fs::read_to_string(codex_home.join("config.toml")).unwrap();
        assert!(!config.contains(&target.plugin_key));
    }

    #[test]
    fn bundled_sync_repairs_same_version_cache_without_changing_disabled_state_or_chats() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        let source = root.path().join("source");
        write_plugin_fixture(&source, "new");
        fs::create_dir_all(codex_home.join("sessions")).unwrap();
        fs::write(codex_home.join("sessions/chat.jsonl"), "chat").unwrap();
        fs::write(codex_home.join("auth.json"), "synthetic-auth").unwrap();
        fs::write(codex_home.join("config.toml"), "[plugins.\"example@wework-personal\"]\nenabled = false\n[plugins.\"other@wework-personal\"]\nenabled = true\n").unwrap();
        let target = LocalPluginInstallTarget {
            plugin_key: "example@wework-personal".to_owned(),
            source_root: source,
            cache_root: codex_home.join("plugins/cache/wework-personal/example/1.0.0"),
            codex_home: codex_home.clone(),
        };
        fs::create_dir_all(&target.cache_root).unwrap();
        fs::write(target.cache_root.join("obsolete.js"), "old").unwrap();
        assert_eq!(sync_bundled_plugin_files(&target).unwrap(), (true, true));
        assert_eq!(sync_bundled_plugin_files(&target).unwrap(), (false, false));
        assert!(!target.cache_root.join("obsolete.js").exists());
        assert!(!plugin_config_enabled(&codex_home, &target.plugin_key).unwrap());
        assert!(plugin_config_enabled(&codex_home, "other@wework-personal").unwrap());
        assert_eq!(
            fs::read_to_string(codex_home.join("sessions/chat.jsonl")).unwrap(),
            "chat"
        );
        assert_eq!(
            fs::read_to_string(codex_home.join("auth.json")).unwrap(),
            "synthetic-auth"
        );
    }

    #[test]
    fn uninstall_resolves_identity_when_the_marketplace_has_been_deleted() {
        let target = resolve_local_plugin_uninstall_target(&json!({
            "pluginName": "smart-app-builder",
            "marketplacePath": "/nonexistent-marketplace/.agents/plugins/marketplace.json",
        }))
        .unwrap();
        assert_eq!(target.plugin_key, "smart-app-builder@wework-personal");
        assert!(
            resolve_local_plugin_uninstall_target(&json!({"pluginName": "../sessions"})).is_err()
        );
    }

    #[test]
    fn resolves_orphaned_personal_plugin_without_a_marketplace_source() {
        let temp = tempfile::tempdir().unwrap();
        let marketplace_root = temp.path().join("wework-personal");
        let manifest_path = marketplace_root.join(".agents/plugins/marketplace.json");
        fs::create_dir_all(manifest_path.parent().unwrap()).unwrap();
        fs::write(&manifest_path, r#"{"name":"wework-personal","plugins":[]}"#).unwrap();

        let target = resolve_local_plugin_uninstall_target(&json!({
            "marketplacePath": manifest_path,
            "pluginName": "orphaned-plugin",
        }))
        .unwrap();

        assert_eq!(target.plugin_key, "orphaned-plugin@wework-personal");
        assert!(target
            .cache_root
            .ends_with("plugins/cache/wework-personal/orphaned-plugin"));
    }

    #[test]
    fn uninstalls_orphaned_personal_plugin_cache_and_config() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join("codex");
        let cache_root = codex_home.join("plugins/cache/wework-personal/orphaned-plugin");
        fs::create_dir_all(cache_root.join("1.0.0")).unwrap();
        fs::write(cache_root.join("1.0.0/plugin.json"), "{}").unwrap();
        set_plugin_config_enabled(&codex_home, "orphaned-plugin@wework-personal", true).unwrap();
        let target = LocalPluginUninstallTarget {
            plugin_key: "orphaned-plugin@wework-personal".to_owned(),
            cache_root: cache_root.clone(),
            codex_home: codex_home.clone(),
        };

        uninstall_local_plugin_files(&target).unwrap();

        assert!(!cache_root.exists());
        assert!(!plugin_config_enabled(&codex_home, &target.plugin_key).unwrap());
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
