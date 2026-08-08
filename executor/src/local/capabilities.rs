// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
    env, fs,
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    pin::Pin,
};

use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;
use toml_edit::{value, DocumentMut};

use crate::{config::device::DeviceConfig, protocol::ExecutionRequest};

mod support;

use support::*;

const MANIFEST_VERSION: i64 = 1;
const DEFAULT_NAMESPACE: &str = "default";
const DEFAULT_PLUGIN_MARKETPLACE: &str = "wegent";
const LOCAL_USER_SOURCE: &str = "local_user";
const WEGENT_SOURCE: &str = "wegent";

fn replace_codex_config(path: &Path, content: &str) -> Result<(), CapabilitySyncError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(content.as_bytes())?;
    temporary.as_file().sync_all()?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(temporary.path(), metadata.permissions())?;
    }
    #[cfg(unix)]
    if !path.exists() {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600))?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[derive(Debug, Error)]
pub enum CapabilitySyncError {
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("{0}")]
    InvalidPayload(String),
    #[error("Plugin checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },
}

impl CapabilitySyncError {
    pub fn invalid_payload(message: impl Into<String>) -> Self {
        Self::InvalidPayload(message.into())
    }
}

pub trait CapabilityPackageProvider {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>>;

    fn download_plugin<'a>(
        &'a self,
        download_path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>>;
}

pub trait CapabilityPluginRuntime: Send + Sync {
    fn install_plugin<'a>(
        &'a self,
        spec: &'a PluginSyncSpec,
        marketplace_path: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>>;

    fn uninstall_plugin<'a>(
        &'a self,
        name: &'a str,
        marketplace: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct NoopPackageProvider;

impl CapabilityPackageProvider for NoopPackageProvider {
    fn stage_skill<'a>(
        &'a self,
        spec: &'a SkillSyncSpec,
        _target: &'a Path,
    ) -> Pin<Box<dyn Future<Output = Result<(), CapabilitySyncError>> + Send + 'a>> {
        let result = Err(CapabilitySyncError::invalid_payload(format!(
            "No package provider configured for skill {}",
            spec.name
        )));
        Box::pin(std::future::ready(result))
    }

    fn download_plugin<'a>(
        &'a self,
        download_path: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        let result = Err(CapabilitySyncError::invalid_payload(format!(
            "No package provider configured for plugin download {download_path}",
        )));
        Box::pin(std::future::ready(result))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillSyncSpec {
    pub name: String,
    pub skill_id: i64,
    pub namespace: String,
    pub is_public: bool,
    pub content_hash: Option<String>,
}

impl SkillSyncSpec {
    fn from_value(value: &Value) -> Result<Self, CapabilitySyncError> {
        let name = value_string(value.get("name"))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill name is required"))?;
        let skill_id = value_i64(value.get("skill_id").or_else(|| value.get("id")))
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill id is required"))?;
        let namespace = value_string(value.get("namespace"))
            .filter(|namespace| !namespace.is_empty())
            .unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned());
        let is_public = value
            .get("is_public")
            .or_else(|| value.get("isPublic"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let content_hash = value
            .get("content_hash")
            .or_else(|| value.get("contentHash"))
            .or_else(|| value.get("file_hash"))
            .or_else(|| value.get("fileHash"))
            .and_then(Value::as_str)
            .map(normalize_content_hash);
        Ok(Self {
            name,
            skill_id,
            namespace,
            is_public,
            content_hash,
        })
    }

    fn store_dir_name(&self) -> String {
        format!("{}-{}-{}", self.skill_id, self.namespace, self.name)
    }
}

fn normalize_content_hash(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.starts_with("sha256:") {
        trimmed.to_owned()
    } else {
        format!("sha256:{trimmed}")
    }
}

#[derive(Debug, Clone)]
pub struct PluginSyncSpec {
    pub name: String,
    key: String,
    installed_plugin_id: Option<i64>,
    pub marketplace: String,
    pub enabled: bool,
    version: String,
    checksum: Option<String>,
    download_path: Option<String>,
    component_states: Value,
}

impl PluginSyncSpec {
    fn from_value(value: &Value) -> Result<Self, CapabilitySyncError> {
        let name = value_string(value.get("name"))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Plugin name is required"))?;
        let source = value.get("source");
        let marketplace = value_string(value.get("marketplace"))
            .or_else(|| source.and_then(|source| value_string(source.get("marketplace"))))
            .or_else(|| {
                source
                    .and_then(|source| value_string(source.get("type")))
                    .filter(|source_type| source_type == "upload")
                    .map(|_| DEFAULT_PLUGIN_MARKETPLACE.to_owned())
            })
            .unwrap_or_else(|| DEFAULT_PLUGIN_MARKETPLACE.to_owned());
        let version = value_string(value.get("version")).unwrap_or_else(|| "latest".to_owned());
        let installed_plugin_id =
            value_i64(value.get("installed_plugin_id").or_else(|| value.get("id")));
        let key = format!("{name}@{marketplace}");
        Ok(Self {
            name,
            key,
            installed_plugin_id,
            marketplace,
            enabled: value
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            version,
            checksum: value_string(value.get("checksum")),
            download_path: value_string(value.get("download_path")),
            component_states: value
                .get("component_states")
                .or_else(|| value.get("componentStates"))
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        })
    }

    fn store_dir_name(&self) -> Option<String> {
        self.installed_plugin_id.map(|plugin_id| {
            format!(
                "{}-{}-{}-{}",
                plugin_id, self.marketplace, self.name, self.version
            )
        })
    }

    fn from_manifest_entry(key: &str, plugin: &Value) -> Self {
        Self {
            name: value_string(plugin.get("name"))
                .or_else(|| key.split_once('@').map(|(name, _)| name.to_owned()))
                .unwrap_or_else(|| key.to_owned()),
            key: key.to_owned(),
            installed_plugin_id: value_i64(plugin.get("installed_plugin_id")),
            marketplace: value_string(plugin.get("marketplace"))
                .or_else(|| {
                    key.split_once('@')
                        .map(|(_, marketplace)| marketplace.to_owned())
                })
                .unwrap_or_else(|| DEFAULT_PLUGIN_MARKETPLACE.to_owned()),
            enabled: plugin
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            version: value_string(plugin.get("version")).unwrap_or_else(|| "latest".to_owned()),
            checksum: value_string(plugin.get("checksum")),
            download_path: None,
            component_states: plugin
                .get("component_states")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new())),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedCapabilityManifest {
    pub path: PathBuf,
}

impl ManagedCapabilityManifest {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn load(&self) -> Result<Value, CapabilitySyncError> {
        if !self.path.exists() {
            return Ok(default_manifest());
        }
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&self.path)?)?;
        normalize_manifest(&mut value);
        Ok(value)
    }

