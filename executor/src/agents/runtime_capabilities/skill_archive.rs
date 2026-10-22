// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

use std::{fs, path::Path};

pub(super) fn expected_hash(value: Option<&str>) -> Option<String> {
    value
        .map(crate::services::skill_deployer::normalize_content_hash)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

pub(super) fn publish_archive(
    staging: tempfile::TempDir,
    skill_name: &str,
    skills_dir: &Path,
    record_metadata: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    // Disable automatic deletion before moving any old content here. A panic or
    // failed rollback must leave the only old copy available for recovery.
    let staging = staging.keep();
    let staged = staging.join(skill_name);
    let backup = staging.join(if skill_name == "previous" {
        "previous-backup"
    } else {
        "previous"
    });
    let target = skills_dir.join(skill_name);
    let had_target = match target.symlink_metadata() {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("failed to inspect existing Skill: {error}")),
    };
    if had_target {
        fs::rename(&target, &backup)
            .map_err(|error| format!("failed to back up existing Skill: {error}"))?;
    }
    let mut activated = false;
    let result = fs::rename(&staged, &target)
        .map_err(|error| format!("failed to activate Skill: {error}"))
        .and_then(|()| {
            activated = true;
            record_metadata()
        });
    if let Err(error) = result {
        let restore = (|| -> std::io::Result<()> {
            if activated {
                fs::rename(&target, &staged)?;
            }
            if had_target {
                fs::rename(&backup, &target)?;
            }
            Ok(())
        })();
        if let Err(restore_error) = restore {
            return Err(format!(
                "{error}; failed to restore Skill: {restore_error}; recovery directory retained at {}",
                staging.display()
            ));
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let _ = fs::remove_dir_all(&staging);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::runtime_capabilities::{tests::skill_zip_entries, *};
    fn seed_install(skills_dir: &Path) -> String {
        let root = skills_dir.join("test-skill");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SKILL.md"), "# Old Skill").unwrap();
        fs::write(root.join("data.txt"), "old data").unwrap();
        let hash = archive_hash(&skill_zip_entries(&[
            ("test-skill/SKILL.md", "# Old Skill"),
            ("test-skill/data.txt", "old data"),
        ]));
        record_installed_skill(skills_dir, "test-skill", 44, "default", Some(hash.clone()))
            .unwrap();
        hash
    }

    #[test]
    fn skill_archive_metadata_failure_restores_old_tree_and_manifest() {
        let temp = tempfile::tempdir().unwrap();
        seed_install(temp.path());
        let manifest = fs::read(skill_manifest_path(temp.path())).unwrap();
        let archive = skill_zip_entries(&[("test-skill/SKILL.md", "# New Skill")]);
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        crate::services::workbench::stage_skill_archive(
            &archive,
            &staging.path().join("test-skill"),
            None,
        )
        .unwrap();
        let error = publish_archive(staging, "test-skill", temp.path(), || {
            assert_eq!(
                fs::read_to_string(temp.path().join("test-skill/SKILL.md")).unwrap(),
                "# New Skill"
            );
            Err("synthetic metadata failure".to_owned())
        })
        .unwrap_err();
        assert_eq!(error, "synthetic metadata failure");
        assert_eq!(
            fs::read_to_string(temp.path().join("test-skill/SKILL.md")).unwrap(),
            "# Old Skill"
        );
        assert_eq!(
            fs::read(skill_manifest_path(temp.path())).unwrap(),
            manifest
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn skill_archive_failed_rollback_keeps_only_old_copy() {
        let temp = tempfile::tempdir().unwrap();
        seed_install(temp.path());
        let archive = skill_zip_entries(&[("test-skill/SKILL.md", "# New Skill")]);
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        crate::services::workbench::stage_skill_archive(
            &archive,
            &staging.path().join("test-skill"),
            None,
        )
        .unwrap();
        let recovery = staging.path().to_owned();
        let error = publish_archive(staging, "test-skill", temp.path(), || {
            // Force the rollback rename to fail after activation.
            fs::create_dir_all(recovery.join("test-skill/obstruction")).unwrap();
            Err("synthetic metadata failure".to_owned())
        })
        .unwrap_err();
        assert!(error.contains("recovery directory retained"));
        assert_eq!(
            fs::read_to_string(recovery.join("previous/SKILL.md")).unwrap(),
            "# Old Skill"
        );
    }

    #[test]
    fn skill_archive_activation_failure_restores_old_tree() {
        let temp = tempfile::tempdir().unwrap();
        seed_install(temp.path());
        let archive = skill_zip_entries(&[("test-skill/SKILL.md", "# New Skill")]);
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        crate::services::workbench::stage_skill_archive(
            &archive,
            &staging.path().join("test-skill"),
            None,
        )
        .unwrap();
        fs::remove_dir_all(staging.path().join("test-skill")).unwrap();
        let error = publish_archive(staging, "test-skill", temp.path(), || {
            panic!("metadata must not be published after activation failure")
        })
        .unwrap_err();
        assert!(error.starts_with("failed to activate Skill:"));
        assert_eq!(
            fs::read_to_string(temp.path().join("test-skill/SKILL.md")).unwrap(),
            "# Old Skill"
        );
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
    }

    #[test]
    fn skill_archive_publication_panic_keeps_old_backup() {
        let temp = tempfile::tempdir().unwrap();
        seed_install(temp.path());
        let archive = skill_zip_entries(&[("test-skill/SKILL.md", "# New Skill")]);
        let staging = tempfile::tempdir_in(temp.path()).unwrap();
        crate::services::workbench::stage_skill_archive(
            &archive,
            &staging.path().join("test-skill"),
            None,
        )
        .unwrap();
        let recovery = staging.path().to_owned();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            publish_archive(staging, "test-skill", temp.path(), || {
                panic!("synthetic panic")
            })
        }));
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(recovery.join("previous/SKILL.md")).unwrap(),
            "# Old Skill"
        );
    }
}
