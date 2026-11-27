// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Keep the selected version in Codex's native cache without discarding history.

use super::*;
use crate::local::plugin_cache::{
    native_cache_segment as native_version, preferred_native_version as preferred,
};
use serde::{Deserialize, Serialize};
use std::io::Write;

pub(super) const RETAINED_CACHE: &str = "retained-cache";
const COMPLETIONS: &str = "plugin_cache_selections";

#[derive(Deserialize, Serialize)]
struct RetiredVersion {
    source: PathBuf,
    archive: PathBuf,
    fingerprint: BTreeMap<PathBuf, String>,
}

#[derive(Deserialize, Serialize)]
struct Record {
    schema_version: u32,
    key: String,
    version: String,
    id: String,
    versions: Vec<RetiredVersion>,
}

pub(super) struct Selection {
    path: PathBuf,
    record: Record,
}

fn journal_path(store: &GlobalCapabilityStore, key: &str) -> PathBuf {
    store
        .manifest
        .path
        .parent()
        .unwrap()
        .join(".plugin-cache-selection")
        .join(format!("{}.json", &sha256_digest(key.as_bytes())[7..]))
}

pub(super) fn pending(store: &GlobalCapabilityStore, key: &str) -> bool {
    exists(&journal_path(store, key))
}

fn conflicts(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
) -> Result<Vec<PathBuf>, CapabilitySyncError> {
    let selected = store.plugin_codex_link(spec);
    let base = selected.parent().unwrap();
    store.ensure_runtime_path(base, false)?;
    let entries = match fs::read_dir(base) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry?;
        let Some(version) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if entry.file_type()?.is_dir()
            && native_version(&version)
            && preferred(&version, &spec.version)
        {
            paths.push(entry.path());
        }
    }
    paths.sort();
    Ok(paths)
}

pub(super) fn has_conflicts(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
) -> Result<bool, CapabilitySyncError> {
    Ok(store.shared_packages && !conflicts(store, spec)?.is_empty())
}

fn entries<'a>(manifest: &'a Value, key: &str) -> Vec<&'a Value> {
    let mut result = Vec::new();
    for field in [
        "plugins",
        "plugin_retained_sources",
        "plugin_legacy_sources",
    ] {
        let mut entry = manifest.get(field).and_then(|values| values.get(key));
        while let Some(value) = entry {
            result.push(value);
            entry = value.get("previous").filter(|value| value.is_object());
        }
    }
    result
}

