// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl GlobalCapabilityStore {
    /// The shared package, every runtime copy, and native configuration must agree.
    /// Legacy stores without a verifiable published package still need normal repair.
    pub(in crate::local::capabilities) fn plugin_metadata_matches(
        &self,
        spec: &PluginSyncSpec,
        manifest: &Value,
        package: &Path,
        reused: &BTreeSet<PathBuf>,
    ) -> Result<bool, CapabilitySyncError> {
        let Some(entry) = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
        else {
            return Ok(false);
        };
        if !self.shared_packages
            || entry["managed"] != true
            || entry.get("runtime_recovery_error").is_some()
            || (self.codex_only_plugins && entry["runtime"].get("claude_link").is_some())
            || RecoveryJournal::pending_identity(self, &spec.key)?.is_some()
            || !same_definition(spec, entry)
        {
            return Ok(false);
        }
        if spec.checksum.is_none() {
            return Ok(false);
        }
        if entry["store_path"].as_str() != package.to_str() {
            return Ok(false);
        }
        validate_package_identity(package, spec)?;
        for (path, field) in self.plugin_runtime_targets(spec) {
            self.ensure_runtime_path(&path, true)?;
            if entry
                .get("runtime")
                .and_then(|runtime| runtime.get(field))
                .and_then(Value::as_str)
                .map(Path::new)
                != Some(path.as_path())
            {
                return Ok(false);
            }
        }
        self.validate_marketplace_occupancy(spec, entry, manifest)?;
        if !self
            .runtime_state_paths(spec)
            .1
            .iter()
            .all(|path| reused.contains(path))
        {
            return Ok(false);
        }
        plan::metadata_matches(
            self,
            spec,
            &PluginSyncSpec::from_manifest_entry(&spec.key, entry).component_states,
        )
    }
}

fn same_definition(spec: &PluginSyncSpec, entry: &Value) -> bool {
    let actual = PluginSyncSpec::from_manifest_entry(&spec.key, entry);
    entry["key"] == spec.key
        && entry["name"] == spec.name
        && actual.name == spec.name
        && actual.marketplace == spec.marketplace
        && actual.installed_plugin_id == spec.installed_plugin_id
        && actual.cloud_plugin_id == spec.cloud_plugin_id
        && actual.version == spec.version
        && actual.checksum == spec.checksum
        && actual.enabled == spec.enabled
        && actual.component_states == spec.component_states
}
