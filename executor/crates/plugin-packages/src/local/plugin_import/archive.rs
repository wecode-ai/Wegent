//! Archive validation and safe extraction.
use super::*;

pub(super) fn read_plugin_archive(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to read selected plugin ZIP: {error}"))?;
    if !metadata.is_file() {
        return Err("Selected plugin package is not a file".to_owned());
    }
    if metadata.len() > MAX_PLUGIN_PACKAGE_BYTES as u64 {
        return Err("Plugin ZIP exceeds 50 MB".to_owned());
    }
    fs::read(path).map_err(|error| format!("Unable to read selected plugin ZIP: {error}"))
}

pub(super) fn extract_plugin_copy(package: &[u8], destination: &Path) -> Result<Value, String> {
    reject_duplicate_zip_paths(package)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(package))
        .map_err(|error| format!("Plugin package is not a valid ZIP: {error}"))?;
    if archive.len() > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(format!(
            "Plugin ZIP contains more than {MAX_PLUGIN_ARCHIVE_ENTRIES} entries"
        ));
    }
    let mut paths = HashSet::new();
    let mut expanded_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read plugin ZIP entry: {error}"))?;
        let entry_name = entry.name().trim_end_matches('/');
        if entry_name.is_empty()
            || entry_name == ".DS_Store"
            || entry_name.ends_with("/.DS_Store")
            || entry_name == "__MACOSX"
            || entry_name.starts_with("__MACOSX/")
        {
            continue;
        }
        let relative = safe_archive_path(entry_name)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if !paths.insert(normalized.clone()) {
            return Err(format!(
                "Plugin ZIP contains a duplicate path: {normalized}"
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("Plugin ZIP contains a symbolic link: {normalized}"));
        }
        let output = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| format!("Failed to create {}: {error}", output.display()))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let mut file = fs::File::create(&output)
            .map_err(|error| format!("Failed to create {}: {error}", output.display()))?;
        let copied = copy_with_expanded_limit(
            &mut entry,
            &mut file,
            MAX_PLUGIN_EXPANDED_BYTES.saturating_sub(expanded_size),
        )
        .map_err(|error| format!("Failed to extract {normalized}: {error}"))?;
        expanded_size = expanded_size
            .checked_add(copied)
            .ok_or_else(|| "Plugin expanded size overflow".to_owned())?;
    }
    let manifest_bytes = fs::read(destination.join(".codex-plugin/plugin.json"))
        .map_err(|_| "Local plugin copy is missing .codex-plugin/plugin.json".to_owned())?;
    let manifest = serde_json::from_slice::<Value>(&manifest_bytes)
        .map_err(|error| format!("Local plugin manifest is invalid: {error}"))?;
    if !manifest.is_object()
        || manifest.get("name").and_then(Value::as_str).is_none()
        || manifest.get("version").and_then(Value::as_str).is_none()
    {
        return Err("Local plugin manifest requires string name and version fields".to_owned());
    }
    Ok(manifest)
}

fn reject_duplicate_zip_paths(package: &[u8]) -> Result<(), String> {
    const END_SIGNATURE: &[u8; 4] = b"PK\x05\x06";
    const CENTRAL_SIGNATURE: &[u8; 4] = b"PK\x01\x02";
    let search_start = package.len().saturating_sub(65_557);
    let end_offset = (search_start..package.len().saturating_sub(3))
        .rev()
        .find(|offset| &package[*offset..*offset + 4] == END_SIGNATURE)
        .ok_or_else(|| "Plugin package is missing its ZIP directory".to_owned())?;
    if end_offset + 22 > package.len() {
        return Err("Plugin ZIP directory is truncated".to_owned());
    }
    let read_u16 =
        |offset: usize| u16::from_le_bytes([package[offset], package[offset + 1]]) as usize;
    let read_u32 = |offset: usize| {
        u32::from_le_bytes([
            package[offset],
            package[offset + 1],
            package[offset + 2],
            package[offset + 3],
        ]) as usize
    };
    let entry_count = read_u16(end_offset + 10);
    let directory_size = read_u32(end_offset + 12);
    let mut cursor = read_u32(end_offset + 16);
    if entry_count == u16::MAX as usize
        || directory_size == u32::MAX as usize
        || cursor == u32::MAX as usize
    {
        return Err("ZIP64 plugin copies are not supported".to_owned());
    }
    if entry_count > MAX_PLUGIN_ARCHIVE_ENTRIES {
        return Err(format!(
            "Plugin ZIP contains more than {MAX_PLUGIN_ARCHIVE_ENTRIES} entries"
        ));
    }
    let directory_end = cursor
        .checked_add(directory_size)
        .ok_or_else(|| "Plugin ZIP directory size overflow".to_owned())?;
    if directory_end > end_offset || directory_end > package.len() {
        return Err("Plugin ZIP directory is invalid".to_owned());
    }
    let mut names = HashSet::new();
    for _ in 0..entry_count {
        if cursor + 46 > directory_end || &package[cursor..cursor + 4] != CENTRAL_SIGNATURE {
            return Err("Plugin ZIP directory entry is invalid".to_owned());
        }
        let name_length = read_u16(cursor + 28);
        let extra_length = read_u16(cursor + 30);
        let comment_length = read_u16(cursor + 32);
        let name_start = cursor + 46;
        let name_end = name_start
            .checked_add(name_length)
            .ok_or_else(|| "Plugin ZIP filename size overflow".to_owned())?;
        if name_end > directory_end {
            return Err("Plugin ZIP filename is truncated".to_owned());
        }
        if !names.insert(package[name_start..name_end].to_vec()) {
            return Err(format!(
                "Plugin ZIP contains a duplicate path: {}",
                String::from_utf8_lossy(&package[name_start..name_end])
            ));
        }
        cursor = name_end
            .checked_add(extra_length)
            .and_then(|value| value.checked_add(comment_length))
            .ok_or_else(|| "Plugin ZIP directory entry size overflow".to_owned())?;
    }
    if cursor != directory_end {
        return Err("Plugin ZIP directory length does not match its entries".to_owned());
    }
    Ok(())
}

