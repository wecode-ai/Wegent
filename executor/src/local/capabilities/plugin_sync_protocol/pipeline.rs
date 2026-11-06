// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Register intent first, prepare independently, then merge into current state.

use super::*;
use futures_util::{stream, StreamExt};
use plugin_preparation::{PreparedPlugin, MAX_PLUGIN_PREPARATIONS};

struct Accepted {
    jobs: Vec<(PluginSyncSpec, bool)>,
    results: Vec<Value>,
}

impl<P: CapabilityPackageProvider> CapabilitySyncHandler<P> {
    pub(super) async fn apply_ordered_plugin_sync(
        &self,
        payload: &Value,
        request: PluginSyncRequest,
    ) -> Result<Value, CapabilitySyncError> {
        let started = Instant::now();
        // Legacy commands have no generation fences. Exclude them for the
        // whole v2 transaction while allowing independent v2 preparations.
        let _protocol = self.plugin_preparation.protocol.read().await;
        let Accepted { jobs, mut results } = self.accept_plugin_intents(&request).await?;
        let mut changes = activation_revision::Changes::default();
        let mut completed = stream::iter(jobs.into_iter().enumerate().map(
            |(index, (spec, removing))| async move {
                self.prepare_and_publish_plugin(spec, request.generation, removing)
                    .await
                    .map(|(result, changes)| (index, result, changes))
            },
        ))
        .buffer_unordered(MAX_PLUGIN_PREPARATIONS);
        let mut ordered = Vec::new();
        while let Some(result) = completed.next().await {
            let (index, result, change) = result?;
            merge_changes(&mut changes, change);
            ordered.push((index, result));
        }
        ordered.sort_by_key(|(index, _)| *index);
        results.extend(ordered.into_iter().map(|(_, result)| result));
        let (skill_results, change) = self
            .finish_plugin_snapshot(
                payload,
                &request,
                results
                    .iter()
                    .any(|result| result["status"] != "superseded"),
            )
            .await?;
        merge_changes(&mut changes, change);
        let success = results
            .iter()
            .chain(&skill_results)
            .all(|result| result["status"] != "failed");
        crate::logging::log_executor_event(
            "plugin_sync_completed",
            &[
                ("generation", request.generation.to_string()),
                ("complete", request.complete.to_string()),
                ("total_ms", started.elapsed().as_millis().to_string()),
                ("plugin_count", results.len().to_string()),
                (
                    "skipped_plugins",
                    results
                        .iter()
                        .filter(|result| result["unchanged"] == true)
                        .count()
                        .to_string(),
                ),
                ("changed", changes.changed.to_string()),
                ("requires_restart", changes.requires_restart.to_string()),
                ("detection_ms", changes.detection_ms.to_string()),
                ("inspected_plugins", changes.inspected_plugins.to_string()),
                ("hashed_files", changes.hashed_files.to_string()),
                ("hashed_bytes", changes.hashed_bytes.to_string()),
                ("reused_hashes", changes.reused_hashes.to_string()),
                ("changed_plugins", changes.plugins.join(",")),
                ("changed_skills", changes.skills.join(",")),
            ],
        );
        Ok(
            json!({"success":success, "changed":changes.changed,"requires_restart":changes.requires_restart,
            "scope":payload.get("scope").and_then(Value::as_str).unwrap_or("all"),
            "skills":skill_results,"plugins":results,
            "plugin_sync":{"version":2,"generation":request.generation,"complete":request.complete}}),
        )
    }

