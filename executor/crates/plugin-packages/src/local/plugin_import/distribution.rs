//! Personal plugin packaging and source discovery.
use super::*;

pub(super) fn ensure_personal_plugin_at(
    source_marketplace_path: &Path,
    destination_marketplace_path: &Path,
    plugin_name: &str,
) -> Result<EnsurePersonalPluginResult, String> {
    let plugin_name = validate_personal_plugin_name(plugin_name)?;
    let destination_root = prepare_local_marketplace_root(destination_marketplace_path)?;
    let _mutation_lock = acquire_personal_marketplace_lock(&destination_root)?;
    let plugins_root = destination_root.join("plugins");
    create_directory_without_symlink(&plugins_root, "personal plugin directory")?;

    let destination_plugin = plugins_root.join(plugin_name);
    if destination_plugin.exists() {
        let plugin_path = resolve_managed_personal_plugin(&destination_root, plugin_name)?;
        return Ok(EnsurePersonalPluginResult {
            plugin_name: plugin_name.to_owned(),
            marketplace_path: destination_root.display().to_string(),
            plugin_path: plugin_path.display().to_string(),
            migrated: false,
        });
    }

    let manifest_paths = prepare_personal_marketplace_manifest_paths(&destination_root)?;
    let manifest_backups = manifest_paths
        .iter()
        .map(|path| read_optional_file(path).map(|bytes| (path.clone(), bytes)))
        .collect::<Result<Vec<_>, _>>()?;

    let source_root = resolve_existing_marketplace_root(source_marketplace_path)?;
    let source_plugin =
        resolve_source_personal_plugin(source_marketplace_path, &source_root, plugin_name)?;
    let staging = plugins_root.join(format!(
        ".{plugin_name}-migrate-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    if staging.exists() {
        return Err("Personal plugin migration staging path already exists".to_owned());
    }
    if let Err(error) = copy_plugin_directory(&source_plugin, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if let Err(error) = fs::rename(&staging, &destination_plugin) {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("Failed to activate migrated plugin: {error}"));
    }

    let manifest_result = manifest_paths
        .iter()
        .try_for_each(|path| upsert_marketplace_plugin_entry(path, plugin_name));
    if let Err(error) = manifest_result {
        for (path, backup) in manifest_backups {
            match backup {
                Some(bytes) => {
                    let _ = write_atomic_file(&path, &bytes);
                }
                None => {
                    let _ = fs::remove_file(path);
                }
            }
        }
        let _ = fs::remove_dir_all(&destination_plugin);
        return Err(error);
    }

    let plugin_path = destination_plugin
        .canonicalize()
        .map_err(|error| format!("Failed to resolve migrated plugin: {error}"))?;
    Ok(EnsurePersonalPluginResult {
        plugin_name: plugin_name.to_owned(),
        marketplace_path: destination_root.display().to_string(),
        plugin_path: plugin_path.display().to_string(),
        migrated: true,
    })
}

pub(super) fn package_plugin_directory(
    root: &Path,
    plugin_name: &str,
    artifact_root: &Path,
) -> Result<LocalPluginPackage, String> {
    let files = collect_plugin_files(root)?;
    let expanded_size = files.iter().try_fold(0_u64, |total, path| {
        let size = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .len();
        total
            .checked_add(size)
            .ok_or_else(|| "Plugin package size overflow".to_owned())
    })?;
    if expanded_size > MAX_PLUGIN_EXPANDED_BYTES {
        return Err("Expanded plugin package exceeds 200 MB".to_owned());
    }

    let cleanup_token = Uuid::new_v4().to_string();
    let artifact_path = artifact_root.join(format!("{cleanup_token}.zip"));
    let mut open_options = fs::OpenOptions::new();
    open_options.create_new(true).write(true);
    #[cfg(unix)]
    open_options.mode(0o600);
    let artifact_file = open_options
        .open(&artifact_path)
        .map_err(|error| format!("Failed to create personal plugin package artifact: {error}"))?;

    let package_result = (|| {
        let mut archive = zip::ZipWriter::new(artifact_file);
        let options =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for path in files {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "Plugin file escaped its package root".to_owned())?;
            let archive_path = relative.to_string_lossy().replace('\\', "/");
            archive
                .start_file(&archive_path, options)
                .map_err(|error| format!("Failed to add {archive_path}: {error}"))?;
            let mut file = fs::File::open(&path)
                .map_err(|error| format!("Failed to open {}: {error}", path.display()))?;
            std::io::copy(&mut file, &mut archive)
                .map_err(|error| format!("Failed to package {archive_path}: {error}"))?;
        }
        let mut artifact_file = archive
            .finish()
            .map_err(|error| format!("Failed to finish plugin package: {error}"))?;
        artifact_file
            .flush()
            .map_err(|error| format!("Failed to flush plugin package: {error}"))?;
        drop(artifact_file);

        let metadata = fs::symlink_metadata(&artifact_path)
            .map_err(|error| format!("Failed to inspect plugin package: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Plugin package artifact is not a regular file".to_owned());
        }
        if metadata.len() > MAX_PLUGIN_PACKAGE_BYTES as u64 {
            return Err("Plugin ZIP exceeds 50 MB".to_owned());
        }
        let sha256 = sha256_file(&artifact_path)?;
        Ok(LocalPluginPackage {
            name: format!("{plugin_name}.zip"),
            path: artifact_path.display().to_string(),
            size: metadata.len(),
            sha256,
            cleanup_token: cleanup_token.clone(),
        })
    })();
    if package_result.is_err() {
        let _ = fs::remove_file(&artifact_path);
    }
    package_result
}