fn copy_with_expanded_limit<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    remaining_bytes: u64,
) -> Result<u64, String> {
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to decompress plugin ZIP entry: {error}"))?;
        if read == 0 {
            return Ok(copied);
        }
        let next = copied
            .checked_add(read as u64)
            .ok_or_else(|| "Plugin expanded size overflow".to_owned())?;
        if next > remaining_bytes {
            return Err("Expanded plugin package exceeds 200 MB".to_owned());
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| format!("Failed to write plugin ZIP entry: {error}"))?;
        copied = next;
    }
}

fn safe_archive_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || name.contains('\0') || name.contains('\\') {
        return Err("Plugin ZIP contains an invalid path".to_owned());
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(format!("Plugin ZIP contains an unsafe path: {name}"));
    }
    let normalized = path.components().collect::<PathBuf>();
    if normalized.to_string_lossy().replace('\\', "/") != name {
        return Err(format!("Plugin ZIP contains an unsafe path: {name}"));
    }
    Ok(normalized)
}

pub(super) fn classify_plugin_import_error(
    package: &[u8],
    error: String,
) -> LocalPluginImportIssue {
    if error.contains("missing .codex-plugin/plugin.json") {
        if let Ok(mut archive) = zip::ZipArchive::new(std::io::Cursor::new(package)) {
            let nested = (0..archive.len()).find_map(|index| {
                archive.by_index(index).ok().and_then(|entry| {
                    let name = entry.name().to_owned();
                    (name != ".codex-plugin/plugin.json"
                        && name.ends_with("/.codex-plugin/plugin.json"))
                    .then_some(name)
                })
            });
            if let Some(path) = nested {
                return plugin_import_issue(
                    "manifest_not_at_root",
                    Some(&path),
                    "The ZIP contains an extra top-level directory. Compress the contents of the plugin directory so `.codex-plugin/plugin.json` is at the ZIP root",
                );
            }
        }
        return plugin_import_issue(
            "manifest_missing",
            Some(".codex-plugin/plugin.json"),
            "This is not a standard Wework plugin package. Add `.codex-plugin/plugin.json` at the ZIP root",
        );
    }
    let normalized = error.to_ascii_lowercase();
    let code = if normalized.contains("password")
        || normalized.contains("decrypt")
        || normalized.contains("encrypted")
    {
        "archive_encrypted"
    } else if error.contains("valid ZIP") || error.contains("ZIP directory") {
        "zip_invalid"
    } else if error.contains("unsafe path")
        || error.contains("symbolic link")
        || error.contains("duplicate path")
    {
        "archive_unsafe"
    } else if error.contains("50 MB") || error.contains("200 MB") || error.contains("entries") {
        "archive_limit_exceeded"
    } else if error.contains("manifest") {
        "manifest_invalid"
    } else {
        "package_invalid"
    };
    plugin_import_issue(code, None, error)
}

