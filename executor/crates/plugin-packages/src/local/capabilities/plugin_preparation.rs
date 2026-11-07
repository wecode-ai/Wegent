// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Isolated package and runtime preparation. No active configuration is written here.

use super::runtime_recovery::validate_package_identity;
use super::*;
use crate::services::workbench::{
    publish_plugin_archive, verify_published_package, PackageKind, PublishedPackage,
};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;
use tokio::sync::{OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

pub(super) const MAX_PLUGIN_PREPARATIONS: usize = 2;
type Coordinators = Mutex<BTreeMap<PathBuf, Weak<PreparationCoordinator>>>;
static COORDINATORS: OnceLock<Coordinators> = OnceLock::new();

pub(super) struct PreparationCoordinator {
    pub slots: Arc<Semaphore>,
    pub protocol: tokio::sync::RwLock<()>,
    plugins: Mutex<BTreeMap<String, Weak<AsyncMutex<()>>>>,
}

impl PreparationCoordinator {
    pub fn for_store(store: &GlobalCapabilityStore) -> Arc<Self> {
        let mut stores = COORDINATORS.get_or_init(Default::default).lock().unwrap();
        stores.retain(|_, entry| entry.strong_count() > 0);
        if let Some(coordinator) = stores.get(&store.manifest.path).and_then(Weak::upgrade) {
            return coordinator;
        }
        let coordinator = Arc::new(Self {
            slots: Arc::new(Semaphore::new(MAX_PLUGIN_PREPARATIONS)),
            protocol: tokio::sync::RwLock::new(()),
            plugins: Mutex::new(BTreeMap::new()),
        });
        stores.insert(store.manifest.path.clone(), Arc::downgrade(&coordinator));
        coordinator
    }

    pub fn plugin(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut plugins = self.plugins.lock().unwrap();
        plugins.retain(|_, entry| entry.strong_count() > 0);
        if let Some(lock) = plugins.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(AsyncMutex::new(()));
        plugins.insert(key.to_owned(), Arc::downgrade(&lock));
        lock
    }
}

pub(super) struct PreparationLease {
    pub _lane: Option<OwnedMutexGuard<()>>,
    pub _slot: OwnedSemaphorePermit,
}

pub(super) struct PreparedRuntime {
    pub reused: BTreeSet<PathBuf>,
    staged: Vec<(PathBuf, tempfile::TempDir)>,
}

impl PreparedRuntime {
    fn prepare(
        store: &GlobalCapabilityStore,
        spec: &PluginSyncSpec,
        source: &Path,
        reused: BTreeSet<PathBuf>,
    ) -> Result<Self, CapabilitySyncError> {
        let mut result = Self {
            reused,
            staged: Vec::new(),
        };
        for (runtime, field) in store.plugin_runtime_targets(spec) {
            let claude = field == "claude_link";
            let market = if claude {
                store.claude_marketplace_dir(&spec.marketplace)
            } else {
                store.codex_marketplace_dir(&spec.marketplace)
            };
            let link = market
                .join("plugins")
                .join(store.marketplace_plugin_name(spec, claude));
            let runtime_stage = if result.reused.contains(&runtime) {
                None
            } else {
                let stage = result.stage(store, &runtime)?;
                copy_dir_atomic(source, &stage.path().join("entry"))?;
                ensure_dual_plugin_manifests(&stage.path().join("entry"))?;
                ensure_plugin_hook_permissions(&stage.path().join("entry"))?;
                Some(stage)
            };
            // Personal marketplaces share one entry between Codex and Claude.
            // Codex is prepared first and owns that entry, as in metadata publication.
            if !result.reused.contains(&link)
                && !result.staged.iter().any(|(target, _)| target == &link)
            {
                let stage = result.stage(store, &link)?;
                let copy_source = runtime_stage
                    .as_ref()
                    .map(|stage| stage.path().join("entry"))
                    .unwrap_or_else(|| runtime.clone());
                link_or_copy_dir_from(&runtime, &copy_source, &stage.path().join("entry"))?;
                result.staged.push((link, stage));
            }
            if let Some(stage) = runtime_stage {
                result.staged.push((runtime, stage));
            }
        }
        Ok(result)
    }

    fn stage(
        &self,
        store: &GlobalCapabilityStore,
        target: &Path,
    ) -> Result<tempfile::TempDir, CapabilitySyncError> {
        store.ensure_state_path(target, true)?;
        let parent = target
            .parent()
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Runtime has no parent"))?;
        fs::create_dir_all(parent)?;
        // Siblings guarantee atomic publication even when runtime roots are on another volume.
        Ok(tempfile::Builder::new()
            .prefix(".plugin-prepare-")
            .tempdir_in(parent)?)
    }

    pub fn paths(&self) -> BTreeSet<PathBuf> {
        self.reused
            .iter()
            .cloned()
            .chain(self.staged.iter().map(|(target, _)| target.clone()))
            .collect()
    }

    pub fn publish(&mut self, store: &GlobalCapabilityStore) -> Result<(), CapabilitySyncError> {
        for (target, stage) in &self.staged {
            store.ensure_state_path(target, true)?;
            if target.exists() || target.is_symlink() {
                return Err(CapabilitySyncError::invalid_payload(
                    "Prepared runtime target was not reserved by the publication transaction",
                ));
            }
            fs::rename(stage.path().join("entry"), target)?;
        }
        Ok(())
    }
}

pub(super) struct PreparedPlugin {
    pub spec: PluginSyncSpec,
    pub unchanged: bool,
    path: Option<PathBuf>,
    private_package: Option<tempfile::TempDir>,
    runtime: Option<PreparedRuntime>,
}

impl PreparedPlugin {
    fn finish(
        store: &GlobalCapabilityStore,
        mut spec: PluginSyncSpec,
        manifest: &Value,
        package: Option<PublishedPackage>,
        private_package: Option<tempfile::TempDir>,
        path: Option<PathBuf>,
    ) -> Result<Self, PluginSyncFailure> {
        let started = Instant::now();
        let source = package
            .as_ref()
            .map(|package| package.path.clone())
            .or_else(|| {
                private_package
                    .as_ref()
                    .map(|stage| stage.path().join("package"))
            })
            .or_else(|| path.clone());
        if let Some(package) = package {
            spec.checksum = Some(package.archive_hash);
        }
        let mut result = Self {
            spec,
            unchanged: false,
            path,
            private_package,
            runtime: None,
        };
        if let Some(source) = source {
            validate_package_identity(&source, &result.spec)
                .map_err(PluginSyncFailure::runtime_metadata)?;
            let reused = store
                .unchanged_plugin_runtime_paths(&result.spec, &source)
                .map_err(PluginSyncFailure::runtime_metadata)?;
            result.unchanged = store
                .plugin_metadata_matches(&result.spec, manifest, &source, &reused)
                .unwrap_or(false);
            if !result.unchanged {
                result.runtime = Some(
                    PreparedRuntime::prepare(store, &result.spec, &source, reused)
                        .map_err(PluginSyncFailure::runtime_metadata)?,
                );
            }
            if store.shared_packages {
                result.path = Some(source);
            }
        }
        crate::logging::log_executor_event(
            "plugin_runtime_prepared",
            &[
                ("plugin", result.spec.key.clone()),
                ("unchanged", result.unchanged.to_string()),
                ("runtime_ms", started.elapsed().as_millis().to_string()),
            ],
        );
        Ok(result)
    }

    pub fn publish(
        &mut self,
        store: &GlobalCapabilityStore,
        manifest: &mut Value,
    ) -> Result<(), PluginSyncFailure> {
        let spec = &self.spec;
        let Some(path) = &self.path else {
            ensure_object_field(manifest, "plugins").insert(spec.key.clone(), json!({"managed":true,
                "name":spec.name,"key":spec.key,"marketplace":spec.marketplace,"version":spec.version,"updated_at":now_rfc3339_like()}));
            return Ok(());
        };
        if store.shared_packages {
            store
                .prepare_relocated_runtime_ownership(spec, path, manifest)
                .map_err(PluginSyncFailure::runtime_metadata)?;
        }
        // Private packages join the same rollback transaction as native metadata.
        let mut package_transaction = if let Some(stage) = &self.private_package {
            let mut transaction = LocalPluginStateTransaction::begin([], [path.clone()])
                .map_err(PluginSyncFailure::runtime_metadata)?;
            if let Err(error) = fs::rename(stage.path().join("package"), path) {
                return Err(PluginSyncFailure::runtime_metadata(
                    transaction.add_rollback_context(error.into()),
                ));
            }
            Some(transaction)
        } else {
            None
        };
        let result =
            store.install_prepared_plugin_runtime(spec, path, manifest, self.runtime.as_mut());
        match result {
            Ok(()) => {
                if let Some(transaction) = package_transaction {
                    transaction.commit();
                }
                Ok(())
            }
            Err(error) => Err(PluginSyncFailure::runtime_metadata(
                match package_transaction.as_mut() {
                    Some(transaction) => transaction.add_rollback_context(error),
                    None => error,
                },
            )),
        }
    }
}

impl<P: CapabilityPackageProvider> CapabilitySyncHandler<P> {
    pub(super) async fn prepare_plugin(
        &self,
        spec: &PluginSyncSpec,
        manifest: &Value,
        lease: Arc<PreparationLease>,
    ) -> Result<PreparedPlugin, PluginSyncFailure> {
        let verify_started = Instant::now();
        let store = self.store.clone();
        let spec = spec.clone();
        let manifest = manifest.clone();
        let root = if store.shared_packages {
            Some(
                store
                    .shared_root()
                    .map_err(PluginSyncFailure::runtime_metadata)?,
            )
        } else {
            None
        };
        let expected = spec.checksum.clone().or_else(|| {
            spec.download_path
                .is_none()
                .then(|| {
                    manifest["plugins"][&spec.key]["checksum"]
                        .as_str()
                        .map(str::to_owned)
                })
                .flatten()
        });
        let verify_root = root.clone();
        let verifying_lease = lease.clone();
        let cached = tokio::task::spawn_blocking(move || {
            let _lease = verifying_lease;
            let cached =
                verify_root
                    .as_ref()
                    .zip(expected.as_deref())
                    .and_then(|(root, checksum)| {
                        verify_published_package(root, PackageKind::Plugin, checksum).ok()
                    });
            cached
        })
        .await
        .map_err(preparation_task_failure)?;
        let verify_ms = verify_started.elapsed().as_millis();
        let cache_hit = cached.is_some();
        self.plugin_sync_binding
            .check()
            .map_err(PluginSyncFailure::runtime_metadata)?;
        let path = store.plugin_store_path(&spec);
        let needs_download = if root.is_some() {
            cached.is_none()
        } else {
            path.as_ref().is_some_and(|path| {
                !has_plugin_manifest(path)
                    || spec.checksum.as_ref().is_some_and(|checksum| {
                        manifest["plugins"][&spec.key]["checksum"].as_str() != Some(checksum)
                    })
            })
        };
        let download_started = Instant::now();
        let bytes = if needs_download {
            match &spec.download_path {
                Some(download) => Some(
                    self.package_provider
                        .download_plugin(download)
                        .await
                        .map_err(|error| {
                            PluginSyncFailure::new(
                                "download",
                                "PLUGIN_DOWNLOAD_FAILED",
                                true,
                                error,
                            )
                        })?,
                ),
                None => None,
            }
        } else {
            None
        };
        crate::logging::log_executor_event(
            "plugin_package_prepared",
            &[
                ("plugin", spec.key.clone()),
                ("cache_hit", cache_hit.to_string()),
                ("verify_ms", verify_ms.to_string()),
                (
                    "download_ms",
                    download_started.elapsed().as_millis().to_string(),
                ),
                (
                    "download_bytes",
                    bytes.as_ref().map_or(0, Vec::len).to_string(),
                ),
            ],
        );
        self.plugin_sync_binding
            .check()
            .map_err(PluginSyncFailure::runtime_metadata)?;
        tokio::task::spawn_blocking(move || {
            // Keep both bounds alive in the worker if its async caller is cancelled.
            let _lease = lease;
            if let Some(root) = root {
                let package = prepare_shared_package(&root, &spec, cached, bytes)?;
                PreparedPlugin::finish(&store, spec, &manifest, Some(package), None, None)
            } else {
                let staged = prepare_private_package(path.as_deref(), &spec, bytes)?;
                PreparedPlugin::finish(&store, spec, &manifest, None, staged, path)
            }
        })
        .await
        .map_err(preparation_task_failure)?
    }
}

fn prepare_shared_package(
    root: &Path,
    spec: &PluginSyncSpec,
    cached: Option<PublishedPackage>,
    bytes: Option<Vec<u8>>,
) -> Result<PublishedPackage, PluginSyncFailure> {
    if let Some(package) = cached {
        return Ok(package);
    }
    let bytes = bytes.ok_or_else(|| {
        PluginSyncFailure::new(
            "package",
            "PLUGIN_PACKAGE_UNAVAILABLE",
            true,
            CapabilitySyncError::invalid_payload("Plugin has no verified package or download URL"),
        )
    })?;
    publish_plugin_archive(root, &bytes, spec.checksum.as_deref()).map_err(|error| {
        PluginSyncFailure::new(
            "package",
            "PLUGIN_PACKAGE_INTEGRITY_FAILED",
            false,
            CapabilitySyncError::invalid_payload(error),
        )
    })
}

fn prepare_private_package(
    path: Option<&Path>,
    spec: &PluginSyncSpec,
    bytes: Option<Vec<u8>>,
) -> Result<Option<tempfile::TempDir>, PluginSyncFailure> {
    let Some(path) = path else {
        return Ok(None);
    };
    let Some(bytes) = bytes else {
        return if has_plugin_manifest(path) {
            Ok(None)
        } else {
            Err(PluginSyncFailure::new(
                "package",
                "PLUGIN_PACKAGE_UNAVAILABLE",
                true,
                CapabilitySyncError::invalid_payload("Plugin package is not available"),
            ))
        };
    };
    if let Some(expected) = &spec.checksum {
        let actual = sha256_digest(&bytes);
        if &actual != expected {
            return Err(PluginSyncFailure::new(
                "checksum",
                "PLUGIN_CHECKSUM_MISMATCH",
                false,
                CapabilitySyncError::ChecksumMismatch {
                    expected: expected.clone(),
                    actual,
                },
            ));
        }
    }
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent)
        .map_err(|error| PluginSyncFailure::runtime_metadata(error.into()))?;
    let stage = tempfile::Builder::new()
        .prefix(".plugin-prepare-")
        .tempdir_in(parent)
        .map_err(|error| PluginSyncFailure::runtime_metadata(error.into()))?;
    extract_plugin_zip(&bytes, &stage.path().join("package")).map_err(|error| {
        PluginSyncFailure::new("extract", "PLUGIN_PACKAGE_EXTRACT_FAILED", false, error)
    })?;
    Ok(Some(stage))
}

fn preparation_task_failure(error: tokio::task::JoinError) -> PluginSyncFailure {
    PluginSyncFailure::new(
        "prepare",
        "PLUGIN_PACKAGE_PREPARE_FAILED",
        true,
        CapabilitySyncError::invalid_payload(error.to_string()),
    )
}