    pub fn save(&self, mut value: Value) -> Result<(), CapabilitySyncError> {
        normalize_manifest(&mut value);
        write_json(&self.path, &value)
    }

    fn save_with_revision_bump(&self, mut value: Value) -> Result<(), CapabilitySyncError> {
        normalize_manifest(&mut value);
        let revision = value
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            + 1;
        value["revision"] = json!(revision);
        write_json(&self.path, &value)
    }
}

#[derive(Debug, Clone)]
pub struct GlobalCapabilityStore {
    pub manifest: ManagedCapabilityManifest,
    pub skills_dir: PathBuf,
    pub codex_skills_dir: PathBuf,
    pub plugins_dir: PathBuf,
    pub codex_plugins_dir: PathBuf,
    pub store_dir: PathBuf,
    plugin_store_dir_override: Option<PathBuf>,
}

impl GlobalCapabilityStore {
    pub fn new(manifest_path: impl Into<PathBuf>, skills_dir: impl Into<PathBuf>) -> Self {
        let skills_dir = skills_dir.into();
        let base = infer_home_from_runtime_dir(&skills_dir, "skills");
        Self {
            manifest: ManagedCapabilityManifest::new(manifest_path),
            skills_dir: skills_dir.clone(),
            codex_skills_dir: base.join(".codex/skills"),
            plugins_dir: base.join(".claude/plugins"),
            codex_plugins_dir: base.join(".codex/plugins"),
            // Skills stay on the legacy store root. Plugin packages use plugin_store_dir()
            // (manifest-adjacent) so marketplace installs follow WEGENT_EXECUTOR_HOME.
            store_dir: base.join(".wegent-executor/capabilities/store"),
            plugin_store_dir_override: None,
        }
    }

    pub fn with_manifest(mut self, manifest: ManagedCapabilityManifest) -> Self {
        self.manifest = manifest;
        self
    }

    pub fn with_codex_skills_dir(mut self, codex_skills_dir: impl Into<PathBuf>) -> Self {
        self.codex_skills_dir = codex_skills_dir.into();
        self
    }

    pub fn with_plugins_dir(mut self, plugins_dir: impl Into<PathBuf>) -> Self {
        self.plugins_dir = plugins_dir.into();
        self
    }

    pub fn with_codex_plugins_dir(mut self, codex_plugins_dir: impl Into<PathBuf>) -> Self {
        self.codex_plugins_dir = codex_plugins_dir.into();
        self
    }

    pub fn with_store_dir(mut self, store_dir: impl Into<PathBuf>) -> Self {
        let store_dir = store_dir.into();
        self.store_dir = store_dir.clone();
        // Tests isolate both skill and plugin packages under one temp store.
        self.plugin_store_dir_override = Some(store_dir);
        self
    }

