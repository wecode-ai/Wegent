// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

use regex::Regex;
use serde::{Deserialize, Serialize};

use super::model::{
    CommandHookConfig, HookHealth, HookPluginManifest, HookPolicy, HookRunSummary, HookSource,
    HooksConfig, ResolvedHookHandlerView, ResolvedHookPluginView, MAX_TIMEOUT_SECONDS,
};

const MAX_JSON_BYTES: u64 = 1024 * 1024;

pub struct ResolvedCommandHook {
    pub handler_id: String,
    pub matcher_source: String,
    pub matcher: Regex,
    pub config: CommandHookConfig,
}

pub struct ResolvedHookPlugin {
    pub manifest: HookPluginManifest,
    pub enabled: bool,
    pub source: HookSource,
    pub directory: PathBuf,
    pub policy: HookPolicy,
    pub health: HookHealth,
    pub hooks: Vec<ResolvedCommandHook>,
}

impl ResolvedHookPlugin {
    pub fn view(&self, runs: Vec<HookRunSummary>) -> ResolvedHookPluginView {
        ResolvedHookPluginView {
            manifest: self.manifest.clone(),
            enabled: self.enabled,
            source: self.source,
            install_path: self.directory.clone(),
            policy: self.policy.clone(),
            health: self.health.clone(),
            handlers: self
                .hooks
                .iter()
                .map(|hook| ResolvedHookHandlerView {
                    id: hook.handler_id.clone(),
                    matcher: hook.matcher_source.clone(),
                    config: hook.config.clone(),
                })
                .collect(),
            recent_runs: runs,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    schema_version: u32,
    #[serde(default)]
    plugins: HashMap<String, RegistryEntry>,
}

impl Default for RegistryFile {
    fn default() -> Self {
        Self {
            schema_version: 1,
            plugins: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryEntry {
    enabled: bool,
    source: HookSource,
    install_path: PathBuf,
    policy: HookPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RuntimeStateFile {
    schema_version: u32,
    #[serde(default)]
    runs: HashMap<String, HookRunSummary>,
}

#[derive(Debug, Clone)]
pub struct HookRegistryStore {
    executor_home: PathBuf,
}

impl HookRegistryStore {
    pub fn from_env() -> Self {
        let executor_home = std::env::var_os("WEGENT_EXECUTOR_HOME")
            .map(PathBuf::from)
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."));
        Self { executor_home }
    }

    #[cfg(test)]
    pub fn new(executor_home: PathBuf) -> Self {
        Self { executor_home }
    }

    pub fn plugins_dir(&self) -> PathBuf {
        self.executor_home.join("hooks/plugins")
    }

    pub fn discover(&self) -> Vec<ResolvedHookPlugin> {
        let mut registry = self.read_registry();
        let mut candidates = Vec::new();
        for entry in registry.plugins.values() {
            candidates.push((
                entry.install_path.clone(),
                entry.source,
                entry.policy.clone(),
                entry.enabled,
            ));
        }
        self.collect_root(&self.plugins_dir(), HookSource::User, &mut candidates);
        if let Some(path) = std::env::var_os("WEGENT_BUNDLED_HOOKS_DIR") {
            self.collect_root(Path::new(&path), HookSource::Bundled, &mut candidates);
        }
        if let Some(path) = std::env::var_os("WEGENT_MANAGED_HOOKS_DIR") {
            self.collect_root(Path::new(&path), HookSource::Managed, &mut candidates);
        }
        let mut loaded = Vec::new();
        let mut ids = HashMap::<String, usize>::new();
        let mut paths = HashMap::<PathBuf, ()>::new();
        for (path, source, policy, enabled) in candidates {
            let normalized = path.canonicalize().unwrap_or(path.clone());
            if paths.insert(normalized, ()).is_some() {
                continue;
            }
            if let Some(plugin) = load_plugin(path, source, policy, enabled) {
                *ids.entry(plugin.manifest.id.clone()).or_default() += 1;
                loaded.push(plugin);
            }
        }
        for plugin in &mut loaded {
            if ids.get(&plugin.manifest.id).copied().unwrap_or_default() > 1 {
                plugin.health = HookHealth::DuplicatePluginId;
            }
            registry
                .plugins
                .entry(plugin.manifest.id.clone())
                .or_insert_with(|| RegistryEntry {
                    enabled: plugin.enabled,
                    source: plugin.source,
                    install_path: plugin.directory.clone(),
                    policy: plugin.policy.clone(),
                });
        }
        let _ = self.write_registry(&registry);
        loaded
    }

    pub fn list(&self) -> Vec<ResolvedHookPluginView> {
        let runs = self.read_runtime_state().runs;
        self.discover()
            .into_iter()
            .map(|plugin| {
                let plugin_runs = runs
                    .values()
                    .filter(|run| run.plugin_id == plugin.manifest.id)
                    .cloned()
                    .collect();
                plugin.view(plugin_runs)
            })
            .collect()
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<ResolvedHookPluginView, String> {
        let plugins = self.discover();
        let plugin = plugins
            .iter()
            .find(|plugin| plugin.manifest.id == id)
            .ok_or("hook plugin not found")?;
        if !plugin.policy.can_disable {
            return Err("hook policy does not allow changing enabled state".to_owned());
        }
        let mut registry = self.read_registry();
        let entry = registry
            .plugins
            .get_mut(id)
            .ok_or("hook registry entry not found")?;
        entry.enabled = enabled;
        self.write_registry(&registry)?;
        self.list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .ok_or_else(|| "hook plugin disappeared after update".to_owned())
    }

    pub fn create(
        &self,
        manifest: HookPluginManifest,
        config: HooksConfig,
    ) -> Result<ResolvedHookPluginView, String> {
        validate_plugin_id(&manifest.id)?;
        let directory = self.plugins_dir().join(&manifest.id);
        if directory.exists() {
            return Err("hook plugin already exists".to_owned());
        }
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        if let Err(error) = write_plugin_files(&directory, &manifest, &config) {
            let _ = fs::remove_dir_all(&directory);
            return Err(error);
        }
        self.list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == manifest.id)
            .ok_or_else(|| "created hook plugin is invalid".to_owned())
    }

    pub fn update(
        &self,
        id: &str,
        manifest: HookPluginManifest,
        config: HooksConfig,
    ) -> Result<ResolvedHookPluginView, String> {
        let plugin = self
            .discover()
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .ok_or("hook plugin not found")?;
        if !plugin.policy.can_edit {
            return Err("hook policy does not allow editing".to_owned());
        }
        if manifest.id != id {
            return Err("hook plugin id cannot be changed".to_owned());
        }
        write_plugin_files(&plugin.directory, &manifest, &config)?;
        self.list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .ok_or_else(|| "updated hook plugin is invalid".to_owned())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let plugin = self
            .discover()
            .into_iter()
            .find(|plugin| plugin.manifest.id == id)
            .ok_or("hook plugin not found")?;
        if !plugin.policy.can_delete {
            return Err("hook policy does not allow deleting".to_owned());
        }
        let root = self
            .plugins_dir()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let path = plugin
            .directory
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !path.starts_with(root) {
            return Err("refusing to delete outside user hooks directory".to_owned());
        }
        fs::remove_dir_all(path).map_err(|error| error.to_string())?;
        let mut registry = self.read_registry();
        registry.plugins.remove(id);
        self.write_registry(&registry)
    }

    pub fn install(&self, source: &Path) -> Result<ResolvedHookPluginView, String> {
        let source = source.canonicalize().map_err(|error| error.to_string())?;
        let manifest: HookPluginManifest = read_json(source.join("plugin.json"))?;
        validate_plugin_id(&manifest.id)?;
        let destination = self.plugins_dir().join(&manifest.id);
        if destination.exists() {
            return Err("hook plugin already exists".to_owned());
        }
        copy_directory(&source, &destination, &source)?;
        self.list()
            .into_iter()
            .find(|plugin| plugin.manifest.id == manifest.id)
            .ok_or_else(|| "installed hook plugin is invalid".to_owned())
    }

    pub fn record_run(&self, run: HookRunSummary) -> Result<(), String> {
        let mut state = self.read_runtime_state();
        state.schema_version = 1;
        state
            .runs
            .insert(format!("{}:{}", run.plugin_id, run.handler_id), run);
        atomic_json_write(&self.executor_home.join("hooks/runtime-state.json"), &state)
    }

    fn collect_root(
        &self,
        root: &Path,
        source: HookSource,
        output: &mut Vec<(PathBuf, HookSource, HookPolicy, bool)>,
    ) {
        let Ok(entries) = fs::read_dir(root) else {
            return;
        };
        for entry in entries.flatten().filter(|entry| entry.path().is_dir()) {
            output.push((entry.path(), source, HookPolicy::for_source(source), true));
        }
    }
    fn registry_path(&self) -> PathBuf {
        self.executor_home.join("hooks/registry.json")
    }
    fn runtime_state_path(&self) -> PathBuf {
        self.executor_home.join("hooks/runtime-state.json")
    }
    fn read_registry(&self) -> RegistryFile {
        read_json(self.registry_path()).unwrap_or_default()
    }
    fn read_runtime_state(&self) -> RuntimeStateFile {
        read_json(self.runtime_state_path()).unwrap_or_default()
    }
    fn write_registry(&self, registry: &RegistryFile) -> Result<(), String> {
        atomic_json_write(&self.registry_path(), registry)
    }
}

fn load_plugin(
    directory: PathBuf,
    source: HookSource,
    policy: HookPolicy,
    enabled: bool,
) -> Option<ResolvedHookPlugin> {
    let manifest: HookPluginManifest = read_json(directory.join("plugin.json")).ok()?;
    let health = if !enabled {
        HookHealth::Disabled
    } else {
        HookHealth::Ready
    };
    let config: HooksConfig = match read_json(directory.join("hooks.json")) {
        Ok(config) => config,
        Err(error) => {
            return Some(ResolvedHookPlugin {
                manifest,
                enabled,
                source,
                directory,
                policy,
                health: HookHealth::InvalidConfig(error),
                hooks: Vec::new(),
            })
        }
    };
    let mut hooks = Vec::new();
    for (group_index, group) in config.post_tool_use.into_iter().enumerate() {
        let matcher = match Regex::new(&group.matcher) {
            Ok(value) => value,
            Err(error) => {
                return Some(ResolvedHookPlugin {
                    manifest,
                    enabled,
                    source,
                    directory,
                    policy,
                    health: HookHealth::InvalidConfig(error.to_string()),
                    hooks: Vec::new(),
                })
            }
        };
        for (hook_index, config) in group.hooks.into_iter().enumerate() {
            if let Err(error) = validate_hook(&config) {
                return Some(ResolvedHookPlugin {
                    manifest,
                    enabled,
                    source,
                    directory,
                    policy,
                    health: HookHealth::Unsupported(error),
                    hooks: Vec::new(),
                });
            }
            hooks.push(ResolvedCommandHook {
                handler_id: format!("post-tool-use-{group_index}-{hook_index}"),
                matcher_source: group.matcher.clone(),
                matcher: matcher.clone(),
                config,
            });
        }
    }
    let command_health = hooks
        .iter()
        .find_map(|hook| command_health(&directory, &hook.config));
    Some(ResolvedHookPlugin {
        manifest,
        enabled,
        source,
        directory,
        policy,
        health: command_health.unwrap_or(health),
        hooks,
    })
}

fn command_health(directory: &Path, config: &CommandHookConfig) -> Option<HookHealth> {
    let command = selected_command(config);
    let program = command.split_whitespace().next()?.trim_matches(['\'', '"']);
    let path = Path::new(program);
    if path.is_absolute() {
        return if path.exists() {
            executable_health(path)
        } else {
            Some(HookHealth::MissingCommand(path.display().to_string()))
        };
    }
    if !program.contains('/') && !program.contains('\\') {
        return None;
    }
    let candidate = directory.join(path);
    if !candidate.exists() {
        return Some(HookHealth::MissingCommand(candidate.display().to_string()));
    }
    let Ok(root) = directory.canonicalize() else {
        return Some(HookHealth::InvalidConfig(
            "plugin directory cannot be resolved".to_owned(),
        ));
    };
    let Ok(candidate) = candidate.canonicalize() else {
        return Some(HookHealth::MissingCommand(candidate.display().to_string()));
    };
    if !candidate.starts_with(root) {
        return Some(HookHealth::InvalidConfig(
            "relative hook command escapes plugin directory".to_owned(),
        ));
    }
    executable_health(&candidate)
}

#[cfg(unix)]
fn executable_health(path: &Path) -> Option<HookHealth> {
    use std::os::unix::fs::PermissionsExt;
    match fs::metadata(path) {
        Ok(metadata) if metadata.permissions().mode() & 0o111 != 0 => None,
        Ok(_) => Some(HookHealth::NotExecutable(path.display().to_string())),
        Err(_) => Some(HookHealth::MissingCommand(path.display().to_string())),
    }
}

#[cfg(not(unix))]
fn executable_health(_path: &Path) -> Option<HookHealth> {
    None
}

fn write_plugin_files(
    directory: &Path,
    manifest: &HookPluginManifest,
    config: &HooksConfig,
) -> Result<(), String> {
    validate_plugin_id(&manifest.id)?;
    for group in &config.post_tool_use {
        Regex::new(&group.matcher).map_err(|error| error.to_string())?;
        for hook in &group.hooks {
            validate_hook(hook)?;
        }
    }
    atomic_json_write(&directory.join("plugin.json"), manifest)?;
    atomic_json_write(&directory.join("hooks.json"), config)
}

fn read_json<T: serde::de::DeserializeOwned>(path: PathBuf) -> Result<T, String> {
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_JSON_BYTES {
        return Err(format!("{} exceeds 1 MiB", path.display()));
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())
}

fn atomic_json_write<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("path has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(
        ".{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn copy_directory(source: &Path, destination: &Path, root: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            return Err("hook installation does not allow symbolic links".to_owned());
        }
        let source_path = entry
            .path()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !source_path.starts_with(root) {
            return Err("hook installation path escapes source directory".to_owned());
        }
        let destination_path = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&source_path, &destination_path, root)?;
        } else if file_type.is_file() {
            fs::copy(source_path, destination_path).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("plugin id must use lowercase letters, digits, and hyphens".to_owned());
    }
    Ok(())
}
fn validate_hook(config: &CommandHookConfig) -> Result<(), String> {
    if config.handler_type != "command" {
        return Err(format!("unsupported hook type: {}", config.handler_type));
    }
    if config.command.trim().is_empty() && config.commands.is_empty() {
        return Err("hook command and platform commands are empty".to_owned());
    }
    for (target, command) in &config.commands {
        if !valid_platform_target(target) {
            return Err(format!("invalid hook platform target: {target}"));
        }
        if command.trim().is_empty() {
            return Err(format!(
                "hook command is empty for platform target: {target}"
            ));
        }
    }
    if !(1..=MAX_TIMEOUT_SECONDS).contains(&config.timeout) {
        return Err(format!(
            "hook timeout must be between 1 and {MAX_TIMEOUT_SECONDS}"
        ));
    }
    Ok(())
}

fn selected_command(config: &CommandHookConfig) -> &str {
    let target = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    if let Some(command) = config.commands.get(&target) {
        return command;
    }
    if cfg!(windows) {
        config.command_windows.as_deref().unwrap_or(&config.command)
    } else {
        &config.command
    }
}

fn valid_platform_target(target: &str) -> bool {
    matches!(
        target,
        "macos-aarch64"
            | "macos-x86_64"
            | "linux-aarch64"
            | "linux-x86_64"
            | "windows-aarch64"
            | "windows-x86_64"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn validates_supported_platform_commands() {
        let mut hook = CommandHookConfig {
            handler_type: "command".to_owned(),
            command: String::new(),
            command_windows: None,
            commands: [("macos-aarch64".to_owned(), "./bin/reporter".to_owned())]
                .into_iter()
                .collect(),
            timeout: 10,
            asynchronous: true,
            status_message: None,
        };

        assert!(validate_hook(&hook).is_ok());
        hook.commands
            .insert("freebsd-x86_64".to_owned(), "./bin/reporter".to_owned());
        assert_eq!(
            validate_hook(&hook).unwrap_err(),
            "invalid hook platform target: freebsd-x86_64"
        );
    }

    #[test]
    fn discovers_duplicates_as_unhealthy() {
        let home = tempdir().unwrap();
        let root = home.path().join("hooks/plugins");
        for name in ["one", "two"] {
            let dir = root.join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("plugin.json"),
                r#"{"schemaVersion":1,"id":"reporter","name":"Reporter","version":"1"}"#,
            )
            .unwrap();
            fs::write(dir.join("hooks.json"), r#"{"PostToolUse":[]}"#).unwrap();
        }
        let plugins = HookRegistryStore::new(home.path().to_path_buf()).discover();
        assert_eq!(plugins.len(), 2);
        assert!(plugins
            .iter()
            .all(|p| p.health == HookHealth::DuplicatePluginId));
    }
}
