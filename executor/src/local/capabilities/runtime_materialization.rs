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
