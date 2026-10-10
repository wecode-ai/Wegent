// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Select the device account store without reading or copying its credentials.

use std::{collections::BTreeMap, path::Path};

pub(crate) fn environment() -> BTreeMap<String, String> {
    let Ok(workbench) = super::workbench::workbench_root() else {
        return BTreeMap::new();
    };
    let Some(home) = dirs::home_dir() else {
        return BTreeMap::new();
    };
    let managed_device = matches!(
        std::env::var("DEVICE_TYPE").as_deref(),
        Ok("cloud" | "remote")
    );
    environment_for(&workbench, &home, managed_device)
}

fn environment_for(
    workbench: &Path,
    home: &Path,
    managed_device: bool,
) -> BTreeMap<String, String> {
    let isolated = workbench != home.join(".wegent/workbench");
    let mut root = workbench.join("git-auth");
    let mut values = BTreeMap::new();
    // Desktop and disposable tasks keep native CLI login unless a device store exists.
    if isolated && !managed_device && !root.join("current").is_dir() {
        return values;
    }
    if isolated {
        values.insert(
            "GIT_CONFIG_GLOBAL".into(),
            root.join("current/gitconfig")
                .to_string_lossy()
                .into_owned(),
        );
    } else if !root.join("current").is_dir() {
        // Old devices retain their account store until an explicit successful sync.
        root = home.join(".wecode/git-auth");
    }
    if isolated || root.join("current").is_dir() {
        for (key, directory) in [("GH_CONFIG_DIR", "gh"), ("GLAB_CONFIG_DIR", "glab")] {
            values.insert(
                key.into(),
                root.join("current")
                    .join(directory)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn device_store_switches_without_restarting_or_copying_secrets() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".wegent/workbench");
        assert!(environment_for(&root, home.path(), true).is_empty());
        let legacy = home.path().join(".wecode/git-auth/current");
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(
            environment_for(&root, home.path(), true)["GH_CONFIG_DIR"],
            legacy.join("gh").to_str().unwrap()
        );
        fs::create_dir_all(root.join("git-auth/current")).unwrap();
        let values = environment_for(&root, home.path(), true);
        assert_eq!(
            values["GH_CONFIG_DIR"],
            root.join("git-auth/current/gh").to_str().unwrap()
        );
        assert!(!values.contains_key("GIT_CONFIG_GLOBAL"));
        assert!(!values.contains_key("GH_TOKEN"));
    }

    #[test]
    fn custom_root_never_uses_default_or_legacy_accounts_even_before_sync() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".wecode/git-auth/current")).unwrap();
        fs::create_dir_all(home.path().join(".wegent/workbench/git-auth/current")).unwrap();
        let root = home.path().join("development/workbench");
        let values = environment_for(&root, home.path(), true);
        for value in values.values() {
            assert!(Path::new(value).starts_with(&root));
        }
        assert_eq!(values.len(), 3);
        assert!(!root.exists());
    }

    #[test]
    fn unmanaged_custom_runtime_keeps_native_cli_login() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join("desktop/workbench");
        assert!(environment_for(&root, home.path(), false).is_empty());
    }
}
