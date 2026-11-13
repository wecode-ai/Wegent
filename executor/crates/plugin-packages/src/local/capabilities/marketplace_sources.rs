// SPDX-License-Identifier: Apache-2.0

//! Retain verifiable ownership of official marketplace copies across uninstall.
//! Receipts authorize replacement only; they never create installed inventory.

use super::*;

const RECEIPTS: &str = "plugin_retained_sources";

fn source_spec(key: &str, entry: &Value) -> Option<PluginSyncSpec> {
    let spec = checked_spec(key, entry).ok()?;
    (entry.get("managed").and_then(Value::as_bool) == Some(true)
        && CLOUD_MANAGED_PLUGIN_MARKETPLACES.contains(&spec.marketplace.as_str())
        && spec.installed_plugin_id.is_some_and(|id| id > 0)
        && spec.checksum.is_some())
    .then_some(spec)
}

fn receipt(key: &str, entry: &Value) -> Option<Value> {
    source_spec(key, entry)?;
    let mut record = Map::new();
    for field in [
        "managed",
        "name",
        "marketplace",
        "version",
        "checksum",
        "installed_plugin_id",
        "runtime",
    ] {
        if let Some(value) = entry.get(field) {
            record.insert(field.to_owned(), value.clone());
        }
    }
    Some(Value::Object(record))
}

pub(in crate::local::capabilities) fn remember(manifest: &mut Value, key: &str, entry: &Value) {
    let Some(mut record) = receipt(key, entry) else {
        return;
    };
    if let Some(previous) = entry.get("previous").and_then(|entry| receipt(key, entry)) {
        record["previous"] = previous;
    }
    ensure_object_field(manifest, RECEIPTS).insert(key.to_owned(), record);
}

pub(super) fn rebase(manifest: &mut Value, key: &str, field: &str, old: &Path, next: &Path) {
    let Some(record) = manifest
        .get_mut(RECEIPTS)
        .and_then(|records| records.get_mut(key))
    else {
        return;
    };
    rebase_entry(record, key, field, old, next);
    if let Some(previous) = record.get_mut("previous") {
        rebase_entry(previous, key, field, old, next);
    }
}

fn rebase_entry(entry: &mut Value, key: &str, field: &str, old: &Path, next: &Path) {
    let Some(spec) = source_spec(key, entry) else {
        return;
    };
    let recorded = entry
        .get("runtime")
        .and_then(|runtime| runtime.get(field))
        .and_then(Value::as_str)
        .map(Path::new);
    if recorded == Some(old) && historical_cache_path(old, &spec, field) {
        // The caller has validated and relocated this exact runtime owner.
        entry["runtime"][field] = json!(next);
    }
}

impl GlobalCapabilityStore {
    fn marketplace_copy_package(
        &self,
        spec: &PluginSyncSpec,
    ) -> Option<crate::services::workbench::LeasedPluginPackage> {
        let package = self
            .verified_plugin_package(spec.checksum.as_deref()?)
            .and_then(|package| {
                validate_package_identity(&package.path, spec)?;
                Ok(package)
            });
        match package {
            Ok(package) => Some(package),
            Err(error) => {
                crate::logging::log_executor_event(
                    "marketplace copy package evidence unavailable",
                    &[
                        ("plugin", spec.key.clone()),
                        ("checksum", spec.checksum.clone().unwrap_or_default()),
                        ("error", error.to_string()),
                    ],
                );
                None
            }
        }
    }

    pub(super) fn owns_managed_marketplace_copy(
        &self,
        requested: &PluginSyncSpec,
        target: &Path,
        field: &str,
        manifest: &Value,
    ) -> Result<bool, CapabilitySyncError> {
        if !self.shared_packages
            || target.is_symlink()
            || !CLOUD_MANAGED_PLUGIN_MARKETPLACES.contains(&requested.marketplace.as_str())
        {
            return Ok(false);
        }
        let active = manifest
            .get("plugins")
            .and_then(|records| records.get(&requested.key));
        // Preserve the existing same-install verifier; only real inventory counts here.
        if active.is_some_and(|entry| {
            entry.get("managed").and_then(Value::as_bool) == Some(true)
                && entry.get("installed_plugin_id").and_then(Value::as_i64)
                    == requested.installed_plugin_id
        }) {
            return Ok(false);
        }
        let retained = manifest
            .get(RECEIPTS)
            .and_then(|records| records.get(&requested.key));
        for (record, retained) in [(active, false), (retained, true)] {
            let Some(record) = record else { continue };
            for entry in [Some(record), record.get("previous")].into_iter().flatten() {
                let Some(spec) = source_spec(&requested.key, entry) else {
                    continue;
                };
                let runtime = if field == "claude_link" {
                    self.plugin_runtime_link(&spec)
                } else {
                    self.plugin_codex_link(&spec)
                };
                if !entry_owns_path(entry, &runtime, field) {
                    continue;
                }
                let owner = manifest
                    .get("plugin_runtime_owners")
                    .and_then(|owners| owners.get(runtime.to_string_lossy().as_ref()))
                    .and_then(Value::as_str);
                if owner.is_some_and(|owner| owner != requested.key)
                    || (retained && owner != Some(requested.key.as_str()))
                {
                    continue;
                }
                self.ensure_runtime_path(&runtime, false)?;
                // The old verified archive, not the mutable native cache, proves content.
                let Some(package) = self.marketplace_copy_package(&spec) else {
                    continue;
                };
                if self.matches_managed_package_copy(target, &spec, &package.path)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
#[path = "marketplace_sources_tests.rs"]
mod tests;
