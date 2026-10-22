// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use super::{set_mode, GitCredentials};

const SCRIPT: &[u8] = b"#!/bin/sh\ncase \"$1\" in\n  *sername*) printf '%s\\n' \"$WEGENT_GIT_USERNAME\" ;;\n  *) case \"$WEGENT_GIT_AUTH_PROVIDER\" in\n       github) printf '%s\\n' \"$GH_TOKEN\" ;;\n       gitlab) printf '%s\\n' \"$GITLAB_TOKEN\" ;;\n       *) exit 1 ;;\n     esac ;;\nesac\n";

pub(super) fn environment(
    git_domain: &str,
    credentials: &GitCredentials,
) -> Result<BTreeMap<String, String>, String> {
    environment_at(
        &crate::services::workbench::workbench_root()?,
        git_domain,
        credentials,
    )
}

fn environment_at(
    root: &Path,
    git_domain: &str,
    credentials: &GitCredentials,
) -> Result<BTreeMap<String, String>, String> {
    let askpass = ensure_script(root)?;
    let github = git_domain.to_ascii_lowercase().contains("github");
    let (provider, host_key, token_key) = if github {
        ("github", "GH_HOST", "GH_TOKEN")
    } else {
        ("gitlab", "GITLAB_HOST", "GITLAB_TOKEN")
    };
    Ok(BTreeMap::from([
        ("GIT_ASKPASS".into(), askpass.display().to_string()),
        ("GIT_ASKPASS_REQUIRE".into(), "force".into()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("WEGENT_GIT_USERNAME".into(), credentials.username.clone()),
        ("WEGENT_GIT_AUTH_PROVIDER".into(), provider.into()),
        (host_key.into(), git_domain.into()),
        (token_key.into(), credentials.token.clone()),
    ]))
}

fn ensure_script(root: &Path) -> Result<PathBuf, String> {
    for directory in [
        root.to_owned(),
        root.join("runtime"),
        root.join("runtime/git-auth"),
    ] {
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if !metadata.is_dir() => {
                return Err("Git authentication directory must not be a symlink or file".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let directory = root.join("runtime/git-auth");
    set_mode(&directory, 0o700)?;
    let target = directory.join("askpass.sh");
    match fs::symlink_metadata(&target) {
        Ok(_) => return validate_script(&target).map(|()| target),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    // Publish one credential-free helper atomically; concurrent tasks never truncate it.
    let mut staged =
        tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
    staged
        .write_all(SCRIPT)
        .map_err(|error| error.to_string())?;
    set_mode(staged.path(), 0o700)?;
    match staged.persist_noclobber(&target) {
        Ok(_) => Ok(target),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            validate_script(&target).map(|()| target)
        }
        Err(error) => Err(error.error.to_string()),
    }
}

fn validate_script(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || metadata.len() != SCRIPT.len() as u64
        || fs::read(path).map_err(|error| error.to_string())? != SCRIPT
    {
        return Err("Existing Git askpass helper is invalid; no files were overwritten".into());
    }
    set_mode(path, 0o700)
}

#[cfg(test)]
mod tests;
