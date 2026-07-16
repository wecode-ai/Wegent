// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeSet,
    env, fs,
    future::Future,
    io,
    path::{Path, PathBuf},
    pin::Pin,
};

use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;

use crate::{config::device::DeviceConfig, protocol::ExecutionRequest};

mod support;

use support::*;

const MANIFEST_VERSION: i64 = 1;
const DEFAULT_NAMESPACE: &str = "default";
const DEFAULT_PLUGIN_MARKETPLACE: &str = "wegent";
const LOCAL_USER_SOURCE: &str = "local_user";
const WEGENT_SOURCE: &str = "wegent";

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
struct PluginSyncSpec {
    name: String,
    key: String,
    installed_plugin_id: Option<i64>,
    marketplace: String,
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
            store_dir: base.join(".wegent-executor/capabilities/store"),
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
        self.store_dir = store_dir.into();
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
        let mut manifest = self.manifest.load()?;
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

    fn install_plugin_runtime_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        let runtime_link = self.plugin_runtime_link(spec);
        let codex_link = self.plugin_codex_link(spec);
        link_or_copy_dir(store_path, &runtime_link)?;
        link_or_copy_dir(store_path, &codex_link)?;
        upsert_installed_plugin(&self.plugins_dir, spec, &runtime_link)?;
        enable_plugin(&self.plugins_dir, &spec.key)?;
        let entry = plugin_manifest_entry(spec, store_path, &runtime_link, &codex_link);
        ensure_object_field(manifest, "plugins").insert(spec.key.clone(), entry);
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

        let mut known =
            read_json_or_default(&self.plugins_dir.join("known_marketplaces.json"), || {
                json!({})
            })?;
        ensure_root_object(&mut known).insert(
            spec.marketplace.clone(),
            json!({"installLocation": marketplace_dir.display().to_string()}),
        );
        write_json(&self.plugins_dir.join("known_marketplaces.json"), &known)?;

        let marketplace_json_path = marketplace_dir.join(".claude-plugin/marketplace.json");
        write_json(
            &marketplace_json_path,
            &json!({
                "plugins": [{
                    "description": "",
                    "name": spec.name,
                    "source": format!("./plugins/{}", plugin_codex_link_name(spec)),
                    "version": spec.version,
                }]
            }),
        )
    }

    fn skill_store_path(&self, spec: &SkillSyncSpec) -> PathBuf {
        self.store_dir.join("skills").join(spec.store_dir_name())
    }

    fn plugin_store_path(&self, spec: &PluginSyncSpec) -> Option<PathBuf> {
        spec.store_dir_name()
            .map(|name| self.store_dir.join("plugins").join(name))
    }

    fn plugin_runtime_link(&self, spec: &PluginSyncSpec) -> PathBuf {
        self.plugins_dir
            .join("cache")
            .join(&spec.marketplace)
            .join(&spec.name)
            .join(&spec.version)
    }

    fn plugin_codex_link(&self, spec: &PluginSyncSpec) -> PathBuf {
        self.codex_plugins_dir.join(plugin_codex_link_name(spec))
    }
}

pub struct CapabilitySyncHandler<P = NoopPackageProvider>
where
    P: CapabilityPackageProvider,
{
    auth_token: String,
    store: GlobalCapabilityStore,
    package_provider: P,
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
            sync_lock: AsyncMutex::new(()),
        }
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub async fn apply_sync(&self, payload: Value) -> Result<Value, CapabilitySyncError> {
        let _sync_guard = self.sync_lock.lock().await;
        let mut manifest = self.store.manifest.load()?;
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
            self.remove_stale_managed_plugins(&desired_plugins, &mut manifest)?;
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
            && (!store_path.join(".claude-plugin/plugin.json").is_file()
                || spec
                    .checksum
                    .as_ref()
                    .zip(previous_checksum.as_ref())
                    .is_some_and(|(expected, previous)| expected != previous));

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
            extract_plugin_zip(&package, &store_path)?;
        } else if !store_path.join(".claude-plugin/plugin.json").is_file() {
            return Err(CapabilitySyncError::invalid_payload(format!(
                "Plugin package {} is not available",
                spec.key
            )));
        }

        self.store
            .install_plugin_runtime_metadata(spec, &store_path, manifest)?;
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

    fn remove_stale_managed_plugins(
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
            plugins.remove(&key);
            remove_runtime_link_from_value(plugin.get("runtime"), "claude_link")?;
            remove_runtime_link_from_value(plugin.get("runtime"), "codex_link")?;
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
    let settings = read_json_or_default(&config_dir.join("settings.json"), || json!({}))?;
    let enabled_plugins = object_map(settings.get("enabledPlugins")).unwrap_or_default();
    if enabled_plugins.is_empty() {
        return Ok(Vec::new());
    }

    let installed = read_installed_plugins(&plugins_dir)?;
    let installed_plugins = object_map(installed.get("plugins")).unwrap_or_default();
    let mut restored = Vec::new();

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