    pub fn record_skill(&self, skill: Value) -> Result<(), CapabilitySyncError> {
        let mut manifest = self.manifest.load()?;
        let name = value_string(skill.get("name"))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill name is required"))?;
        let skill_id = value_i64(skill.get("skill_id").or_else(|| skill.get("id")))
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill id is required"))?;
        let namespace = value_string(skill.get("namespace"))
            .filter(|namespace| !namespace.is_empty())
            .unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned());
        ensure_object_field(&mut manifest, "skills").insert(
            name.clone(),
            json!({
                "managed": true,
                "name": name,
                "skill_id": skill_id,
                "namespace": namespace,
                "updated_at": now_rfc3339_like(),
            }),
        );
        self.manifest.save_with_revision_bump(manifest)
    }

    pub fn reconcile_managed_plugins(&self) -> Result<Vec<String>, CapabilitySyncError> {
        let mut manifest = self.load_manifest_with_plugin_store_migration()?;
        let mut restored = Vec::new();
        let plugins = object_map(manifest.get("plugins")).unwrap_or_default();
        for (key, plugin) in plugins {
            if plugin.get("managed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let spec = PluginSyncSpec {
                name: value_string(plugin.get("name"))
                    .or_else(|| key.split_once('@').map(|(name, _)| name.to_owned()))
                    .unwrap_or_else(|| key.clone()),
                key: key.clone(),
                installed_plugin_id: value_i64(plugin.get("installed_plugin_id")),
                marketplace: value_string(plugin.get("marketplace"))
                    .or_else(|| {
                        key.split_once('@')
                            .map(|(_, marketplace)| marketplace.to_owned())
                    })
                    .unwrap_or_else(|| DEFAULT_PLUGIN_MARKETPLACE.to_owned()),
                enabled: plugin
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                version: value_string(plugin.get("version")).unwrap_or_else(|| "latest".to_owned()),
                checksum: value_string(plugin.get("checksum")),
                download_path: None,
                component_states: plugin
                    .get("component_states")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new())),
            };
            let Some(store_path) = value_string(plugin.get("store_path")).map(PathBuf::from) else {
                continue;
            };
            if !store_path.is_dir() {
                continue;
            }
            self.install_plugin_runtime_metadata(&spec, &store_path, &mut manifest)?;
            self.install_marketplace_metadata(&spec, &store_path)?;
            restored.push(key);
        }
        self.manifest.save_with_revision_bump(manifest)?;
        Ok(restored)
    }

    pub fn reconcile_managed_claude_plugins(&self) -> Result<Vec<String>, CapabilitySyncError> {
        let manifest = self.load_manifest_with_plugin_store_migration()?;
        let mut restored = Vec::new();
        let plugins = object_map(manifest.get("plugins")).unwrap_or_default();
        for (key, plugin) in plugins {
            if plugin.get("managed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let managed_runtime = plugin
                .get("runtime")
                .and_then(|runtime| value_string(runtime.get("claude_link")))
                .map(PathBuf::from);
            if !managed_runtime
                .as_ref()
                .is_some_and(|path| path.starts_with(&self.plugins_dir))
            {
                continue;
            }
            let Some(store_path) = value_string(plugin.get("store_path")).map(PathBuf::from) else {
                continue;
            };
            if !store_path.is_dir() {
                continue;
            }
            let manifests_changed = ensure_dual_plugin_manifests(&store_path)?;
            let spec = PluginSyncSpec::from_manifest_entry(&key, &plugin);
            let runtime_path = self.plugin_runtime_link(&spec);
            if manifests_changed || !runtime_path.is_dir() || runtime_path.is_symlink() {
                copy_dir_atomic(&store_path, &runtime_path)?;
                restored.push(key.clone());
            }
            ensure_plugin_hook_permissions(&runtime_path)?;
            self.install_marketplace_metadata(&spec, &store_path)?;
            let installed = read_installed_plugins(&self.plugins_dir)?;
            let registered = installed
                .get("plugins")
                .and_then(|plugins| plugins.get(&key))
                .and_then(Value::as_array)
                .and_then(|entries| entries.first())
                .and_then(|entry| value_string(entry.get("installPath")))
                .is_some_and(|path| Path::new(&path) == runtime_path);
            if !registered {
                upsert_installed_plugin(&self.plugins_dir, &spec, &runtime_path)?;
            }
            set_plugin_enabled(&self.plugins_dir, &key, spec.enabled)?;
        }
        Ok(restored)
    }

    fn load_manifest_with_plugin_store_migration(&self) -> Result<Value, CapabilitySyncError> {
        let mut manifest = self.manifest.load()?;
        let plugin_store_dir = self.plugin_store_dir();
        let (changed, legacy_paths) =
            rewrite_managed_plugin_store_paths(&mut manifest, &plugin_store_dir)?;
        if !changed {
            return Ok(manifest);
        }

        let revision = manifest
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            + 1;
        manifest["revision"] = json!(revision);
        write_plugin_manifest_atomic(&self.manifest.path, &manifest)?;

        for legacy_path in legacy_paths {
            remove_existing_path(&legacy_path)?;
            remove_empty_legacy_store_parents(&legacy_path, &plugin_store_dir)?;
        }
        write_plugin_store_layout_marker(&plugin_store_dir)?;
        Ok(manifest)
    }

    fn install_plugin_runtime_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let runtime_link = self.plugin_runtime_link(spec);
        let codex_link = self.plugin_codex_link(spec);
        let previous_runtime = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .and_then(|plugin| plugin.get("runtime"));
        let previous_runtime_link = previous_runtime
            .and_then(|runtime| value_string(runtime.get("claude_link")))
            .map(PathBuf::from);
        let previous_codex_link = previous_runtime
            .and_then(|runtime| value_string(runtime.get("codex_link")))
            .map(PathBuf::from);
        self.install_claude_plugin_runtime_metadata(spec, store_path)?;
        copy_dir_atomic(store_path, &codex_link)?;
        if let Some(previous_runtime_link) = previous_runtime_link {
            if previous_runtime_link != runtime_link {
                self.remove_claude_plugin_runtime_path(&previous_runtime_link)?;
            }
        }
        if let Some(previous_codex_link) = previous_codex_link {
            if previous_codex_link != codex_link
                && previous_codex_link.starts_with(&self.codex_plugins_dir)
            {
                self.remove_codex_plugin_runtime_path(&previous_codex_link)?;
            }
        }
        self.install_codex_marketplace_metadata(spec, store_path)?;
        let entry = plugin_manifest_entry(spec, store_path, &runtime_link, &codex_link);
        ensure_object_field(manifest, "plugins").insert(spec.key.clone(), entry);
        Ok(())
    }

    fn install_claude_plugin_runtime_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
    ) -> Result<(), CapabilitySyncError> {
        let runtime_path = self.plugin_runtime_link(spec);
        copy_dir_atomic(store_path, &runtime_path)?;
        self.install_marketplace_metadata(spec, store_path)?;
        upsert_installed_plugin(&self.plugins_dir, spec, &runtime_path)?;
        set_plugin_enabled(&self.plugins_dir, &spec.key, spec.enabled)
    }

    fn remove_claude_plugin_runtime_path(&self, path: &Path) -> Result<(), CapabilitySyncError> {
        if !path.starts_with(&self.plugins_dir) {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Managed Claude plugin path is outside the plugin directory: {}",
                path.display()
            )));
        }
        remove_existing_path(path)
    }

    fn remove_codex_plugin_runtime_path(&self, path: &Path) -> Result<(), CapabilitySyncError> {
        if !path.starts_with(&self.codex_plugins_dir) {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Managed Codex plugin path is outside the plugin directory: {}",
                path.display()
            )));
        }
        remove_existing_path(path)
    }

    fn install_codex_marketplace_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
    ) -> Result<(), CapabilitySyncError> {
        let marketplace_dir = self
            .codex_plugins_dir
            .join("marketplaces")
            .join(&spec.marketplace);
        let marketplace_link = marketplace_dir.join("plugins").join(&spec.name);
        link_or_copy_dir(store_path, &marketplace_link)?;

        let marketplace_json_path = marketplace_dir.join(".agents/plugins/marketplace.json");
        let mut marketplace = read_json_or_default(&marketplace_json_path, || json!({}))?;
        let root = ensure_root_object(&mut marketplace);
        root.insert("name".to_owned(), json!(spec.marketplace));
        root.insert("interface".to_owned(), json!({"displayName": "Wegent"}));
        upsert_marketplace_plugin(
            &mut marketplace,
            &spec.name,
            json!({
                "name": spec.name,
                "source": {
                    "source": "local",
                    "path": format!("./plugins/{}", spec.name),
                },
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                    "products": ["CODEX"],
                },
            }),
        )?;
        write_json(&marketplace_json_path, &marketplace)?;

        let config_path = self
            .codex_plugins_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("config.toml");
        let content = match fs::read_to_string(&config_path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        let mut document = content.parse::<DocumentMut>().map_err(|error| {
            CapabilitySyncError::invalid_payload(format!(
                "Invalid Codex config {}: {error}",
                config_path.display()
            ))
        })?;
        document["marketplaces"][&spec.marketplace]["source_type"] = value("local");
        document["marketplaces"][&spec.marketplace]["source"] =
            value(marketplace_dir.display().to_string());
        document["plugins"][&spec.key]["enabled"] = value(spec.enabled);
        let next_content = document.to_string();
        if next_content != content {
            replace_codex_config(&config_path, &next_content)?;
        }
        Ok(())
    }

    fn install_marketplace_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
    ) -> Result<(), CapabilitySyncError> {
        let marketplace_dir = self
            .plugins_dir
            .join("marketplaces")
            .join(&spec.marketplace);
        let marketplace_plugins_dir = marketplace_dir.join("plugins");
        let marketplace_link = marketplace_plugins_dir.join(plugin_codex_link_name(spec));
        link_or_copy_dir(store_path, &marketplace_link)?;

        let marketplace_source = json!({
            "source": "directory",
            "path": marketplace_dir.display().to_string(),
        });
        let mut known =
            read_json_or_default(&self.plugins_dir.join("known_marketplaces.json"), || {
                json!({})
            })?;
        ensure_root_object(&mut known).insert(
            spec.marketplace.clone(),
            json!({
                "source": marketplace_source,
                "installLocation": marketplace_dir.display().to_string(),
                "lastUpdated": chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        );
        write_json(&self.plugins_dir.join("known_marketplaces.json"), &known)?;

        let settings_path = self
            .plugins_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("settings.json");
        let mut settings = read_json_or_default(&settings_path, || json!({}))?;
        ensure_object_field(&mut settings, "extraKnownMarketplaces").insert(
            spec.marketplace.clone(),
            json!({"source": marketplace_source}),
        );
        write_json(&settings_path, &settings)?;

        let marketplace_json_path = marketplace_dir.join(".claude-plugin/marketplace.json");
        let mut marketplace = read_json_or_default(&marketplace_json_path, || json!({}))?;
        marketplace["$schema"] = json!("https://anthropic.com/claude-code/marketplace.schema.json");
        marketplace["name"] = json!(spec.marketplace);
        marketplace["description"] = json!("Plugins managed by Wegent.");
        marketplace["owner"] = json!({"name": "Wegent Team"});
        upsert_marketplace_plugin(
            &mut marketplace,
            &spec.name,
            json!({
                "description": "",
                "name": spec.name,
                "source": format!("./plugins/{}", plugin_codex_link_name(spec)),
                "version": spec.version,
            }),
        )?;
        write_json(&marketplace_json_path, &marketplace)?;

        let codex_marketplace_path = marketplace_dir.join(".agents/plugins/marketplace.json");
        let mut codex_marketplace = read_json_or_default(&codex_marketplace_path, || json!({}))?;
        let root = ensure_root_object(&mut codex_marketplace);
        root.insert("name".to_owned(), json!(spec.marketplace));
        root.insert("interface".to_owned(), json!({"displayName": "Wegent"}));
        upsert_marketplace_plugin(
            &mut codex_marketplace,
            &spec.name,
            json!({
                "name": spec.name,
                "source": {
                    "source": "local",
                    "path": format!("./plugins/{}", plugin_codex_link_name(spec)),
                },
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
            }),
        )?;
        write_json(&codex_marketplace_path, &codex_marketplace)
    }

    fn record_app_server_plugin(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        manifest: &mut Value,
    ) {
        ensure_object_field(manifest, "plugins").insert(
            spec.key.clone(),
            json!({
                "managed": true,
                "name": spec.name,
                "key": spec.key,
                "installed_plugin_id": spec.installed_plugin_id,
                "marketplace": spec.marketplace,
                "enabled": spec.enabled,
                "version": spec.version,
                "checksum": spec.checksum,
                "store_path": store_path.display().to_string(),
                "install_authority": "codex_app_server",
                "updated_at": now_rfc3339_like(),
            }),
        );
    }

    fn plugin_marketplace_manifest_path(&self, marketplace: &str) -> PathBuf {
        self.plugins_dir
            .join("marketplaces")
            .join(marketplace)
            .join(".agents/plugins/marketplace.json")
    }

    fn skill_store_path(&self, spec: &SkillSyncSpec) -> PathBuf {
        self.store_dir.join("skills").join(spec.store_dir_name())
    }

    fn plugin_store_path(&self, spec: &PluginSyncSpec) -> Option<PathBuf> {
        spec.store_dir_name()
            .map(|name| self.plugin_store_dir().join("plugins").join(name))
    }

    fn plugin_store_dir(&self) -> PathBuf {
        if let Some(store_dir) = &self.plugin_store_dir_override {
            return store_dir.clone();
        }
        self.manifest
            .path
            .parent()
            .map(|capabilities_dir| capabilities_dir.join("store"))
            .unwrap_or_else(|| PathBuf::from("store"))
    }

    fn plugin_runtime_link(&self, spec: &PluginSyncSpec) -> PathBuf {
        self.plugins_dir
            .join("cache")
            .join(&spec.marketplace)
            .join(&spec.name)
            .join(&spec.version)
    }

    fn plugin_codex_link(&self, spec: &PluginSyncSpec) -> PathBuf {
        self.codex_plugins_dir
            .join("cache")
            .join(&spec.marketplace)
            .join(&spec.name)
            .join(&spec.version)
    }
}

fn rewrite_managed_plugin_store_paths(
    manifest: &mut Value,
    canonical_store: &Path,
) -> Result<(bool, Vec<PathBuf>), CapabilitySyncError> {
    let mut changed = false;
    let mut migrated_paths = BTreeSet::new();
    let entries = ensure_object_field(manifest, "plugins");
    for entry in entries.values_mut() {
        if entry.get("managed").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(legacy_path) = value_string(entry.get("store_path")).map(PathBuf::from) else {
            continue;
        };
        if legacy_path.starts_with(canonical_store)
            || legacy_plugin_store_root(&legacy_path).is_none()
        {
            continue;
        }
        let Some(package_name) = legacy_path.file_name() else {
            continue;
        };
        let canonical_path = canonical_store.join("plugins").join(package_name);
        if legacy_path.is_dir() {
            copy_dir_atomic(&legacy_path, &canonical_path)?;
            migrated_paths.insert(legacy_path.clone());
        } else if !has_plugin_manifest(&canonical_path) {
            // Missing legacy packages must not permanently bind to an unverified
            // canonical leftover; leave the path for a later sync to recover.
            continue;
        } else if let Some(object) = entry.as_object_mut() {
            // Package was already relocated (for example by desktop home merge).
            // Drop the cached checksum so the next sync can revalidate content.
            object.remove("checksum");
        }
        entry["store_path"] = json!(canonical_path.display().to_string());
        changed = true;
    }
    Ok((changed, migrated_paths.into_iter().collect()))
}

fn legacy_plugin_store_root(path: &Path) -> Option<&Path> {
    let plugins_dir = path.parent()?;
    if plugins_dir.file_name()?.to_str()? != "plugins" {
        return None;
    }
    let store_dir = plugins_dir.parent()?;
    if store_dir.file_name()?.to_str()? != "store" {
        return None;
    }
    let capabilities_dir = store_dir.parent()?;
    (capabilities_dir.file_name()?.to_str()? == "capabilities").then_some(store_dir)
}

fn remove_empty_legacy_store_parents(
    legacy_path: &Path,
    canonical_store: &Path,
) -> Result<(), CapabilitySyncError> {
    let Some(store_dir) = legacy_path.parent().and_then(Path::parent) else {
        return Ok(());
    };
    if store_dir == canonical_store {
        return Ok(());
    }
    for directory in [legacy_path.parent(), Some(store_dir)]
        .into_iter()
        .flatten()
    {
        if directory.is_dir() && fs::read_dir(directory)?.next().is_none() {
            fs::remove_dir(directory)?;
        }
    }
    Ok(())
}

fn write_plugin_store_layout_marker(store_dir: &Path) -> Result<(), CapabilitySyncError> {
    write_json(
        &store_dir.join(".plugin-store-layout.json"),
        &json!({
            "version": 1,
            "authority": "manifest_executor_home",
        }),
    )
}

fn write_plugin_manifest_atomic(path: &Path, manifest: &Value) -> Result<(), CapabilitySyncError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut temporary, manifest)?;
    temporary.flush()?;
    temporary.as_file().sync_all()?;
    if let Ok(metadata) = fs::metadata(path) {
        fs::set_permissions(temporary.path(), metadata.permissions())?;
    }
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