pub(super) fn validate_plugin_import_manifest(
    root: &Path,
    manifest: &Value,
) -> Vec<LocalPluginImportIssue> {
    let mut issues = Vec::new();
    let name = manifest_string(manifest, "name");
    if !valid_plugin_slug(name) {
        issues.push(plugin_import_issue(
            "manifest_name_invalid",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `name` must be a lowercase plugin slug",
        ));
    }
    if !valid_strict_semver(manifest_string(manifest, "version")) {
        issues.push(plugin_import_issue(
            "manifest_version_invalid",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `version` must use strict SemVer, for example 0.1.0",
        ));
    }
    if manifest_string(manifest, "description").is_empty() {
        issues.push(plugin_import_issue(
            "manifest_description_missing",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `description` is required",
        ));
    }
    if manifest
        .get("author")
        .and_then(Value::as_object)
        .and_then(|author| author.get("name"))
        .and_then(Value::as_str)
        .map_or(true, |name| name.trim().is_empty())
    {
        issues.push(plugin_import_issue(
            "manifest_author_missing",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `author.name` is required",
        ));
    }
    for key in [
        "displayName",
        "shortDescription",
        "longDescription",
        "developerName",
        "category",
    ] {
        if plugin_interface_string(manifest, key).is_empty() {
            issues.push(plugin_import_issue(
                "manifest_interface_incomplete",
                Some(".codex-plugin/plugin.json"),
                format!("plugin.json field `interface.{key}` is required"),
            ));
        }
    }
    let interface = manifest.get("interface").and_then(Value::as_object);
    if interface
        .and_then(|value| value.get("capabilities"))
        .map_or(true, |value| !value.is_array())
    {
        issues.push(plugin_import_issue(
            "manifest_capabilities_invalid",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `interface.capabilities` must be an array",
        ));
    }
    if interface.map_or(true, |value| {
        !value.contains_key("defaultPrompt") && !value.contains_key("default_prompt")
    }) {
        issues.push(plugin_import_issue(
            "manifest_default_prompt_missing",
            Some(".codex-plugin/plugin.json"),
            "plugin.json field `interface.defaultPrompt` is required",
        ));
    }
    if let Some(skills) = manifest.get("skills") {
        if skills
            .as_str()
            .map_or(true, |path| path.trim_end_matches('/') != "./skills")
            || !root.join("skills").is_dir()
        {
            issues.push(plugin_import_issue(
                "skills_path_invalid",
                Some(".codex-plugin/plugin.json"),
                "plugin.json field `skills` must resolve to an existing `./skills/` directory",
            ));
        }
    }
    validate_skill_manifests(root, &mut issues);
    match read_plugin_mcp_document(root, manifest) {
        Ok(Some(document)) if !valid_plugin_mcp_document(&document) => {
            issues.push(plugin_import_issue(
                "mcp_manifest_invalid",
                Some(".mcp.json"),
                "MCP configuration must be a direct server map or contain an `mcp_servers` or `mcpServers` object",
            ));
        }
        Err(issue) => issues.push(issue),
        _ => {}
    }
    if let Some(interface) = interface {
        for key in ["composerIcon", "logo", "logoDark"] {
            if let Some(path) = interface.get(key).and_then(Value::as_str) {
                let relative = path.trim_start_matches("./");
                if safe_archive_path(relative).is_err() || !root.join(relative).is_file() {
                    issues.push(plugin_import_issue(
                        "interface_asset_missing",
                        Some(".codex-plugin/plugin.json"),
                        format!("plugin.json field `interface.{key}` points to a missing file"),
                    ));
                }
            }
        }
    }
    issues
}

fn validate_skill_manifests(root: &Path, issues: &mut Vec<LocalPluginImportIssue>) {
    let Ok(entries) = fs::read_dir(root.join("skills")) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_root = entry.path();
        if !skill_root.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let label = format!("skills/{}/SKILL.md", entry.file_name().to_string_lossy());
        let valid = fs::read_to_string(skill_root.join("SKILL.md"))
            .ok()
            .filter(|contents| contents.starts_with("---\n"))
            .and_then(|contents| {
                let frontmatter = contents[4..].split("\n---").next()?.to_owned();
                Some(frontmatter)
            })
            .is_some_and(|frontmatter| {
                ["name:", "description:"].iter().all(|key| {
                    frontmatter.lines().any(|line| {
                        line.trim_start()
                            .strip_prefix(key)
                            .is_some_and(|value| !value.trim().is_empty())
                    })
                })
            });
        if !valid {
            issues.push(plugin_import_issue(
                "skill_manifest_invalid",
                Some(&label),
                "Each skill directory must contain SKILL.md with closed YAML frontmatter and non-empty `name` and `description` fields",
            ));
        }
    }
}

