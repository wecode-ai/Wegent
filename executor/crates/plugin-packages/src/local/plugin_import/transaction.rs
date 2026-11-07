//! Package import preview, commit, and rollback.
use super::*;

pub(super) fn preview_plugin_import_at(
    archive_path: &Path,
    marketplace_path: &Path,
) -> Result<LocalPluginImportPreview, String> {
    let package = read_plugin_archive(archive_path)?;
    let sha256 = format!("{:x}", Sha256::digest(&package));
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let preview_root = std::env::temp_dir().join(format!(
        "wework-plugin-preview-{}-{}-{nonce}",
        std::process::id(),
        &sha256[..16]
    ));
    let _ = fs::remove_dir_all(&preview_root);
    fs::create_dir_all(&preview_root)
        .map_err(|error| format!("Failed to prepare plugin preview: {error}"))?;
    let manifest = match extract_plugin_copy(&package, &preview_root) {
        Ok(manifest) => manifest,
        Err(error) => {
            let _ = fs::remove_dir_all(&preview_root);
            return Ok(LocalPluginImportPreview {
                valid: false,
                archive_path: archive_path.display().to_string(),
                sha256,
                name: String::new(),
                display_name: String::new(),
                version: String::new(),
                description: String::new(),
                skill_count: 0,
                mcp_server_count: 0,
                executable_capabilities: Vec::new(),
                existing: false,
                existing_version: None,
                issues: vec![classify_plugin_import_error(&package, error)],
            });
        }
    };
    let issues = validate_plugin_import_manifest(&preview_root, &manifest);
    let name = manifest_string(&manifest, "name").to_owned();
    let version = manifest_string(&manifest, "version").to_owned();
    let description = manifest_string(&manifest, "description").to_owned();
    let display_name = match plugin_interface_string(&manifest, "displayName") {
        "" => name.clone(),
        value => value.to_owned(),
    };
    let (skill_count, mcp_server_count, executable_capabilities) =
        plugin_component_summary(&preview_root, &manifest);
    let existing_root = marketplace_root_from_path(marketplace_path)
        .join("plugins")
        .join(&name);
    let existing_version = fs::read(existing_root.join(".codex-plugin/plugin.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| {
            value
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let existing = existing_root.is_dir();
    let _ = fs::remove_dir_all(&preview_root);
    Ok(LocalPluginImportPreview {
        valid: issues.is_empty(),
        archive_path: archive_path.display().to_string(),
        sha256,
        name,
        display_name,
        version,
        description,
        skill_count,
        mcp_server_count,
        executable_capabilities,
        existing,
        existing_version,
        issues,
    })
}

pub(super) fn import_plugin_package_at(
    marketplace_path: &Path,
    archive_path: &Path,
    expected_sha256: &str,
    overwrite: bool,
) -> Result<LocalPluginPackageImportResult, String> {
    let package = read_plugin_archive(archive_path)?;
    let actual_sha256 = format!("{:x}", Sha256::digest(&package));
    if actual_sha256 != expected_sha256 {
        return Err("The plugin ZIP changed after preview; select it again".to_owned());
    }
    fs::create_dir_all(marketplace_path).map_err(|error| {
        format!(
            "Failed to create personal marketplace {}: {error}",
            marketplace_path.display()
        )
    })?;
    let resolved_marketplace_path = marketplace_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let marketplace_root = marketplace_root_from_path(&resolved_marketplace_path);
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    let plugins_root = marketplace_root.join("plugins");
    fs::create_dir_all(&plugins_root)
        .map_err(|error| format!("Failed to create plugin directory: {error}"))?;
    let staging_root = plugins_root.join(format!(
        ".plugin-import-{}-{}",
        std::process::id(),
        &actual_sha256[..12]
    ));
    let _ = fs::remove_dir_all(&staging_root);
    fs::create_dir(&staging_root)
        .map_err(|error| format!("Failed to create plugin staging directory: {error}"))?;
    let import_result = (|| {
        let manifest = extract_plugin_copy(&package, &staging_root)?;
        let issues = validate_plugin_import_manifest(&staging_root, &manifest);
        if let Some(issue) = issues.first() {
            return Err(issue.message.clone());
        }
        let plugin_name = manifest_string(&manifest, "name").to_owned();
        let version = manifest_string(&manifest, "version").to_owned();
        let display_name = match plugin_interface_string(&manifest, "displayName") {
            "" => plugin_name.clone(),
            value => value.to_owned(),
        };
        let plugin_path = plugins_root.join(&plugin_name);
        let replaced_existing = plugin_path.exists();
        if replaced_existing && !overwrite {
            return Err(format!(
                "Plugin `{plugin_name}` already exists; confirm overwrite before importing"
            ));
        }
        let rollback_id = format!("{}-{}", &actual_sha256[..16], std::process::id());
        let backup_root = plugin_import_backup_root(&marketplace_root, &rollback_id)?;
        if backup_root.exists() {
            fs::remove_dir_all(&backup_root)
                .map_err(|error| format!("Failed to clear stale plugin import backup: {error}"))?;
        }
        fs::create_dir_all(&backup_root)
            .map_err(|error| format!("Failed to create plugin import backup: {error}"))?;
        let codex_marketplace = marketplace_root.join(".agents/plugins/marketplace.json");
        let claude_marketplace = marketplace_root.join(".claude-plugin/marketplace.json");
        let codex_marketplace_existed = codex_marketplace.is_file();
        let claude_marketplace_existed = claude_marketplace.is_file();
        backup_file_if_present(
            &codex_marketplace,
            &backup_root.join("codex-marketplace.json"),
        )?;
        backup_file_if_present(
            &claude_marketplace,
            &backup_root.join("claude-marketplace.json"),
        )?;
        let metadata = LocalPluginImportRollback {
            plugin_name: plugin_name.clone(),
            replaced_existing,
            codex_marketplace_existed,
            claude_marketplace_existed,
        };
        write_atomic_file(
            &backup_root.join("rollback.json"),
            &serde_json::to_vec_pretty(&metadata).map_err(|error| {
                format!("Failed to serialize plugin import rollback state: {error}")
            })?,
        )?;
        if replaced_existing {
            fs::rename(&plugin_path, backup_root.join("plugin"))
                .map_err(|error| format!("Failed to back up existing plugin: {error}"))?;
        }
        if let Err(error) = fs::rename(&staging_root, &plugin_path) {
            if replaced_existing {
                let _ = fs::rename(backup_root.join("plugin"), &plugin_path);
            }
            let _ = fs::remove_dir_all(&backup_root);
            return Err(format!("Failed to activate imported plugin: {error}"));
        }
        if let Err(error) = upsert_marketplace_plugin_entry(&codex_marketplace, &plugin_name)
            .and_then(|_| upsert_marketplace_plugin_entry(&claude_marketplace, &plugin_name))
        {
            let _ = restore_plugin_import(&marketplace_root, &rollback_id);
            return Err(error);
        }
        Ok(LocalPluginPackageImportResult {
            plugin_name,
            display_name,
            version,
            marketplace_path: marketplace_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
            rollback_id,
        })
    })();
    if import_result.is_err() {
        let _ = fs::remove_dir_all(&staging_root);
    }
    import_result
}

fn backup_file_if_present(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_file() {
        fs::copy(source, destination)
            .map_err(|error| format!("Failed to back up {}: {error}", source.display()))?;
    }
    Ok(())
}

pub(super) fn plugin_import_backup_root(
    marketplace_root: &Path,
    rollback_id: &str,
) -> Result<PathBuf, String> {
    if rollback_id.is_empty()
        || !rollback_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err("Plugin import rollback identifier is invalid".to_owned());
    }
    Ok(marketplace_root
        .join(".wegent/plugin-import-backups")
        .join(rollback_id))
}

pub(super) fn restore_plugin_import(
    marketplace_root: &Path,
    rollback_id: &str,
) -> Result<(), String> {
    let backup_root = plugin_import_backup_root(marketplace_root, rollback_id)?;
    let metadata = serde_json::from_slice::<LocalPluginImportRollback>(
        &fs::read(backup_root.join("rollback.json"))
            .map_err(|error| format!("Failed to read plugin import rollback state: {error}"))?,
    )
    .map_err(|error| format!("Plugin import rollback state is invalid: {error}"))?;
    let plugin_path = marketplace_root.join("plugins").join(&metadata.plugin_name);
    if plugin_path.exists() {
        fs::remove_dir_all(&plugin_path)
            .map_err(|error| format!("Failed to remove imported plugin: {error}"))?;
    }
    let backed_up_plugin = backup_root.join("plugin");
    if metadata.replaced_existing && backed_up_plugin.exists() {
        fs::rename(backed_up_plugin, &plugin_path)
            .map_err(|error| format!("Failed to restore previous plugin: {error}"))?;
    }
    for (marketplace_path, backup_name, existed) in [
        (
            marketplace_root.join(".agents/plugins/marketplace.json"),
            "codex-marketplace.json",
            metadata.codex_marketplace_existed,
        ),
        (
            marketplace_root.join(".claude-plugin/marketplace.json"),
            "claude-marketplace.json",
            metadata.claude_marketplace_existed,
        ),
    ] {
        if existed {
            write_atomic_file(
                &marketplace_path,
                &fs::read(backup_root.join(backup_name)).map_err(|error| {
                    format!("Failed to read marketplace rollback copy: {error}")
                })?,
            )?;
        } else if marketplace_path.exists() {
            fs::remove_file(&marketplace_path)
                .map_err(|error| format!("Failed to remove marketplace manifest: {error}"))?;
        }
    }
    fs::remove_dir_all(backup_root)
        .map_err(|error| format!("Failed to clear plugin import rollback state: {error}"))
}

pub(super) fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Failed to read {}: {error}", path.display())),
    }
}

pub(super) fn write_atomic_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Atomic write path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    wegent_filesystem::atomic_file::write_atomic_file(path, bytes).map_err(|error| {
        use wegent_filesystem::atomic_file::WriteStage;
        match error.stage {
            WriteStage::CreateTemporary => {
                format!("Failed to create temporary file: {}", error.source)
            }
            WriteStage::Write => format!("Failed to write temporary file: {}", error.source),
            WriteStage::Sync => format!("Failed to sync temporary file: {}", error.source),
            WriteStage::PreservePermissions => {
                format!("Failed to preserve permissions: {}", error.source)
            }
            WriteStage::Publish => format!(
                "Failed to atomically replace {}: {}",
                path.display(),
                error.source
            ),
        }
    })
}
