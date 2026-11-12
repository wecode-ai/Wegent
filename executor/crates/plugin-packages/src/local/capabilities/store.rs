//! Capability storage layout and materialization.
use super::*;

impl GlobalCapabilityStore {
    pub fn new(manifest_path: impl Into<PathBuf>, skills_dir: impl Into<PathBuf>) -> Self {
        let skills_dir = skills_dir.into();
        let base = infer_home_from_runtime_dir(&skills_dir, "skills");
        Self {
            manifest: ManagedCapabilityManifest::new(manifest_path),
            skills_dir: skills_dir.clone(),
            codex_skills_dir: base.join(".codex/skills"),
            plugins_dir: base.join(".claude/plugins"),
            codex_plugins_dir: base.join(".codex/plugins"),
            // Skills stay on the legacy store root. Plugin packages use plugin_store_dir()
            // (manifest-adjacent) so marketplace installs follow WEGENT_EXECUTOR_HOME.
            store_dir: base.join(".wegent/workbench/executor/capabilities/store"),
            plugin_store_dir_override: None,
            shared_packages: false,
            codex_only_plugins: env::var("WEGENT_PLUGIN_RUNTIME_TARGET").as_deref() == Ok("codex"),
            workbench_root_override: None,
        }
    }

    pub fn with_manifest(mut self, manifest: ManagedCapabilityManifest) -> Self {
        self.manifest = manifest;
        self
    }

    pub fn with_shared_packages(mut self) -> Self {
        self.shared_packages = true;
        self
    }

    pub fn with_codex_only_plugins(mut self) -> Self {
        self.codex_only_plugins = true;
        self
    }

