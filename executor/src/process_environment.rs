// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{collections::HashMap, env, path::PathBuf};

const STANDARD_DEVELOPER_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/Library/Apple/usr/bin",
];

pub fn process_env(extra_env: &[(String, String)]) -> HashMap<String, String> {
    let mut values = env::vars().collect::<HashMap<_, _>>();
    values.extend(extra_env.iter().cloned());
    let current_path = values.get("PATH").map(String::as_str).unwrap_or_default();
    values.insert("PATH".to_owned(), normalized_process_path(current_path));
    values.retain(|key, _| !ignored_process_env_key(key));
    values
}

pub fn normalized_process_path(current_path: &str) -> String {
    let mut paths = Vec::new();
    append_path_entries(&mut paths, current_path);
    if let Ok(extra_paths) = env::var("WEGENT_EXTRA_PATHS") {
        append_path_entries(&mut paths, &extra_paths);
    }
    for path in STANDARD_DEVELOPER_PATHS {
        append_unique_path(&mut paths, PathBuf::from(path));
    }

    env::join_paths(paths)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| current_path.to_owned())
}

fn append_path_entries(paths: &mut Vec<PathBuf>, value: &str) {
    for path in env::split_paths(value) {
        append_unique_path(paths, path);
    }
}

fn append_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if path.as_os_str().is_empty() || paths.iter().any(|existing| existing == &path) {
        return;
    }
    paths.push(path);
}

fn ignored_process_env_key(key: &str) -> bool {
    key.starts_with("_PYI_") || key.starts_with("_MEI_") || key == "_MEIPASS"
}