fn owns_source(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
    source: &Path,
    contents: &Path,
    manifest: &Value,
) -> Result<bool, CapabilitySyncError> {
    let pending =
        manifest["plugin_runtime_relocated_owners"][source.to_string_lossy().as_ref()] == spec.key;
    if !pending && shared_packages::owns_retained_plugin_runtime(manifest, &spec.key, source) {
        return Ok(true);
    }
    for entry in entries(manifest, &spec.key) {
        if entry["managed"] != true {
            continue;
        }
        let candidate = checked_spec(&spec.key, entry)?;
        if source.file_name().and_then(|name| name.to_str()) != Some(candidate.version.as_str()) {
            continue;
        }
        let Some(recorded) = entry["runtime"]["codex_link"].as_str().map(Path::new) else {
            continue;
        };
        if !historical_cache_path(recorded, &candidate, "codex_link") {
            continue;
        }
        if !pending && shared_packages::same_entry(recorded, source) {
            return Ok(true);
        }
        let Some(hash) = candidate.checksum.as_deref() else {
            continue;
        };
        let package = store.verified_plugin_package(hash)?;
        validate_package_identity(&package.path, &candidate)?;
        if store.matches_managed_package_copy(contents, &candidate, &package.path, entry)? {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Selection {
    pub(super) fn prepare(
        store: &GlobalCapabilityStore,
        spec: &PluginSyncSpec,
        manifest: &Value,
    ) -> Result<Option<Self>, CapabilitySyncError> {
        if !store.shared_packages {
            return Ok(None);
        }
        let paths = conflicts(store, spec)?;
        if paths.is_empty() {
            return Ok(None);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let mut versions = Vec::new();
        for source in paths {
            store.ensure_runtime_path(&source, false)?;
            if !owns_source(store, spec, &source, &source, manifest)? {
                return Err(CapabilitySyncError::invalid_payload("A newer unmanaged Codex cache prevents selecting this plugin version; preserving it"));
            }
            let archive = store
                .codex_plugins_dir
                .join(RETAINED_CACHE)
                .join(&spec.marketplace)
                .join(&spec.name)
                .join(format!(
                    "{}@{id}",
                    source.file_name().unwrap().to_string_lossy()
                ));
            store.ensure_runtime_path(&archive, false)?;
            if exists(&archive) {
                return Err(CapabilitySyncError::invalid_payload(
                    "Retained Codex cache destination is occupied",
                ));
            }
            versions.push(RetiredVersion {
                fingerprint: tree_fingerprint(&source)?,
                source,
                archive,
            });
        }
        let selection = Self {
            path: journal_path(store, &spec.key),
            record: Record {
                schema_version: 1,
                key: spec.key.clone(),
                version: spec.version.clone(),
                id,
                versions,
            },
        };
        selection.persist(store)?;
        Ok(Some(selection))
    }

    fn persist(&self, store: &GlobalCapabilityStore) -> Result<(), CapabilitySyncError> {
        safe_managed_path(store.manifest.path.parent().unwrap(), &self.path, false)?;
        fs::create_dir_all(self.path.parent().unwrap())?;
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())?;
        file.write_all(&serde_json::to_vec(&self.record)?)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(&self.path)
            .map_err(|error| error.error)?;
        sync_directory(self.path.parent().unwrap())
    }

    pub(super) fn retire(&self, store: &GlobalCapabilityStore) -> Result<(), CapabilitySyncError> {
        for version in &self.record.versions {
            store.ensure_runtime_path(&version.source, false)?;
            store.ensure_runtime_path(&version.archive, false)?;
            if exists(&version.archive) || tree_fingerprint(&version.source)? != version.fingerprint
            {
                return Err(CapabilitySyncError::invalid_payload(
                    "Codex cache changed after selection planning; preserving the journal",
                ));
            }
            fs::create_dir_all(version.archive.parent().unwrap())?;
            fs::rename(&version.source, &version.archive)?;
            sync_directory(version.source.parent().unwrap())?;
            sync_directory(version.archive.parent().unwrap())?;
        }
        Ok(())
    }

    pub(super) fn record_commit(&self, manifest: &mut Value, entry: &mut Value) {
        for version in &self.record.versions {
            for field in [
                "plugins",
                "plugin_retained_sources",
                "plugin_legacy_sources",
            ] {
                if let Some(value) = manifest
                    .get_mut(field)
                    .and_then(|values| values.get_mut(&self.record.key))
                {
                    rewrite_entry(value, &self.record.key, version);
                }
            }
            rewrite_entry(entry, &self.record.key, version);
            let owners = ensure_object_field(manifest, "plugin_runtime_owners");
            owners.retain(|path, owner| {
                owner.as_str() != Some(self.record.key.as_str())
                    || !shared_packages::same_entry(Path::new(path), &version.source)
            });
            owners.insert(
                version.archive.to_string_lossy().into_owned(),
                json!(self.record.key),
            );
            ensure_object_field(manifest, "plugin_runtime_relocated_owners").retain(
                |path, owner| {
                    owner != &self.record.key
                        || !same_version_path(Path::new(path), &self.record.key, version)
                },
            );
        }
        ensure_object_field(manifest, COMPLETIONS)
            .insert(self.record.key.clone(), json!(self.record.id));
    }

    pub(super) fn finish(&self) -> Result<(), CapabilitySyncError> {
        fs::remove_file(&self.path)?;
        sync_directory(self.path.parent().unwrap())
    }

    fn restore(&self, store: &GlobalCapabilityStore) -> Result<(), CapabilitySyncError> {
        for version in &self.record.versions {
            let source = exists(&version.source);
            let archive = exists(&version.archive);
            if source == archive {
                return Err(CapabilitySyncError::invalid_payload("Native cache selection has conflicting or missing copies; preserving the journal"));
            }
            let current = if archive {
                &version.archive
            } else {
                &version.source
            };
            store.ensure_runtime_path(current, false)?;
            if tree_fingerprint(current)? != version.fingerprint {
                return Err(CapabilitySyncError::invalid_payload(
                    "Native cache selection data changed; preserving the journal",
                ));
            }
        }
        for version in self.record.versions.iter().rev() {
            if exists(&version.archive) {
                fs::rename(&version.archive, &version.source)?;
                sync_directory(version.archive.parent().unwrap())?;
                sync_directory(version.source.parent().unwrap())?;
            }
        }
        self.finish()
    }

    pub(super) fn rollback(
        &self,
        store: &GlobalCapabilityStore,
    ) -> Result<(), CapabilitySyncError> {
        self.restore(store)
    }
}

fn same_version_path(path: &Path, key: &str, version: &RetiredVersion) -> bool {
    let (name, marketplace) = split_plugin_key(key);
    let candidate = json!({"name":name,"marketplace":marketplace,"version":version.source.file_name().unwrap().to_string_lossy()});
    checked_spec(key, &candidate).is_ok_and(|spec| historical_cache_path(path, &spec, "codex_link"))
        && path
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|name| name == "cache")
}

fn rewrite_entry(entry: &mut Value, key: &str, version: &RetiredVersion) {
    if entry
        .get("runtime")
        .and_then(|value| value.get("codex_link"))
        .and_then(Value::as_str)
        .is_some_and(|path| same_version_path(Path::new(path), key, version))
    {
        entry["runtime"]["codex_link"] = json!(version.archive);
    }
    if let Some(previous) = entry.get_mut("previous").filter(|value| value.is_object()) {
        rewrite_entry(previous, key, version);
    }
}

pub(super) fn recover(
    store: &GlobalCapabilityStore,
    key: &str,
    manifest: &Value,
) -> Result<(), CapabilitySyncError> {
    let path = journal_path(store, key);
    if !exists(&path) {
        return Ok(());
    }
    safe_managed_path(store.manifest.path.parent().unwrap(), &path, false)?;
    let record: Record = serde_json::from_slice(&fs::read(&path)?)?;
    if record.schema_version != 1
        || record.key != key
        || uuid::Uuid::parse_str(&record.id).is_err()
        || record.versions.is_empty()
    {
        return Err(CapabilitySyncError::invalid_payload(
            "Invalid native cache selection identity",
        ));
    }
    let (name, marketplace) = split_plugin_key(key);
    let spec = checked_spec(
        key,
        &json!({"name":name,"marketplace":marketplace,"version":record.version}),
    )?;
    validate_record(store, &spec, &record, manifest)?;
    let selection = Selection { path, record };
    if manifest[COMPLETIONS][key].as_str() == Some(selection.record.id.as_str()) {
        selection.finish()
    } else {
        selection.restore(store)
    }
}

fn validate_record(
    store: &GlobalCapabilityStore,
    spec: &PluginSyncSpec,
    record: &Record,
    manifest: &Value,
) -> Result<(), CapabilitySyncError> {
    let base = store.plugin_codex_link(spec).parent().unwrap().to_owned();
    let history = store
        .codex_plugins_dir
        .join(RETAINED_CACHE)
        .join(&spec.marketplace)
        .join(&spec.name);
    let mut sources = BTreeSet::new();
    for version in &record.versions {
        let name = version
            .source
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if version.source.parent() != Some(base.as_path())
            || !native_version(name)
            || !preferred(name, &spec.version)
            || version.archive != history.join(format!("{name}@{}", record.id))
            || !sources.insert(&version.source)
        {
            return Err(CapabilitySyncError::invalid_payload(
                "Native cache selection paths do not match the managed plugin",
            ));
        }
        store.ensure_runtime_path(&version.source, false)?;
        store.ensure_runtime_path(&version.archive, false)?;
        let committed = manifest[COMPLETIONS][&record.key].as_str() == Some(record.id.as_str());
        let contents = if exists(&version.archive) {
            &version.archive
        } else {
            &version.source
        };
        if !committed && !owns_source(store, spec, &version.source, contents, manifest)? {
            return Err(CapabilitySyncError::invalid_payload(
                "Native cache selection has no registered owner; preserving it",
            ));
        }
    }
    Ok(())
}

pub(super) fn is_retained(path: &Path) -> bool {
    path.parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .is_some_and(|name| name == RETAINED_CACHE)
}

pub(super) fn archived_version(path: &Path) -> Option<&str> {
    let leaf = path.file_name()?.to_str()?;
    let (version, id) = leaf.rsplit_once('@')?;
    uuid::Uuid::parse_str(id).ok()?;
    Some(version)
}

fn sync_directory(path: &Path) -> Result<(), CapabilitySyncError> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
#[path = "runtime_cache_selection_tests.rs"]
mod tests;
