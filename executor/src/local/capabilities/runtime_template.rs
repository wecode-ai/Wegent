// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// Expected runtime contents are shared by every destination in one reuse probe.
pub(super) struct RuntimeTemplate {
    fingerprint: BTreeMap<PathBuf, String>,
    modes: BTreeMap<PathBuf, u32>,
}

impl RuntimeTemplate {
    pub(super) fn read(source: &Path) -> Result<Self, CapabilitySyncError> {
        let mut fingerprint = runtime_tree_fingerprint(source)?;
        let mut modes = BTreeMap::new();
        for relative in fingerprint.keys() {
            let mode = file_mode(&fs::metadata(source.join(relative))?);
            #[cfg(unix)]
            let mode = if is_plugin_hook_path(relative) {
                mode | 0o111
            } else {
                mode
            };
            modes.insert(relative.clone(), mode);
        }

        // Reuse the actual manifest conversion without copying the package's
        // payload. Only these small files differ from the published source.
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
        for (relative, digest) in runtime_tree_fingerprint(stage.path())? {
            modes.insert(
                relative.clone(),
                file_mode(&fs::metadata(stage.path().join(&relative))?),
            );
            fingerprint.insert(relative, digest);
        }
        Ok(Self { fingerprint, modes })
    }

    pub(super) fn matches(&self, path: &Path) -> Result<bool, CapabilitySyncError> {
        if !path.is_dir() || path.is_symlink() {
            return Ok(false);
        }
        if !same_fingerprints(runtime_tree_fingerprint(path)?, &self.fingerprint) {
            return Ok(false);
        }
        Ok(self.modes.iter().all(|(relative, expected)| {
            fs::symlink_metadata(path.join(relative))
                .is_ok_and(|metadata| file_mode(&metadata) == *expected)
        }))
    }
}
