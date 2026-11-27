// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Author installations are independent of the immutable account release.

use super::runtime_recovery::{safe_managed_path, validate_package_identity};
use super::*;
use crate::local::{plugin_cache::read_codex_plugin_cache, plugin_import};

/// Resolve current author facts without treating recorded paths as authority.
pub fn read_personal_author_source(
    manifest_path: &Path,
    codex_home: &Path,
    entry: &Value,
) -> Result<Option<Value>, CapabilitySyncError> {
    if entry["personal_source_owner"] != true
        || entry["marketplace"] != PERSONAL_SHARED_PLUGIN_MARKETPLACE
    {
        return Ok(None);
    }
    let Some(name) = entry["name"].as_str() else {
        return Ok(None);
    };
    shared_packages::validate_component(name)?;
    let Some(plugin_id) = entry["cloud_plugin_id"].as_i64().filter(|id| *id > 0) else {
        return Ok(None);
    };
    let Some(scope) = entry
        .get("account_scope")
        .cloned()
        .and_then(|value| serde_json::from_value::<plugin_import::PluginAccountScope>(value).ok())
    else {
        return Ok(None);
    };
    let scope = plugin_import::PluginAccountScope::new(scope.backend_url, scope.user_id)
        .map_err(CapabilitySyncError::invalid_payload)?;
    let root = manifest_path.parent().unwrap_or(Path::new("."));
    let marketplace = root.join("bundled-marketplaces/wework-personal");
    let source = marketplace.join("plugins").join(name);
    if !source.is_dir() || source.is_symlink() {
        return Ok(None);
    }
    safe_managed_path(root, &source, false)?;
    if !plugin_import::personal_plugin_cloud_link_matches(&marketplace, name, plugin_id, &scope)
        .map_err(CapabilitySyncError::invalid_payload)?
    {
        return Ok(None);
    }
    let source_manifest = source.join(CODEX_PLUGIN_MANIFEST_PATH);
    safe_managed_path(root, &source_manifest, false)?;
    let manifest: Value = serde_json::from_slice(&fs::read(source_manifest)?)?;
    if !manifest["name"]
        .as_str()
        .is_some_and(|manifest_name| personal_manifest_name_matches_slug(manifest_name, name))
    {
        return Err(CapabilitySyncError::invalid_payload(
            "Author plugin source identity does not match its account release",
        ));
    }
    author_runtime_facts(codex_home, name, source.canonicalize()?)
}

fn author_runtime_facts(
    codex_home: &Path,
    name: &str,
    source: PathBuf,
) -> Result<Option<Value>, CapabilitySyncError> {
    let config = codex_home.join("config.toml");
    safe_managed_path(codex_home, &config, false)?;
    let content = match fs::read_to_string(config) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let document = content.parse::<DocumentMut>().map_err(|error| {
        CapabilitySyncError::invalid_payload(format!("Invalid Codex config: {error}"))
    })?;
    let key = format!("{name}@{PERSONAL_SHARED_PLUGIN_MARKETPLACE}");
    let configuration = document
        .get("plugins")
        .and_then(|plugins| plugins.get(&key));
    let cached = read_codex_plugin_cache(codex_home, PERSONAL_SHARED_PLUGIN_MARKETPLACE, name)
        .map_err(CapabilitySyncError::invalid_payload)?;
    let installed = configuration.is_some() && cached.is_some();
    let mut facts = json!({
        "source_path":source,
        "installed":installed,
        "enabled":installed && configuration.and_then(|item| item.get("enabled")).and_then(Item::as_bool).unwrap_or(false),
    });
    if installed {
        let cached = cached.expect("Installed author plugin has a cache");
        safe_managed_path(&codex_home.canonicalize()?, &cached.root, false)?;
        facts["runtime_path"] = json!(cached.root);
        facts["version"] = json!(cached.manifest["version"].as_str());
    }
    Ok(Some(facts))
}

impl GlobalCapabilityStore {
    pub(super) fn personal_author_source(
        &self,
        spec: &PluginSyncSpec,
    ) -> Result<Option<Value>, CapabilitySyncError> {
        let Some(scope) = self.account_scope.lock().unwrap().clone() else {
            return Ok(None);
        };
        if !self.shared_packages {
            return Ok(None);
        }
        read_personal_author_source(
            &self.manifest.path,
            self.codex_plugins_dir
                .parent()
                .unwrap_or(&self.codex_plugins_dir),
            &json!({"name":spec.name,"marketplace":spec.marketplace,
                "cloud_plugin_id":spec.cloud_plugin_id,"personal_source_owner":spec.personal_source_owner,
                "account_scope":scope}),
        )
    }

    pub(super) fn preserve_personal_author_source(
        &self,
        spec: &PluginSyncSpec,
        package: &Path,
        manifest: &mut Value,
    ) -> Result<Value, CapabilitySyncError> {
        let _personal = acquire_personal_marketplace_lock(&self.personal_marketplace_dir())
            .map_err(CapabilitySyncError::invalid_payload)?;
        let source = self.personal_author_source(spec)?.ok_or_else(|| {
            CapabilitySyncError::invalid_payload(
                "Author plugin source changed during account installation",
            )
        })?;
        validate_package_identity(package, spec)?;
        let mut entry = manifest["plugins"][&spec.key]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut fields = plugin_manifest_entry(spec, package, Path::new(""), Path::new(""));
        fields.as_object_mut().unwrap().remove("runtime");
        entry.extend(fields.as_object().unwrap().clone());
        if spec.component_states.as_object().is_some_and(Map::is_empty) {
            entry.remove("component_states");
        }
        if let Some(runtime) = entry.get_mut("runtime").and_then(Value::as_object_mut) {
            for field in ["codex_link", "claude_link", "managed_mcp_python"] {
                runtime.remove(field);
            }
            if runtime.is_empty() {
                entry.remove("runtime");
            }
        }
        entry.remove("runtime_recovery_error");
        let mut entry = Value::Object(entry);
        entry["personal_source_owner"] = json!(true);
        entry["account_scope"] = json!(self.account_scope.lock().unwrap().clone());
        entry["materialization"] = json!("author_source");
        entry["author_source"] = source.clone();
        ensure_object_field(manifest, "plugins").insert(spec.key.clone(), entry);
        Ok(source)
    }
}

pub(super) fn receipt(source: &Value) -> Value {
    let mut receipt = json!({"installed":source["installed"],"enabled":source["enabled"]});
    if let Some(version) = source["version"]
        .as_str()
        .filter(|version| !version.is_empty())
    {
        receipt["version"] = json!(version);
    }
    receipt
}

pub fn personal_manifest_name_matches_slug(name: &str, slug: &str) -> bool {
    if matches!(name, "." | "..") || name.chars().any(|ch| matches!(ch, '/' | '\\' | ':' | '\0')) {
        return false;
    }
    let mut normalized = String::new();
    let mut separating = false;
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-') {
            normalized.push(ch);
            separating = false;
        } else if !separating {
            normalized.push('-');
            separating = true;
        }
    }
    normalized == slug
}
