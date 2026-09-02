// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use toml_edit::DocumentMut;

const EXECUTOR_HOME_ENV: &str = "WEGENT_EXECUTOR_HOME";
const CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
const E2E_NATIVE_CODEX_HOME_ENV: &str = "WEWORK_E2E_NATIVE_CODEX_HOME";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeMigrationStatus {
    wework_codex_home: String,
    native_codex_home: String,
    wework_codex_home_exists: bool,
    native_codex_home_exists: bool,
    should_prompt_migration: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexHomeInitializeRequest {
    migrate_native_home: bool,
    #[serde(default = "default_remote_apps_enabled")]
    remote_apps_enabled: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportRequest {
    source: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalContentImportResult {
    source: String,
    source_path: String,
    destination_path: String,
    imported_entries: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfigPatch {
    remote_apps_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct CodexLocalConfigUpdateRequest {
    pub patch: CodexLocalConfigPatch,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLocalConfig {
    codex_home: String,
    config_path: String,
    remote_apps_enabled: bool,
}

fn default_remote_apps_enabled() -> bool {
    true
}

pub fn codex_home_migration_status() -> Result<CodexHomeMigrationStatus, String> {
    let wework_codex_home = wework_codex_home_path()?;
    let native_codex_home = native_codex_home_path()?;
    Ok(codex_home_migration_status_from_paths(
        &wework_codex_home,
        &native_codex_home,
    ))
}

pub fn initialize_codex_home(
    request: CodexHomeInitializeRequest,
) -> Result<CodexHomeMigrationStatus, String> {
    let wework_codex_home = wework_codex_home_path()?;
    let native_codex_home = native_codex_home_path()?;
    initialize_codex_home_from_paths(&wework_codex_home, &native_codex_home, request)
}

pub fn import_external_content(
    request: ExternalContentImportRequest,
) -> Result<ExternalContentImportResult, String> {
    let home = dirs::home_dir().ok_or_else(|| "Unable to resolve home directory".to_owned())?;
    let destination = wework_codex_home_path()?;
    import_external_content_from_paths(&request.source, &home, &destination)
}

pub fn read_codex_local_config() -> Result<CodexLocalConfig, String> {
    let codex_home = wework_codex_home_path()?;
    read_codex_local_config_from_path(&codex_home)
}

pub fn update_codex_local_config(
    request: CodexLocalConfigUpdateRequest,
) -> Result<CodexLocalConfig, String> {
    let codex_home = wework_codex_home_path()?;
    if let Some(enabled) = request.patch.remote_apps_enabled {
        write_remote_apps_enabled(&codex_home, enabled)?;
    }
    read_codex_local_config_from_path(&codex_home)
}

fn codex_home_migration_status_from_paths(
    wework_codex_home: &Path,
    native_codex_home: &Path,
) -> CodexHomeMigrationStatus {
    let wework_codex_home_exists = wework_codex_home.exists();
    let native_codex_home_exists = native_codex_home.exists();
    CodexHomeMigrationStatus {
        wework_codex_home: wework_codex_home.display().to_string(),
        native_codex_home: native_codex_home.display().to_string(),
        wework_codex_home_exists,
        native_codex_home_exists,
        should_prompt_migration: !wework_codex_home.join("config.toml").is_file()
            && native_codex_home_exists,
    }
}

fn initialize_codex_home_from_paths(
    wework_codex_home: &Path,
    native_codex_home: &Path,
    request: CodexHomeInitializeRequest,
) -> Result<CodexHomeMigrationStatus, String> {
    let status = codex_home_migration_status_from_paths(wework_codex_home, native_codex_home);
    if request.migrate_native_home && status.should_prompt_migration {
        copy_initialization_files(native_codex_home, wework_codex_home)?;
    } else {
        fs::create_dir_all(wework_codex_home).map_err(|error| {
            format!(
                "Failed to create Codex home {}: {error}",
                wework_codex_home.display()
            )
        })?;
    }
    write_remote_apps_enabled(wework_codex_home, request.remote_apps_enabled)?;
    Ok(codex_home_migration_status_from_paths(
        wework_codex_home,
        native_codex_home,
    ))
}

fn wework_codex_home_path() -> Result<PathBuf, String> {
    if let Some(path) = non_empty_path(CODEX_HOME_ENV) {
        return Ok(path);
    }
    let executor_home = non_empty_path(EXECUTOR_HOME_ENV)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .ok_or_else(|| "Unable to resolve executor home".to_owned())?;
    Ok(executor_home.join("codex"))
}

fn native_codex_home_path() -> Result<PathBuf, String> {
    if env::var("VITE_WEWORK_E2E").as_deref() == Ok("true") {
        if let Some(path) = non_empty_path(E2E_NATIVE_CODEX_HOME_ENV) {
            return Ok(path);
        }
    }
    dirs::home_dir()
        .map(|home| home.join(".codex"))
        .ok_or_else(|| "Unable to resolve native Codex home".to_owned())
}

fn read_codex_local_config_from_path(codex_home: &Path) -> Result<CodexLocalConfig, String> {
    let config_path = codex_home.join("config.toml");
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    Ok(CodexLocalConfig {
        codex_home: codex_home.display().to_string(),
        config_path: config_path.display().to_string(),
        remote_apps_enabled: read_remote_apps_enabled(&content),
    })
}

fn read_remote_apps_enabled(content: &str) -> bool {
    content
        .parse::<DocumentMut>()
        .ok()
        .and_then(|config| {
            config
                .get("features")
                .and_then(|features| features.get("apps"))
                .and_then(|apps| apps.as_bool())
        })
        .unwrap_or_else(default_remote_apps_enabled)
}

fn write_remote_apps_enabled(codex_home: &Path, enabled: bool) -> Result<(), String> {
    fs::create_dir_all(codex_home)
        .map_err(|error| format!("Failed to create {}: {error}", codex_home.display()))?;
    let config_path = codex_home.join("config.toml");
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    fs::write(&config_path, set_remote_apps_enabled(&content, enabled))
        .map_err(|error| format!("Failed to write {}: {error}", config_path.display()))
}

fn set_remote_apps_enabled(content: &str, enabled: bool) -> String {
    let apps_line = format!("apps = {enabled}");
    let mut lines = content.lines().map(str::to_owned).collect::<Vec<_>>();
    let mut features_start = None;
    let mut features_end = lines.len();

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if features_start.is_some() {
                features_end = index;
                break;
            }
            if trimmed == "[features]" {
                features_start = Some(index);
            }
        }
    }

    if let Some(start) = features_start {
        for line in lines.iter_mut().take(features_end).skip(start + 1) {
            let trimmed = line.trim_start();
            let Some(rest) = trimmed.strip_prefix("apps") else {
                continue;
            };
            if rest.trim_start().starts_with('=') {
                let indentation = line.len() - trimmed.len();
                *line = format!("{}{}", " ".repeat(indentation), apps_line);
                return format!("{}\n", lines.join("\n"));
            }
        }
        lines.insert(start + 1, apps_line);
        return format!("{}\n", lines.join("\n"));
    }

    let mut next = content.trim_end().to_owned();
    if !next.is_empty() {
        next.push_str("\n\n");
    }
    next.push_str("[features]\n");
    next.push_str(&apps_line);
    next.push('\n');
    next
}

fn copy_initialization_files(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
    for entry in [
        "config.toml",
        "auth.json",
        "AGENTS.md",
        "models_cache.json",
        "plugins",
        "skills",
        "cache",
        "vendor_imports",
    ] {
        copy_entry(&source.join(entry), &destination.join(entry))?;
    }
    Ok(())
}

fn import_external_content_from_paths(
    source: &str,
    home: &Path,
    destination: &Path,
) -> Result<ExternalContentImportResult, String> {
    let (source_path, entries): (PathBuf, &[(&str, &str)]) = match source {
        "codex" => (
            home.join(".codex"),
            &[
                ("config.toml", "config.toml"),
                ("auth.json", "auth.json"),
                ("AGENTS.md", "AGENTS.md"),
                ("models_cache.json", "models_cache.json"),
                ("plugins", "plugins"),
                ("skills", "skills"),
                ("cache", "cache"),
                ("vendor_imports", "vendor_imports"),
            ],
        ),
        "claude-code" => (
            home.join(".claude"),
            &[
                ("CLAUDE.md", "AGENTS.md"),
                ("settings.json", "claude/settings.json"),
                ("plugins", "claude/plugins"),
                ("skills", "skills"),
            ],
        ),
        _ => return Err(format!("Unsupported external content source: {source}")),
    };

    let mut imported_entries = Vec::new();
    for (source_entry, destination_entry) in entries {
        let entry_path = source_path.join(source_entry);
        if !entry_path.exists() {
            continue;
        }
        copy_entry(&entry_path, &destination.join(destination_entry))?;
        imported_entries.push((*source_entry).to_owned());
    }
    if imported_entries.is_empty() {
        return Err(format!(
            "No supported content was found in {}",
            source_path.display()
        ));
    }

    Ok(ExternalContentImportResult {
        source: source.to_owned(),
        source_path: source_path.display().to_string(),
        destination_path: destination.display().to_string(),
        imported_entries,
    })
}

fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    if destination.exists() {
        if let (Ok(source_path), Ok(destination_path)) =
            (fs::canonicalize(source), fs::canonicalize(destination))
        {
            if source_path == destination_path {
                return Ok(());
            }
        }
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Failed to inspect {}: {error}", source.display()))?;
    if metadata.is_dir() {
        fs::create_dir_all(destination)
            .map_err(|error| format!("Failed to create {}: {error}", destination.display()))?;
        let mut entries = fs::read_dir(source)
            .map_err(|error| format!("Failed to read {}: {error}", source.display()))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Failed to read {}: {error}", source.display()))?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        fs::copy(source, destination).map_err(|error| {
            format!(
                "Failed to copy {} to {}: {error}",
                source.display(),
                destination.display()
            )
        })?;
    }
    Ok(())
}

fn non_empty_path(key: &str) -> Option<PathBuf> {
    env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_a_blank_codex_home_without_copying_native_configuration() {
        let root = tempfile::tempdir().unwrap();
        let native_home = root.path().join("native");
        let wework_home = root.path().join("wework");
        fs::create_dir_all(&native_home).unwrap();
        fs::write(native_home.join("config.toml"), "# native marker\n").unwrap();

        let status = initialize_codex_home_from_paths(
            &wework_home,
            &native_home,
            CodexHomeInitializeRequest {
                migrate_native_home: false,
                remote_apps_enabled: true,
            },
        )
        .unwrap();

        let config = fs::read_to_string(wework_home.join("config.toml")).unwrap();
        assert!(!config.contains("native marker"));
        assert!(config.contains("[features]\napps = true"));
        assert!(!status.should_prompt_migration);
    }

    #[test]
    fn migrates_supported_native_codex_entries() {
        let root = tempfile::tempdir().unwrap();
        let native_home = root.path().join("native");
        let wework_home = root.path().join("wework");
        fs::create_dir_all(native_home.join("skills/example")).unwrap();
        fs::write(native_home.join("config.toml"), "model = \"native\"\n").unwrap();
        fs::write(native_home.join("skills/example/SKILL.md"), "example").unwrap();

        initialize_codex_home_from_paths(
            &wework_home,
            &native_home,
            CodexHomeInitializeRequest {
                migrate_native_home: true,
                remote_apps_enabled: false,
            },
        )
        .unwrap();

        let config = fs::read_to_string(wework_home.join("config.toml")).unwrap();
        assert!(config.contains("model = \"native\""));
        assert!(config.contains("apps = false"));
        assert_eq!(
            fs::read_to_string(wework_home.join("skills/example/SKILL.md")).unwrap(),
            "example"
        );
    }

    #[test]
    fn reads_and_updates_remote_apps_config() {
        let root = tempfile::tempdir().unwrap();
        let codex_home = root.path().join("codex");
        fs::create_dir_all(&codex_home).unwrap();
        assert!(read_remote_apps_enabled(""));
        assert!(read_remote_apps_enabled("model = \"gpt-5\"\n"));
        fs::write(
            codex_home.join("config.toml"),
            "model = \"gpt-5\"\n\n[features]\napps = true # enabled\n",
        )
        .unwrap();

        let current = read_codex_local_config_from_path(&codex_home).unwrap();
        assert!(current.remote_apps_enabled);

        write_remote_apps_enabled(&codex_home, false).unwrap();

        let updated = read_codex_local_config_from_path(&codex_home).unwrap();
        assert!(!updated.remote_apps_enabled);
        assert!(fs::read_to_string(codex_home.join("config.toml"))
            .unwrap()
            .contains("model = \"gpt-5\""));
    }

    #[test]
    fn imports_codex_content_into_an_existing_home() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let destination = root.path().join("destination");
        fs::create_dir_all(home.join(".codex/skills/example")).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(home.join(".codex/config.toml"), "model = \"gpt-5\"\n").unwrap();
        fs::write(home.join(".codex/skills/example/SKILL.md"), "example").unwrap();
        fs::write(destination.join("config.toml"), "old\n").unwrap();

        let result = import_external_content_from_paths("codex", &home, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("config.toml")).unwrap(),
            "model = \"gpt-5\"\n"
        );
        assert_eq!(
            fs::read_to_string(destination.join("skills/example/SKILL.md")).unwrap(),
            "example"
        );
        assert_eq!(result.imported_entries, vec!["config.toml", "skills"]);
    }

    #[test]
    fn maps_claude_instructions_and_skills_to_codex_content() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let destination = root.path().join("destination");
        fs::create_dir_all(home.join(".claude/skills/example")).unwrap();
        fs::write(home.join(".claude/CLAUDE.md"), "Claude instructions").unwrap();
        fs::write(home.join(".claude/skills/example/SKILL.md"), "example").unwrap();

        let result =
            import_external_content_from_paths("claude-code", &home, &destination).unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("AGENTS.md")).unwrap(),
            "Claude instructions"
        );
        assert_eq!(
            fs::read_to_string(destination.join("skills/example/SKILL.md")).unwrap(),
            "example"
        );
        assert_eq!(result.imported_entries, vec!["CLAUDE.md", "skills"]);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_an_existing_link_to_the_imported_codex_auth() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source_auth = home.join(".codex/auth.json");
        let destination = root.path().join("destination");
        let destination_auth = destination.join("auth.json");
        fs::create_dir_all(source_auth.parent().unwrap()).unwrap();
        fs::create_dir_all(&destination).unwrap();
        fs::write(&source_auth, "{\"auth\":\"native\"}\n").unwrap();
        std::os::unix::fs::symlink(&source_auth, &destination_auth).unwrap();

        let result = import_external_content_from_paths("codex", &home, &destination).unwrap();

        assert_eq!(result.imported_entries, vec!["auth.json"]);
        assert!(fs::symlink_metadata(&destination_auth)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read_to_string(destination_auth).unwrap(),
            "{\"auth\":\"native\"}\n"
        );
    }
}