pub struct CapabilitySyncHandler<P = NoopPackageProvider>
where
    P: CapabilityPackageProvider,
{
    auth_token: String,
    store: GlobalCapabilityStore,
    package_provider: P,
    plugin_runtime: Option<std::sync::Arc<dyn CapabilityPluginRuntime>>,
    sync_lock: AsyncMutex<()>,
}

impl CapabilitySyncHandler<NoopPackageProvider> {
    pub fn new(auth_token: impl Into<String>, store: GlobalCapabilityStore) -> Self {
        Self::with_package_provider(auth_token, store, NoopPackageProvider)
    }

    pub fn from_device_config(config: &DeviceConfig, store: GlobalCapabilityStore) -> Self {
        Self::new(config.connection.auth_token.trim().to_owned(), store)
    }
}

impl<P> CapabilitySyncHandler<P>
where
    P: CapabilityPackageProvider,
{
    pub fn with_package_provider(
        auth_token: impl Into<String>,
        store: GlobalCapabilityStore,
        package_provider: P,
    ) -> Self {
        Self {
            auth_token: auth_token.into(),
            store,
            package_provider,
            plugin_runtime: None,
            sync_lock: AsyncMutex::new(()),
        }
    }

    pub fn with_plugin_runtime<R>(mut self, runtime: R) -> Self
    where
        R: CapabilityPluginRuntime + 'static,
    {
        self.plugin_runtime = Some(std::sync::Arc::new(runtime));
        self
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub async fn apply_sync(&self, payload: Value) -> Result<Value, CapabilitySyncError> {
        let _sync_guard = self.sync_lock.lock().await;
        let mode = payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("merge");
        let skill_specs = value_array(payload.get("skills"))
            .into_iter()
            .map(|value| SkillSyncSpec::from_value(&value))
            .collect::<Result<Vec<_>, _>>()?;
        let plugin_specs = value_array(payload.get("plugins"))
            .into_iter()
            .map(|value| PluginSyncSpec::from_value(&value))
            .collect::<Result<Vec<_>, _>>()?;
        let mut manifest = if plugin_specs.is_empty() {
            self.store.manifest.load()?
        } else {
            self.store.load_manifest_with_plugin_store_migration()?
        };

        if mode == "replace" {
            let desired_skills = skill_specs
                .iter()
                .map(|spec| spec.name.clone())
                .collect::<BTreeSet<_>>();
            let desired_plugins = plugin_specs
                .iter()
                .map(|spec| spec.key.clone())
                .collect::<BTreeSet<_>>();
            self.remove_stale_managed_skills(&desired_skills, &mut manifest)?;
            self.remove_stale_managed_plugins(&desired_plugins, &mut manifest)
                .await?;
        }

        let mut skill_results = Vec::with_capacity(skill_specs.len());
        for spec in &skill_specs {
            skill_results.push(self.sync_skill(spec, &mut manifest).await);
        }
        let mut plugin_results = Vec::with_capacity(plugin_specs.len());
        for spec in &plugin_specs {
            plugin_results.push(self.sync_plugin(spec, &mut manifest).await);
        }
        self.record_mcps(payload.get("mcps"), mode, &mut manifest)?;
        self.store.manifest.save_with_revision_bump(manifest)?;
        let success = skill_results
            .iter()
            .chain(plugin_results.iter())
            .all(|result| result.get("status").and_then(Value::as_str) != Some("failed"));

        Ok(json!({
            "success": success,
            "skills": skill_results,
            "plugins": plugin_results,
        }))
    }

    pub fn extract_plugin_zip(
        &self,
        package: &[u8],
        install_path: &Path,
    ) -> Result<(), CapabilitySyncError> {
        extract_plugin_zip(package, install_path)
    }

    async fn sync_skill(&self, spec: &SkillSyncSpec, manifest: &mut Value) -> Value {
        match self.try_sync_skill(spec, manifest).await {
            Ok(()) => json!({"id": spec.skill_id, "name": spec.name, "status": "synced"}),
            Err(error) => json!({
                "id": spec.skill_id,
                "name": spec.name,
                "status": "failed",
                "error": error.to_string(),
            }),
        }
    }

    async fn try_sync_skill(
        &self,
        spec: &SkillSyncSpec,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let store_path = self.store.skill_store_path(spec);
        let runtime_link = self.store.skills_dir.join(&spec.name);
        let codex_link = self.store.codex_skills_dir.join(&spec.name);
        if runtime_link.exists()
            && !runtime_link.is_symlink()
            && !is_manifest_managed_skill(manifest, &spec.name)
        {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime Skill path is occupied by a local user item",
            ));
        }

        if !is_installed_skill_current(spec, &store_path, manifest) {
            remove_existing_path(&store_path)?;
            self.package_provider.stage_skill(spec, &store_path).await?;
        }
        link_or_copy_dir(&store_path, &runtime_link)?;
        link_or_copy_dir(&store_path, &codex_link)?;
        ensure_object_field(manifest, "skills").insert(
            spec.name.clone(),
            json!({
                "managed": true,
                "name": spec.name,
                "skill_id": spec.skill_id,
                "namespace": spec.namespace,
                "is_public": spec.is_public,
                "content_hash": spec.content_hash,
                "store_path": store_path.display().to_string(),
                "runtime": {
                    "claude_link": runtime_link.display().to_string(),
                    "codex_link": codex_link.display().to_string(),
                },
                "updated_at": now_rfc3339_like(),
            }),
        );
        Ok(())
    }

    async fn sync_plugin(&self, spec: &PluginSyncSpec, manifest: &mut Value) -> Value {
        match self.try_sync_plugin(spec, manifest).await {
            Ok(()) => match spec.installed_plugin_id {
                Some(id) => json!({"id": id, "name": spec.name, "status": "synced"}),
                None => json!({"name": spec.name, "status": "synced"}),
            },
            Err(error) => match spec.installed_plugin_id {
                Some(id) => json!({
                    "id": id,
                    "name": spec.name,
                    "status": "failed",
                    "error": error.to_string(),
                }),
                None => json!({
                    "name": spec.name,
                    "status": "failed",
                    "error": error.to_string(),
                }),
            },
        }
    }

    async fn try_sync_plugin(
        &self,
        spec: &PluginSyncSpec,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let Some(store_path) = self.store.plugin_store_path(spec) else {
            ensure_object_field(manifest, "plugins").insert(
                spec.key.clone(),
                json!({
                    "managed": true,
                    "name": spec.name,
                    "key": spec.key,
                    "marketplace": spec.marketplace,
                    "version": spec.version,
                    "updated_at": now_rfc3339_like(),
                }),
            );
            return Ok(());
        };
        let installed = read_installed_plugins(&self.store.plugins_dir)?;
        let previous_checksum = installed
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
            .and_then(|entry| value_string(entry.get("checksum")))
            .or_else(|| {
                manifest
                    .get("plugins")
                    .and_then(|plugins| plugins.get(&spec.key))
                    .and_then(|plugin| value_string(plugin.get("checksum")))
            });
        let should_download = spec.download_path.is_some()
            && (!has_plugin_manifest(&store_path)
                || spec.checksum.as_ref().is_some_and(|expected| {
                    previous_checksum
                        .as_ref()
                        .map(|previous| previous != expected)
                        .unwrap_or(true)
                }));

        if should_download {
            let download_path = spec.download_path.as_deref().unwrap_or_default();
            let package = self.package_provider.download_plugin(download_path).await?;
            if let Some(expected) = &spec.checksum {
                let actual = sha256_digest(&package);
                if &actual != expected {
                    return Err(CapabilitySyncError::ChecksumMismatch {
                        expected: expected.clone(),
                        actual,
                    });
                }
            }
            let backup_path = if store_path.exists() {
                Some(sibling_temp_path(&store_path).with_extension("rollback"))
            } else {
                None
            };
            if let Some(backup) = backup_path.as_ref() {
                if let Err(error) = copy_dir_recursive(&store_path, backup) {
                    if !store_path.is_dir() {
                        let _ = error;
                    }
                }
            }
            let extract_result = extract_plugin_zip(&package, &store_path);
            if let Err(error) = extract_result {
                if let Some(backup) = backup_path.as_ref() {
                    let _ = remove_existing_path(&store_path);
                    let _ = copy_dir_recursive(backup, &store_path);
                    let _ = remove_existing_path(backup);
                }
                return Err(error);
            }
            if let Some(runtime) = &self.plugin_runtime {
                self.store.install_marketplace_metadata(spec, &store_path)?;
                let marketplace_manifest_path = self
                    .store
                    .plugin_marketplace_manifest_path(&spec.marketplace);
                if let Err(error) = runtime
                    .install_plugin(spec, &marketplace_manifest_path)
                    .await
                {
                    if let Some(backup) = backup_path.as_ref() {
                        let _ = remove_existing_path(&store_path);
                        let _ = copy_dir_recursive(backup, &store_path);
                    } else {
                        let _ = remove_existing_path(&store_path);
                    }
                    if let Some(backup) = backup_path.as_ref() {
                        let _ = remove_existing_path(backup);
                    }
                    return Err(error);
                }
                self.store
                    .record_app_server_plugin(spec, &store_path, manifest);
            } else {
                self.store
                    .install_plugin_runtime_metadata(spec, &store_path, manifest)?;
            }
            if let Some(backup) = backup_path.as_ref() {
                let _ = remove_existing_path(backup);
            }
            return Ok(());
        } else if !has_plugin_manifest(&store_path) {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Plugin package {} is not available",
                spec.key
            )));
        }

        if let Some(runtime) = &self.plugin_runtime {
            self.store.install_marketplace_metadata(spec, &store_path)?;
            let marketplace_manifest_path = self
                .store
                .plugin_marketplace_manifest_path(&spec.marketplace);
            runtime
                .install_plugin(spec, &marketplace_manifest_path)
                .await?;
            self.store
                .record_app_server_plugin(spec, &store_path, manifest);
        } else {
            self.store
                .install_plugin_runtime_metadata(spec, &store_path, manifest)?;
        }
        Ok(())
    }

    fn remove_stale_managed_skills(
        &self,
        desired: &BTreeSet<String>,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let stale = object_map(manifest.get("skills"))
            .unwrap_or_default()
            .into_iter()
            .filter(|(name, skill)| {
                !desired.contains(name)
                    && skill.get("managed").and_then(Value::as_bool) != Some(false)
            })
            .collect::<Vec<_>>();
        for (name, skill) in stale {
            remove_runtime_link_from_value(skill.get("runtime"), "claude_link")?;
            remove_runtime_link_from_value(skill.get("runtime"), "codex_link")?;
            remove_managed_runtime_path(&self.store.skills_dir.join(&name))?;
            remove_managed_runtime_path(&self.store.codex_skills_dir.join(&name))?;
            ensure_object_field(manifest, "skills").remove(&name);
        }
        Ok(())
    }

    async fn remove_stale_managed_plugins(
        &self,
        desired: &BTreeSet<String>,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let stale = object_map(manifest.get("plugins"))
            .unwrap_or_default()
            .into_iter()
            .filter(|(key, plugin)| {
                !desired.contains(key)
                    && plugin.get("managed").and_then(Value::as_bool) != Some(false)
            })
            .collect::<Vec<_>>();
        if stale.is_empty() {
            return Ok(());
        }

        let mut installed = read_installed_plugins(&self.store.plugins_dir)?;
        let plugins = ensure_object_field(&mut installed, "plugins");
        for (key, plugin) in stale {
            if let Some(runtime) = &self.plugin_runtime {
                let name = value_string(plugin.get("name"))
                    .or_else(|| key.split_once('@').map(|(name, _)| name.to_owned()))
                    .unwrap_or_else(|| key.clone());
                let marketplace = value_string(plugin.get("marketplace"))
                    .or_else(|| {
                        key.split_once('@')
                            .map(|(_, marketplace)| marketplace.to_owned())
                    })
                    .unwrap_or_else(|| DEFAULT_PLUGIN_MARKETPLACE.to_owned());
                runtime.uninstall_plugin(&name, &marketplace).await?;
            }
            plugins.remove(&key);
            if let Some(runtime) = plugin.get("runtime") {
                if let Some(path) = value_string(runtime.get("claude_link")) {
                    remove_existing_path(Path::new(&path))?;
                }
                if let Some(path) = value_string(runtime.get("codex_link")) {
                    remove_existing_path(Path::new(&path))?;
                }
            }
            if let Some(store_path) = value_string(plugin.get("store_path")).map(PathBuf::from) {
                remove_existing_path(&store_path)?;
            }
            ensure_object_field(manifest, "plugins").remove(&key);
        }
        write_json(
            &self.store.plugins_dir.join("installed_plugins.json"),
            &installed,
        )?;
        Ok(())
    }

    fn record_mcps(
        &self,
        mcps: Option<&Value>,
        mode: &str,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        if mode == "replace" {
            manifest["mcps"] = Value::Object(Map::new());
        }
        for mcp in value_array(mcps) {
            let name = value_string(mcp.get("name"))
                .filter(|name| !name.is_empty())
                .ok_or_else(|| CapabilitySyncError::invalid_payload("MCP name is required"))?;
            let mut entry = mcp;
            entry["managed"] = json!(true);
            ensure_object_field(manifest, "mcps").insert(name, entry);
        }
        Ok(())
    }
}

