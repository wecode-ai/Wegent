// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

use super::strip_wework_browser_instructions;

pub(super) const CODEX_HOME_ENV: &str = "CODEX_HOME";
pub(super) const WEGENT_CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";

/// Resolves the isolated Codex home owned by the Wework executor.
pub(crate) fn wework_codex_home() -> PathBuf {
    env::var_os(WEGENT_CODEX_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| executor_home().join("codex"))
}

/// Creates and normalizes the isolated Codex home before app-server startup.
pub(super) fn prepare_wework_codex_home(codex_home: &Path) -> Result<(), String> {
    fs::create_dir_all(codex_home).map_err(|error| {
        format!(
            "failed to create Codex home {}: {error}",
            codex_home.display()
        )
    })?;
    link_user_codex_auth(codex_home)?;
    normalize_wework_codex_config(codex_home)
}

fn normalize_wework_codex_config(codex_home: &Path) -> Result<(), String> {
    use toml_edit::{value, DocumentMut};

    let config_path = codex_home.join("config.toml");
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let mut document = content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "failed to parse Codex config {}: {error}",
            config_path.display()
        )
    })?;
    let legacy_instructions = document
        .get("instructions")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    let developer_instructions = document
        .get("developer_instructions")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    let user_instructions =
        select_wework_codex_user_instructions(legacy_instructions, developer_instructions);

    document.remove("instructions");
    if user_instructions.is_empty() {
        document.remove("developer_instructions");
    } else {
        document["developer_instructions"] = value(user_instructions);
    }
    if document
        .get("personality")
        .and_then(|item| item.as_str())
        .is_none()
    {
        document["personality"] = value("pragmatic");
    }

    let next_content = document.to_string();
    if next_content == content {
        return Ok(());
    }
    replace_config(&config_path, next_content)
}

pub(crate) fn read_wework_codex_user_instructions(codex_home: &Path) -> Result<String, String> {
    use toml_edit::DocumentMut;

    let config_path = codex_home.join("config.toml");
    let content = match fs::read_to_string(&config_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => {
            return Err(format!(
                "failed to read Codex config {}: {error}",
                config_path.display()
            ));
        }
    };
    let document = content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "failed to parse Codex config {}: {error}",
            config_path.display()
        )
    })?;
    let legacy_instructions = document
        .get("instructions")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    let developer_instructions = document
        .get("developer_instructions")
        .and_then(|item| item.as_str())
        .unwrap_or_default();
    Ok(select_wework_codex_user_instructions(
        legacy_instructions,
        developer_instructions,
    ))
}

pub(crate) fn select_wework_codex_user_instructions(
    legacy_instructions: &str,
    developer_instructions: &str,
) -> String {
    let legacy_instructions = legacy_instructions.trim();
    if !legacy_instructions.is_empty() {
        return legacy_instructions.to_owned();
    }
    strip_wework_browser_instructions(developer_instructions).to_owned()
}

pub(crate) fn replace_config(config_path: &Path, content: String) -> Result<(), String> {
    let parent = config_path
        .parent()
        .ok_or_else(|| format!("Codex config has no parent: {}", config_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create Codex config directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("failed to create Codex config temp file: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("failed to write Codex config temp file: {error}"))?;
    if let Ok(metadata) = fs::metadata(config_path) {
        fs::set_permissions(temporary.path(), metadata.permissions()).map_err(|error| {
            format!(
                "failed to preserve Codex config permissions {}: {error}",
                temporary.path().display()
            )
        })?;
    }
    #[cfg(unix)]
    if !config_path.exists() {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600)).map_err(
            |error| {
                format!(
                    "failed to secure Codex config permissions {}: {error}",
                    temporary.path().display()
                )
            },
        )?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("failed to sync Codex config temp file: {error}"))?;
    temporary.persist(config_path).map_err(|error| {
        format!(
            "failed to replace Codex config {}: {}",
            config_path.display(),
            error.error
        )
    })?;
    sync_parent_directory(parent)
        .map_err(|error| format!("failed to sync Codex config directory: {error}"))?;
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> std::io::Result<()> {
    Ok(())
}

fn link_user_codex_auth(codex_home: &Path) -> Result<(), String> {
    let target = codex_home.join("auth.json");
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() && !target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove stale Codex auth link {}: {error}",
                    target.display()
                )
            })?;
        } else {
            return Ok(());
        }
    }
    let Some(source) = user_codex_auth_path().filter(|path| path.is_file()) else {
        return Ok(());
    };

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target).map_err(|error| {
            format!(
                "failed to link Codex auth {} -> {}: {error}",
                target.display(),
                source.display()
            )
        })
    }
    #[cfg(not(unix))]
    {
        fs::copy(&source, &target).map(|_| ()).map_err(|error| {
            format!(
                "failed to copy Codex auth {} -> {}: {error}",
                source.display(),
                target.display()
            )
        })
    }
}

fn user_codex_auth_path() -> Option<PathBuf> {
    env::var_os(CODEX_HOME_ENV)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|home| home.join("auth.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex").join("auth.json")))
}

pub(crate) fn executor_home() -> PathBuf {
    env::var_os("WEGENT_EXECUTOR_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".wegent-executor")))
        .unwrap_or_else(|| PathBuf::from(".wegent-executor"))
}
