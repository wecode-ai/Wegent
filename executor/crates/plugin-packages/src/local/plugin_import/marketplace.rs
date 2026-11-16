//! Personal marketplace paths, artifacts, and catalogue.
use super::*;

pub(super) fn prepare_personal_marketplace_root(path: &Path) -> Result<PathBuf, String> {
    prepare_personal_marketplace_root_for_capabilities(path, &capabilities_root()?)
}

fn capabilities_root() -> Result<PathBuf, String> {
    if env::var_os("WEGENT_CAPABILITIES_HOME").is_none() {
        reject_symlink(&required_executor_home()?, "executor home")?;
    }
    wegent_runtime_config::paths::default_manifest_path()
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Invalid capabilities root".to_owned())
}

pub(super) fn prepare_local_marketplace_root(path: &Path) -> Result<PathBuf, String> {
    let root = marketplace_root_from_path(path);
    if root.exists() {
        reject_symlink(&root, "personal marketplace")?;
        if !root.is_dir() {
            return Err("Personal marketplace path must be a directory".to_owned());
        }
    } else {
        fs::create_dir_all(&root).map_err(|error| {
            format!(
                "Failed to create personal marketplace {}: {error}",
                root.display()
            )
        })?;
    }
    root.canonicalize()
        .map_err(|error| format!("Failed to resolve personal marketplace: {error}"))
}

#[cfg(all(test, unix))]
pub(super) fn prepare_personal_marketplace_root_for_executor_home(
    path: &Path,
    executor_home: &Path,
) -> Result<PathBuf, String> {
    create_directory_without_symlink(executor_home, "executor home")?;
    prepare_personal_marketplace_root_for_capabilities(path, &executor_home.join("capabilities"))
}

pub(super) fn prepare_personal_marketplace_root_for_capabilities(
    path: &Path,
    capabilities_root: &Path,
) -> Result<PathBuf, String> {
    let expected = validated_personal_marketplace_path_for_capabilities("", capabilities_root)?;
    if path != expected {
        return Err(format!(
            "Personal marketplace path must be {}",
            expected.display()
        ));
    }
    create_directory_without_symlink(capabilities_root, "executor capabilities")?;
    let mut parent = capabilities_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor capabilities: {error}"))?;
    for (name, label) in [
        ("bundled-marketplaces", "bundled marketplace directory"),
        (PERSONAL_MARKETPLACE_ID, "personal marketplace"),
    ] {
        parent = prepare_direct_child_directory(&parent, name, label)?;
    }
    Ok(parent)
}

pub(super) fn personal_marketplace_path(capabilities_root: &Path) -> PathBuf {
    capabilities_root
        .join("bundled-marketplaces")
        .join(PERSONAL_MARKETPLACE_ID)
}

pub(super) fn resolve_existing_marketplace_root(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        reject_symlink(path, "marketplace path")?;
    }
    let root = marketplace_root_from_path(path);
    reject_symlink(&root, "marketplace root")?;
    let metadata = fs::metadata(&root)
        .map_err(|error| format!("Failed to inspect local marketplace: {error}"))?;
    if !metadata.is_dir() {
        return Err("Local marketplace path must resolve to a directory".to_owned());
    }
    root.canonicalize()
        .map_err(|error| format!("Failed to resolve local marketplace: {error}"))
}

pub(super) fn resolve_managed_personal_plugin(
    marketplace_root: &Path,
    plugin_name: &str,
) -> Result<PathBuf, String> {
    let plugins_root = marketplace_root.join("plugins");
    reject_symlink(&plugins_root, "personal plugin directory")?;
    let canonical_plugins_root = plugins_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal plugin directory: {error}"))?;
    let plugin_path = plugins_root.join(plugin_name);
    reject_symlink(&plugin_path, "personal plugin")?;
    let metadata = fs::metadata(&plugin_path)
        .map_err(|error| format!("Failed to inspect personal plugin: {error}"))?;
    if !metadata.is_dir() {
        return Err("Plugin is not a managed personal plugin directory".to_owned());
    }
    let canonical_plugin = plugin_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve personal plugin: {error}"))?;
    if canonical_plugin.parent() != Some(canonical_plugins_root.as_path())
        || canonical_plugin.file_name().and_then(|name| name.to_str()) != Some(plugin_name)
        || regular_plugin_manifest(&canonical_plugin)?.is_none()
    {
        return Err("Plugin is not a managed personal plugin".to_owned());
    }
    Ok(canonical_plugin)
}

