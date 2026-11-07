// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{
    env,
    path::{Component, PathBuf},
};

pub fn configured_home_dir() -> Option<std::path::PathBuf> {
    let configured = std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from);
    #[cfg(windows)]
    {
        configured
            .map(normalize_windows_home_path)
            .or_else(dirs::home_dir)
    }
    #[cfg(not(windows))]
    {
        configured.or_else(dirs::home_dir)
    }
}

pub fn normalize_windows_home_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let value = path.to_string_lossy();
    let bytes = value.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let suffix = value[3..].replace('/', "\\");
        return std::path::PathBuf::from(format!("{drive}:\\{suffix}"));
    }
    path
}

/// Use the current user's Workbench root unless startup supplies an explicit root.
pub fn workbench_root() -> Result<PathBuf, String> {
    resolve_workbench_root(
        env::var_os("WEGENT_WORKBENCH_HOME")
            .filter(|value| !value.to_string_lossy().trim().is_empty())
            .map(PathBuf::from),
        configured_home_dir(),
    )
}

pub fn resolve_workbench_root(
    explicit: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    let path = explicit
        .filter(|path| !path.as_os_str().is_empty())
        .or_else(|| home.map(|path| path.join(".wegent/workbench")))
        .ok_or("Unable to resolve Workbench home")?;
    if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
        return Err("Workbench home must be an absolute path without parent traversal".into());
    }
    Ok(path)
}
