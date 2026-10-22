// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

use super::bundled_plugins::directory_content_hash;

pub(crate) fn cache_matches_source(source: &Path, cache: &Path) -> Result<bool, String> {
    if !cache.exists() {
        return Ok(false);
    }
    reject_symlink(cache)?;
    Ok(directory_content_hash(source)? == directory_content_hash(cache)?)
}

/// Keep the previous cache until both file validation and configuration commit succeed.
pub(crate) fn replace_cache<F>(source: &Path, destination: &Path, commit: F) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    reject_symlink(source)?;
    if destination.exists() {
        reject_symlink(destination)?;
    }
    let parent = destination.parent().ok_or("Plugin cache has no parent")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let id = uuid::Uuid::new_v4();
    let staging = parent.join(format!(".wework-install-{id}"));
    let backup = parent.join(format!(".wework-backup-{id}"));
    let prepared = copy_directory(source, &staging).and_then(|_| {
        if cache_matches_source(source, &staging)? {
            Ok(())
        } else {
            Err("Plugin source changed while preparing its cache".to_owned())
        }
    });
    if let Err(error) = prepared {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let had_destination = destination.exists();
    let result = (|| {
        if had_destination {
            fs::rename(destination, &backup).map_err(|error| error.to_string())?;
        }
        fs::rename(&staging, destination).map_err(|error| error.to_string())?;
        commit()
    })();
    if result.is_err() && backup.exists() {
        let _ = fs::remove_dir_all(destination);
        fs::rename(&backup, destination)
            .map_err(|error| format!("Plugin cache rollback failed: {error}"))?;
    } else if result.is_err() && !had_destination && destination.exists() {
        let _ = fs::remove_dir_all(destination);
    }
    let _ = fs::remove_dir_all(&staging);
    if result.is_ok() {
        let _ = fs::remove_dir_all(&backup);
    }
    result
}

fn reject_symlink(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Plugin cache or source may not be a symbolic link".to_owned());
    }
    Ok(())
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let output = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &output)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), output).map_err(|error| error.to_string())?;
        } else {
            return Err("Plugin source contains an unsupported file type".to_owned());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_same_version_changes_and_removed_files() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let cache = root.path().join("cache");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("tool.js"), "new").unwrap();
        replace_cache(&source, &cache, || Ok(())).unwrap();
        assert!(cache_matches_source(&source, &cache).unwrap());
        fs::write(cache.join("tool.js"), "old").unwrap();
        assert!(!cache_matches_source(&source, &cache).unwrap());
        fs::write(cache.join("obsolete.js"), "old").unwrap();
        replace_cache(&source, &cache, || Ok(())).unwrap();
        assert!(!cache.join("obsolete.js").exists());
        assert!(cache_matches_source(&source, &cache).unwrap());
    }

    #[test]
    fn restores_old_cache_when_configuration_commit_fails() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let cache = root.path().join("cache");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(source.join("tool.js"), "new").unwrap();
        fs::write(cache.join("tool.js"), "old").unwrap();
        assert!(replace_cache(&source, &cache, || Err("config locked".to_owned())).is_err());
        assert_eq!(fs::read_to_string(cache.join("tool.js")).unwrap(), "old");
    }
}