pub(super) fn regular_plugin_manifest(plugin_root: &Path) -> Result<Option<PathBuf>, String> {
    for path in [
        plugin_root.join(".codex-plugin/plugin.json"),
        plugin_root.join(".claude-plugin/plugin.json"),
        plugin_root.join("plugin.json"),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Plugin manifest may not be a symbolic link: {}",
                    path.display()
                ));
            }
            Ok(metadata) if metadata.is_file() => return Ok(Some(path)),
            Ok(_) => {
                return Err(format!(
                    "Plugin manifest must be a regular file: {}",
                    path.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Failed to inspect {}: {error}", path.display()));
            }
        }
    }
    Ok(None)
}

pub(super) fn create_directory_without_symlink(path: &Path, label: &str) -> Result<(), String> {
    if path.exists() {
        reject_symlink(path, label)?;
        if !path.is_dir() {
            return Err(format!("{label} must be a directory"));
        }
        return Ok(());
    }
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create {}: {error}", path.display()))
}

pub(super) fn reject_symlink(path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(format!(
            "{label} may not be a symbolic link: {}",
            path.display()
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to inspect {}: {error}", path.display())),
    }
}

pub(super) fn validate_personal_plugin_name(plugin_name: &str) -> Result<&str, String> {
    let plugin_name = validate_plugin_name(plugin_name)?;
    if !valid_plugin_slug(plugin_name) {
        return Err("Plugin name must be a lowercase plugin slug".to_owned());
    }
    Ok(plugin_name)
}

fn required_executor_home() -> Result<PathBuf, String> {
    env::var_os(EXECUTOR_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| format!("{EXECUTOR_HOME_ENV} is required for personal plugin copies"))
}

pub(super) fn prepare_personal_package_artifact_root() -> Result<PathBuf, String> {
    let executor_home = required_executor_home()?;
    if executor_home
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Executor home may not contain parent traversal".to_owned());
    }
    create_directory_without_symlink(&executor_home, "executor home")?;
    let artifacts_root = executor_home.join("artifacts");
    create_directory_without_symlink(&artifacts_root, "executor artifact directory")?;
    let package_root = artifacts_root.join(PERSONAL_PACKAGE_ARTIFACT_DIRECTORY);
    create_directory_without_symlink(&package_root, "personal plugin package artifact directory")?;
    #[cfg(unix)]
    for path in [&artifacts_root, &package_root] {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| {
            format!("Failed to secure personal plugin package artifact directory: {error}")
        })?;
    }

    let canonical_home = executor_home
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor home: {error}"))?;
    let canonical_artifacts = artifacts_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve executor artifact directory: {error}"))?;
    let canonical_package_root = package_root.canonicalize().map_err(|error| {
        format!("Failed to resolve personal plugin package artifact directory: {error}")
    })?;
    if canonical_artifacts.parent() != Some(canonical_home.as_path())
        || canonical_package_root.parent() != Some(canonical_artifacts.as_path())
    {
        return Err("Personal plugin package artifact directory escaped executor home".to_owned());
    }
    Ok(canonical_package_root)
}

pub(super) fn validate_personal_package_cleanup_token(value: &str) -> Result<&str, String> {
    let token = value.trim();
    let parsed = Uuid::parse_str(token)
        .map_err(|_| "Personal plugin package cleanup token is invalid".to_owned())?;
    if parsed.to_string() != token {
        return Err("Personal plugin package cleanup token is invalid".to_owned());
    }
    Ok(token)
}

