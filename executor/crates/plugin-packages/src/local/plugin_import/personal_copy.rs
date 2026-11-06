//! Personal plugin copy download and rollback.
use super::*;

pub(super) fn validate_plugin_copy_request(
    request: &ImportPersonalPluginCopyRequest,
) -> Result<(), String> {
    normalized_plugin_copy_sha256(&request.sha256)?;
    if request.source_plugin_id <= 0 || request.source_release_id <= 0 {
        return Err("Plugin copy source identifiers must be positive".to_owned());
    }
    let source_name = request.source_plugin_name.trim();
    if !valid_plugin_slug(source_name) {
        return Err("Plugin copy source name must be a lowercase plugin slug".to_owned());
    }
    if request.source_display_name.chars().count() > 200 {
        return Err("Plugin copy display name exceeds 200 characters".to_owned());
    }
    Ok(())
}

fn normalized_plugin_copy_sha256(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.len() != 64
        || !normalized
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Plugin copy checksum is invalid".to_owned());
    }
    Ok(normalized)
}

pub(super) fn validated_plugin_copy_download_url(value: &str) -> Result<Url, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_PLUGIN_COPY_URL_BYTES {
        return Err("Plugin copy download URL is invalid".to_owned());
    }
    let url = Url::parse(value)
        .map_err(|error| format!("Plugin copy download URL is invalid: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "Plugin copy download URL must be an HTTP(S) URL without credentials or a fragment"
                .to_owned(),
        );
    }
    Ok(url)
}

pub(super) async fn download_plugin_copy(
    url: &Url,
    expected_sha256: &str,
) -> Result<Vec<u8>, String> {
    let expected_sha256 = normalized_plugin_copy_sha256(expected_sha256)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(Policy::none())
        .build()
        .map_err(|error| format!("Failed to prepare plugin download: {error}"))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("Failed to download plugin copy: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Plugin copy download failed with HTTP {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_PLUGIN_PACKAGE_BYTES as u64)
    {
        return Err("Plugin ZIP exceeds 50 MB".to_owned());
    }

    let capacity = response
        .content_length()
        .unwrap_or_default()
        .min(MAX_PLUGIN_PACKAGE_BYTES as u64) as usize;
    let mut package = Vec::with_capacity(capacity);
    let mut digest = Sha256::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Failed to read plugin copy download: {error}"))?;
        let next_size = package
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| "Plugin ZIP size overflow".to_owned())?;
        if next_size > MAX_PLUGIN_PACKAGE_BYTES {
            return Err("Plugin ZIP exceeds 50 MB".to_owned());
        }
        digest.update(&chunk);
        package.extend_from_slice(&chunk);
    }
    if format!("{:x}", digest.finalize()) != expected_sha256 {
        return Err("Plugin copy checksum mismatch".to_owned());
    }
    Ok(package)
}

fn normalized_copy_slug(source_name: &str) -> String {
    const MAX_COPY_BASE_BYTES: usize = 80;
    let mut slug = source_name
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    slug = slug.trim_matches(['-', '_']).to_owned();
    if slug.is_empty() {
        slug = "plugin".to_owned();
    }
    slug.truncate(MAX_COPY_BASE_BYTES - "-copy".len());
    slug = slug.trim_end_matches(['-', '_']).to_owned();
    format!("{slug}-copy")
}

fn unique_copy_slug(plugins_root: &Path, source_name: &str) -> Result<String, String> {
    let base = normalized_copy_slug(source_name);
    for suffix in 1_u32.. {
        let candidate = if suffix == 1 {
            base.clone()
        } else {
            format!("{base}-{suffix}")
        };
        match fs::symlink_metadata(plugins_root.join(&candidate)) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Plugin copy destination may not be a symbolic link: {candidate}"
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(candidate),
            Err(error) => {
                return Err(format!(
                    "Failed to inspect plugin copy destination {candidate}: {error}"
                ));
            }
        }
    }
    unreachable!("copy suffix range is unbounded")
}

pub(super) fn copy_registry_path(marketplace_root: &Path) -> PathBuf {
    marketplace_root.join(".wegent/plugin-copy-sources.json")
}

pub(super) fn read_plugin_copy_registry(path: &Path) -> Result<LocalPluginCopyRegistry, String> {
    reject_symlink(path, "plugin copy registry")?;
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Plugin copy registry is invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(LocalPluginCopyRegistry::default())
        }
        Err(error) => Err(format!("Failed to read plugin copy registry: {error}")),
    }
}

pub(super) fn serialize_plugin_copy_registry(
    registry: &LocalPluginCopyRegistry,
) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(registry)
        .map_err(|error| format!("Failed to serialize plugin copy registry: {error}"))
}

