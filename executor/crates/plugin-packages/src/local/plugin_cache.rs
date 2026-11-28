// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs, io,
    path::{Path, PathBuf},
};

use serde_json::Value;

use crate::logging::log_executor_event;

use super::{bundled_plugins::directory_content_hash, plugin_catalog::read_json_file};

#[derive(PartialEq)]
pub struct CachedCodexPlugin {
    pub root: PathBuf,
    pub manifest: Value,
}

pub fn native_cache_segment(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"-_.+".contains(&ch))
}

/// Native pairwise preference; custom versions do not make this a sorting order.
pub(super) fn preferred_native_version(candidate: &str, selected: &str) -> bool {
    if candidate == selected || selected == "local" {
        return false;
    }
    if candidate == "local" {
        return true;
    }
    compare_native_version_pair(candidate, selected).is_gt()
}

fn compare_native_version_pair(left: &str, right: &str) -> std::cmp::Ordering {
    match (semver::Version::parse(left), semver::Version::parse(right)) {
        (Ok(left), Ok(right)) => left.cmp(&right),
        _ => left.cmp(right),
    }
}

fn native_semver_ranks(names: &[&str]) -> (Vec<usize>, Vec<(usize, semver::Version)>) {
    let mut parsed: Vec<_> = names
        .iter()
        .enumerate()
        .filter_map(|(index, name)| {
            semver::Version::parse(name)
                .ok()
                .map(|version| (index, version))
        })
        .collect();
    parsed.sort_unstable_by(|left, right| left.1.cmp(&right.1));
    let mut prefix_ends = vec![0; names.len()];
    let mut start = 0;
    while start < parsed.len() {
        let mut end = start + 1;
        while end < parsed.len() && parsed[end].1 == parsed[start].1 {
            end += 1;
        }
        for (index, _) in &parsed[start..end] {
            prefix_ends[*index] = end;
        }
        start = end;
    }
    (prefix_ends, parsed)
}

/// Select only when native pair comparisons have an unambiguous finite-set order.
pub(super) fn select_native_version<'a>(
    versions: impl IntoIterator<Item = &'a str>,
) -> io::Result<Option<&'a str>> {
    let mut names: Vec<_> = versions.into_iter().collect();
    names.sort_unstable();
    names.dedup();
    if let Ok(index) = names.binary_search(&"local") {
        return Ok(Some(names[index]));
    }
    let ambiguous = || {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "Native Codex cache version order is ambiguous; preserving all versions",
        )
    };
    let (prefix_ends, parsed) = native_semver_ranks(&names);
    let (mut seen, mut prefix_end) = (0, 0);
    for &end in &prefix_ends {
        if end > 0 {
            seen += 1;
            prefix_end = prefix_end.max(end);
        } else if seen != prefix_end {
            // Every opaque name must cut the SemVer chain at a complete prefix.
            return Err(ambiguous());
        }
    }
    let Some(last) = names.len().checked_sub(1) else {
        return Ok(None);
    };
    if prefix_ends[last] == 0 {
        return Ok(Some(names[last]));
    }
    let (index, maximum) = parsed.last().expect("The final name is a SemVer");
    if parsed.len() > 1 && parsed[parsed.len() - 2].1 == *maximum {
        return Err(ambiguous());
    }
    Ok(Some(names[*index]))
}

pub fn read_codex_marketplace_cache(
    codex_home: &Path,
    marketplace: &str,
) -> Result<BTreeMap<String, Option<CachedCodexPlugin>>, String> {
    let Some(directory) = native_cache_directory(codex_home, &["plugins", "cache", marketplace])?
    else {
        return Ok(BTreeMap::new());
    };
    let read = || -> io::Result<_> {
        let mut plugins = BTreeMap::new();
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            let kind = entry.file_type()?;
            if !native_cache_segment(&name) || !(kind.is_dir() || kind.is_symlink()) {
                continue;
            }
            let package = if kind.is_dir() {
                selected_codex_package(&entry.path(), marketplace, &name).unwrap_or_else(|error| {
                    log_executor_event(
                        "Codex plugin cache package unavailable",
                        &[
                            ("marketplace", marketplace.to_owned()),
                            ("plugin", name.clone()),
                            ("error", error.to_string()),
                        ],
                    );
                    None
                })
            } else {
                None
            };
            plugins.insert(name, package);
        }
        Ok(plugins)
    };
    read().map_err(|error| format!("Failed to read Codex marketplace cache: {error}"))
}