fn read_plugin_mcp_document(
    root: &Path,
    manifest: &Value,
) -> Result<Option<Value>, LocalPluginImportIssue> {
    let (path, display_path) = match manifest.get("mcpServers") {
        Some(declaration) if declaration.is_object() => return Ok(Some(declaration.clone())),
        Some(declaration) => {
            let Some(relative) = declaration.as_str().map(str::trim) else {
                return Err(plugin_import_issue(
                    "mcp_manifest_invalid",
                    Some(".codex-plugin/plugin.json"),
                    "plugin.json field `mcpServers` must be a relative path or an object",
                ));
            };
            let Some(trimmed) = relative.strip_prefix("./") else {
                return Err(plugin_import_issue(
                    "mcp_path_invalid",
                    Some(".codex-plugin/plugin.json"),
                    "plugin.json field `mcpServers` must start with `./`",
                ));
            };
            if safe_archive_path(trimmed).is_err() || !root.join(trimmed).is_file() {
                return Err(plugin_import_issue(
                    "mcp_path_invalid",
                    Some(".codex-plugin/plugin.json"),
                    "plugin.json field `mcpServers` must resolve to a file inside the plugin",
                ));
            }
            (root.join(trimmed), trimmed.to_owned())
        }
        None => {
            let Some(relative) = ["mcp.json", ".mcp.json"]
                .into_iter()
                .find(|relative| root.join(relative).is_file())
            else {
                return Ok(None);
            };
            (root.join(relative), relative.to_owned())
        }
    };
    fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(Some)
        .ok_or_else(|| {
            plugin_import_issue(
                "mcp_manifest_invalid",
                Some(&display_path),
                "MCP configuration must contain valid JSON",
            )
        })
}

pub(super) fn plugin_component_summary(
    root: &Path,
    manifest: &Value,
) -> (usize, usize, Vec<String>) {
    let skill_count = fs::read_dir(root.join("skills"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().join("SKILL.md").is_file())
                .count()
        })
        .unwrap_or(0);
    let mcp = read_plugin_mcp_document(root, manifest)
        .ok()
        .flatten()
        .and_then(|document| mcp_server_map(&document).cloned())
        .map(Value::Object);
    let mcp_server_count = mcp.as_ref().and_then(Value::as_object).map_or(0, Map::len);
    let mut executable = Vec::new();
    if let Some(servers) = mcp.as_ref().and_then(Value::as_object) {
        for (name, server) in servers {
            if server.get("command").is_some()
                || server.get("type").and_then(Value::as_str) == Some("stdio")
            {
                executable.push(format!("stdio MCP: {name}"));
            }
        }
    }
    if root.join("hooks").exists() || root.join("hooks.json").exists() {
        executable.push("hooks".to_owned());
    }
    if root.join("bin").exists() || root.join("bins").exists() {
        executable.push("binaries".to_owned());
    }
    (skill_count, mcp_server_count, executable)
}

fn mcp_server_map(document: &Value) -> Option<&Map<String, Value>> {
    let object = document.as_object()?;
    for wrapper in ["mcp_servers", "mcpServers"] {
        if let Some(servers) = object.get(wrapper) {
            return servers.as_object();
        }
    }
    Some(object)
}

fn valid_plugin_mcp_document(document: &Value) -> bool {
    mcp_server_map(document).is_some_and(|servers| {
        servers
            .iter()
            .all(|(name, server)| !name.trim().is_empty() && server.is_object())
    })
}

fn plugin_import_issue(
    code: &str,
    path: Option<&str>,
    message: impl Into<String>,
) -> LocalPluginImportIssue {
    LocalPluginImportIssue {
        code: code.to_owned(),
        path: path.map(str::to_owned),
        message: message.into(),
    }
}

pub(super) fn manifest_string<'a>(manifest: &'a Value, key: &str) -> &'a str {
    manifest
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

pub(super) fn plugin_interface_string<'a>(manifest: &'a Value, key: &str) -> &'a str {
    manifest
        .get("interface")
        .and_then(Value::as_object)
        .and_then(|interface| interface.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

pub(super) fn valid_plugin_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
        && value.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        })
}

fn valid_strict_semver(value: &str) -> bool {
    let (core_and_pre, build) = value
        .split_once('+')
        .map_or((value, None), |(left, right)| (left, Some(right)));
    if build.is_some_and(|value| {
        value
            .split('.')
            .any(|item| !valid_semver_identifier(item, true))
    }) {
        return false;
    }
    let (core, pre) = core_and_pre
        .split_once('-')
        .map_or((core_and_pre, None), |(left, right)| (left, Some(right)));
    if pre.is_some_and(|value| {
        value
            .split('.')
            .any(|item| !valid_semver_identifier(item, false))
    }) {
        return false;
    }
    let parts = core.split('.').collect::<Vec<_>>();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.chars().all(|character| character.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
        })
}

fn valid_semver_identifier(value: &str, allow_leading_zero: bool) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
        && (allow_leading_zero
            || value.len() == 1
            || !value.starts_with('0')
            || !value.chars().all(|character| character.is_ascii_digit()))
}