fn is_installed_skill_current(spec: &SkillSyncSpec, store_path: &Path, manifest: &Value) -> bool {
    if !store_path.join("SKILL.md").is_file() {
        return false;
    }
    let Some(expected_hash) = spec.content_hash.as_deref() else {
        return true;
    };
    object_map(manifest.get("skills"))
        .and_then(|skills| skills.get(&spec.name).cloned())
        .and_then(|entry| {
            Some(
                value_i64(entry.get("skill_id"))? == spec.skill_id
                    && value_string(entry.get("namespace")).as_deref()
                        == Some(spec.namespace.as_str())
                    && value_string(entry.get("content_hash")).as_deref() == Some(expected_hash),
            )
        })
        .unwrap_or(false)
}

pub struct GlobalCapabilityReporter {
    skills_dir: PathBuf,
    plugins_dir: PathBuf,
    manifest: ManagedCapabilityManifest,
}

impl GlobalCapabilityReporter {
    pub fn new(
        skills_dir: impl Into<PathBuf>,
        plugins_dir: impl Into<PathBuf>,
        manifest: ManagedCapabilityManifest,
    ) -> Self {
        Self {
            skills_dir: skills_dir.into(),
            plugins_dir: plugins_dir.into(),
            manifest,
        }
    }

    pub fn build_report(&self, force_full: bool) -> Result<Value, CapabilitySyncError> {
        let manifest = self.manifest.load()?;
        let skills = self.report_skills(&manifest)?;
        let plugins = self.report_plugins(&manifest)?;
        let mcps = self.report_mcps(&manifest);
        let details = json!({
            "skills": skills,
            "plugins": plugins,
            "mcps": mcps,
        });
        Ok(json!({
            "revision": manifest.get("revision").and_then(Value::as_i64).unwrap_or_default(),
            "digest": sha256_json_digest(&details),
            "full": force_full,
            "skills": details["skills"].clone(),
            "plugins": details["plugins"].clone(),
            "mcps": details["mcps"].clone(),
            "last_sync_at": manifest.get("last_sync_at").cloned().unwrap_or(Value::Null),
        }))
    }