pub fn read_codex_plugin_cache(
    codex_home: &Path,
    marketplace: &str,
    name: &str,
) -> Result<Option<CachedCodexPlugin>, String> {
    let Some(directory) =
        native_cache_directory(codex_home, &["plugins", "cache", marketplace, name])?
    else {
        return Ok(None);
    };
    selected_codex_package(&directory, marketplace, name)
        .map_err(|error| format!("Failed to read Codex plugin cache: {error}"))
}

/// Resolve Codex's active directory after the caller verifies configuration membership.
/// Package validation must not select a different, inactive version on failure.
pub fn read_active_codex_plugin_root(
    codex_home: &Path,
    marketplace: &str,
    name: &str,
) -> Result<Option<PathBuf>, String> {
    let Some(directory) =
        native_cache_directory(codex_home, &["plugins", "cache", marketplace, name])?
    else {
        return Ok(None);
    };
    selected_codex_plugin_root(&directory)
        .map_err(|error| format!("Failed to read active Codex plugin root: {error}"))
}

fn native_cache_directory(codex_home: &Path, segments: &[&str]) -> Result<Option<PathBuf>, String> {
    if segments
        .iter()
        .any(|segment| !native_cache_segment(segment))
    {
        return Err("Invalid Codex marketplace cache identity".into());
    }
    let mut directory = codex_home.to_path_buf();
    for segment in segments {
        directory.push(segment);
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err("Invalid Codex marketplace cache directory".into()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(Some(directory))
}

fn selected_codex_plugin_root(path: &Path) -> io::Result<Option<PathBuf>> {
    let mut versions = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let Ok(version) = entry.file_name().into_string() else {
            continue;
        };
        if !entry.file_type()?.is_dir() || !native_cache_segment(&version) {
            continue;
        }
        versions.push((version, entry.path()));
    }
    let active = select_native_version(versions.iter().map(|(version, _)| version.as_str()))?;
    let selected = active.and_then(|active| versions.iter().find(|(version, _)| version == active));
    selected.map(|(_, root)| root.canonicalize()).transpose()
}

fn selected_codex_package(
    path: &Path,
    marketplace: &str,
    name: &str,
) -> io::Result<Option<CachedCodexPlugin>> {
    Ok(selected_codex_plugin_root(path)?.and_then(|root| {
        let path = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]
            .into_iter()
            .map(|relative| root.join(relative))
            .find(|path| path.is_file())?;
        if !path.canonicalize().ok()?.starts_with(&root) {
            return None;
        }
        let manifest = read_json_file(&path, 1024 * 1024).ok()?;
        let matches = manifest["name"].as_str().is_some_and(|manifest_name| {
            if marketplace == "wework-personal" {
                super::capabilities::personal_manifest_name_matches_slug(manifest_name, name)
            } else {
                manifest_name == name
            }
        });
        matches.then_some(CachedCodexPlugin { root, manifest })
    }))
}

pub fn cache_matches_source(source: &Path, cache: &Path) -> Result<bool, String> {
    if !cache.exists() {
        return Ok(false);
    }
    reject_symlink(cache)?;
    Ok(directory_content_hash(source)? == directory_content_hash(cache)?)
}