pub(super) fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path)
        .map_err(|error| format!("Failed to open plugin package for verification: {error}"))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let bytes_read = file
            .read(&mut buffer)
            .map_err(|error| format!("Failed to verify plugin package: {error}"))?;
        if bytes_read == 0 {
            break;
        }
        digest.update(&buffer[..bytes_read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

pub(super) fn collect_plugin_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    fn visit(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<(), String> {
        let mut entries = fs::read_dir(directory)
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            let entry_name = entry.file_name();
            if metadata.is_dir()
                && IGNORED_PLUGIN_SOURCE_DIRECTORIES
                    .iter()
                    .any(|ignored| entry_name == *ignored)
            {
                continue;
            }
            if metadata.is_file()
                && IGNORED_PLUGIN_SOURCE_FILES
                    .iter()
                    .any(|ignored| entry_name == *ignored)
            {
                continue;
            }
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Plugin package cannot contain symbolic links: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                visit(root, &path, files)?;
            } else if metadata.is_file() {
                path.strip_prefix(root)
                    .map_err(|_| "Plugin file escaped its package root".to_owned())?;
                files.push(path);
            } else {
                return Err(format!(
                    "Plugin package contains an unsupported filesystem entry: {}",
                    path.display()
                ));
            }
        }
        Ok(())
    }

    let metadata = fs::symlink_metadata(root)
        .map_err(|error| format!("Failed to inspect {}: {error}", root.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Plugin package root must be a regular directory".to_owned());
    }
    let mut files = Vec::new();
    visit(root, root, &mut files)?;
    Ok(files)
}

fn copy_plugin_directory(source: &Path, destination: &Path) -> Result<(), String> {
    fn copy_entries(source: &Path, destination: &Path, total: &mut u64) -> Result<(), String> {
        fs::create_dir_all(destination)
            .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source_path)
                .map_err(|error| format!("Failed to inspect {}: {error}", source_path.display()))?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Personal plugin cannot contain symbolic links: {}",
                    source_path.display()
                ));
            }
            if metadata.is_dir() {
                copy_entries(&source_path, &destination_path, total)?;
            } else if metadata.is_file() {
                *total = total
                    .checked_add(metadata.len())
                    .ok_or_else(|| "Plugin expanded size overflow".to_owned())?;
                if *total > MAX_PLUGIN_EXPANDED_BYTES {
                    return Err("Expanded plugin package exceeds 200 MB".to_owned());
                }
                fs::copy(&source_path, &destination_path).map_err(|error| {
                    format!(
                        "Failed to copy {} to {}: {error}",
                        source_path.display(),
                        destination_path.display()
                    )
                })?;
            } else {
                return Err(format!(
                    "Personal plugin contains an unsupported filesystem entry: {}",
                    source_path.display()
                ));
            }
        }
        Ok(())
    }

    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Failed to inspect {}: {error}", source.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Personal plugin source must be a regular directory".to_owned());
    }
    let mut total = 0_u64;
    copy_entries(source, destination, &mut total)
}

fn resolve_source_personal_plugin(
    marketplace_path: &Path,
    marketplace_root: &Path,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    let mut candidates = vec![
        marketplace_root.join("plugins").join(plugin_name),
        marketplace_root.join(plugin_name),
    ];
    for manifest_path in marketplace_manifest_paths(marketplace_path, marketplace_root) {
        if let Some(source) = plugin_source_from_manifest(&manifest_path, plugin_name)? {
            candidates.push(source);
        }
    }

    let mut seen = HashSet::new();
    for candidate in candidates {
        let Ok(metadata) = fs::symlink_metadata(&candidate) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.starts_with(marketplace_root)
            || canonical.file_name().and_then(|name| name.to_str()) != Some(plugin_name)
            || !seen.insert(canonical.clone())
        {
            continue;
        }
        if regular_plugin_manifest(&canonical)?.is_some() {
            return Ok(canonical);
        }
    }
    Err("Local plugin manifest is unavailable".to_owned())
}

fn marketplace_manifest_paths(marketplace_path: &Path, marketplace_root: &Path) -> Vec<PathBuf> {
    let mut paths = vec![
        marketplace_root.join(".agents/plugins/marketplace.json"),
        marketplace_root.join(".claude-plugin/marketplace.json"),
        marketplace_root.join("marketplace.json"),
        marketplace_root.join("plugins/marketplace.json"),
    ];
    if marketplace_path.file_name().and_then(|name| name.to_str()) == Some("marketplace.json") {
        paths.push(marketplace_path.to_path_buf());
    }
    paths.sort();
    paths.dedup();
    paths
}

fn plugin_source_from_manifest(
    manifest_path: &Path,
    plugin_name: &str,
) -> Result<Option<PathBuf>, String> {
    if !manifest_path.exists() {
        return Ok(None);
    }
    reject_symlink(manifest_path, "marketplace manifest")?;
    let manifest = serde_json::from_slice::<Value>(
        &fs::read(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
    let source = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .and_then(|plugins| {
            plugins
                .iter()
                .find(|plugin| plugin.get("name").and_then(Value::as_str) == Some(plugin_name))
        })
        .and_then(|plugin| plugin.get("source"))
        .and_then(|source| {
            source
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| source.as_str())
        });
    let Some(source) = source.map(str::trim).filter(|source| !source.is_empty()) else {
        return Ok(None);
    };
    let relative = Path::new(source);
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Personal marketplace plugin source must be a relative path".to_owned());
    }
    let marketplace_root = marketplace_root_from_path(manifest_path);
    Ok(Some(marketplace_root.join(relative)))
}
