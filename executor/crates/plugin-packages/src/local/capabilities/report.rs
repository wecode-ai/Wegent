//! Installed capability reporting.
use super::*;

impl GlobalCapabilityReporter {
    pub fn new(
        skills_dir: impl Into<PathBuf>,
        plugins_dir: impl Into<PathBuf>,
        manifest: ManagedCapabilityManifest,
    ) -> Self {
        Self {
            skills_dir: skills_dir.into(),
            plugins_dir: plugins_dir.into(),
            manifest,
        }
    }

    pub fn build_report(&self, force_full: bool) -> Result<Value, CapabilitySyncError> {
        let manifest = self.manifest.load()?;
        let skills = self.report_skills(&manifest)?;
        let plugins = self.report_plugins(&manifest)?;
        let mcps = self.report_mcps(&manifest);
        let details = json!({
            "skills": skills,
            "plugins": plugins,
            "mcps": mcps,
        });
        Ok(json!({
            "revision": manifest.get("revision").and_then(Value::as_i64).unwrap_or_default(),
            "digest": sha256_json_digest(&details),
            "full": force_full,
            "skills": details["skills"].clone(),
            "plugins": details["plugins"].clone(),
            "mcps": details["mcps"].clone(),
            "last_sync_at": manifest.get("last_sync_at").cloned().unwrap_or(Value::Null),
        }))
    }

    fn report_skills(&self, manifest: &Value) -> Result<Vec<Value>, CapabilitySyncError> {
        let managed = object_map(manifest.get("skills")).unwrap_or_default();
        let mut output = Vec::new();
        for (name, skill) in &managed {
            if skill.get("managed").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let mut entry = Map::new();
            entry.insert("name".to_owned(), json!(name));
            if let Some(skill_id) = value_i64(skill.get("skill_id")) {
                entry.insert("skill_id".to_owned(), json!(skill_id));
            }
            if let Some(namespace) = value_string(skill.get("namespace")) {
                entry.insert("namespace".to_owned(), json!(namespace));
            }
            entry.insert("source".to_owned(), json!(WEGENT_SOURCE));
            output.push(Value::Object(entry));
        }

        for entry in sorted_dir_entries(&self.skills_dir)? {
            let path = entry.path();
            if !path.is_dir() || !path.join("SKILL.md").is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if managed.contains_key(name) {
                continue;
            }
            output.push(json!({"name": name, "source": LOCAL_USER_SOURCE}));
        }
        Ok(output)
    }

    fn report_mcps(&self, manifest: &Value) -> Vec<Value> {
        object_map(manifest.get("mcps"))
            .unwrap_or_default()
            .into_iter()
            .map(|(name, mcp)| {
                let mut entry = mcp.as_object().cloned().unwrap_or_default();
                entry.remove("managed");
                entry.insert("name".to_owned(), json!(name));
                entry.insert("source".to_owned(), json!(WEGENT_SOURCE));
                Value::Object(entry)
            })
            .collect()
    }

    fn report_plugins(&self, manifest: &Value) -> Result<Vec<Value>, CapabilitySyncError> {
        let installed = read_installed_plugins(&self.plugins_dir)?;
        let managed = object_map(manifest.get("plugins")).unwrap_or_default();
        let plugins = object_map(installed.get("plugins")).unwrap_or_default();
        let mut output = BTreeMap::new();

        for (key, manifest_entry) in &managed {
            if manifest_entry.get("managed").and_then(Value::as_bool) != Some(true) {
                continue;
            }
            let registry_entry = plugins
                .get(key)
                .and_then(Value::as_array)
                .and_then(|entries| entries.first());
            output.insert(
                key.clone(),
                managed_plugin_report_entry(key, manifest_entry, registry_entry)?,
            );
        }

        for (key, entries) in plugins {
            if output.contains_key(&key) {
                continue;
            }
            let Some(first) = entries.as_array().and_then(|entries| entries.first()) else {
                continue;
            };
            output.insert(key.clone(), local_plugin_report_entry(&key, first)?);
        }

        Ok(output.into_values().collect())
    }
}

