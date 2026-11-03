// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl GlobalCapabilityStore {
    pub(super) fn unchanged_plugin_runtime_paths(
        &self,
        spec: &PluginSyncSpec,
        source: &Path,
    ) -> Result<BTreeSet<PathBuf>, CapabilitySyncError> {
        let stage = tempfile::tempdir()?;
        let template = stage.path().join("runtime");
        copy_dir_atomic(source, &template)?;
        ensure_dual_plugin_manifests(&template)?;
        ensure_plugin_hook_permissions(&template)?;
        let modes = tree_fingerprint(&template)?
            .into_keys()
            .map(|path| Ok((path.clone(), file_mode(&fs::metadata(template.join(path))?))))
            .collect::<Result<BTreeMap<_, _>, CapabilitySyncError>>()?;
        let reusable = |path: &Path| {
            // Ownership was validated before this probe. Unreadable or symlinked
            // contents still follow the existing whole-directory repair path.
            same_runtime_contents(path, &template).unwrap_or(false)
                && modes.iter().all(|(relative, expected)| {
                    fs::symlink_metadata(path.join(relative))
                        .is_ok_and(|metadata| file_mode(&metadata) == *expected)
                })
        };
        let mut reused = BTreeSet::new();
        for (runtime, field) in self.plugin_runtime_targets(spec) {
            if reusable(&runtime) {
                reused.insert(runtime.clone());
            }
            let claude = field == "claude_link";
            let market = if claude {
                self.claude_marketplace_dir(&spec.marketplace)
            } else {
                self.codex_marketplace_dir(&spec.marketplace)
            };
            let link = market
                .join("plugins")
                .join(self.marketplace_plugin_name(spec, claude));
            self.ensure_state_path(&link, true)?;
            if fs::read_link(&link).is_ok_and(|target| target == runtime) || reusable(&link) {
                reused.insert(link);
            }
        }
        Ok(reused)
    }
}

fn file_mode(metadata: &fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111
    }
    #[cfg(not(unix))]
    {
        u32::from(metadata.permissions().readonly())
    }
}

pub(super) fn tree_fingerprint(
    path: &Path,
) -> Result<BTreeMap<PathBuf, String>, CapabilitySyncError> {
    fn visit(
        root: &Path,
        path: &Path,
        result: &mut BTreeMap<PathBuf, String>,
    ) -> Result<(), CapabilitySyncError> {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime ownership cannot be proved through a symlink",
            ));
        }
        if metadata.is_dir() {
            for child in fs::read_dir(path)? {
                visit(root, &child?.path(), result)?;
            }
        } else if metadata.is_file() {
            result.insert(
                path.strip_prefix(root).unwrap().to_owned(),
                sha256_digest(&fs::read(path)?),
            );
        } else {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime contains a special file",
            ));
        }
        Ok(())
    }
    let mut result = BTreeMap::new();
    visit(path, path, &mut result)?;
    Ok(result)
}

// Ownership compares manifest content; recovery receipts keep raw byte fingerprints.
pub(super) fn runtime_tree_fingerprint(
    path: &Path,
) -> Result<BTreeMap<PathBuf, String>, CapabilitySyncError> {
    let mut fingerprint = tree_fingerprint(path)?;
    for relative in [CODEX_PLUGIN_MANIFEST_PATH, CLAUDE_PLUGIN_MANIFEST_PATH] {
        if let Some(digest) = fingerprint.get_mut(Path::new(relative)) {
            let mut manifest: Value = serde_json::from_slice(&fs::read(path.join(relative))?)?;
            manifest.sort_all_objects();
            *digest = sha256_digest(&serde_json::to_vec(&manifest)?);
        }
    }
    Ok(fingerprint)
}

pub(super) fn same_runtime_contents(
    left: &Path,
    right: &Path,
) -> Result<bool, CapabilitySyncError> {
    if !left.is_dir() || left.is_symlink() || !right.is_dir() || right.is_symlink() {
        return Ok(false);
    }
    Ok(same_fingerprints(
        runtime_tree_fingerprint(left)?,
        &runtime_tree_fingerprint(right)?,
    ))
}

pub(super) fn same_fingerprints(
    mut left: BTreeMap<PathBuf, String>,
    right: &BTreeMap<PathBuf, String>,
) -> bool {
    left.retain(|path, _| {
        !(path
            .components()
            .any(|component| component.as_os_str() == "__pycache__")
            && path.extension().is_some_and(|extension| extension == "pyc")
            && !right.contains_key(path))
    });
    left == *right
}