pub(super) fn import_plugin_copy_package(
    marketplace_root: &Path,
    package: &[u8],
    request: &ImportPersonalPluginCopyRequest,
) -> Result<LocalPluginCopyImportResult, String> {
    validate_plugin_copy_request(request)?;
    if package.len() > MAX_PLUGIN_PACKAGE_BYTES {
        return Err("Plugin ZIP exceeds 50 MB".to_owned());
    }
    let expected_sha256 = normalized_plugin_copy_sha256(&request.sha256)?;
    if format!("{:x}", Sha256::digest(package)) != expected_sha256 {
        return Err("Plugin copy checksum mismatch".to_owned());
    }

    let marketplace_root = marketplace_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    let plugins_root =
        prepare_direct_child_directory(&marketplace_root, "plugins", "personal plugin directory")?;
    let manifest_paths = prepare_personal_marketplace_manifest_paths(&marketplace_root)?;
    let registry_path = copy_registry_path(&marketplace_root);
    reject_symlink(&registry_path, "plugin copy registry")?;
    let registry_backup = read_optional_file(&registry_path)?;
    let mut registry = read_plugin_copy_registry(&registry_path)?;

    let plugin_name = unique_copy_slug(&plugins_root, &request.source_plugin_name)?;
    let display_base = request.source_display_name.trim();
    let display_name = format!(
        "{} · 我的副本",
        if display_base.is_empty() {
            request.source_plugin_name.trim()
        } else {
            display_base
        }
    );
    let staging_root = plugins_root.join(format!(
        ".{plugin_name}-import-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    if fs::symlink_metadata(&staging_root).is_ok() {
        return Err("Plugin copy staging path already exists".to_owned());
    }
    fs::create_dir(&staging_root)
        .map_err(|error| format!("Failed to create plugin import directory: {error}"))?;

    let import_result = (|| {
        let mut manifest = extract_plugin_copy(package, &staging_root)?;
        if manifest_string(&manifest, "name") != request.source_plugin_name.trim() {
            return Err(
                "Plugin copy manifest name does not match its source descriptor".to_owned(),
            );
        }
        let manifest_object = manifest
            .as_object_mut()
            .ok_or_else(|| "Local plugin manifest must be an object".to_owned())?;
        manifest_object.insert("name".to_owned(), Value::String(plugin_name.clone()));
        manifest_object.insert("version".to_owned(), Value::String("0.1.0".to_owned()));
        let interface = manifest_object
            .entry("interface")
            .or_insert_with(|| json!({}));
        let interface_object = interface
            .as_object_mut()
            .ok_or_else(|| "Local plugin manifest interface must be an object".to_owned())?;
        interface_object.insert(
            "displayName".to_owned(),
            Value::String(display_name.clone()),
        );
        write_atomic_file(
            &staging_root.join(".codex-plugin/plugin.json"),
            &serde_json::to_vec_pretty(&manifest)
                .map_err(|error| format!("Failed to serialize local plugin manifest: {error}"))?,
        )?;

        let manifest_backups = manifest_paths
            .iter()
            .map(|path| read_optional_file(path).map(|bytes| (path.clone(), bytes)))
            .collect::<Result<Vec<_>, _>>()?;
        registry.copies.push(LocalPluginCopyRecord {
            local_plugin_name: plugin_name.clone(),
            source_plugin_id: request.source_plugin_id,
            source_release_id: request.source_release_id,
            source_plugin_name: request.source_plugin_name.trim().to_owned(),
        });
        let registry_bytes = serialize_plugin_copy_registry(&registry)?;
        let plugin_path = plugins_root.join(&plugin_name);
        fs::rename(&staging_root, &plugin_path)
            .map_err(|error| format!("Failed to install local plugin copy: {error}"))?;

        let mutation = manifest_paths
            .iter()
            .try_for_each(|path| upsert_marketplace_plugin_entry(path, &plugin_name))
            .and_then(|_| write_atomic_file(&registry_path, &registry_bytes));
        if let Err(error) = mutation {
            for (path, backup) in manifest_backups {
                let _ = restore_optional_file(&path, backup.as_deref());
            }
            let _ = restore_optional_file(&registry_path, registry_backup.as_deref());
            let _ = fs::remove_dir_all(&plugin_path);
            return Err(error);
        }
        Ok(LocalPluginCopyImportResult {
            plugin_name,
            display_name,
            version: "0.1.0".to_owned(),
            marketplace_path: marketplace_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
        })
    })();
    if import_result.is_err() {
        let _ = fs::remove_dir_all(&staging_root);
    }
    import_result
}

pub(super) fn rollback_plugin_copy(
    marketplace_root: &Path,
    plugin_name: &str,
) -> Result<(), String> {
    let plugin_name = validate_plugin_copy_name(plugin_name)?;
    let marketplace_root = marketplace_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))?;
    let _mutation_lock = acquire_personal_marketplace_lock(&marketplace_root)?;
    let plugins_root =
        prepare_direct_child_directory(&marketplace_root, "plugins", "personal plugin directory")?;
    let manifest_paths = prepare_personal_marketplace_manifest_paths(&marketplace_root)?;
    let registry_path = copy_registry_path(&marketplace_root);
    reject_symlink(&registry_path, "plugin copy registry")?;
    let registry_backup = read_optional_file(&registry_path)?;
    let mut registry = read_plugin_copy_registry(&registry_path)?;
    let manifest_backups = manifest_paths
        .iter()
        .map(|path| read_optional_file(path).map(|bytes| (path.clone(), bytes)))
        .collect::<Result<Vec<_>, _>>()?;
    let registered = registry
        .copies
        .iter()
        .any(|copy| copy.local_plugin_name == plugin_name);
    let plugin_path = plugins_root.join(plugin_name);
    let plugin_metadata = match fs::symlink_metadata(&plugin_path) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Failed to inspect plugin copy: {error}")),
    };
    if !registered {
        return if plugin_metadata.is_none() {
            Ok(())
        } else {
            Err("Plugin is not registered as a managed personal copy".to_owned())
        };
    }

    let rollback_staging = if let Some(metadata) = plugin_metadata {
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("Plugin copy must be a regular managed directory".to_owned());
        }
        let canonical_plugin = plugin_path
            .canonicalize()
            .map_err(|error| format!("Failed to resolve plugin copy: {error}"))?;
        if canonical_plugin.parent() != Some(plugins_root.as_path()) {
            return Err("Plugin copy is outside the personal marketplace".to_owned());
        }
        let manifest = serde_json::from_slice::<Value>(
            &fs::read(canonical_plugin.join(".codex-plugin/plugin.json"))
                .map_err(|error| format!("Failed to read plugin copy manifest: {error}"))?,
        )
        .map_err(|error| format!("Plugin copy manifest is invalid: {error}"))?;
        if manifest_string(&manifest, "name") != plugin_name {
            return Err("Plugin copy manifest name does not match its directory".to_owned());
        }
        collect_plugin_files(&canonical_plugin)?;
        let staging = plugins_root.join(format!(
            ".{plugin_name}-rollback-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        if fs::symlink_metadata(&staging).is_ok() {
            return Err("Plugin copy rollback staging path already exists".to_owned());
        }
        fs::rename(&canonical_plugin, &staging)
            .map_err(|error| format!("Failed to stage plugin copy rollback: {error}"))?;
        Some(staging)
    } else {
        None
    };

    registry
        .copies
        .retain(|copy| copy.local_plugin_name != plugin_name);
    let mutation = manifest_paths
        .iter()
        .try_for_each(|path| remove_marketplace_plugin_entry(path, plugin_name))
        .and_then(|_| {
            write_atomic_file(&registry_path, &serialize_plugin_copy_registry(&registry)?)
        });
    if let Err(error) = mutation {
        for (path, backup) in manifest_backups {
            let _ = restore_optional_file(&path, backup.as_deref());
        }
        let _ = restore_optional_file(&registry_path, registry_backup.as_deref());
        if let Some(staging) = rollback_staging {
            let _ = fs::rename(staging, &plugin_path);
        }
        return Err(error);
    }
    if let Some(staging) = rollback_staging {
        fs::remove_dir_all(staging)
            .map_err(|error| format!("Failed to remove plugin copy: {error}"))?;
    }
    Ok(())
}

fn validate_plugin_copy_name(plugin_name: &str) -> Result<&str, String> {
    let plugin_name = validate_personal_plugin_name(plugin_name)?;
    let plain_copy = plugin_name
        .strip_suffix("-copy")
        .is_some_and(|prefix| !prefix.is_empty());
    let numbered_copy = plugin_name
        .rsplit_once("-copy-")
        .is_some_and(|(prefix, suffix)| {
            !prefix.is_empty() && suffix.parse::<u32>().is_ok_and(|number| number >= 2)
        });
    if !plain_copy && !numbered_copy {
        return Err("Plugin copy name is invalid".to_owned());
    }
    Ok(plugin_name)
}

pub(super) fn restore_optional_file(path: &Path, bytes: Option<&[u8]>) -> Result<(), String> {
    match bytes {
        Some(bytes) => write_atomic_file(path, bytes),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove {}: {error}", path.display())),
        },
    }
}
