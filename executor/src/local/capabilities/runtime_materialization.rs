// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[path = "runtime_template.rs"]
mod template;
use template::RuntimeTemplate;

impl GlobalCapabilityStore {
    pub(in crate::local::capabilities) fn unchanged_plugin_runtime_paths(
        &self,
        spec: &PluginSyncSpec,
        source: &Path,
    ) -> Result<BTreeSet<PathBuf>, CapabilitySyncError> {
        let mut reused = BTreeSet::new();
        let mut candidates = BTreeSet::new();
        for (runtime, field) in self.plugin_runtime_targets(spec) {
            if runtime.is_dir() && !runtime.is_symlink() {
                candidates.insert(runtime.clone());
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
            if fs::read_link(&link).is_ok_and(|target| target == runtime) {
                reused.insert(link);
            } else if link.is_dir() && !link.is_symlink() {
                candidates.insert(link);
            }
        }
        if candidates.is_empty() {
            return Ok(reused);
        }
        let template = RuntimeTemplate::read(source)?;
        // Ownership was validated before this probe. Unreadable or symlinked
        // contents still follow the existing whole-directory repair path.
        reused.extend(template.matching_paths(&candidates)?);
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
            #[cfg(test)]
            tests::record_hash(path);
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
    left.retain(|path, _| !is_runtime_bytecode(path) || right.contains_key(path));
    left == *right
}

fn is_runtime_bytecode(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "__pycache__")
        && path.extension().is_some_and(|extension| extension == "pyc")
}

#[cfg(test)]
#[path = "runtime_materialization_tests.rs"]
mod tests;