    pub fn with_workbench_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.shared_packages = true;
        self.workbench_root_override = Some(root.into());
        self
    }

    pub fn with_codex_skills_dir(mut self, codex_skills_dir: impl Into<PathBuf>) -> Self {
        self.codex_skills_dir = codex_skills_dir.into();
        self
    }

    pub fn with_plugins_dir(mut self, plugins_dir: impl Into<PathBuf>) -> Self {
        self.plugins_dir = plugins_dir.into();
        self
    }

    pub fn with_codex_plugins_dir(mut self, codex_plugins_dir: impl Into<PathBuf>) -> Self {
        self.codex_plugins_dir = codex_plugins_dir.into();
        self
    }

    pub fn with_store_dir(mut self, store_dir: impl Into<PathBuf>) -> Self {
        let store_dir = store_dir.into();
        self.store_dir = store_dir.clone();
        // Tests isolate both skill and plugin packages under one temp store.
        self.plugin_store_dir_override = Some(store_dir);
        self
    }

    pub(super) fn personal_marketplace_dir(&self) -> PathBuf {
        self.manifest
            .path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("bundled-marketplaces")
            .join(PERSONAL_SHARED_PLUGIN_MARKETPLACE)
    }

    pub(super) fn claude_marketplace_dir(&self, marketplace: &str) -> PathBuf {
        if marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE {
            return self.personal_marketplace_dir();
        }
        self.plugins_dir.join("marketplaces").join(marketplace)
    }

    pub(super) fn codex_marketplace_dir(&self, marketplace: &str) -> PathBuf {
        if marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE {
            return self.personal_marketplace_dir();
        }
        self.codex_plugins_dir
            .join("marketplaces")
            .join(marketplace)
    }

    pub(super) fn marketplace_plugin_name(
        &self,
        spec: &PluginSyncSpec,
        for_claude: bool,
    ) -> String {
        if spec.marketplace == PERSONAL_SHARED_PLUGIN_MARKETPLACE || !for_claude {
            return spec.name.clone();
        }
        plugin_codex_link_name(spec)
    }

    pub fn record_skill(&self, skill: Value) -> Result<(), CapabilitySyncError> {
        let mut manifest = self.manifest.load()?;
        let name = value_string(skill.get("name"))
            .filter(|name| !name.is_empty())
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill name is required"))?;
        let skill_id = value_i64(skill.get("skill_id").or_else(|| skill.get("id")))
            .ok_or_else(|| CapabilitySyncError::invalid_payload("Skill id is required"))?;
        let namespace = value_string(skill.get("namespace"))
            .filter(|namespace| !namespace.is_empty())
            .unwrap_or_else(|| DEFAULT_NAMESPACE.to_owned());
        ensure_object_field(&mut manifest, "skills").insert(
            name.clone(),
            json!({
                "managed": true,
                "name": name,
                "skill_id": skill_id,
                "namespace": namespace,
                "updated_at": now_rfc3339_like(),
            }),
        );
        self.manifest.save_with_revision_bump(manifest)
    }

    pub fn reconcile_managed_plugins(&self) -> Result<Vec<String>, CapabilitySyncError> {
        let mut manifest = self.load_manifest_with_plugin_store_migration()?;
        let mut restored = Vec::new();
        let plugins = object_map(manifest.get("plugins")).unwrap_or_default();
        for (key, plugin) in plugins {
            if plugin.get("managed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let spec = PluginSyncSpec {
                name: value_string(plugin.get("name"))
                    .or_else(|| key.split_once('@').map(|(name, _)| name.to_owned()))
                    .unwrap_or_else(|| key.clone()),
                key: key.clone(),
                installed_plugin_id: value_i64(plugin.get("installed_plugin_id")),
                cloud_plugin_id: value_i64(plugin.get("cloud_plugin_id")),
                marketplace: value_string(plugin.get("marketplace"))
                    .or_else(|| {
                        key.split_once('@')
                            .map(|(_, marketplace)| marketplace.to_owned())
                    })
                    .unwrap_or_else(|| DEFAULT_PLUGIN_MARKETPLACE.to_owned()),
                enabled: plugin
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                version: value_string(plugin.get("version")).unwrap_or_else(|| "latest".to_owned()),
                checksum: value_string(plugin.get("checksum")),
                download_path: None,
                component_states: plugin
                    .get("component_states")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(Map::new())),
                sync_generation: plugin.get("plugin_sync_generation").and_then(Value::as_u64),
                scoped_sync: plugin
                    .get("plugin_sync_protocol_version")
                    .and_then(Value::as_u64)
                    == Some(3),
            };
            let Some(store_path) = value_string(plugin.get("store_path")).map(PathBuf::from) else {
                continue;
            };
            if !store_path.is_dir() {
                continue;
            }
            self.install_plugin_runtime_metadata(&spec, &store_path, &mut manifest)?;
            restored.push(key);
        }
        self.garbage_collect_unreferenced_managed_plugins(&manifest, |_| {})?;
        self.manifest.save_with_revision_bump(manifest)?;
        Ok(restored)
    }

    pub(super) fn garbage_collect_unreferenced_managed_plugins(
        &self,
        manifest: &Value,
        mut observe_native_change: impl FnMut(&Path),
    ) -> Result<Vec<PathBuf>, CapabilitySyncError> {
        // Live and rollback references span agents and processes. A local manifest
        // cannot prove a shared package or native cache is unreferenced.
        if self.shared_packages {
            return Ok(Vec::new());
        }
        let plugins = object_map(manifest.get("plugins")).unwrap_or_default();
        let referenced_store_paths = plugins
            .values()
            .filter_map(|plugin| value_string(plugin.get("store_path")).map(PathBuf::from))
            .collect::<BTreeSet<_>>();
        let mut expected_claude_cache_paths = BTreeSet::new();
        let mut expected_codex_cache_paths = BTreeSet::new();
        for (key, plugin) in &plugins {
            let spec = PluginSyncSpec::from_manifest_entry(key, plugin);
            if !CLOUD_MANAGED_PLUGIN_MARKETPLACES.contains(&spec.marketplace.as_str()) {
                continue;
            }
            expected_claude_cache_paths.insert(self.plugin_runtime_link(&spec));
            expected_codex_cache_paths.insert(self.plugin_codex_link(&spec));
        }

        let store_plugins_dir = self.plugin_store_dir().join("plugins");
        let mut removed = if referenced_store_paths
            .iter()
            .all(|path| path.starts_with(&store_plugins_dir))
        {
            remove_unreferenced_store_packages(
                &self.plugin_store_dir(),
                &store_plugins_dir,
                &referenced_store_paths,
            )?
        } else {
            Vec::new()
        };
        removed.extend(remove_unreferenced_cloud_plugin_cache(
            &self.plugins_dir,
            &self.plugins_dir.join("cache"),
            &expected_claude_cache_paths,
            &mut observe_native_change,
        )?);
        removed.extend(remove_unreferenced_cloud_plugin_cache(
            &self.codex_plugins_dir,
            &self.codex_plugins_dir.join("cache"),
            &expected_codex_cache_paths,
            &mut observe_native_change,
        )?);
        for marketplace in CLOUD_MANAGED_PLUGIN_MARKETPLACES {
            let desired_names = plugins
                .iter()
                .filter_map(|(key, plugin)| {
                    let spec = PluginSyncSpec::from_manifest_entry(key, plugin);
                    (spec.marketplace == marketplace).then_some(spec.name)
                })
                .collect::<BTreeSet<_>>();
            let desired_claude_link_names = desired_names
                .iter()
                .map(|name| format!("{name}-{marketplace}"))
                .collect::<BTreeSet<_>>();
            let claude_marketplace_dir = self.plugins_dir.join("marketplaces").join(marketplace);
            let codex_marketplace_dir = self
                .codex_plugins_dir
                .join("marketplaces")
                .join(marketplace);
            removed.extend(remove_unreferenced_marketplace_links(
                &self.plugins_dir,
                &claude_marketplace_dir.join("plugins"),
                &desired_claude_link_names,
                &mut observe_native_change,
            )?);
            removed.extend(remove_unreferenced_marketplace_links(
                &self.codex_plugins_dir,
                &codex_marketplace_dir.join("plugins"),
                &desired_names,
                &mut observe_native_change,
            )?);
            prune_unreferenced_marketplace_plugins(
                &self.plugins_dir,
                &claude_marketplace_dir.join(".claude-plugin/marketplace.json"),
                &desired_names,
            )?;
            prune_unreferenced_marketplace_plugins(
                &self.plugins_dir,
                &claude_marketplace_dir.join(".agents/plugins/marketplace.json"),
                &desired_names,
            )?;
            prune_unreferenced_marketplace_plugins(
                &self.codex_plugins_dir,
                &codex_marketplace_dir.join(".agents/plugins/marketplace.json"),
                &desired_names,
            )?;
        }
        Ok(removed)
    }

    pub fn reconcile_managed_claude_plugins(&self) -> Result<Vec<String>, CapabilitySyncError> {
        if self.codex_only_plugins {
            return Ok(Vec::new());
        }
        let manifest = self.load_manifest_with_plugin_store_migration()?;
        let mut restored = Vec::new();
        let plugins = object_map(manifest.get("plugins")).unwrap_or_default();
        for (key, plugin) in plugins {
            if plugin.get("managed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let managed_runtime = plugin
                .get("runtime")
                .and_then(|runtime| value_string(runtime.get("claude_link")))
                .map(PathBuf::from);
            if !managed_runtime
                .as_ref()
                .is_some_and(|path| shared_packages::managed_descendant(&self.plugins_dir, path))
            {
                continue;
            }
            let Some(store_path) = value_string(plugin.get("store_path")).map(PathBuf::from) else {
                continue;
            };
            if !store_path.is_dir() {
                continue;
            }
            let spec = PluginSyncSpec::from_manifest_entry(&key, &plugin);
            let runtime_path = self.plugin_runtime_link(&spec);
            let missing_native_manifest = !runtime_path.join(".codex-plugin/plugin.json").is_file()
                || !runtime_path.join(".claude-plugin/plugin.json").is_file();
            if !runtime_path.is_dir() || runtime_path.is_symlink() || missing_native_manifest {
                copy_dir_atomic(&store_path, &runtime_path)?;
                restored.push(key.clone());
            }
            ensure_dual_plugin_manifests(&runtime_path)?;
            ensure_plugin_hook_permissions(&runtime_path)?;
            self.install_marketplace_metadata(&spec, &runtime_path)?;
            let installed = read_installed_plugins(&self.plugins_dir)?;
            let registered = installed
                .get("plugins")
                .and_then(|plugins| plugins.get(&key))
                .and_then(Value::as_array)
                .and_then(|entries| entries.first())
                .and_then(|entry| value_string(entry.get("installPath")))
                .is_some_and(|path| Path::new(&path) == runtime_path);
            if !registered {
                upsert_installed_plugin(&self.plugins_dir, &spec, &runtime_path)?;
            }
            set_plugin_enabled(&self.plugins_dir, &key, spec.enabled)?;
        }
        Ok(restored)
    }

    pub(super) fn load_manifest_with_plugin_store_migration(
        &self,
    ) -> Result<Value, CapabilitySyncError> {
        let mut manifest = self.manifest.load()?;
        if self.shared_packages {
            // Legacy packages remain readable until a verified archive is synced.
            return Ok(manifest);
        }
        let plugin_store_dir = self.plugin_store_dir();
        let (changed, legacy_paths) =
            rewrite_managed_plugin_store_paths(&mut manifest, &plugin_store_dir)?;
        if !changed {
            return Ok(manifest);
        }

        let revision = manifest
            .get("revision")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            + 1;
        manifest["revision"] = json!(revision);
        write_plugin_manifest_atomic(&self.manifest.path, &manifest)?;

        for legacy_path in legacy_paths {
            remove_existing_path(&legacy_path)?;
            remove_empty_legacy_store_parents(&legacy_path, &plugin_store_dir)?;
        }
        write_plugin_store_layout_marker(&plugin_store_dir)?;
        Ok(manifest)
    }

    pub(super) fn install_claude_plugin_runtime_metadata_at(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        timestamp: &str,
        reused: &BTreeSet<PathBuf>,
    ) -> Result<(), CapabilitySyncError> {
        let runtime_path = self.plugin_runtime_link(spec);
        if !reused.contains(&runtime_path) {
            copy_dir_atomic(store_path, &runtime_path)?;
            ensure_dual_plugin_manifests(&runtime_path)?;
            ensure_plugin_hook_permissions(&runtime_path)?;
        }
        self.install_marketplace_metadata_at(spec, &runtime_path, timestamp, reused)?;
        upsert_installed_plugin_at(&self.plugins_dir, spec, &runtime_path, timestamp)?;
        set_plugin_enabled(&self.plugins_dir, &spec.key, spec.enabled)
    }

    pub(super) fn install_codex_marketplace_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        previous_states: &Value,
        reused: &BTreeSet<PathBuf>,
    ) -> Result<(), CapabilitySyncError> {
        let marketplace_dir = self.codex_marketplace_dir(&spec.marketplace);
        let marketplace_link = marketplace_dir
            .join("plugins")
            .join(self.marketplace_plugin_name(spec, false));
        if !reused.contains(&marketplace_link) {
            link_or_copy_dir(store_path, &marketplace_link)?;
        }

        let marketplace_json_path = marketplace_dir.join(".agents/plugins/marketplace.json");
        let mut marketplace = read_json_or_default(&marketplace_json_path, || json!({}))?;
        let root = ensure_root_object(&mut marketplace);
        root.insert("name".to_owned(), json!(spec.marketplace));
        root.insert("interface".to_owned(), json!({"displayName": "Wegent"}));
        upsert_marketplace_plugin(
            &mut marketplace,
            &spec.name,
            json!({
                "name": spec.name,
                "source": {
                    "source": "local",
                    "path": format!("./plugins/{}", spec.name),
                },
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                    "products": ["CODEX"],
                },
            }),
        )?;
        write_json(&marketplace_json_path, &marketplace)?;

        let config_path = self
            .codex_plugins_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("config.toml");
        let content = match fs::read_to_string(&config_path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(error.into()),
        };
        let mut document = content.parse::<DocumentMut>().map_err(|error| {
            CapabilitySyncError::invalid_payload(format!(
                "Invalid Codex config {}: {error}",
                config_path.display()
            ))
        })?;
        document["marketplaces"][&spec.marketplace]["source_type"] = value("local");
        document["marketplaces"][&spec.marketplace]["source"] =
            value(marketplace_dir.display().to_string());
        document["plugins"][&spec.key]["enabled"] = value(spec.enabled);
        runtime_skill_config::relocate_plugin_skill_config(&mut document, spec, store_path)?;
        runtime_skill_config::apply_plugin_skill_states(
            &mut document,
            spec,
            store_path,
            previous_states,
        )?;
        let next_content = document.to_string();
        if next_content != content {
            replace_codex_config(&config_path, &next_content)?;
        }
        Ok(())
    }

    pub(super) fn remove_plugin_runtime_configuration(
        &self,
        stale_keys: &BTreeSet<String>,
        stale_marketplaces: &BTreeSet<String>,
        desired_marketplaces: &BTreeSet<String>,
    ) -> Result<(), CapabilitySyncError> {
        let claude_settings_path = self
            .plugins_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("settings.json");
        // Removal also cleans Claude enablement left by earlier dual-runtime
        // installations; installation paths stay Codex-only.
        if claude_settings_path.is_file() {
            let mut settings = read_json_or_default(&claude_settings_path, || json!({}))?;
            let mut changed = false;
            if let Some(enabled_plugins) = settings
                .get_mut("enabledPlugins")
                .and_then(Value::as_object_mut)
            {
                for key in stale_keys {
                    changed |= enabled_plugins.remove(key).is_some();
                }
            }
            if let Some(marketplaces) = settings
                .get_mut("extraKnownMarketplaces")
                .and_then(Value::as_object_mut)
            {
                for marketplace in stale_marketplaces {
                    if !desired_marketplaces.contains(marketplace) {
                        changed |= marketplaces.remove(marketplace).is_some();
                    }
                }
            }
            if changed {
                write_json(&claude_settings_path, &settings)?;
            }
        }

        let codex_config_path = self
            .codex_plugins_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("config.toml");
        let content = match fs::read_to_string(&codex_config_path) {
            Ok(content) => content,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let mut document = content.parse::<DocumentMut>().map_err(|error| {
            CapabilitySyncError::invalid_payload(format!(
                "Invalid Codex config {}: {error}",
                codex_config_path.display()
            ))
        })?;
        let mut changed = false;
        changed |= remove_toml_keys(&mut document["plugins"], stale_keys);
        let removable_marketplaces = stale_marketplaces
            .difference(desired_marketplaces)
            .cloned()
            .collect::<BTreeSet<_>>();
        changed |= remove_toml_keys(&mut document["marketplaces"], &removable_marketplaces);
        if changed {
            replace_codex_config(&codex_config_path, &document.to_string())?;
        }
        Ok(())
    }

    fn install_marketplace_metadata(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
    ) -> Result<(), CapabilitySyncError> {
        self.install_marketplace_metadata_at(
            spec,
            store_path,
            &now_rfc3339_like(),
            &BTreeSet::new(),
        )
    }

    fn install_marketplace_metadata_at(
        &self,
        spec: &PluginSyncSpec,
        store_path: &Path,
        timestamp: &str,
        reused: &BTreeSet<PathBuf>,
    ) -> Result<(), CapabilitySyncError> {
        let marketplace_dir = self.claude_marketplace_dir(&spec.marketplace);
        let marketplace_plugins_dir = marketplace_dir.join("plugins");
        let marketplace_plugin_name = self.marketplace_plugin_name(spec, true);
        let marketplace_link = marketplace_plugins_dir.join(&marketplace_plugin_name);
        if !reused.contains(&marketplace_link) {
            link_or_copy_dir(store_path, &marketplace_link)?;
        }

        let marketplace_source = json!({
            "source": "directory",
            "path": marketplace_dir.display().to_string(),
        });
        let mut known =
            read_json_or_default(&self.plugins_dir.join("known_marketplaces.json"), || {
                json!({})
            })?;
        ensure_root_object(&mut known).insert(
            spec.marketplace.clone(),
            json!({
                "source": marketplace_source,
                "installLocation": marketplace_dir.display().to_string(),
                "lastUpdated": timestamp.parse::<i64>().ok().and_then(chrono::DateTime::from_timestamp_millis)
                    .ok_or_else(||CapabilitySyncError::invalid_payload("Invalid plugin publication time"))?
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        );
        write_json(&self.plugins_dir.join("known_marketplaces.json"), &known)?;

        let settings_path = self
            .plugins_dir
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("settings.json");
        let mut settings = read_json_or_default(&settings_path, || json!({}))?;
        ensure_object_field(&mut settings, "extraKnownMarketplaces").insert(
            spec.marketplace.clone(),
            json!({"source": marketplace_source}),
        );
        write_json(&settings_path, &settings)?;

        let marketplace_json_path = marketplace_dir.join(".claude-plugin/marketplace.json");
        let mut marketplace = read_json_or_default(&marketplace_json_path, || json!({}))?;
        marketplace["$schema"] = json!("https://anthropic.com/claude-code/marketplace.schema.json");
        marketplace["name"] = json!(spec.marketplace);
        marketplace["description"] = json!("Plugins managed by Wegent.");
        marketplace["owner"] = json!({"name": "Wegent Team"});
        upsert_marketplace_plugin(
            &mut marketplace,
            &spec.name,
            json!({
                "description": "",
                "name": spec.name,
                "source": format!("./plugins/{marketplace_plugin_name}"),
                "version": spec.version,
            }),
        )?;
        write_json(&marketplace_json_path, &marketplace)?;

        let codex_marketplace_path = marketplace_dir.join(".agents/plugins/marketplace.json");
        let mut codex_marketplace = read_json_or_default(&codex_marketplace_path, || json!({}))?;
        let root = ensure_root_object(&mut codex_marketplace);
        root.insert("name".to_owned(), json!(spec.marketplace));
        root.insert("interface".to_owned(), json!({"displayName": "Wegent"}));
        upsert_marketplace_plugin(
            &mut codex_marketplace,
            &spec.name,
            json!({
                "name": spec.name,
                "source": {
                    "source": "local",
                    "path": format!("./plugins/{marketplace_plugin_name}"),
                },
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
            }),
        )?;
        write_json(&codex_marketplace_path, &codex_marketplace)
    }

    pub(super) fn skill_store_path(&self, spec: &SkillSyncSpec) -> PathBuf {
        self.store_dir.join("skills").join(spec.store_dir_name())
    }

    pub(super) fn plugin_store_path(&self, spec: &PluginSyncSpec) -> Option<PathBuf> {
        spec.store_dir_name()
            .map(|name| self.plugin_store_dir().join("plugins").join(name))
    }

    pub(super) fn plugin_store_dir(&self) -> PathBuf {
        if let Some(store_dir) = &self.plugin_store_dir_override {
            return store_dir.clone();
        }
        self.manifest
            .path
            .parent()
            .map(|capabilities_dir| capabilities_dir.join("store"))
            .unwrap_or_else(|| PathBuf::from("store"))
    }

    pub(super) fn plugin_runtime_link(&self, spec: &PluginSyncSpec) -> PathBuf {
        self.plugins_dir
            .join("cache")
            .join(&spec.marketplace)
            .join(&spec.name)
            .join(self.plugin_cache_version(spec))
    }

    pub(super) fn plugin_codex_link(&self, spec: &PluginSyncSpec) -> PathBuf {
        // Codex selects the manifest version and removes other cache versions
        // during native installation. Content hashes belong in the shared store.
        self.codex_plugins_dir
            .join("cache")
            .join(&spec.marketplace)
            .join(&spec.name)
            .join(&spec.version)
    }

    fn plugin_cache_version(&self, spec: &PluginSyncSpec) -> String {
        if self.shared_packages {
            if let Some(hash) = spec
                .checksum
                .as_deref()
                .and_then(|hash| hash.strip_prefix("sha256:"))
            {
                if hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return format!("{}-{hash}", spec.version);
                }
            }
        }
        spec.version.clone()
    }
}

fn rewrite_managed_plugin_store_paths(
    manifest: &mut Value,
    canonical_store: &Path,
) -> Result<(bool, Vec<PathBuf>), CapabilitySyncError> {
    let mut changed = false;
    let mut migrated_paths = BTreeSet::new();
    let entries = ensure_object_field(manifest, "plugins");
    for entry in entries.values_mut() {
        if entry.get("managed").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        let Some(legacy_path) = value_string(entry.get("store_path")).map(PathBuf::from) else {
            continue;
        };
        if legacy_path.starts_with(canonical_store)
            || legacy_plugin_store_root(&legacy_path).is_none()
        {
            continue;
        }
        let Some(package_name) = legacy_path.file_name() else {
            continue;
        };
        let canonical_path = canonical_store.join("plugins").join(package_name);
        if legacy_path.is_dir() {
            copy_dir_atomic(&legacy_path, &canonical_path)?;
            migrated_paths.insert(legacy_path.clone());
        } else if !has_plugin_manifest(&canonical_path) {
            // Missing legacy packages must not permanently bind to an unverified
            // canonical leftover; leave the path for a later sync to recover.
            continue;
        } else if let Some(object) = entry.as_object_mut() {
            // Package was already relocated (for example by desktop home merge).
            // Drop the cached checksum so the next sync can revalidate content.
            object.remove("checksum");
        }
        entry["store_path"] = json!(canonical_path.display().to_string());
        changed = true;
    }
    Ok((changed, migrated_paths.into_iter().collect()))
}

pub(super) fn legacy_plugin_store_root(path: &Path) -> Option<&Path> {
    let plugins_dir = path.parent()?;
    if plugins_dir.file_name()?.to_str()? != "plugins" {
        return None;
    }
    let store_dir = plugins_dir.parent()?;
    if store_dir.file_name()?.to_str()? != "store" {
        return None;
    }
    let capabilities_dir = store_dir.parent()?;
    (capabilities_dir.file_name()?.to_str()? == "capabilities").then_some(store_dir)
}

fn remove_empty_legacy_store_parents(
    legacy_path: &Path,
    canonical_store: &Path,
) -> Result<(), CapabilitySyncError> {
    let Some(store_dir) = legacy_path.parent().and_then(Path::parent) else {
        return Ok(());
    };
    if store_dir == canonical_store {
        return Ok(());
    }
    for directory in [legacy_path.parent(), Some(store_dir)]
        .into_iter()
        .flatten()
    {
        if directory.is_dir() && fs::read_dir(directory)?.next().is_none() {
            fs::remove_dir(directory)?;
        }
    }
    Ok(())
}

fn write_plugin_store_layout_marker(store_dir: &Path) -> Result<(), CapabilitySyncError> {
    write_json(
        &store_dir.join(".plugin-store-layout.json"),
        &json!({
            "version": 1,
            "authority": "manifest_executor_home",
        }),
    )
}
