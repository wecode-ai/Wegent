// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Share one publication across transports without weakening intent ordering.

use super::*;

fn trusted_checksum(spec: &PluginSyncSpec) -> Option<String> {
    let checksum = spec.checksum.as_deref()?;
    let digest = checksum.strip_prefix("sha256:").unwrap_or(checksum);
    (digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| digest.to_ascii_lowercase())
}

pub(super) fn target_fingerprint(spec: &PluginSyncSpec, removing: bool) -> String {
    // Transport generations and renewable URLs do not change desired files.
    let checksum = trusted_checksum(spec);
    let mut target = if removing {
        json!([spec.key, spec.installed_plugin_id, "remove"])
    } else {
        json!([
            spec.key,
            spec.installed_plugin_id,
            spec.cloud_plugin_id,
            spec.enabled,
            spec.version,
            checksum.as_ref().or(spec.checksum.as_ref()),
            spec.component_states,
            if checksum.is_some() {
                None
            } else {
                spec.download_path.as_ref()
            }
        ])
    };
    target.sort_all_objects();
    sha256_digest(target.to_string().as_bytes())
}

fn matching_intent<'a>(
    manifest: &'a Value,
    spec: &PluginSyncSpec,
    removing: bool,
) -> Option<&'a Value> {
    // An unversioned download address alone cannot prove equivalent bytes.
    if !removing && trusted_checksum(spec).is_none() {
        return None;
    }
    let (collection, key) = intent_identity(spec, removing);
    let record = &manifest["plugin_sync"][collection][key];
    let generation = record["generation"].as_u64()?;
    if record["target"].as_str()? != target_fingerprint(spec, removing)
        || generation < complete_generation(manifest)
    {
        return None;
    }
    let opposite = if removing {
        &manifest["plugin_sync"]["entries"][&spec.key]
    } else {
        &manifest["plugin_sync"]["removals"][spec.installed_plugin_id?.to_string()]
    };
    let opposite_generation = opposite["generation"].as_u64().unwrap_or(0);
    if opposite["installed_plugin_id"].as_i64() == spec.installed_plugin_id
        && (generation < opposite_generation || !removing && generation == opposite_generation)
    {
        return None;
    }
    Some(record)
}

pub(super) fn equivalent_generation(
    manifest: &Value,
    spec: &PluginSyncSpec,
    generation: u64,
    removing: bool,
) -> u64 {
    let existing = matching_intent(manifest, spec, removing)
        .and_then(equivalent_floor)
        .filter(|first| *first <= generation);
    if let Some(first) = existing {
        return first;
    }
    let (collection, key) = intent_identity(spec, removing);
    let previous = manifest["plugin_sync"][collection][key]["generation"]
        .as_u64()
        .unwrap_or(0);
    let opposite = if removing {
        &manifest["plugin_sync"]["entries"][&spec.key]
    } else {
        &manifest["plugin_sync"]["removals"][spec.installed_plugin_id.unwrap().to_string()]
    };
    let opposite_generation =
        if opposite["installed_plugin_id"].as_i64() == spec.installed_plugin_id {
            opposite["generation"].as_u64().unwrap_or(0)
        } else {
            0
        };
    // A return to an earlier target must retain the intervening change barrier.
    previous
        .max(opposite_generation)
        .max(complete_generation(manifest))
        .saturating_add(1)
        .min(generation)
}

pub(super) fn equivalent_request(
    manifest: &Value,
    spec: &PluginSyncSpec,
    generation: u64,
    removing: bool,
) -> bool {
    matching_intent(manifest, spec, removing)
        .and_then(equivalent_floor)
        .is_some_and(|first| first <= generation)
}

fn equivalent_floor(record: &Value) -> Option<u64> {
    record["equivalent_since"]
        .as_u64()
        .filter(|first| *first > 0 && *first <= record["generation"].as_u64().unwrap_or(0))
}

pub(super) fn publication_generation(
    manifest: &Value,
    spec: &PluginSyncSpec,
    generation: u64,
    removing: bool,
) -> u64 {
    matching_intent(manifest, spec, removing)
        .and_then(|record| record["generation"].as_u64())
        .unwrap_or(0)
        .max(generation)
}

impl<P: CapabilityPackageProvider> CapabilitySyncHandler<P> {
    pub(super) async fn prepare_and_publish_plugin(
        &self,
        spec: PluginSyncSpec,
        generation: u64,
        removing: bool,
    ) -> Result<(Value, activation_revision::Changes), CapabilitySyncError> {
        let key = {
            let _sync = self.sync_lock.lock().await;
            let _binding = self.plugin_sync_binding.lock_active()?;
            let manifest = self.store.manifest.load()?;
            if is_superseded(&manifest, &spec, generation, removing) {
                return Ok((
                    acknowledgement(
                        &spec,
                        generation,
                        "superseded",
                        if removing { "remove" } else { "upsert" },
                    ),
                    Default::default(),
                ));
            }
            let first = equivalent_generation(&manifest, &spec, generation, removing);
            format!("target:{first}:{}", target_fingerprint(&spec, removing))
        };
        let (pending, owner) = self.plugin_sync_inflight.claim(&key);
        if !owner {
            let result = pending.wait().await?;
            return self
                .confirm_shared_publication(&spec, generation, removing, result)
                .await;
        }
        let owner = InFlightOwner {
            requests: &self.plugin_sync_inflight,
            key,
            request: pending,
        };
        let result = self
            .prepare_and_publish_plugin_once(spec, generation, removing)
            .await;
        *owner
            .request
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(
            result
                .as_ref()
                .map(|(ack, _)| ack.clone())
                .map_err(ToString::to_string),
        );
        result
    }

    async fn confirm_shared_publication(
        &self,
        spec: &PluginSyncSpec,
        generation: u64,
        removing: bool,
        mut result: Value,
    ) -> Result<(Value, activation_revision::Changes), CapabilitySyncError> {
        let _sync = self.sync_lock.lock().await;
        let _publication = self.store.lock_shared_manifest()?;
        let _binding = self.plugin_sync_binding.lock_active()?;
        let mut manifest = self.store.manifest.load()?;
        // Shared work proves success only while this goal is still current.
        if is_superseded(&manifest, spec, generation, removing) {
            result = acknowledgement(
                spec,
                generation,
                "superseded",
                if removing { "remove" } else { "upsert" },
            );
        } else if matches!(result["status"].as_str(), Some("synced" | "removed")) {
            record_generation(&mut manifest, spec, generation, removing);
            self.store.manifest.save_with_revision_bump(manifest)?;
            result["unchanged"] = json!(true);
            if !removing {
                result["version"] = json!(spec.version);
                result["checksum"] = json!(spec.checksum);
            }
        }
        result["generation"] = json!(generation);
        crate::logging::log_executor_event(
            "plugin_target_coalesced",
            &[
                ("plugin", spec.key.clone()),
                ("generation", generation.to_string()),
            ],
        );
        Ok((result, Default::default()))
    }
}