fn personal_package_artifact_token(path: &Path) -> Option<&str> {
    let name = path.file_name()?.to_str()?;
    let token = name.strip_suffix(".zip")?;
    validate_personal_package_cleanup_token(token).ok()
}

pub(super) fn remove_personal_package_artifact(
    artifact_root: &Path,
    cleanup_token: &str,
) -> Result<(), String> {
    let canonical_artifact_root = artifact_root
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin package artifact directory: {error}"))?;
    let artifact_path = artifact_root.join(format!("{cleanup_token}.zip"));
    let metadata = match fs::symlink_metadata(&artifact_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(format!(
                "Failed to inspect plugin package artifact: {error}"
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Plugin package cleanup target must be a direct regular file".to_owned());
    }
    let canonical_path = artifact_path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve plugin package artifact: {error}"))?;
    if canonical_path.parent() != Some(canonical_artifact_root.as_path()) {
        return Err("Plugin package cleanup target escaped its artifact directory".to_owned());
    }
    fs::remove_file(canonical_path)
        .map_err(|error| format!("Failed to clean up plugin package artifact: {error}"))
}

pub(super) fn cleanup_stale_personal_package_artifacts(artifact_root: &Path) {
    let now = SystemTime::now();
    let entries = match fs::read_dir(artifact_root) {
        Ok(entries) => entries,
        Err(error) => {
            log_executor_event(
                "personal plugin package artifact cleanup failed",
                &[("error", error.to_string())],
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if personal_package_artifact_token(&path).is_none() {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        let is_stale = metadata
            .modified()
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= PERSONAL_PACKAGE_ARTIFACT_TTL);
        if is_stale {
            if let Err(error) = fs::remove_file(&path) {
                log_executor_event(
                    "stale personal plugin package artifact cleanup failed",
                    &[("error", error.to_string())],
                );
            }
        }
    }
}

pub(super) fn validated_personal_marketplace_path(path: &str) -> Result<PathBuf, String> {
    validated_personal_marketplace_path_for_capabilities(path, &capabilities_root()?)
}

#[cfg(test)]
pub(super) fn validated_personal_marketplace_path_for_executor_home(
    path: &str,
    executor_home: &Path,
) -> Result<PathBuf, String> {
    reject_symlink(executor_home, "executor home")?;
    validated_personal_marketplace_path_for_capabilities(path, &executor_home.join("capabilities"))
}

pub(super) fn validated_personal_marketplace_path_for_capabilities(
    path: &str,
    capabilities_root: &Path,
) -> Result<PathBuf, String> {
    if !capabilities_root.is_absolute()
        || capabilities_root
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Capabilities root must be absolute without parent traversal".to_owned());
    }
    let expected = personal_marketplace_path(capabilities_root);
    let requested = match path.trim() {
        "" => expected.clone(),
        value => PathBuf::from(value),
    };
    if requested
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err("Personal marketplace path may not contain parent traversal".to_owned());
    }
    reject_symlink(&requested, "requested personal marketplace")?;
    if requested.exists() && !requested.is_dir() {
        return Err("Requested personal marketplace must be a directory".to_owned());
    }
    let canonical_expected = expected.canonicalize().ok();
    if requested != expected
        && canonical_expected.as_ref().map_or(true, |canonical| {
            requested.canonicalize().ok().as_ref() != Some(canonical)
        })
    {
        return Err(format!(
            "Personal marketplace path must be {}",
            expected.display()
        ));
    }
    for (candidate, label) in [
        (capabilities_root.to_path_buf(), "executor capabilities"),
        (
            capabilities_root.join("bundled-marketplaces"),
            "bundled marketplace directory",
        ),
        (expected.clone(), "personal marketplace"),
    ] {
        reject_symlink(&candidate, label)?;
        if candidate.exists() && !candidate.is_dir() {
            return Err(format!("{label} must be a directory"));
        }
    }
    Ok(expected)
}

pub(super) fn prepare_direct_child_directory(
    parent: &Path,
    name: &str,
    label: &str,
) -> Result<PathBuf, String> {
    let path = parent.join(name);
    create_directory_without_symlink(&path, label)?;
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Failed to resolve {label}: {error}"))?;
    if canonical.parent() != Some(parent) {
        return Err(format!("{label} escaped its managed parent"));
    }
    Ok(canonical)
}

pub(super) fn prepare_personal_marketplace_manifest_paths(
    marketplace_root: &Path,
) -> Result<[PathBuf; 2], String> {
    let agents =
        prepare_direct_child_directory(marketplace_root, ".agents", "Codex marketplace directory")?;
    let agents_plugins =
        prepare_direct_child_directory(&agents, "plugins", "Codex plugin directory")?;
    let claude = prepare_direct_child_directory(
        marketplace_root,
        ".claude-plugin",
        "Claude marketplace directory",
    )?;
    let paths = [
        agents_plugins.join("marketplace.json"),
        claude.join("marketplace.json"),
    ];
    for path in &paths {
        reject_symlink(path, "personal marketplace manifest")?;
        if path.exists() {
            let metadata = fs::metadata(path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            if !metadata.is_file() {
                return Err("Personal marketplace manifest must be a regular file".to_owned());
            }
            let manifest = serde_json::from_slice::<Value>(
                &fs::read(path)
                    .map_err(|error| format!("Failed to read {}: {error}", path.display()))?,
            )
            .map_err(|error| format!("Invalid marketplace manifest: {error}"))?;
            if manifest
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name != PERSONAL_MARKETPLACE_ID)
            {
                return Err("Refusing to mutate a non-personal marketplace".to_owned());
            }
        }
    }
    Ok(paths)
}

pub(super) fn list_personal_plugins_at(
    path: &Path,
) -> Result<PersonalMarketplaceListResult, String> {
    let root = marketplace_root_from_path(path);
    if root.exists() {
        reject_symlink(&root, "personal marketplace")?;
        if !root.is_dir() {
            return Err("Personal marketplace path must be a directory".to_owned());
        }
    }
    let root = root.canonicalize().unwrap_or(root);
    let mut by_name = BTreeMap::<String, PersonalMarketplacePluginSummary>::new();
    let manifest_path = root.join(".agents/plugins/marketplace.json");
    if manifest_path.exists() {
        reject_symlink(&manifest_path, "personal marketplace manifest")?;
        match personal_marketplace_plugin_names(&manifest_path) {
            Ok(names) => {
                for name in names {
                    if let Ok(plugin_root) = resolve_managed_personal_plugin(&root, &name) {
                        by_name.insert(
                            name.clone(),
                            personal_plugin_summary(&name, &root, &plugin_root),
                        );
                    }
                }
            }
            Err(error) => {
                eprintln!(
                    "[Wework] personal marketplace.json skipped at {}: {error}",
                    manifest_path.display()
                );
            }
        }
    }

    let plugins_root = root.join("plugins");
    if plugins_root.exists() {
        reject_symlink(&plugins_root, "personal plugin directory")?;
        let entries = fs::read_dir(&plugins_root)
            .map_err(|error| format!("Failed to read {}: {error}", plugins_root.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Failed to read {}: {error}", plugins_root.display()))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                continue;
            }
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_personal_plugin_name(&name).is_err() {
                continue;
            }
            let Ok(plugin_root) = resolve_managed_personal_plugin(&root, &name) else {
                continue;
            };
            let summary = personal_plugin_summary(&name, &root, &plugin_root);
            match by_name.get_mut(&name) {
                Some(existing) => enrich_personal_plugin_summary(existing, summary),
                None => {
                    by_name.insert(name, summary);
                }
            }
        }
    }
    Ok(PersonalMarketplaceListResult {
        marketplace_id: PERSONAL_MARKETPLACE_ID.to_owned(),
        marketplace_path: root.display().to_string(),
        plugins: by_name.into_values().collect(),
    })
}

fn personal_marketplace_plugin_names(manifest_path: &Path) -> Result<Vec<String>, String> {
    let manifest = serde_json::from_slice::<Value>(
        &fs::read(manifest_path)
            .map_err(|error| format!("Failed to read {}: {error}", manifest_path.display()))?,
    )
    .map_err(|error| format!("Invalid marketplace {}: {error}", manifest_path.display()))?;
    if !matches!(
        manifest.get("name").and_then(Value::as_str),
        Some(PERSONAL_MARKETPLACE_ID) | Some(CODEX_PERSONAL_MARKETPLACE_ID)
    ) {
        return Err(format!(
            "Marketplace {} is not a personal marketplace",
            manifest_path.display()
        ));
    }
    let plugins = manifest
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or_else(|| "Personal marketplace plugins must be an array".to_owned())?;
    let mut names = plugins
        .iter()
        .filter_map(|plugin| plugin.get("name").and_then(Value::as_str))
        .filter_map(|name| validate_personal_plugin_name(name).ok().map(str::to_owned))
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    Ok(names)
}

fn personal_plugin_summary(
    name: &str,
    marketplace_root: &Path,
    plugin_root: &Path,
) -> PersonalMarketplacePluginSummary {
    let mut summary = PersonalMarketplacePluginSummary {
        name: name.to_owned(),
        version: None,
        display_name: None,
        description: None,
        logo: None,
        category: None,
        marketplace_path: marketplace_root.display().to_string(),
        plugin_path: plugin_root.display().to_string(),
    };
    if let Ok(Some(manifest_path)) = regular_plugin_manifest(plugin_root) {
        if let Ok(manifest) = fs::read(&manifest_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .ok_or(())
        {
            summary.version = optional_trimmed_string(manifest.get("version"));
            summary.description =
                optional_trimmed_string(manifest.get("description")).or_else(|| {
                    optional_trimmed_string(manifest.pointer("/interface/shortDescription"))
                });
            summary.display_name =
                optional_trimmed_string(manifest.pointer("/interface/displayName"));
            summary.logo = optional_trimmed_string(manifest.pointer("/interface/logo"));
            summary.category = optional_trimmed_string(manifest.pointer("/interface/category"));
        }
    }
    summary
}

fn enrich_personal_plugin_summary(
    existing: &mut PersonalMarketplacePluginSummary,
    candidate: PersonalMarketplacePluginSummary,
) {
    if existing.display_name.is_none() {
        existing.display_name = candidate.display_name;
    }
    if existing.description.is_none() {
        existing.description = candidate.description;
    }
    if existing.version.is_none() {
        existing.version = candidate.version;
    }
    if existing.logo.is_none() {
        existing.logo = candidate.logo;
    }
    if existing.category.is_none() {
        existing.category = candidate.category;
    }
}

fn optional_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn marketplace_root_from_path(path: &Path) -> PathBuf {
    if path
        .file_name()
        .map_or(true, |name| name != "marketplace.json")
    {
        return path.to_path_buf();
    }
    let Some(parent) = path.parent() else {
        return path.to_path_buf();
    };
    if parent.file_name().is_some_and(|name| name == "plugins") {
        if let Some(scope) = parent.parent() {
            if scope
                .file_name()
                .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
            {
                return scope.parent().unwrap_or(scope).to_path_buf();
            }
        }
    }
    if parent
        .file_name()
        .is_some_and(|name| name == ".agents" || name == ".claude-plugin")
    {
        return parent.parent().unwrap_or(parent).to_path_buf();
    }
    parent.to_path_buf()
}

pub(super) fn validate_plugin_name(plugin_name: &str) -> Result<&str, String> {
    let normalized = plugin_name.trim();
    if normalized.is_empty()
        || normalized.contains('/')
        || normalized.contains('\\')
        || matches!(normalized, "." | "..")
    {
        return Err("Plugin name is invalid".to_owned());
    }
    Ok(normalized)
}
