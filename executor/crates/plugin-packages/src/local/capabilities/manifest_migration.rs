// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use fs2::FileExt;

use super::*;

const WORKBENCH_MANIFEST: &str = "manifest-v2.json";
const WORKBENCH_VERSION: i64 = 2;

fn is_workbench_manifest(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == WORKBENCH_MANIFEST)
}

fn validate_shape(value: &Value, expected_version: i64) -> Result<(), CapabilitySyncError> {
    if !value.is_object()
        || value
            .get("version")
            .is_some_and(|version| version.as_i64() != Some(expected_version))
        || ["skills", "plugins", "mcps"]
            .iter()
            .any(|key| value.get(key).is_some_and(|field| !field.is_object()))
    {
        return Err(CapabilitySyncError::invalid_payload(format!(
            "Invalid capability manifest or unsupported schema (expected {expected_version})"
        )));
    }
    Ok(())
}

fn regular_destination(path: &Path) -> Result<bool, CapabilitySyncError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_file() {
        return Err(CapabilitySyncError::invalid_payload(
            "Workbench manifest must be an independent regular file, not a symlink",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(CapabilitySyncError::invalid_payload(
                "Workbench manifest must not be hard-linked to another manifest",
            ));
        }
    }
    Ok(true)
}

pub(super) fn validate_current(path: &Path, value: &Value) -> Result<(), CapabilitySyncError> {
    if is_workbench_manifest(path) {
        regular_destination(path)?;
        validate_shape(value, WORKBENCH_VERSION)?;
        if value.get("version").and_then(Value::as_i64) != Some(WORKBENCH_VERSION) {
            return Err(CapabilitySyncError::invalid_payload(
                "Workbench manifest is missing schema version 2",
            ));
        }
    }
    Ok(())
}

/// Import once without changing the legacy file or following an alias to it.
pub(super) fn initialize(path: &Path) -> Result<(), CapabilitySyncError> {
    if !is_workbench_manifest(path) {
        return Ok(());
    }
    let parent = path
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(parent.join(".manifest-v2-migration.lock"))?;
    lock.lock_exclusive()?;
    if regular_destination(path)? {
        return validate_current(path, &serde_json::from_slice(&fs::read(path)?)?);
    }
    let legacy = parent.join("manifest.json");
    if legacy.is_symlink() {
        return Err(CapabilitySyncError::invalid_payload(
            "Legacy manifest must not be a file symlink; preserve it as an independent file before import",
        ));
    }
    let mut value = match fs::read(&legacy) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => default_manifest(),
        Err(error) => return Err(error.into()),
    };
    validate_shape(&value, MANIFEST_VERSION)?;
    normalize_manifest(&mut value);
    value["version"] = json!(WORKBENCH_VERSION);
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut staged, &value)?;
    staged.as_file().sync_all()?;
    // Never overwrite a file published by a different writer during import.
    staged
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

pub(super) fn prepare_save(path: &Path, value: &mut Value) -> Result<(), CapabilitySyncError> {
    if is_workbench_manifest(path) {
        initialize(path)?;
        // Existing callers can still construct a version-1 value in memory.
        let version = value.get("version").and_then(Value::as_i64).unwrap_or(1);
        if ![MANIFEST_VERSION, WORKBENCH_VERSION].contains(&version) {
            return Err(CapabilitySyncError::invalid_payload(
                "Cannot save an unsupported capability manifest schema",
            ));
        }
        validate_shape(value, version)?;
        value["version"] = json!(WORKBENCH_VERSION);
    }
    Ok(())
}

#[cfg(test)]
#[path = "manifest_migration_tests.rs"]
mod tests;
