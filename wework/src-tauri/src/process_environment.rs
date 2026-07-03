// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::PathBuf};

const STANDARD_DEVELOPER_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/Library/Apple/usr/bin",
];

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

pub fn normalized_current_path() -> String {
    normalized_process_path(env::var("PATH").ok().as_deref().unwrap_or_default())
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
            .lock()
            .expect("env lock should be available")
    }

    #[test]
    fn normalized_process_path_adds_standard_developer_directories_once() {
        let _guard = env_lock();
        let previous_extra = std::env::var_os("WEGENT_EXTRA_PATHS");
        std::env::set_var("WEGENT_EXTRA_PATHS", "/custom/bin:/opt/homebrew/bin");

        let path = normalized_process_path("/usr/bin:/opt/homebrew/bin:/bin");

        if let Some(previous_extra) = previous_extra {
            std::env::set_var("WEGENT_EXTRA_PATHS", previous_extra);
        } else {
            std::env::remove_var("WEGENT_EXTRA_PATHS");
        }

        assert!(path.starts_with("/usr/bin:/opt/homebrew/bin:/bin:/custom/bin"));
        assert_eq!(path.matches("/opt/homebrew/bin").count(), 1);
        assert!(path.contains("/opt/homebrew/sbin"));
        assert!(path.contains("/usr/local/bin"));
        assert!(path.contains("/usr/local/sbin"));
    }
}
