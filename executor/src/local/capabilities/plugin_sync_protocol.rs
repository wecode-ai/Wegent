// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Instant;

use tokio::sync::Notify;

use super::*;

#[derive(Debug)]
pub(super) struct PluginSyncRequest {
    generation: u64,
    complete: bool,
    plugins_only: bool,
    plugins: Vec<PluginSyncSpec>,
    removals: Vec<PluginSyncSpec>,
    skills: Vec<SkillSyncSpec>,
}

impl PluginSyncRequest {
    pub(super) fn parse(payload: &Value) -> Result<Option<Self>, CapabilitySyncError> {
        let Some(protocol) = payload.get("plugin_sync") else {
            if payload.get("scope").and_then(Value::as_str) == Some("plugin_delta")
                || payload.get("removed_plugins").is_some()
            {
                return Err(invalid("Plugin deltas require the plugin sync protocol"));
            }
            return Ok(None);
        };
        if protocol.get("version").and_then(Value::as_u64) != Some(2) {
            return Err(invalid("Unsupported plugin sync protocol version"));
        }
        let generation = protocol
            .get("generation")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(|| invalid("Plugin sync generation must be a positive integer"))?;
        let complete = protocol
            .get("complete")
            .and_then(Value::as_bool)
            .ok_or_else(|| invalid("Plugin sync complete must be a boolean"))?;
        let scope = payload.get("scope").and_then(Value::as_str);
        let mode = payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("merge");
        let plugins_only = scope == Some("plugins") || scope == Some("plugin_delta");
        let valid_scope = matches!(
            (complete, scope, mode),
            (false, Some("plugin_delta"), "merge")
                | (true, Some("plugins"), "merge" | "replace")
                | (true, None | Some("all"), "replace")
        );
        if !valid_scope
            || (plugins_only && (payload.get("skills").is_some() || payload.get("mcps").is_some()))
        {
            return Err(invalid("Plugin sync scope does not match its completeness"));
        }
        for field in ["skills", "mcps"] {
            if payload.get(field).is_some_and(|value| !value.is_array()) {
                return Err(invalid("Capability collections must be arrays"));
            }
        }
        for mcp in value_array(payload.get("mcps")) {
            if !mcp
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| !name.is_empty())
            {
                return Err(invalid("MCP name is required"));
            }
        }
        let plugins = payload
            .get("plugins")
            .and_then(Value::as_array)
            .ok_or_else(|| invalid("Plugin sync requires a plugins array"))?
            .iter()
            .map(PluginSyncSpec::from_value)
            .collect::<Result<Vec<_>, _>>()?;
        let removals = match payload.get("removed_plugins") {
            Some(value) => value
                .as_array()
                .ok_or_else(|| invalid("Plugin removals must be an array"))?
                .iter()
                .map(PluginSyncSpec::from_value)
                .collect::<Result<Vec<_>, _>>()?,
            None => Vec::new(),
        };
        let mut keys = BTreeSet::new();
        for spec in plugins.iter().chain(&removals) {
            if !spec.installed_plugin_id.is_some_and(|id| id > 0) {
                return Err(invalid(
                    "Plugin sync requires a positive installed plugin id",
                ));
            }
            if !keys.insert(spec.key.clone()) {
                return Err(invalid("Plugin sync contains duplicate plugin identities"));
            }
        }
        let skills = value_array(payload.get("skills"))
            .iter()
            .map(SkillSyncSpec::from_value)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Some(Self {
            generation,
            complete,
            plugins_only,
            plugins,
            removals,
            skills,
        }))
    }
}

fn invalid(message: &str) -> CapabilitySyncError {
    CapabilitySyncError::invalid_payload(message)
}

type ActiveBindings = Mutex<BTreeMap<PathBuf, Weak<Mutex<String>>>>;
static ACTIVE_BINDINGS: OnceLock<ActiveBindings> = OnceLock::new();

pub(super) struct ConnectionBinding {
    active: Arc<Mutex<String>>,
    identity: String,
    instance: String,
}