fn managed_plugin_report_entry(
    key: &str,
    manifest_entry: &Value,
    registry_entry: Option<&Value>,
) -> Result<Value, CapabilitySyncError> {
    let (name, marketplace) = split_plugin_key(key);
    let mut entry = Map::new();
    entry.insert(
        "name".to_owned(),
        json!(value_string(manifest_entry.get("name")).unwrap_or(name)),
    );
    entry.insert(
        "marketplace".to_owned(),
        json!(value_string(manifest_entry.get("marketplace")).unwrap_or(marketplace)),
    );
    entry.insert(
        "scope".to_owned(),
        registry_entry
            .and_then(|entry| entry.get("scope"))
            .cloned()
            .unwrap_or_else(|| json!("user")),
    );
    if let Some(version) = value_string(manifest_entry.get("version"))
        .or_else(|| registry_entry.and_then(|entry| value_string(entry.get("version"))))
    {
        entry.insert("version".to_owned(), json!(version));
    }
    entry.insert("source".to_owned(), json!(WEGENT_SOURCE));
    copy_registry_plugin_timestamp(&mut entry, registry_entry, "installedAt", "installed_at");
    copy_registry_plugin_timestamp(&mut entry, registry_entry, "lastUpdated", "last_updated");
    entry.insert(
        "skills".to_owned(),
        Value::Array(scan_optional_plugin_path(managed_plugin_scan_path(
            manifest_entry,
        ))?),
    );
    if let Some(installed_plugin_id) = value_i64(manifest_entry.get("installed_plugin_id")) {
        entry.insert("installed_plugin_id".to_owned(), json!(installed_plugin_id));
    }
    Ok(Value::Object(entry))
}

fn local_plugin_report_entry(
    key: &str,
    registry_entry: &Value,
) -> Result<Value, CapabilitySyncError> {
    let (name, marketplace) = split_plugin_key(key);
    let mut entry = Map::new();
    entry.insert("name".to_owned(), json!(name));
    entry.insert("marketplace".to_owned(), json!(marketplace));
    entry.insert(
        "scope".to_owned(),
        registry_entry
            .get("scope")
            .cloned()
            .unwrap_or_else(|| json!("user")),
    );
    if let Some(version) = value_string(registry_entry.get("version")) {
        entry.insert("version".to_owned(), json!(version));
    }
    entry.insert("source".to_owned(), json!(LOCAL_USER_SOURCE));
    copy_registry_plugin_timestamp(
        &mut entry,
        Some(registry_entry),
        "installedAt",
        "installed_at",
    );
    copy_registry_plugin_timestamp(
        &mut entry,
        Some(registry_entry),
        "lastUpdated",
        "last_updated",
    );
    let scan_path = value_string(registry_entry.get("installPath"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir());
    entry.insert(
        "skills".to_owned(),
        Value::Array(scan_optional_plugin_path(scan_path)?),
    );
    Ok(Value::Object(entry))
}

fn copy_registry_plugin_timestamp(
    output: &mut Map<String, Value>,
    registry_entry: Option<&Value>,
    source_key: &str,
    output_key: &str,
) {
    if let Some(timestamp) = registry_entry.and_then(|entry| value_string(entry.get(source_key))) {
        output.insert(output_key.to_owned(), json!(timestamp));
    }
}

fn scan_optional_plugin_path(path: Option<PathBuf>) -> Result<Vec<Value>, CapabilitySyncError> {
    path.as_deref()
        .map(scan_plugin_skills)
        .transpose()
        .map(Option::unwrap_or_default)
}

fn managed_plugin_scan_path(plugin: &Value) -> Option<PathBuf> {
    value_string(
        plugin
            .get("runtime")
            .and_then(|runtime| runtime.get("codex_link")),
    )
    .map(PathBuf::from)
    .filter(|path| path.is_dir())
    .or_else(|| {
        value_string(plugin.get("store_path"))
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
    })
}
