//! Capability synchronization orchestration.
use super::*;

impl CapabilitySyncHandler<NoopPackageProvider> {
    pub fn new(
        auth_token: impl Into<String>,
        store: GlobalCapabilityStore,
        skill_reloader: std::sync::Arc<dyn crate::SkillConfigurationReloader>,
    ) -> Self {
        Self::with_package_provider(auth_token, store, NoopPackageProvider, skill_reloader)
    }

    pub fn from_device_config(
        config: &DeviceConfig,
        store: GlobalCapabilityStore,
        skill_reloader: std::sync::Arc<dyn crate::SkillConfigurationReloader>,
    ) -> Self {
        Self::new(
            config.connection.auth_token.trim().to_owned(),
            store,
            skill_reloader,
        )
    }
}

impl<P> CapabilitySyncHandler<P>
where
    P: CapabilityPackageProvider,
{
    pub fn with_package_provider(
        auth_token: impl Into<String>,
        store: GlobalCapabilityStore,
        package_provider: P,
        skill_reloader: std::sync::Arc<dyn crate::SkillConfigurationReloader>,
    ) -> Self {
        let auth_token = auth_token.into();
        let plugin_sync_binding =
            plugin_sync_protocol::ConnectionBinding::new(&store.manifest.path, &auth_token);
        let plugin_preparation = plugin_preparation::PreparationCoordinator::for_store(&store);
        Self {
            skill_reloader,
            auth_token,
            store,
            package_provider,
            sync_lock: AsyncMutex::new(()),
            plugin_sync_inflight: Default::default(),
            plugin_sync_binding,
            plugin_preparation,
        }
    }

    /// Fence publications from work owned by a disconnected account profile.
    pub fn invalidate_connection(&self) {
        self.plugin_sync_binding.invalidate();
    }

    pub fn local_plugin_digest(&self) -> Result<String, CapabilitySyncError> {
        self.plugin_sync_binding.check()?;
        activation_revision::local_plugin_digest(&self.store)
    }

    pub fn auth_token(&self) -> &str {
        &self.auth_token
    }

    pub async fn apply_sync(&self, payload: Value) -> Result<Value, CapabilitySyncError> {
        self.plugin_sync_binding.check()?;
        let protocol = plugin_sync_protocol::PluginSyncRequest::parse(&payload)?;
        if let Some(request) = protocol {
            return self.apply_plugin_sync_request(payload, request).await;
        }
        self.apply_legacy_sync(payload).await
    }

    async fn apply_legacy_sync(&self, payload: Value) -> Result<Value, CapabilitySyncError> {
        let started = std::time::Instant::now();
        // Ungenerated legacy cleanup cannot safely interleave with a prepared
        // v2 install. Preserve its serialization contract without blocking v2 peers.
        let _protocol = self.plugin_preparation.protocol.write().await;
        let slot = self
            .plugin_preparation
            .slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                CapabilitySyncError::invalid_payload("Plugin preparation scheduler closed")
            })?;
        let preparation_lease = std::sync::Arc::new(plugin_preparation::PreparationLease {
            _lane: None,
            _slot: slot,
        });
        let _sync_guard = self.sync_lock.lock().await;
        let _activation = crate::services::capability_activation::activate().await;
        let queued_ms = started.elapsed().as_millis();
        let _publication_lock = self.store.lock_shared_manifest()?;
        let plugins_only = payload.get("scope").and_then(Value::as_str) == Some("plugins");
        if plugins_only
            && (payload.get("plugins").and_then(Value::as_array).is_none()
                || payload.get("skills").is_some()
                || payload.get("mcps").is_some())
        {
            return Err(CapabilitySyncError::invalid_payload(
                "Plugin reconciliation requires a complete plugins array and no other capabilities"
                    .to_owned(),
            ));
        }
        let mode = payload
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("merge");
        let skill_specs = value_array(payload.get("skills"))
            .into_iter()
            .map(|value| SkillSyncSpec::from_value(&value))
            .collect::<Result<Vec<_>, _>>()?;
        let plugin_specs = value_array(payload.get("plugins"))
            .into_iter()
            .map(|value| PluginSyncSpec::from_value(&value))
            .collect::<Result<Vec<_>, _>>()?;
        let mut activation = activation_revision::ActivationRevision::begin(
            &self.store,
            &plugin_specs,
            &skill_specs,
        )?;
        let mut manifest = {
            let _binding = self.plugin_sync_binding.lock_active()?;
            if plugin_specs.is_empty() || self.store.shared_packages {
                self.store.manifest.load()?
            } else {
                self.store.load_manifest_with_plugin_store_migration()?
            }
        };

        {
            let _binding = self.plugin_sync_binding.lock_active()?;
            if mode == "replace" || plugins_only {
                let desired_skills = skill_specs
                    .iter()
                    .map(|spec| spec.name.clone())
                    .collect::<BTreeSet<_>>();
                let desired_plugins = plugin_specs
                    .iter()
                    .map(|spec| spec.key.clone())
                    .collect::<BTreeSet<_>>();
                if !plugins_only {
                    self.remove_stale_managed_skills(
                        &desired_skills,
                        &mut manifest,
                        &mut activation,
                    )?;
                }
                self.remove_stale_managed_plugins(
                    &desired_plugins,
                    &mut manifest,
                    plugins_only,
                    &mut activation,
                )?;
            }
        }

        let mut skill_results = Vec::with_capacity(skill_specs.len());
        for spec in &skill_specs {
            skill_results.push(self.sync_skill(spec, &mut manifest).await);
        }
        let mut plugin_results = Vec::with_capacity(plugin_specs.len());
        for spec in &plugin_specs {
            plugin_results.push(
                self.sync_plugin(spec, &mut manifest, preparation_lease.clone())
                    .await,
            );
        }
        let _binding = self.plugin_sync_binding.lock_active()?;
        if !plugins_only {
            self.record_mcps(payload.get("mcps"), mode, &mut manifest)?;
        }
        self.store
            .garbage_collect_unreferenced_managed_plugins(&manifest, |path| {
                activation.observe_cleanup_path(path);
            })?;
        self.store.manifest.save_with_revision_bump(manifest)?;
        let success = skill_results
            .iter()
            .chain(plugin_results.iter())
            .all(|result| result.get("status").and_then(Value::as_str) != Some("failed"));
        drop(_binding);
        let changes = activation
            .finish_with_skill_reload(self.skill_reloader.as_ref())
            .await?;
        crate::logging::log_executor_event(
            "capability_sync_completed",
            &[
                ("queue_ms", queued_ms.to_string()),
                ("total_ms", started.elapsed().as_millis().to_string()),
                ("plugin_count", plugin_specs.len().to_string()),
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

        Ok(json!({
            "success": success,
            "changed": changes.changed,
            "requires_restart": changes.requires_restart,
            "scope": if plugins_only { "plugins" } else { "all" },
            "skills": skill_results,
            "plugins": plugin_results,
        }))
    }

    pub fn extract_plugin_zip(
        &self,
        package: &[u8],
        install_path: &Path,
    ) -> Result<(), CapabilitySyncError> {
        extract_plugin_zip(package, install_path)
    }

    pub(super) async fn sync_skill(&self, spec: &SkillSyncSpec, manifest: &mut Value) -> Value {
        match self.try_sync_skill(spec, manifest).await {
            Ok(()) => json!({"id": spec.skill_id, "name": spec.name, "status": "synced"}),
            Err(error) => json!({
                "id": spec.skill_id,
                "name": spec.name,
                "status": "failed",
                "error": error.to_string(),
            }),
        }
    }

    async fn try_sync_skill(
        &self,
        spec: &SkillSyncSpec,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        if self.store.shared_packages {
            return self.try_sync_shared_skill(spec, manifest).await;
        }
        let store_path = self.store.skill_store_path(spec);
        let runtime_link = self.store.skills_dir.join(&spec.name);
        let codex_link = self.store.codex_skills_dir.join(&spec.name);
        if runtime_link.exists()
            && !runtime_link.is_symlink()
            && !is_manifest_managed_skill(manifest, &spec.name)
        {
            return Err(CapabilitySyncError::invalid_payload(
                "Runtime Skill path is occupied by a local user item",
            ));
        }

        let staging = if !is_installed_skill_current(spec, &store_path, manifest) {
            let parent = store_path.parent().expect("skill store parent");
            fs::create_dir_all(parent)?;
            let staging = tempfile::tempdir_in(parent)?;
            self.package_provider
                .stage_skill(spec, &staging.path().join("package"))
                .await?;
            Some(staging)
        } else {
            None
        };
        let _binding = self.plugin_sync_binding.lock_active()?;
        if let Some(staging) = staging {
            remove_existing_path(&store_path)?;
            fs::rename(staging.path().join("package"), &store_path)?;
        }
        link_or_copy_dir(&store_path, &runtime_link)?;
        link_or_copy_dir(&store_path, &codex_link)?;
        ensure_object_field(manifest, "skills").insert(
            spec.name.clone(),
            json!({
                "managed": true,
                "name": spec.name,
                "skill_id": spec.skill_id,
                "namespace": spec.namespace,
                "is_public": spec.is_public,
                "content_hash": spec.content_hash,
                "bind_shells": spec.bind_shells,
                "store_path": store_path.display().to_string(),
                "runtime": {
                    "claude_link": runtime_link.display().to_string(),
                    "codex_link": codex_link.display().to_string(),
                },
                "updated_at": now_rfc3339_like(),
            }),
        );
        Ok(())
    }

    async fn sync_plugin(
        &self,
        spec: &PluginSyncSpec,
        manifest: &mut Value,
        lease: std::sync::Arc<plugin_preparation::PreparationLease>,
    ) -> Value {
        match self.try_sync_plugin(spec, manifest, lease).await {
            Ok(()) => match spec.installed_plugin_id {
                Some(id) => json!({"id": id, "name": spec.name, "status": "synced"}),
                None => json!({"name": spec.name, "status": "synced"}),
            },
            Err(failure) => match spec.installed_plugin_id {
                Some(id) => json!({
                    "id": id,
                    "name": spec.name,
                    "status": "failed",
                    "stage": failure.stage,
                    "error_code": failure.error_code,
                    "retryable": failure.retryable,
                    "error": failure.error.to_string(),
                }),
                None => json!({
                    "name": spec.name,
                    "status": "failed",
                    "stage": failure.stage,
                    "error_code": failure.error_code,
                    "retryable": failure.retryable,
                    "error": failure.error.to_string(),
                }),
            },
        }
    }

    async fn try_sync_plugin(
        &self,
        spec: &PluginSyncSpec,
        manifest: &mut Value,
        lease: std::sync::Arc<plugin_preparation::PreparationLease>,
    ) -> Result<(), PluginSyncFailure> {
        let mut prepared = self.prepare_plugin(spec, manifest, lease).await?;
        let _binding = self
            .plugin_sync_binding
            .lock_active()
            .map_err(PluginSyncFailure::runtime_metadata)?;
        if !prepared.unchanged {
            prepared.publish(&self.store, manifest)?;
        }
        Ok(())
    }

    pub(super) fn remove_stale_managed_skills(
        &self,
        desired: &BTreeSet<String>,
        manifest: &mut Value,
        activation: &mut activation_revision::ActivationRevision<'_>,
    ) -> Result<(), CapabilitySyncError> {
        let stale = object_map(manifest.get("skills"))
            .unwrap_or_default()
            .into_iter()
            .filter(|(name, skill)| {
                !desired.contains(name)
                    && skill.get("managed").and_then(Value::as_bool) != Some(false)
            })
            .collect::<Vec<_>>();
        for (name, skill) in stale {
            activation.observe_skill(&name)?;
            remove_runtime_link_from_value(skill.get("runtime"), "claude_link")?;
            remove_runtime_link_from_value(skill.get("runtime"), "codex_link")?;
            remove_managed_runtime_path(&self.store.skills_dir.join(&name))?;
            remove_managed_runtime_path(&self.store.codex_skills_dir.join(&name))?;
            ensure_object_field(manifest, "skills").remove(&name);
        }
        Ok(())
    }

    fn remove_stale_managed_plugins(
        &self,
        desired: &BTreeSet<String>,
        manifest: &mut Value,
        cloud_only: bool,
        activation: &mut activation_revision::ActivationRevision<'_>,
    ) -> Result<(), CapabilitySyncError> {
        let stale = object_map(manifest.get("plugins"))
            .unwrap_or_default()
            .into_iter()
            .filter(|(key, plugin)| {
                !desired.contains(key)
                    && plugin.get("managed").and_then(Value::as_bool) != Some(false)
                    && (!cloud_only
                        || (plugin.get("managed").and_then(Value::as_bool) == Some(true)
                            && plugin
                                .get("installed_plugin_id")
                                .and_then(Value::as_i64)
                                .is_some()
                            && RECONCILABLE_PLUGIN_MARKETPLACES.contains(
                                &PluginSyncSpec::from_manifest_entry(key, plugin)
                                    .marketplace
                                    .as_str(),
                            )))
            })
            .collect::<Vec<_>>();
        if stale.is_empty() {
            return Ok(());
        }

        self.remove_managed_plugins(stale, desired, manifest, activation)
    }

    pub(super) fn remove_managed_plugins(
        &self,
        stale: Vec<(String, Value)>,
        desired: &BTreeSet<String>,
        manifest: &mut Value,
        activation: &mut activation_revision::ActivationRevision<'_>,
    ) -> Result<(), CapabilitySyncError> {
        for (key, plugin) in &stale {
            activation.observe_plugin(&PluginSyncSpec::from_manifest_entry(key, plugin))?;
        }
        let _personal_marketplace_lock = if stale.iter().any(|(key, plugin)| {
            PluginSyncSpec::from_manifest_entry(key, plugin).marketplace
                == PERSONAL_SHARED_PLUGIN_MARKETPLACE
        }) {
            Some(
                acquire_personal_marketplace_lock(&self.store.personal_marketplace_dir())
                    .map_err(CapabilitySyncError::invalid_payload)?,
            )
        } else {
            None
        };

        let stale_keys = stale
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<BTreeSet<_>>();
        let stale_marketplaces = stale
            .iter()
            .filter_map(|(key, plugin)| {
                let marketplace = value_string(plugin.get("marketplace"))
                    .or_else(|| {
                        key.split_once('@')
                            .map(|(_, marketplace)| marketplace.to_owned())
                    })
                    .unwrap_or_else(|| DEFAULT_PLUGIN_MARKETPLACE.to_owned());
                CLOUD_MANAGED_PLUGIN_MARKETPLACES
                    .contains(&marketplace.as_str())
                    .then_some(marketplace)
            })
            .collect::<BTreeSet<_>>();
        let desired_marketplaces = desired
            .iter()
            .filter_map(|key| {
                key.split_once('@')
                    .map(|(_, marketplace)| marketplace.to_owned())
            })
            .collect::<BTreeSet<_>>();

        self.store.ensure_state_path(
            &self
                .store
                .codex_plugins_dir
                .parent()
                .unwrap_or(&self.store.codex_plugins_dir)
                .join("config.toml"),
            false,
        )?;
        // Codex-only mode never creates Claude state, but it still cleans
        // registrations left by earlier dual-runtime installations.
        let claude_installed_path = self.store.plugins_dir.join("installed_plugins.json");
        self.store
            .ensure_state_path(&claude_installed_path, false)?;
        let claude_installed_exists = claude_installed_path.is_file();
        let mut installed = read_installed_plugins(&self.store.plugins_dir)?;
        let mut moved_paths = Vec::new();
        if !self.store.shared_packages {
            for (key, plugin) in &stale {
                moved_paths.extend(self.store.current_recorded_runtime_paths(key, plugin)?);
                if let Some(path) = self.store.current_recorded_store_path(plugin)? {
                    moved_paths.push(path);
                }
            }
        }
        let mut file_paths = vec![
            self.store.manifest.path.clone(),
            self.store.plugins_dir.join("installed_plugins.json"),
            self.store
                .plugins_dir
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("settings.json"),
            self.store
                .codex_plugins_dir
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("config.toml"),
        ];
        let owned_personal = stale
            .iter()
            .filter(|(key, plugin)| {
                self.store
                    .can_remove_personal_marketplace_plugin(key, plugin)
            })
            .map(|(key, _)| key.clone())
            .collect::<BTreeSet<_>>();
        for (key, plugin) in &stale {
            let spec = PluginSyncSpec::from_manifest_entry(key, plugin);
            if spec.marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE
                && owned_personal.contains(key)
            {
                file_paths.extend(self.personal_shared_marketplace_manifest_paths());
                moved_paths.extend(self.personal_shared_marketplace_plugin_paths(&spec));
            }
        }
        for path in &file_paths {
            // The store manifest lives outside the managed plugin roots; the
            // transaction still snapshots it, but the managed-path guard only
            // applies to runtime and registration files.
            if path == &self.store.manifest.path {
                continue;
            }
            self.store.ensure_state_path(path, false)?;
        }
        let original_manifest = manifest.clone();
        let mut transaction = LocalPluginStateTransaction::begin(file_paths, moved_paths)?;
        let result = (|| {
            for (key, plugin) in stale {
                let spec = PluginSyncSpec::from_manifest_entry(&key, &plugin);
                ensure_object_field(&mut installed, "plugins").remove(&key);
                if spec.marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE
                    && owned_personal.contains(&key)
                {
                    self.remove_personal_shared_marketplace_plugin(&spec)?;
                }
                if self.store.shared_packages {
                    // Retained native caches remain ours after the active install is removed.
                    shared_packages::remember_plugin_runtime_owner(manifest, &key, &plugin);
                    runtime_recovery::legacy_sources::remember_legacy_plugin_source(
                        manifest, &key, &plugin,
                    );
                }
                ensure_object_field(manifest, "plugins").remove(&key);
            }
            if !self.store.codex_only_plugins || claude_installed_exists {
                write_json(
                    &self.store.plugins_dir.join("installed_plugins.json"),
                    &installed,
                )?;
            }
            self.store.remove_plugin_runtime_configuration(
                &stale_keys,
                &stale_marketplaces,
                &desired_marketplaces,
            )?;
            if self.store.shared_packages || manifest.get("plugin_sync").is_some() {
                self.store
                    .manifest
                    .save_with_revision_bump(manifest.clone())?;
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                transaction.commit();
                Ok(())
            }
            Err(error) => {
                *manifest = original_manifest;
                Err(transaction.add_rollback_context(error))
            }
        }
    }

    pub(super) fn personal_shared_marketplace_manifest_paths(&self) -> Vec<PathBuf> {
        let marketplace = self.store.personal_marketplace_dir();
        vec![
            marketplace.join(".claude-plugin/marketplace.json"),
            marketplace.join(".agents/plugins/marketplace.json"),
        ]
    }

    fn personal_shared_marketplace_plugin_paths(&self, spec: &PluginSyncSpec) -> Vec<PathBuf> {
        vec![self
            .store
            .personal_marketplace_dir()
            .join("plugins")
            .join(&spec.name)]
    }

    fn remove_personal_shared_marketplace_plugin(
        &self,
        spec: &PluginSyncSpec,
    ) -> Result<(), CapabilitySyncError> {
        for path in self.personal_shared_marketplace_plugin_paths(spec) {
            remove_existing_path(&path)?;
        }
        for path in self.personal_shared_marketplace_manifest_paths() {
            remove_marketplace_plugin_entry(&path, &spec.name)?;
        }
        Ok(())
    }

    pub(super) fn record_mcps(
        &self,
        mcps: Option<&Value>,
        mode: &str,
        manifest: &mut Value,
    ) -> Result<(), CapabilitySyncError> {
        if mode == "replace" {
            manifest["mcps"] = Value::Object(Map::new());
        }
        for mcp in value_array(mcps) {
            let name = value_string(mcp.get("name"))
                .filter(|name| !name.is_empty())
                .ok_or_else(|| CapabilitySyncError::invalid_payload("MCP name is required"))?;
            let mut entry = mcp;
            entry["managed"] = json!(true);
            ensure_object_field(manifest, "mcps").insert(name, entry);
        }
        Ok(())
    }
}