impl ConnectionBinding {
    pub(super) fn new(path: &Path, auth_token: &str) -> Self {
        let identity = sha256_digest(auth_token.as_bytes());
        let instance = uuid::Uuid::new_v4().to_string();
        let mut registry = ACTIVE_BINDINGS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        registry.retain(|_, active| active.strong_count() > 0);
        let active = registry
            .get(path)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let active = Arc::new(Mutex::new(identity.clone()));
                registry.insert(path.to_path_buf(), Arc::downgrade(&active));
                active
            });
        *active.lock().unwrap_or_else(|error| error.into_inner()) = instance.clone();
        Self {
            active,
            identity,
            instance,
        }
    }

    pub(super) fn check(&self) -> Result<(), CapabilitySyncError> {
        self.lock_active().map(drop)
    }

    pub(super) fn lock_active(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, String>, CapabilitySyncError> {
        let active = self
            .active
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if *active != self.instance {
            return Err(invalid(
                "Plugin sync belongs to an inactive backend connection",
            ));
        }
        Ok(active)
    }

    fn bind_manifest(&self, manifest: &mut Value) -> bool {
        // The caller holds the active binding through the manifest commit.
        if manifest.get("plugin_sync_binding").and_then(Value::as_str) == Some(&self.identity) {
            return false;
        }
        // Tokens are never persisted or logged. Changing the connection creates
        // a fresh ordering namespace while package caches remain reusable.
        manifest["plugin_sync_binding"] = json!(self.identity);
        manifest["plugin_sync"] =
            json!({"version": 2, "complete_generation": 0, "full_generation": 0, "entries": {}});
        for plugin in ensure_object_field(manifest, "plugins").values_mut() {
            if let Some(plugin) = plugin.as_object_mut() {
                plugin.remove("plugin_sync_generation");
            }
        }
        true
    }
}

#[derive(Default)]
pub(super) struct InFlightRequests(Mutex<BTreeMap<String, Arc<InFlight>>>);

#[derive(Default)]
struct InFlight {
    generation: u64,
    result: Mutex<Option<Result<Value, String>>>,
    ready: Notify,
}

struct InFlightOwner<'a> {
    requests: &'a InFlightRequests,
    key: String,
    request: Arc<InFlight>,
}

impl Drop for InFlightOwner<'_> {
    fn drop(&mut self) {
        let mut result = self
            .request
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if result.is_none() {
            *result = Some(Err(
                "Plugin sync owner was cancelled; retry the request".to_owned()
            ));
        }
        self.request.ready.notify_waiters();
        self.requests
            .0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&self.key);
    }
}

