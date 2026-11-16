// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use std::io::Read;

/// Compare full bytes against the source without rehashing or copying its payload.
pub(super) struct RuntimeTemplate {
    source: PathBuf,
    modes: BTreeMap<PathBuf, u32>,
    manifests: BTreeMap<PathBuf, Value>,
}

impl RuntimeTemplate {
    pub(super) fn read(source: &Path) -> Result<Self, CapabilitySyncError> {
        let mut modes = file_inventory(source)?;
        #[cfg(unix)]
        for (relative, mode) in &mut modes {
            if is_plugin_hook_path(relative) {
                *mode |= 0o111;
            }
        }
        // Only the small converted manifests differ from the published source.
        let stage = tempfile::tempdir()?;
        for relative in PLUGIN_MANIFEST_PATHS {
            let path = source.join(relative);
            if path.is_file() {
                let target = stage.path().join(relative);
                fs::create_dir_all(target.parent().expect("Manifest has a parent"))?;
                fs::copy(path, target)?;
            }
        }
        ensure_dual_plugin_manifests(stage.path())?;
        let mut manifests = BTreeMap::new();
        for (relative, mode) in file_inventory(stage.path())? {
            manifests.insert(
                relative.clone(),
                serde_json::from_slice(&fs::read(stage.path().join(&relative))?)?,
            );
            modes.insert(relative, mode);
        }
        Ok(Self {
            source: source.to_owned(),
            modes,
            manifests,
        })
    }

    pub(super) fn matching_paths(
        &self,
        paths: &BTreeSet<PathBuf>,
    ) -> Result<BTreeSet<PathBuf>, CapabilitySyncError> {
        let mut matching = paths
            .iter()
            .filter(|path| self.matches_layout(path).unwrap_or(false))
            .cloned()
            .collect::<BTreeSet<_>>();
        for relative in self
            .modes
            .keys()
            .filter(|path| !self.manifests.contains_key(*path))
        {
            if matching.is_empty() {
                break;
            }
            matching = matching_file(&self.source, relative, &matching)?;
        }
        Ok(matching)
    }

    fn matches_layout(&self, path: &Path) -> Result<bool, CapabilitySyncError> {
        let mut actual = file_inventory(path)?;
        actual.retain(|relative, _| {
            self.modes.contains_key(relative) || !is_runtime_bytecode(relative)
        });
        if actual != self.modes {
            return Ok(false);
        }
        for (relative, expected) in &self.manifests {
            let actual: Value = serde_json::from_slice(&fs::read(path.join(relative))?)?;
            if actual != *expected {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

fn file_inventory(root: &Path) -> Result<BTreeMap<PathBuf, u32>, CapabilitySyncError> {
    fn visit(
        root: &Path,
        path: &Path,
        files: &mut BTreeMap<PathBuf, u32>,
    ) -> Result<(), CapabilitySyncError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.is_symlink() {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime ownership cannot be proved through a symlink",
            ));
        }
        if metadata.is_dir() {
            for child in fs::read_dir(path)? {
                visit(root, &child?.path(), files)?;
            }
        } else if metadata.is_file() {
            files.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                file_mode(&metadata),
            );
        } else {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime contains a special file",
            ));
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn matching_file(
    source: &Path,
    relative: &Path,
    paths: &BTreeSet<PathBuf>,
) -> Result<BTreeSet<PathBuf>, CapabilitySyncError> {
    let mut original = fs::File::open(source.join(relative))?;
    #[cfg(test)]
    super::tests::record_read(&source.join(relative));
    let mut readers = paths
        .iter()
        .filter_map(|path| {
            let file = fs::File::open(path.join(relative)).ok()?;
            #[cfg(test)]
            super::tests::record_read(&path.join(relative));
            Some((path.clone(), file))
        })
        .collect::<BTreeMap<_, _>>();
    let mut expected = [0u8; 64 * 1024];
    let mut actual = [0u8; 64 * 1024];
    loop {
        let count = original.read(&mut expected)?;
        if count == 0 || readers.is_empty() {
            break;
        }
        readers.retain(|_, file| {
            file.read_exact(&mut actual[..count]).is_ok() && actual[..count] == expected[..count]
        });
    }
    readers.retain(|_, file| file.read(&mut actual[..1]).is_ok_and(|count| count == 0));
    Ok(readers.into_keys().collect())
}