    async fn accept_plugin_intents(
        &self,
        request: &PluginSyncRequest,
    ) -> Result<Accepted, CapabilitySyncError> {
        let _sync = self.sync_lock.lock().await;
        let _publication = self.store.lock_shared_manifest()?;
        let _binding = self.plugin_sync_binding.lock_active()?;
        let mut manifest = self.store.manifest.load()?;
        let original = manifest.clone();
        self.plugin_sync_binding.bind_manifest(&mut manifest);
        if !request.plugins_only && request.generation > full_generation(&manifest) {
            protocol_state(&mut manifest)
                .insert("full_generation".to_owned(), json!(request.generation));
        }
        if request.complete && request.generation > complete_generation(&manifest) {
            protocol_state(&mut manifest)
                .insert("complete_generation".to_owned(), json!(request.generation));
            for collection in ["entries", "removals"] {
                if let Some(records) = manifest["plugin_sync"]
                    .get_mut(collection)
                    .and_then(Value::as_object_mut)
                {
                    records.retain(|_, record| {
                        record["generation"].as_u64().unwrap_or(0) >= request.generation
                    });
                }
            }
        }
        let mut removals = request.removals.clone();
        if request.complete && request.generation >= complete_generation(&manifest) {
            let desired = request
                .plugins
                .iter()
                .map(|spec| &spec.key)
                .collect::<BTreeSet<_>>();
            let explicit = removals
                .iter()
                .map(|spec| spec.key.clone())
                .collect::<BTreeSet<_>>();
            for (key, entry) in object_map(manifest.get("plugins")).unwrap_or_default() {
                if !desired.contains(&key)
                    && !explicit.contains(&key)
                    && is_reconcilable(&key, &entry)
                {
                    removals.push(PluginSyncSpec::from_manifest_entry(&key, &entry));
                }
            }
        }
        let mut accepted = Accepted {
            jobs: Vec::new(),
            results: Vec::new(),
        };
        for (spec, removing) in removals
            .into_iter()
            .map(|spec| (spec, true))
            .chain(request.plugins.iter().cloned().map(|spec| (spec, false)))
        {
            if is_superseded(&manifest, &spec, request.generation, removing) {
                accepted.results.push(acknowledgement(
                    &spec,
                    request.generation,
                    "superseded",
                    if removing { "remove" } else { "upsert" },
                ));
            } else {
                // Persist before downloads or lane waits. A newer removal or
                // complete snapshot can fence an already preparing installation.
                record_intent(&mut manifest, &spec, request.generation, removing);
                accepted.jobs.push((spec, removing));
            }
        }
        if manifest != original {
            self.store.manifest.save_with_revision_bump(manifest)?;
        }
        Ok(accepted)
    }