impl<P: CapabilityPackageProvider> CapabilitySyncHandler<P> {
    pub(super) async fn apply_plugin_sync_request(
        &self,
        payload: Value,
        request: PluginSyncRequest,
    ) -> Result<Value, CapabilitySyncError> {
        let started = Instant::now();
        let mut target = payload.clone();
        target["plugin_sync"]
            .as_object_mut()
            .expect("validated protocol")
            .remove("generation");
        for plugin in target
            .get_mut("plugins")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            if let Some(object) = plugin.as_object_mut() {
                let trusted_checksum = object
                    .get("checksum")
                    .and_then(Value::as_str)
                    .and_then(|checksum| checksum.strip_prefix("sha256:"))
                    .is_some_and(|hash| {
                        hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                    });
                if trusted_checksum {
                    object.remove("download_path");
                    object.remove("download_url_expires_at");
                }
            }
        }
        let key = serde_json::to_string(&target)?;
        let (pending, owner) = {
            let mut requests = self
                .plugin_sync_inflight
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            match requests.get(&key) {
                Some(pending) => (pending.clone(), false),
                None => {
                    let pending = Arc::new(InFlight {
                        generation: request.generation,
                        ..Default::default()
                    });
                    requests.insert(key.clone(), pending.clone());
                    (pending, true)
                }
            }
        };
        if !owner {
            loop {
                let notified = pending.ready.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let result = pending
                    .result
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .clone();
                if let Some(result) = result {
                    crate::logging::log_executor_event(
                        "plugin_sync_coalesced",
                        &[
                            ("generation", request.generation.to_string()),
                            ("queue_ms", started.elapsed().as_millis().to_string()),
                        ],
                    );
                    if pending.generation == request.generation {
                        return result.map_err(CapabilitySyncError::invalid_payload);
                    }
                    // A new generation must verify the current files and ordering
                    // fence, rather than claiming an earlier result is still true.
                    return self.apply_ordered_plugin_sync(&payload, request).await;
                }
                notified.await;
            }
        }
        let owner = InFlightOwner {
            requests: &self.plugin_sync_inflight,
            key,
            request: pending,
        };
        let result = self.apply_ordered_plugin_sync(&payload, request).await;
        *owner
            .request
            .result
            .lock()
            .unwrap_or_else(|error| error.into_inner()) =
            Some(result.as_ref().cloned().map_err(ToString::to_string));
        result
    }

    async fn apply_ordered_plugin_sync(
        &self,
        payload: &Value,
        request: PluginSyncRequest,
    ) -> Result<Value, CapabilitySyncError> {
        let started = Instant::now();
        let _sync_guard = self.sync_lock.lock().await;
        let _activation = crate::services::capability_activation::activate().await;
        let queued_ms = started.elapsed().as_millis();
        let _publication_lock = self.store.lock_shared_manifest()?;
        let mut activation = activation_revision::ActivationRevision::begin(
            &self.store,
            &request.plugins,
            &request.skills,
        )?;
        let mut manifest;
        let mut results = Vec::new();
        let plugins_superseded;
        let full_superseded;
        {
            let _binding = self.plugin_sync_binding.lock_active()?;
            manifest = self.store.manifest.load()?;
            if self.plugin_sync_binding.bind_manifest(&mut manifest) {
                self.store
                    .manifest
                    .save_with_revision_bump(manifest.clone())?;
            }
            plugins_superseded =
                request.complete && request.generation < complete_generation(&manifest);
            full_superseded =
                !request.plugins_only && request.generation < full_generation(&manifest);
            if plugins_superseded && request.plugins_only {
                let mut results = request
                    .plugins
                    .iter()
                    .map(|spec| acknowledgement(spec, request.generation, "superseded", "upsert"))
                    .collect::<Vec<_>>();
                results.extend(
                    request.removals.iter().map(|spec| {
                        acknowledgement(spec, request.generation, "superseded", "remove")
                    }),
                );
                return Ok(
                    json!({"success": true, "changed": activation.finish().changed,
                "scope": payload.get("scope").and_then(Value::as_str).unwrap_or("all"),
                "skills": [], "plugins": results,
                "plugin_sync": {"version": 2, "generation": request.generation, "complete": true}}),
                );
            }
            let advances_full =
                !request.plugins_only && request.generation > full_generation(&manifest);
            if advances_full {
                // Plugin-only refreshes cannot supersede Skills/MCP work. Fence
                // full-all intent before side effects, allowing equal-generation retry.
                protocol_state(&mut manifest)
                    .insert("full_generation".to_owned(), json!(request.generation));
            }
            if request.complete && request.generation > complete_generation(&manifest) {
                // Acceptance fences delayed deltas even when materialization fails.
                let state = protocol_state(&mut manifest);
                state.insert("complete_generation".to_owned(), json!(request.generation));
                // The complete fence supersedes strictly older intents and tombstones.
                // Keep entries at the fence: an equal-generation removal must still
                // block a delayed install of the same generation.
                for collection in ["entries", "removals"] {
                    if let Some(records) = state.get_mut(collection).and_then(Value::as_object_mut)
                    {
                        records.retain(|_, record| {
                            record
                                .get("generation")
                                .and_then(Value::as_u64)
                                .unwrap_or(0)
                                >= request.generation
                        });
                    }
                }
                self.store
                    .manifest
                    .save_with_revision_bump(manifest.clone())?;
            } else if advances_full {
                self.store
                    .manifest
                    .save_with_revision_bump(manifest.clone())?;
            }
            for spec in &request.removals {
                results.push(self.remove_ordered_plugin(
                    spec,
                    request.generation,
                    &mut manifest,
                )?);
            }
            if request.complete && !plugins_superseded {
                let desired = request
                    .plugins
                    .iter()
                    .map(|spec| spec.key.clone())
                    .collect::<BTreeSet<_>>();
                let omitted = object_map(manifest.get("plugins"))
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|(key, plugin)| !desired.contains(key) && is_reconcilable(key, plugin))
                    .map(|(key, plugin)| PluginSyncSpec::from_manifest_entry(&key, &plugin))
                    .collect::<Vec<_>>();
                for spec in omitted {
                    results.push(self.remove_ordered_plugin(
                        &spec,
                        request.generation,
                        &mut manifest,
                    )?);
                }
            }
        }
        for mut spec in request.plugins {
            {
                let _binding = self.plugin_sync_binding.lock_active()?;
                if is_superseded(&manifest, &spec, request.generation, false) {
                    results.push(acknowledgement(
                        &spec,
                        request.generation,
                        "superseded",
                        "upsert",
                    ));
                    continue;
                }
                record_intent(&mut manifest, &spec, request.generation, false);
                self.store
                    .manifest
                    .save_with_revision_bump(manifest.clone())?;
            }
            spec.sync_generation = Some(request.generation);
            let mut result = self.sync_plugin(&spec, &mut manifest).await;
            let _binding = self.plugin_sync_binding.lock_active()?;
            result["generation"] = json!(request.generation);
            result["operation"] = json!("upsert");
            if result.get("status").and_then(Value::as_str) == Some("synced") {
                result["version"] = json!(spec.version);
                result["checksum"] = json!(spec.checksum);
                record_generation(&mut manifest, &spec, request.generation, false);
                self.store
                    .manifest
                    .save_with_revision_bump(manifest.clone())?;
            }
            results.push(result);
        }
        let mut skill_results = Vec::new();
        if !request.plugins_only && !full_superseded {
            let desired = request
                .skills
                .iter()
                .map(|spec| spec.name.clone())
                .collect();
            {
                let _binding = self.plugin_sync_binding.lock_active()?;
                self.remove_stale_managed_skills(&desired, &mut manifest)?;
            }
            for spec in &request.skills {
                skill_results.push(self.sync_skill(spec, &mut manifest).await);
            }
            let _binding = self.plugin_sync_binding.lock_active()?;
            self.record_mcps(payload.get("mcps"), "replace", &mut manifest)?;
        }
        let success = results
            .iter()
            .chain(&skill_results)
            .all(|result| result.get("status").and_then(Value::as_str) != Some("failed"));
        let _binding = self.plugin_sync_binding.lock_active()?;
        if (request.complete && !plugins_superseded)
            || (!request.plugins_only && !full_superseded)
            || results
                .iter()
                .any(|result| result.get("status").and_then(Value::as_str) != Some("superseded"))
        {
            self.store
                .garbage_collect_unreferenced_managed_plugins(&manifest)?;
            self.store.manifest.save_with_revision_bump(manifest)?;
        }
        drop(_binding);
        let changes = activation.finish_with_skill_reload().await?;
        crate::logging::log_executor_event(
            "plugin_sync_completed",
            &[
                ("generation", request.generation.to_string()),
                ("complete", request.complete.to_string()),
                ("queue_ms", queued_ms.to_string()),
                ("total_ms", started.elapsed().as_millis().to_string()),
                ("plugin_count", results.len().to_string()),
                ("changed", changes.changed.to_string()),
                ("requires_restart", changes.requires_restart.to_string()),
                ("detection_ms", changes.detection_ms.to_string()),
                ("changed_plugins", changes.plugins.join(",")),
                ("changed_skills", changes.skills.join(",")),
            ],
        );
        Ok(json!({
            "success": success,
            "changed": changes.changed,
            "requires_restart": changes.requires_restart,
            "scope": payload.get("scope").and_then(Value::as_str).unwrap_or("all"),
            "skills": skill_results,
            "plugins": results,
            "plugin_sync": {"version": 2, "generation": request.generation, "complete": request.complete},
        }))
    }

    fn remove_ordered_plugin(
        &self,
        spec: &PluginSyncSpec,
        generation: u64,
        manifest: &mut Value,
    ) -> Result<Value, CapabilitySyncError> {
        let existing = manifest
            .get("plugins")
            .and_then(|plugins| plugins.get(&spec.key))
            .cloned();
        if is_superseded(manifest, spec, generation, true) {
            return Ok(acknowledgement(spec, generation, "superseded", "remove"));
        }
        if existing.as_ref().is_some_and(|plugin| {
            plugin.get("installed_plugin_id").and_then(Value::as_i64) != spec.installed_plugin_id
        }) {
            // A different installation may still be materialized while this
            // removal overtakes its own install. Fence only the removed id.
            record_generation(manifest, spec, generation, true);
            self.store
                .manifest
                .save_with_revision_bump(manifest.clone())?;
            return Ok(acknowledgement(spec, generation, "removed", "remove"));
        }
        if existing
            .as_ref()
            .is_some_and(|plugin| !is_reconcilable(&spec.key, plugin))
        {
            return Err(invalid("Refusing to remove an unmanaged plugin"));
        }
        record_intent(manifest, spec, generation, true);
        self.store
            .manifest
            .save_with_revision_bump(manifest.clone())?;
        let original = manifest.clone();
        record_generation(manifest, spec, generation, true);
        let result = if let Some(plugin) = existing {
            let desired = object_map(manifest.get("plugins"))
                .unwrap_or_default()
                .into_keys()
                .filter(|key| key != &spec.key)
                .collect();
            self.remove_managed_plugins(vec![(spec.key.clone(), plugin)], &desired, manifest)
        } else {
            self.store
                .manifest
                .save_with_revision_bump(manifest.clone())
        };
        match result {
            Ok(()) => Ok(acknowledgement(spec, generation, "removed", "remove")),
            Err(error) => {
                *manifest = original;
                Err(error)
            }
        }
    }
}