    fn report_skills(&self, manifest: &Value) -> Result<Vec<Value>, CapabilitySyncError> {
        let managed = object_map(manifest.get("skills")).unwrap_or_default();
        let mut output = Vec::new();
        for (name, skill) in &managed {
            if skill.get("managed").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let mut entry = Map::new();
            entry.insert("name".to_owned(), json!(name));
            if let Some(skill_id) = value_i64(skill.get("skill_id")) {
                entry.insert("skill_id".to_owned(), json!(skill_id));
            }
            if let Some(namespace) = value_string(skill.get("namespace")) {
                entry.insert("namespace".to_owned(), json!(namespace));
            }
            entry.insert("source".to_owned(), json!(WEGENT_SOURCE));
            output.push(Value::Object(entry));
        }

        for entry in sorted_dir_entries(&self.skills_dir)? {
            let path = entry.path();
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if managed.contains_key(name) {
                continue;
            }
            output.push(json!({"name": name, "source": LOCAL_USER_SOURCE}));
        }
        Ok(output)
    }

    fn report_mcps(&self, manifest: &Value) -> Vec<Value> {
        object_map(manifest.get("mcps"))
            .unwrap_or_default()
            .into_iter()
            .map(|(name, mcp)| {
                let mut entry = mcp.as_object().cloned().unwrap_or_default();
                entry.remove("managed");
                entry.insert("name".to_owned(), json!(name));
                entry.insert("source".to_owned(), json!(WEGENT_SOURCE));
                Value::Object(entry)
            })
            .collect()
    }