/// Keep the previous cache until both file validation and configuration commit succeed.
pub fn replace_cache<F>(source: &Path, destination: &Path, commit: F) -> Result<(), String>
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
    fn cache_version_preference_matches_codex_native_ordering() {
        for (candidate, selected, preferred) in [
            ("0.1.10", "0.1.9", true),
            ("10.0.0", "10.0.0-beta.1", true),
            ("v10.0", "v9.0", false),
            ("10.0", "9.0", false),
            ("10.0", "10.0-beta.1", false),
            ("10.0.0", "custom", false),
            ("local", "99.0.0", true),
            ("99.0.0", "local", false),
            ("0.1.10", "0.1.10", false),
        ] {
            assert_eq!(
                preferred_native_version(candidate, selected),
                preferred,
                "{candidate} compared with {selected}"
            );
        }
    }

    #[test]
    fn native_selection_rejects_cycles_and_preserves_consistent_native_preferences() {
        for versions in [
            ["2.0.0", "10.0.0", "11-custom"],
            ["2.0.0", "11-custom", "10.0.0"],
            ["10.0.0", "2.0.0", "11-custom"],
            ["10.0.0", "11-custom", "2.0.0"],
            ["11-custom", "2.0.0", "10.0.0"],
            ["11-custom", "10.0.0", "2.0.0"],
        ] {
            assert_eq!(
                select_native_version(versions).unwrap_err().kind(),
                io::ErrorKind::InvalidData
            );
        }
        for (versions, expected) in [
            (vec!["2.0.0", "10.0.0"], "10.0.0"),
            (vec!["2.0.0", "10.0.0", "z-custom"], "z-custom"),
            (vec!["2.0.0", "10.0.0", "0-custom"], "10.0.0"),
            (vec!["v10.0", "v9.0"], "v9.0"),
            (vec!["1.0.0+001", "1.0.0+01"], "1.0.0+001"),
            (vec!["2.0.0", "10.0.0", "11-custom", "local"], "local"),
        ] {
            assert_eq!(
                select_native_version(versions.iter().copied()).unwrap(),
                Some(expected)
            );
            assert_eq!(
                select_native_version(versions.iter().rev().copied()).unwrap(),
                Some(expected)
            );
        }
    }

    #[test]
    fn active_root_and_preview_share_native_selection_without_package_fallback() {
        let home = tempfile::tempdir().unwrap();
        let cache = home.path().join("plugins/cache/test-market/demo");
        for version in ["0.1.9", "0.1.10"] {
            let root = cache.join(version);
            fs::create_dir_all(root.join(".codex-plugin")).unwrap();
            fs::write(root.join(".codex-plugin/plugin.json"), r#"{"name":"demo"}"#).unwrap();
        }
        fs::create_dir_all(cache.join("ignored version")).unwrap();
        fs::write(cache.join("999.0.0"), "not a version directory").unwrap();
        let active = read_active_codex_plugin_root(home.path(), "test-market", "demo")
            .unwrap()
            .unwrap();
        assert_eq!(active, cache.join("0.1.10").canonicalize().unwrap());
        assert_eq!(
            read_codex_plugin_cache(home.path(), "test-market", "demo")
                .unwrap()
                .unwrap()
                .root,
            active
        );

        fs::create_dir(cache.join("local")).unwrap();

        assert_eq!(
            read_active_codex_plugin_root(home.path(), "test-market", "demo").unwrap(),
            Some(cache.join("local").canonicalize().unwrap())
        );
        assert!(read_codex_plugin_cache(home.path(), "test-market", "demo")
            .unwrap()
            .is_none());

        let ambiguous = home.path().join("plugins/cache/ambiguous-market/demo");
        for version in ["2.0.0", "10.0.0", "11-custom"] {
            fs::create_dir_all(ambiguous.join(version)).unwrap();
        }
        assert!(read_active_codex_plugin_root(home.path(), "ambiguous-market", "demo").is_err());
        assert!(read_codex_plugin_cache(home.path(), "ambiguous-market", "demo").is_err());
        let healthy = home
            .path()
            .join("plugins/cache/ambiguous-market/healthy/1.0.0");
        fs::create_dir_all(healthy.join(".codex-plugin")).unwrap();
        fs::write(
            healthy.join(".codex-plugin/plugin.json"),
            r#"{"name":"healthy","version":"1.0.0"}"#,
        )
        .unwrap();
        let packages = read_codex_marketplace_cache(home.path(), "ambiguous-market").unwrap();
        assert_eq!(packages.len(), 2);
        assert!(packages["demo"].is_none());
        assert_eq!(
            packages["healthy"].as_ref().unwrap().root,
            healthy.canonicalize().unwrap()
        );
        for version in ["2.0.0", "10.0.0", "11-custom"] {
            assert!(ambiguous.join(version).is_dir());
        }

        for marketplace in ["wework-personal", "test-market"] {
            let root = home
                .path()
                .join("plugins/cache")
                .join(marketplace)
                .join("demo-tool/1.0.0");
            fs::create_dir_all(root.join(".codex-plugin")).unwrap();
            for (name, accepted) in [
                ("Demo Tool", marketplace == "wework-personal"),
                ("other-tool", false),
            ] {
                fs::write(
                    root.join(".codex-plugin/plugin.json"),
                    serde_json::json!({"name":name}).to_string(),
                )
                .unwrap();
                assert_eq!(
                    read_codex_plugin_cache(home.path(), marketplace, "demo-tool")
                        .unwrap()
                        .is_some(),
                    accepted
                );
                assert_eq!(
                    read_codex_marketplace_cache(home.path(), marketplace).unwrap()["demo-tool"]
                        .is_some(),
                    accepted
                );
            }
        }
    }

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