fn is_reconcilable(key: &str, plugin: &Value) -> bool {
    plugin.get("managed").and_then(Value::as_bool) == Some(true)
        && plugin
            .get("installed_plugin_id")
            .and_then(Value::as_i64)
            .is_some()
        && RECONCILABLE_PLUGIN_MARKETPLACES.contains(
            &PluginSyncSpec::from_manifest_entry(key, plugin)
                .marketplace
                .as_str(),
        )
}

fn protocol_state(manifest: &mut Value) -> &mut Map<String, Value> {
    ensure_object_field(manifest, "plugin_sync")
}

fn complete_generation(manifest: &Value) -> u64 {
    manifest
        .get("plugin_sync")
        .and_then(|state| state.get("complete_generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn full_generation(manifest: &Value) -> u64 {
    manifest
        .get("plugin_sync")
        .and_then(|state| state.get("full_generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

fn is_superseded(manifest: &Value, spec: &PluginSyncSpec, generation: u64, removing: bool) -> bool {
    let state = manifest.get("plugin_sync");
    let recorded = state
        .and_then(|state| state.get("entries"))
        .and_then(|entries| entries.get(&spec.key));
    let same_installation = |entry: &&Value| {
        entry.get("installed_plugin_id").and_then(Value::as_i64) == spec.installed_plugin_id
    };
    let stored_generation = recorded
        .filter(|entry| !removing || same_installation(entry))
        .and_then(|entry| entry.get("generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .max(
            manifest
                .get("plugins")
                .and_then(|plugins| plugins.get(&spec.key))
                .filter(|entry| !removing || same_installation(entry))
                .and_then(|plugin| plugin.get("plugin_sync_generation"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        );
    let removed_generation = state
        .and_then(|state| state.get("removals"))
        .and_then(|entries| {
            spec.installed_plugin_id
                .and_then(|id| entries.get(id.to_string()))
        })
        .and_then(|entry| entry.get("generation"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    generation < complete_generation(manifest).max(stored_generation)
        || generation < removed_generation
        || (!removing && generation == removed_generation)
}

fn record_generation(manifest: &mut Value, spec: &PluginSyncSpec, generation: u64, removed: bool) {
    record_intent(manifest, spec, generation, removed);
    let (collection, key) = intent_identity(spec, removed);
    manifest["plugin_sync"][collection][key]["pending"] = json!(false);
    if !removed {
        if let Some(plugin) = manifest
            .get_mut("plugins")
            .and_then(|plugins| plugins.get_mut(&spec.key))
        {
            plugin["plugin_sync_generation"] = json!(generation);
        }
    }
}

fn record_intent(manifest: &mut Value, spec: &PluginSyncSpec, generation: u64, removed: bool) {
    let state = protocol_state(manifest);
    state.insert("version".to_owned(), json!(2));
    let (collection, key) = intent_identity(spec, removed);
    ensure_object_field(&mut manifest["plugin_sync"], collection).insert(
        key,
        json!({
            "generation": generation,
            "installed_plugin_id": spec.installed_plugin_id,
            "name": spec.name,
            "marketplace": spec.marketplace,
            "removed": removed,
            "pending": true,
        }),
    );
}

fn intent_identity(spec: &PluginSyncSpec, removed: bool) -> (&'static str, String) {
    if removed {
        (
            "removals",
            spec.installed_plugin_id.expect("validated id").to_string(),
        )
    } else {
        ("entries", spec.key.clone())
    }
}

fn acknowledgement(spec: &PluginSyncSpec, generation: u64, status: &str, operation: &str) -> Value {
    json!({"id": spec.installed_plugin_id, "name": spec.name, "generation": generation,
        "status": status, "operation": operation})
}

#[cfg(test)]
mod tests;