    fn report_plugins(&self, manifest: &Value) -> Result<Vec<Value>, CapabilitySyncError> {
        let installed = read_installed_plugins(&self.plugins_dir)?;
        let managed = object_map(manifest.get("plugins")).unwrap_or_default();
        let mut output = Vec::new();
        let plugins = object_map(installed.get("plugins")).unwrap_or_default();
        for (key, entries) in plugins {
            let Some(first) = entries.as_array().and_then(|entries| entries.first()) else {
                continue;
            };
            let (name, marketplace) = split_plugin_key(&key);
            let manifest_entry = managed.get(&key);
            let is_managed = manifest_entry
                .and_then(|entry| entry.get("managed"))
                .and_then(Value::as_bool)
                == Some(true);
            let install_path = value_string(first.get("installPath"))
                .map(PathBuf::from)
                .unwrap_or_default();
            let scan_path = if install_path.is_dir() {
                install_path
            } else {
                manifest_entry
                    .and_then(|entry| value_string(entry.get("store_path")))
                    .map(PathBuf::from)
                    .unwrap_or(install_path)
            };
            let mut entry = Map::new();
            entry.insert("name".to_owned(), json!(name));
            entry.insert("marketplace".to_owned(), json!(marketplace));
            entry.insert(
                "scope".to_owned(),
                first.get("scope").cloned().unwrap_or_else(|| json!("user")),
            );
            if let Some(version) = value_string(first.get("version"))
                .or_else(|| manifest_entry.and_then(|entry| value_string(entry.get("version"))))
            {
                entry.insert("version".to_owned(), json!(version));
            }
            entry.insert(
                "source".to_owned(),
                json!(if is_managed {
                    WEGENT_SOURCE
                } else {
                    LOCAL_USER_SOURCE
                }),
            );
            if let Some(installed_at) = value_string(first.get("installedAt")) {
                entry.insert("installed_at".to_owned(), json!(installed_at));
            }
            if let Some(last_updated) = value_string(first.get("lastUpdated")) {
                entry.insert("last_updated".to_owned(), json!(last_updated));
            }
            entry.insert(
                "skills".to_owned(),
                Value::Array(scan_plugin_skills(&scan_path)?),
            );
            if is_managed {
                if let Some(installed_plugin_id) =
                    manifest_entry.and_then(|entry| value_i64(entry.get("installed_plugin_id")))
                {
                    entry.insert("installed_plugin_id".to_owned(), json!(installed_plugin_id));
                }
            }
            output.push(Value::Object(entry));
        }
        Ok(output)
    }
}