    async fn prepare_and_publish_plugin(
        &self,
        mut spec: PluginSyncSpec,
        generation: u64,
        removing: bool,
    ) -> Result<(Value, activation_revision::Changes), CapabilitySyncError> {
        let queued = Instant::now();
        // Acquire a plugin lane before a global slot: queued work for the same
        // plugin must not consume every slot and starve unrelated installations.
        let lane = self.plugin_preparation.plugin(&spec.key).lock_owned().await;
        let snapshot = {
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
            manifest
        };
        if removing {
            return self
                .publish_prepared_plugin(&spec, generation, true, &snapshot, None)
                .await;
        }
        let permit = self
            .plugin_preparation
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| invalid("Plugin preparation scheduler closed"))?;
        let queue_ms = queued.elapsed().as_millis();
        spec.sync_generation = Some(generation);
        let lease = Arc::new(plugin_preparation::PreparationLease {
            _lane: Some(lane),
            _slot: permit,
        });
        // The caller and worker share the lease. Failure keeps the lane until
        // publication, and cancellation cannot release a still-running worker's slot.
        let prepared = self.prepare_plugin(&spec, &snapshot, lease.clone()).await;
        crate::logging::log_executor_event(
            "plugin_prepared",
            &[
                ("plugin", spec.key.clone()),
                ("generation", generation.to_string()),
                ("queue_ms", queue_ms.to_string()),
                ("total_ms", queued.elapsed().as_millis().to_string()),
            ],
        );
        self.publish_prepared_plugin(&spec, generation, false, &snapshot, Some(prepared))
            .await
    }

    async fn publish_prepared_plugin(
        &self,
        spec: &PluginSyncSpec,
        generation: u64,
        removing: bool,
        snapshot: &Value,
        prepared: Option<Result<PreparedPlugin, PluginSyncFailure>>,
    ) -> Result<(Value, activation_revision::Changes), CapabilitySyncError> {
        let _sync = self.sync_lock.lock().await;
        let _activation = crate::services::capability_activation::activate().await;
        let _publication = self.store.lock_shared_manifest()?;
        let mut activation = activation_revision::ActivationRevision::begin(&self.store, &[], &[])?;
        let result;
        {
            let _binding = self.plugin_sync_binding.lock_active()?;
            // Never save the preparation snapshot over another plugin's commit.
            let mut manifest = self.store.manifest.load()?;
            if is_superseded(&manifest, spec, generation, removing) {
                return Ok((
                    acknowledgement(
                        spec,
                        generation,
                        "superseded",
                        if removing { "remove" } else { "upsert" },
                    ),
                    Default::default(),
                ));
            }
            if removing {
                result =
                    self.remove_ordered_plugin(spec, generation, &mut manifest, &mut activation)?;
            } else {
                let prepared = prepared.expect("upsert has preparation result");
                result = match prepared {
                    Err(failure) => failed_ack(spec, generation, failure),
                    Ok(mut prepared) => {
                        if manifest["plugins"].get(&spec.key) != snapshot["plugins"].get(&spec.key)
                        {
                            return Err(invalid("Plugin installation changed during preparation; retry against current state"));
                        }
                        if prepared.unchanged {
                            let mut result = acknowledgement(spec, generation, "synced", "upsert");
                            result["unchanged"] = json!(true);
                            result
                        } else {
                            activation.observe_plugin(spec)?;
                            match prepared.publish(&self.store, &mut manifest) {
                                Ok(()) => acknowledgement(spec, generation, "synced", "upsert"),
                                Err(failure) => failed_ack(spec, generation, failure),
                            }
                        }
                    }
                };
                if result["status"] == "synced" {
                    record_generation(&mut manifest, spec, generation, false);
                }
                self.store.manifest.save_with_revision_bump(manifest)?;
            }
        }
        let mut result = result;
        if result["status"] == "synced" {
            result["version"] = json!(spec.version);
            result["checksum"] = json!(spec.checksum);
        }
        Ok((result, activation.finish_with_skill_reload().await?))
    }

    async fn finish_plugin_snapshot(
        &self,
        payload: &Value,
        request: &PluginSyncRequest,
        applied: bool,
    ) -> Result<(Vec<Value>, activation_revision::Changes), CapabilitySyncError> {
        let _sync = self.sync_lock.lock().await;
        let _activation = crate::services::capability_activation::activate().await;
        let _publication = self.store.lock_shared_manifest()?;
        let mut activation = activation_revision::ActivationRevision::begin(&self.store, &[], &[])?;
        let mut manifest = {
            let _binding = self.plugin_sync_binding.lock_active()?;
            self.store.manifest.load()?
        };
        let mut skills = Vec::new();
        let original = manifest.clone();
        if !request.plugins_only && request.generation >= full_generation(&manifest) {
            let desired = request
                .skills
                .iter()
                .map(|spec| spec.name.clone())
                .collect();
            {
                let _binding = self.plugin_sync_binding.lock_active()?;
                self.remove_stale_managed_skills(&desired, &mut manifest, &mut activation)?;
            }
            for spec in &request.skills {
                activation.observe_skill(&spec.name)?;
                skills.push(self.sync_skill(spec, &mut manifest).await);
            }
            let _binding = self.plugin_sync_binding.lock_active()?;
            self.record_mcps(payload.get("mcps"), "replace", &mut manifest)?;
        }
        {
            let _binding = self.plugin_sync_binding.lock_active()?;
            // Private-store GC must not delete a sibling stage or an older
            // runtime still used by another request's preparation worker.
            let current = applied
                || (request.complete && request.generation >= complete_generation(&manifest))
                || (!request.plugins_only && request.generation >= full_generation(&manifest));
            if current
                && self.plugin_preparation.slots.available_permits() == MAX_PLUGIN_PREPARATIONS
            {
                self.store
                    .garbage_collect_unreferenced_managed_plugins(&manifest, |path| {
                        activation.observe_cleanup_path(path)
                    })?;
            }
            if manifest != original {
                self.store.manifest.save_with_revision_bump(manifest)?;
            }
        }
        Ok((skills, activation.finish_with_skill_reload().await?))
    }
}

fn failed_ack(spec: &PluginSyncSpec, generation: u64, failure: PluginSyncFailure) -> Value {
    json!({"id":spec.installed_plugin_id,"name":spec.name,"generation":generation,"operation":"upsert",
        "status":"failed","stage":failure.stage,"error_code":failure.error_code,
        "retryable":failure.retryable,"error":failure.error.to_string()})
}

fn merge_changes(total: &mut activation_revision::Changes, change: activation_revision::Changes) {
    total.changed |= change.changed;
    total.requires_restart |= change.requires_restart;
    total.plugins.extend(change.plugins);
    total.skills.extend(change.skills);
    total.detection_ms += change.detection_ms;
    total.inspected_plugins += change.inspected_plugins;
    total.hashed_files += change.hashed_files;
    total.hashed_bytes += change.hashed_bytes;
    total.reused_hashes += change.reused_hashes;
}
