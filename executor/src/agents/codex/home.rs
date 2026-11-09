// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env, fs,
    path::{Path, PathBuf},
};

use super::strip_wework_browser_instructions;

pub(super) const CODEX_HOME_ENV: &str = "CODEX_HOME";
pub(super) const WEGENT_CODEX_HOME_ENV: &str = "WEGENT_CODEX_HOME";
pub(super) const WEGENT_NATIVE_CODEX_HOME_ENV: &str = "WEGENT_NATIVE_CODEX_HOME";
pub(super) const WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV: &str = "WEWORK_CODEX_SUBSCRIPTION_ENABLED";

#[path = "home_auth.rs"]
mod auth;
pub(super) use auth::acquire_shared_auth;
pub(crate) use auth::prepare_provider_migration;

#[cfg(test)]
#[path = "home_auth_tests.rs"]
mod auth_tests;

/// Returns whether the local Codex subscription is opted in via the desktop
/// preference threaded through the executor environment.
pub(super) fn codex_subscription_enabled() -> bool {
    env::var_os(WEWORK_CODEX_SUBSCRIPTION_ENABLED_ENV)
        .map(|value| value != "false")
        .unwrap_or(true)
}

pub(crate) use wegent_runtime_config::paths::wework_codex_home;

/// Creates and normalizes the isolated Codex home before app-server startup.
#[cfg(test)]
pub(super) fn prepare_wework_codex_home(codex_home: &Path) -> Result<(), String> {
    prepare_wework_codex_home_with_auth(codex_home, codex_subscription_enabled())
}

/// Creates and normalizes the isolated Codex home with an explicit auth mode.
///
/// The shared app-server can outlive a transient ChatGPT cloud-config failure.
/// When that happens the executor restarts the app-server in router-only mode,
/// removing the managed ChatGPT auth link so WeWork and local models remain
/// usable while the subscription account is offline.
pub(super) fn prepare_wework_codex_home_with_auth(
    codex_home: &Path,
    auth_enabled: bool,
) -> Result<(), String> {
    fs::create_dir_all(codex_home).map_err(|error| {
        format!(
            "failed to create Codex home {}: {error}",
            codex_home.display()
        )
    })?;
    sync_user_codex_auth(codex_home, auth_enabled)?;
    normalize_wework_codex_config(codex_home)?;
    crate::local::plugin_creator::install(codex_home)
}

fn normalize_wework_codex_config(codex_home: &Path) -> Result<(), String> {
    use toml_edit::{value, DocumentMut};

    let config_path = codex_home.join("config.toml");
    let content = crate::local::codex_home::read_optional_config(&config_path)?;
    let mut document = content.parse::<DocumentMut>().map_err(|error| {
        format!(
            "failed to parse Codex config {}: {error}",
            config_path.display()
        )
    })?;
    log_config_state("codex config normalization read", &config_path, &content);
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

pub(crate) use wegent_plugin_packages::codex_configuration::{log_config_state, replace_config};

fn sync_user_codex_auth(codex_home: &Path, auth_enabled: bool) -> Result<(), String> {
    let target = codex_home.join("auth.json");
    let native_source = user_codex_auth_path();

    if !auth_enabled {
        return remove_managed_codex_auth(codex_home);
    }

    let Some(source) = native_source.filter(|path| path.is_file()) else {
        return Ok(());
    };

    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() && !target.exists() {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove stale Codex auth link {}: {error}",
                    target.display()
                )
            })?;
        } else {
            // An existing target (link or real file) was not created here; leave
            // it and its marker state untouched so user-managed auth is never
            // reclassified as wework-managed.
            return Ok(());
        }
    }

    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&source, &target).map_err(|error| {
            format!(
                "failed to link Codex auth {} -> {}: {error}",
                target.display(),
                source.display()
            )
        })?;
    }
    #[cfg(not(unix))]
    {
        fs::copy(&source, &target).map_err(|error| {
            format!(
                "failed to copy Codex auth {} -> {}: {error}",
                source.display(),
                target.display()
            )
        })?;
    }
    write_managed_auth_marker(codex_home)
}

/// Removes only the auth link/copy managed by Wework. A user-managed auth file
/// is intentionally preserved.
pub(super) fn remove_managed_codex_auth(codex_home: &Path) -> Result<(), String> {
    let target = codex_home.join("auth.json");
    let native_source = user_codex_auth_path();
    let Ok(metadata) = fs::symlink_metadata(&target) else {
        return remove_managed_auth_marker(codex_home);
    };

    if metadata.file_type().is_symlink() {
        let linked_source = fs::read_link(&target).ok().map(|path| {
            if path.is_absolute() {
                path
            } else {
                codex_home.join(path)
            }
        });
        let managed = has_managed_auth_marker(codex_home)
            || native_source
                .as_ref()
                .is_some_and(|source| linked_source.as_ref() == Some(source));
        if managed {
            fs::remove_file(&target).map_err(|error| {
                format!(
                    "failed to remove disabled Codex auth link {}: {error}",
                    target.display()
                )
            })?;
            remove_managed_auth_marker(codex_home)?;
        }
    } else if has_managed_auth_marker(codex_home) {
        fs::remove_file(&target).map_err(|error| {
            format!(
                "failed to remove disabled Codex auth copy {}: {error}",
                target.display()
            )
        })?;
        remove_managed_auth_marker(codex_home)?;
    }
    Ok(())
}

fn user_codex_auth_path() -> Option<PathBuf> {
    env::var_os(WEGENT_NATIVE_CODEX_HOME_ENV)
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os(CODEX_HOME_ENV).filter(|value| !value.is_empty()))
        .map(PathBuf::from)
        .map(|home| home.join("auth.json"))
        .or_else(|| dirs::home_dir().map(|home| home.join(".codex").join("auth.json")))
}

// Marker file written alongside a wework-managed Codex auth so the disable
// path can distinguish its own copy (Windows) from a user-managed auth file.
const MANAGED_AUTH_MARKER: &str = ".wework-managed-auth";

fn managed_auth_marker_path(codex_home: &Path) -> PathBuf {
    codex_home.join(MANAGED_AUTH_MARKER)
}

fn write_managed_auth_marker(codex_home: &Path) -> Result<(), String> {
    fs::write(managed_auth_marker_path(codex_home), []).map_err(|error| {
        format!(
            "failed to write Codex auth marker {}: {error}",
            managed_auth_marker_path(codex_home).display()
        )
    })
}

fn has_managed_auth_marker(codex_home: &Path) -> bool {
    managed_auth_marker_path(codex_home).exists()
}

fn remove_managed_auth_marker(codex_home: &Path) -> Result<(), String> {
    match fs::remove_file(managed_auth_marker_path(codex_home)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "failed to remove Codex auth marker {}: {error}",
            managed_auth_marker_path(codex_home).display()
        )),
    }
}

pub(crate) fn executor_home() -> PathBuf {
    crate::config::paths::executor_home()
}
