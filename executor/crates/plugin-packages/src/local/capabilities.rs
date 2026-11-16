// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    future::Future,
    io::{self, Write},
    path::{Path, PathBuf},
    pin::Pin,
};

use serde_json::{json, Map, Value};
use thiserror::Error;
use tokio::sync::Mutex as AsyncMutex;
use toml_edit::{value, DocumentMut, Item};

use crate::{
    config::device::DeviceConfig, protocol::ExecutionRequest,
    services::workbench::PackageRecoveryError,
};

use super::personal_marketplace_lock::acquire_personal_marketplace_lock;

mod transaction;
use transaction::LocalPluginStateTransaction;
mod manifest;
use manifest::write_plugin_manifest_atomic;
mod store;
use store::legacy_plugin_store_root;
mod cleanup;
mod sync_handler;
use cleanup::{
    is_installed_skill_current, prune_unreferenced_marketplace_plugins,
    remove_marketplace_plugin_entry, remove_unreferenced_cloud_plugin_cache,
    remove_unreferenced_marketplace_links, remove_unreferenced_store_packages,
};
mod report;
mod restore;
pub use restore::{
    restore_enabled_claude_plugin_cache, restore_enabled_claude_plugin_cache_with_manifest,
};
mod activation_revision;
mod manifest_migration;
mod plugin_preparation;
mod plugin_skills;
mod plugin_sync_protocol;
mod runtime_recovery;
mod runtime_skill_config;
mod shared_packages;
mod support;

use plugin_skills::scan_plugin_skills;
pub use runtime_recovery::PluginRuntimeRecoveryReport;
use support::*;

const MANIFEST_VERSION: i64 = 1;
const DEFAULT_NAMESPACE: &str = "default";
const DEFAULT_PLUGIN_MARKETPLACE: &str = "wegent";
const LOCAL_USER_SOURCE: &str = "local_user";
const WEGENT_SOURCE: &str = "wegent";
const CLOUD_MANAGED_PLUGIN_MARKETPLACES: [&str; 2] = ["wegent", "wework"];
const PERSONAL_SHARED_PLUGIN_MARKETPLACE: &str = "wework-personal";
const RECONCILABLE_PLUGIN_MARKETPLACES: [&str; 3] =
    ["wegent", "wework", PERSONAL_SHARED_PLUGIN_MARKETPLACE];

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

fn remove_toml_keys(item: &mut Item, keys: &BTreeSet<String>) -> bool {
    if item.is_inline_table() {
        let Some(table) = item.as_inline_table_mut() else {
            return false;
        };
        let mut changed = false;
        for key in keys {
            changed |= table.remove(key).is_some();
        }
        return changed;
    }
    let Some(table) = item.as_table_mut() else {
        return false;
    };
    let mut changed = false;
    for key in keys {
        changed |= table.remove(key).is_some();
    }
    changed
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
    #[error("{0}")]
    PluginPackageBusy(String),
    #[error("Plugin checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },
}

impl CapabilitySyncError {
    pub fn invalid_payload(message: impl Into<String>) -> Self {
        Self::InvalidPayload(message.into())
    }
}

impl From<PackageRecoveryError> for CapabilitySyncError {
    fn from(error: PackageRecoveryError) -> Self {
        match error {
            busy @ PackageRecoveryError::Busy => Self::PluginPackageBusy(busy.to_string()),
            PackageRecoveryError::Invalid(message) => Self::invalid_payload(message),
        }
    }
}

#[derive(Debug)]
struct PluginSyncFailure {
    stage: &'static str,
    error_code: &'static str,
    retryable: bool,
    error: CapabilitySyncError,
}

impl PluginSyncFailure {
    fn new(
        stage: &'static str,
        error_code: &'static str,
        retryable: bool,
        error: CapabilitySyncError,
    ) -> Self {
        Self {
            stage,
            error_code,
            retryable,
            error,
        }
    }

    fn runtime_metadata(error: CapabilitySyncError) -> Self {
        if matches!(&error, CapabilitySyncError::PluginPackageBusy(_)) {
            return Self::new("package", "PLUGIN_PACKAGE_BUSY", true, error);
        }
        if error.to_string().contains("Invalid Codex config") {
            return Self::new("codex_config", "INVALID_CODEX_CONFIG", false, error);
        }
        Self::new(
            "runtime_metadata",
            "PLUGIN_RUNTIME_METADATA_FAILED",
            false,
            error,
        )
    }
}

pub trait CapabilityPackageProvider {
    fn download_skill<'a>(
        &'a self,
        _spec: &'a SkillSyncSpec,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<u8>, CapabilitySyncError>> + Send + 'a>> {
        Box::pin(std::future::ready(Err(
            CapabilitySyncError::invalid_payload(
                "Package provider must supply skill archive bytes for shared storage",
            ),
        )))
    }

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
    pub bind_shells: Vec<String>,
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
        shared_packages::validate_component(&name)?;
        shared_packages::validate_component(&namespace)?;
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
            bind_shells: value
                .get("bind_shells")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
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
    cloud_plugin_id: Option<i64>,
    pub marketplace: String,
    pub enabled: bool,
    version: String,
    checksum: Option<String>,
    download_path: Option<String>,
    component_states: Value,
    sync_generation: Option<u64>,
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
        for component in [&name, &marketplace, &version] {
            shared_packages::validate_component(component)?;
        }
        let installed_plugin_id =
            value_i64(value.get("installed_plugin_id").or_else(|| value.get("id")));
        let cloud_plugin_id = value_i64(
            value
                .get("cloud_plugin_id")
                .or_else(|| value.get("cloudPluginId"))
                .or_else(|| source.and_then(|source| source.get("catalogItemId"))),
        );
        let key = format!("{name}@{marketplace}");
        Ok(Self {
            name,
            key,
            installed_plugin_id,
            cloud_plugin_id,
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
            sync_generation: None,
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
            cloud_plugin_id: value_i64(plugin.get("cloud_plugin_id")),
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
            sync_generation: plugin.get("plugin_sync_generation").and_then(Value::as_u64),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ManagedCapabilityManifest {
    pub path: PathBuf,
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
    shared_packages: bool,
    codex_only_plugins: bool,
    workbench_root_override: Option<PathBuf>,
}

pub struct CapabilitySyncHandler<P = NoopPackageProvider>
where
    P: CapabilityPackageProvider,
{
    skill_reloader: std::sync::Arc<dyn crate::SkillConfigurationReloader>,
    auth_token: String,
    store: GlobalCapabilityStore,
    package_provider: P,
    sync_lock: std::sync::Arc<AsyncMutex<()>>,
    plugin_sync_inflight: plugin_sync_protocol::InFlightRequests,
    plugin_sync_binding: plugin_sync_protocol::ConnectionBinding,
    plugin_preparation: std::sync::Arc<plugin_preparation::PreparationCoordinator>,
}

pub struct GlobalCapabilityReporter {
    skills_dir: PathBuf,
    plugins_dir: PathBuf,
    manifest: ManagedCapabilityManifest,
}

pub use wegent_runtime_config::paths::default_manifest_path;

/// Initialize before any component reads the default manifest as raw JSON.
pub fn initialize_default_manifest() -> Result<PathBuf, CapabilitySyncError> {
    let path = default_manifest_path();
    manifest_migration::initialize(&path)?;
    Ok(path)
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