pub fn default_manifest_path() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"))
        .join("capabilities/manifest.json")
}

pub fn restore_enabled_claude_plugin_cache(
    config_dir: &Path,
) -> Result<Vec<String>, CapabilitySyncError> {
    let plugins_dir = config_dir.join("plugins");
    let executor_home = env::var_os("WEGENT_EXECUTOR_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            config_dir
                .parent()
                .map(|home| home.join(".wegent-executor"))
        })
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"));
    let store = GlobalCapabilityStore::new(
        executor_home.join("capabilities/manifest.json"),
        config_dir.join("skills"),
    )
    .with_plugins_dir(plugins_dir.clone());
    let mut restored = store.reconcile_managed_claude_plugins()?;
    let settings = read_json_or_default(&config_dir.join("settings.json"), || json!({}))?;
    let enabled_plugins = object_map(settings.get("enabledPlugins")).unwrap_or_default();
    if enabled_plugins.is_empty() {
        return Ok(Vec::new());
    }

    let installed = read_installed_plugins(&plugins_dir)?;
    let installed_plugins = object_map(installed.get("plugins")).unwrap_or_default();

    for (key, enabled) in enabled_plugins {
        if enabled.as_bool() != Some(true) {
            continue;
        }
        let Some(first) = installed_plugins
            .get(&key)
            .and_then(Value::as_array)
            .and_then(|entries| entries.first())
        else {
            continue;
        };
        let Some(install_path) = value_string(first.get("installPath")).map(PathBuf::from) else {
            continue;
        };
        if install_path.is_dir() {
            ensure_plugin_hook_permissions(&install_path)?;
            continue;
        }

        let (name, marketplace) = split_plugin_key(&key);
        let Some(zip_path) = cached_plugin_zip_path(&plugins_dir, &name, &marketplace) else {
            continue;
        };
        let package = fs::read(&zip_path)?;
        extract_plugin_zip(&package, &install_path)?;
        restored.push(key);
    }

    Ok(restored)
}

fn cached_plugin_zip_path(plugins_dir: &Path, name: &str, marketplace: &str) -> Option<PathBuf> {
    let cache_dir = plugins_dir.join("cache");
    let marketplace_zip = cache_dir.join(marketplace).join(format!("{name}.zip"));
    if marketplace_zip.is_file() {
        return Some(marketplace_zip);
    }

    let Ok(entries) = fs::read_dir(cache_dir) else {
        return None;
    };
    let mut candidates = entries
        .flatten()
        .map(|entry| entry.path().join(format!("{name}.zip")))
        .filter(|path| path.is_file())
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

pub fn get_project_id(request: &ExecutionRequest) -> String {
    let standalone = request
        .extra
        .get("standalone_chat_workspace")
        .or_else(|| request.extra.get("standaloneChatWorkspace"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let project_id = value_string(request.extra.get("project_id"))
        .or_else(|| value_string(request.extra.get("projectId")))
        .or_else(|| value_path_string(&request.extra, &["workspace", "project", "project_id"]))
        .or_else(|| value_path_string(&request.extra, &["workspace", "project", "projectId"]));
    let Some(project_id) = project_id.map(|value| value.trim().to_owned()) else {
        return String::new();
    };
    if project_id.is_empty() || (!standalone && project_id == "0") {
        String::new()
    } else {
        project_id
    }
}

pub fn is_project_task(request: &ExecutionRequest) -> bool {
    !get_project_id(request).is_empty()
}
