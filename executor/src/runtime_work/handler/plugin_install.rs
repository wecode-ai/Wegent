// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::agents::replace_config;
use std::io::{BufReader, Read};
use toml_edit::{value, DocumentMut};

const WEWORK_PERSONAL_MARKETPLACE: &str = "wework-personal";
#[derive(Debug)]
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
    let context = resolve_local_plugin_request_context(payload)?;
    let plugin_key = format!("{}@{WEWORK_PERSONAL_MARKETPLACE}", context.plugin_name);
    let cache_root = context
        .codex_home
        .join("plugins/cache")
        .join(WEWORK_PERSONAL_MARKETPLACE)
        .join(&context.plugin_name);
    Ok(LocalPluginUninstallTarget {
        plugin_key,
        cache_root,
        codex_home: context.codex_home,
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
    replace_cache_from_source(&target.source_root, &target.cache_root)?;
    if let Err(error) = set_plugin_config_enabled(&target.codex_home, &target.plugin_key, true) {
        let _ = fs::remove_dir_all(&target.cache_root);
        return Err(error);
    }
    if !local_plugin_install_is_committed(target)? {
        return Err("local plugin files did not match the committed installation".to_owned());
    }
    Ok(())
}

fn uninstall_local_plugin_files(target: &LocalPluginUninstallTarget) -> Result<(), String> {
    remove_plugin_config(&target.codex_home, &target.plugin_key)?;
    if target.cache_root.is_dir() {
        fs::remove_dir_all(&target.cache_root)
            .map_err(|error| format!("failed to remove local plugin cache: {error}"))?;
    }
    Ok(())
}

fn replace_cache_from_source(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "local plugin cache path has no parent".to_owned())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to prepare local plugin cache: {error}"))?;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = parent.join(format!(".wework-install-{}-{unique}", std::process::id()));
    let backup = parent.join(format!(".wework-backup-{}-{unique}", std::process::id()));
    if let Err(error) = copy_directory(source, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }

    let had_destination = destination.exists();
    if had_destination {
        fs::rename(destination, &backup)
            .map_err(|error| format!("failed to stage existing plugin cache: {error}"))?;
    }
    if let Err(error) = fs::rename(&staging, destination) {
        if had_destination {
            let _ = fs::rename(&backup, destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("failed to commit local plugin cache: {error}"));
    }
    if had_destination {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("failed to create local plugin cache directory: {error}"))?;
    let entries = fs::read_dir(source)
        .map_err(|error| format!("failed to read local plugin source: {error}"))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("failed to read plugin source entry: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect plugin source entry: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path)
                .map_err(|error| format!("failed to copy local plugin file: {error}"))?;
        } else {
            let _ = fs::remove_dir_all(destination);
            return Err("plugin source contains an unsupported file type".to_owned());
        }
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
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let mut document = content
        .parse::<DocumentMut>()
        .map_err(|error| format!("invalid Codex config: {error}"))?;
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
    readers_equal(left_file, right_file)
}

fn readers_equal(left: impl Read, right: impl Read) -> Result<bool, String> {
    let mut left_reader = BufReader::new(left);
    let mut right_reader = BufReader::new(right);
    let mut left_buffer = [0_u8; 16 * 1024];
    let mut right_buffer = [0_u8; 16 * 1024];
    loop {
        let left_read = fill_read_buffer(&mut left_reader, &mut left_buffer, "source")?;
        let right_read = fill_read_buffer(&mut right_reader, &mut right_buffer, "cache")?;
        if left_read != right_read || left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
    }
}

fn fill_read_buffer(
    reader: &mut impl Read,
    buffer: &mut [u8],
    file_kind: &str,
) -> Result<usize, String> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(count) => filled += count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(format!("failed to read plugin {file_kind} file: {error}"));
            }
        }
    }
    Ok(filled)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct ChunkedReader {
        bytes: Vec<u8>,
        offset: usize,
        chunk_size: usize,
    }

    impl Read for ChunkedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.offset == self.bytes.len() {
                return Ok(0);
            }
            let count = self
                .chunk_size
                .min(buffer.len())
                .min(self.bytes.len() - self.offset);
            buffer[..count].copy_from_slice(&self.bytes[self.offset..self.offset + count]);
            self.offset += count;
            Ok(count)
        }
    }

    fn chunked_reader(content: &str, chunk_size: usize) -> ChunkedReader {
        ChunkedReader {
            bytes: content.as_bytes().to_vec(),
            offset: 0,
            chunk_size,
        }
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
    fn reader_comparison_accumulates_short_reads_before_comparing() {
        assert!(readers_equal(
            chunked_reader("identical content", 1),
            chunked_reader("identical content", 7),
        )
        .unwrap());
        assert!(!readers_equal(
            chunked_reader("identical content", 1),
            chunked_reader("identical contenx", 7),
        )
        .unwrap());
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
        assert!(local_plugin_install_is_committed(&target).unwrap());

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
