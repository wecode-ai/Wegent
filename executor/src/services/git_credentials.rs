// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

//! Select the device account store without reading or copying its credentials.

use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub(crate) fn environment() -> BTreeMap<String, String> {
    let Some(home) = crate::local::command::configured_home_dir() else {
        return BTreeMap::new();
    };
    let Ok(workbench) = credential_workbench_root(
        std::env::var_os("WEGENT_WORKBENCH_HOME").map(PathBuf::from),
        std::env::var_os("WEGENT_EXECUTOR_HOME").map(PathBuf::from),
        Some(home.clone()),
    ) else {
        return BTreeMap::new();
    };
    let managed_device = matches!(
        std::env::var("DEVICE_TYPE").as_deref(),
        Ok("cloud" | "remote")
    );
    environment_for(&workbench, &home, managed_device)
}

fn credential_workbench_root(
    workbench: Option<PathBuf>,
    executor: Option<PathBuf>,
    home: Option<PathBuf>,
) -> Result<PathBuf, String> {
    // Match the device-side writer's precedence without changing other Workbench paths.
    let configured = |path: &PathBuf| !path.as_os_str().to_string_lossy().trim().is_empty();
    let explicit = workbench.filter(configured).or_else(|| {
        executor
            .filter(configured)
            .map(|root| root.join("workbench"))
    });
    wegent_runtime_config::home::resolve_workbench_root(explicit, home)
}

pub(super) fn environment_for(
    workbench: &Path,
    home: &Path,
    managed_device: bool,
) -> BTreeMap<String, String> {
    let isolated = workbench != home.join(".wegent").join("workbench");
    let mut root = workbench.join("git-auth");
    let mut values = BTreeMap::new();
    // Desktop and disposable tasks keep native CLI login unless a device store exists.
    if isolated && !managed_device && !root.join("current").is_dir() {
        return values;
    }
    if isolated {
        values.insert(
            "GIT_CONFIG_GLOBAL".into(),
            root.join("current")
                .join("gitconfig")
                .to_string_lossy()
                .into_owned(),
        );
    } else if !root.join("current").is_dir() {
        // Old devices retain their account store until an explicit successful sync.
        root = home.join(".wecode").join("git-auth");
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
    use std::{collections::HashMap, fs, time::Duration};

    #[test]
    fn executor_root_matches_the_device_writer() {
        let directory = tempfile::tempdir().unwrap();
        let executor = directory.path().join("executor space's root");
        assert_eq!(
            credential_workbench_root(None, Some(executor.clone()), Some(directory.path().into()))
                .unwrap(),
            executor.join("workbench")
        );
    }

    #[test]
    fn explicit_workbench_root_takes_precedence_over_executor_root() {
        let directory = tempfile::tempdir().unwrap();
        let workbench = directory.path().join("workbench");
        assert_eq!(
            credential_workbench_root(
                Some(workbench.clone()),
                Some(PathBuf::from("invalid executor root")),
                Some(directory.path().into())
            )
            .unwrap(),
            workbench
        );
    }

    #[test]
    fn blank_roots_use_the_next_configured_root_or_home() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        for blank in ["", " \t\n"] {
            let executor = home.join("executor");
            assert_eq!(
                credential_workbench_root(
                    Some(blank.into()),
                    Some(executor.clone()),
                    Some(home.into())
                )
                .unwrap(),
                executor.join("workbench")
            );
            assert_eq!(
                credential_workbench_root(
                    Some(blank.into()),
                    Some(blank.into()),
                    Some(home.into())
                )
                .unwrap(),
                home.join(".wegent/workbench")
            );
        }
        assert_eq!(
            credential_workbench_root(None, None, Some(home.into())).unwrap(),
            home.join(".wegent/workbench")
        );
        assert!(credential_workbench_root(None, None, None).is_err());
    }

    #[test]
    fn invalid_explicit_roots_do_not_select_another_account_store() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        for invalid in [PathBuf::from("relative"), home.join("executor/../other")] {
            assert!(credential_workbench_root(
                Some(invalid.clone()),
                Some(home.join("valid-executor")),
                Some(home.into())
            )
            .is_err());
            assert!(credential_workbench_root(None, Some(invalid), Some(home.into())).is_err());
        }
    }

    async fn read_git_profile(
        environment: &HashMap<String, String>,
    ) -> crate::local::native_git::GitCapture {
        crate::local::native_git::run_git_capture(
            &["config", "--global", "--get", "wegent-test.profile"].map(String::from),
            None,
            environment,
            Duration::from_secs(5),
            1024,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn native_git_reads_live_synced_accounts_without_touching_native_config() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        let native = home.join(".gitconfig");
        let native_config = "[wegent-test]\n\tprofile = native\n";
        fs::write(&native, native_config).unwrap();
        let executor = home.join("executor space's root");
        for workbench in [None, Some(home.join("explicit-workbench"))] {
            let root =
                credential_workbench_root(workbench, Some(executor.clone()), Some(home.into()))
                    .unwrap();
            let mut environment = HashMap::from([
                ("HOME".into(), home.display().to_string()),
                ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
            ]);
            for key in ["PATH", "SystemRoot", "WINDIR"] {
                if let Ok(value) = std::env::var(key) {
                    environment.insert(key.into(), value);
                }
            }
            environment.extend(environment_for(&root, home, true));
            let config = root.join("git-auth/current/gitconfig");
            fs::create_dir_all(config.parent().unwrap()).unwrap();
            for profile in ["first-sync", "updated-sync"] {
                fs::write(&config, format!("[wegent-test]\n\tprofile = {profile}\n")).unwrap();
                let result = read_git_profile(&environment).await;
                assert!(result.success, "{}", result.stderr);
                assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), profile);
            }
            fs::remove_file(&config).unwrap();
            let cleared = read_git_profile(&environment).await;
            assert!(!cleared.success);
            assert!(cleared.stdout.is_empty());
            assert_eq!(fs::read_to_string(&native).unwrap(), native_config);
        }
    }

    #[test]
    fn device_store_switches_without_restarting_or_copying_secrets() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".wegent").join("workbench");
        assert!(environment_for(&root, home.path(), true).is_empty());
        let legacy = home.path().join(".wecode").join("git-auth").join("current");
        fs::create_dir_all(&legacy).unwrap();
        assert_eq!(
            environment_for(&root, home.path(), true)["GH_CONFIG_DIR"],
            legacy.join("gh").to_str().unwrap()
        );
        fs::create_dir_all(root.join("git-auth").join("current")).unwrap();
        let values = environment_for(&root, home.path(), true);
        assert_eq!(
            values["GH_CONFIG_DIR"],
            root.join("git-auth")
                .join("current")
                .join("gh")
                .to_str()
                .unwrap()
        );
        assert!(!values.contains_key("GIT_CONFIG_GLOBAL"));
        assert!(!values.contains_key("GH_TOKEN"));
    }

    #[test]
    fn custom_root_never_uses_default_or_legacy_accounts_even_before_sync() {
        let home = tempfile::tempdir().unwrap();
        fs::create_dir_all(home.path().join(".wecode").join("git-auth").join("current")).unwrap();
        fs::create_dir_all(
            home.path()
                .join(".wegent")
                .join("workbench")
                .join("git-auth")
                .join("current"),
        )
        .unwrap();
        let root = home.path().join("development").join("workbench");
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
        let root = home.path().join("desktop").join("workbench");
        assert!(environment_for(&root, home.path(), false).is_empty());
    }
}
